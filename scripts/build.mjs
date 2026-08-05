/**
 * PnP 아카이브 KOREA — Notion → games.json 빌드 스크립트
 *
 * 실행:  NOTION_TOKEN=ntn_xxx node scripts/build.mjs
 * 산출물: games.json  (사이트가 fetch 하는 파일)
 *
 * 의존성 없음 (Node 18+ 내장 fetch 사용)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
const TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID =
  process.env.NOTION_DATABASE_ID || "edc7c616d3e948b79780d48e4d211987";

// 이 상태인 행만 사이트에 공개합니다.
const PUBLISH_STATUS = "게시완료";

if (!TOKEN) {
  console.error("✗ NOTION_TOKEN 환경변수가 없습니다.");
  process.exit(1);
}

// ─────────────────────────────────────────────
// Notion API 호출 (페이지네이션 전체 수집)
// ─────────────────────────────────────────────
async function fetchAllPages() {
  const rows = [];
  let cursor = undefined;

  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page_size: 100,
          start_cursor: cursor,
          filter: {
            property: "검토상태",
            select: { equals: PUBLISH_STATUS },
          },
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status}\n${text}`);
    }

    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;

    // Notion 레이트리밋(초당 3회) 여유
    if (cursor) await new Promise((r) => setTimeout(r, 350));
  } while (cursor);

  return rows;
}

// ─────────────────────────────────────────────
// 속성 값 추출 헬퍼
// ─────────────────────────────────────────────
const plain = (rich) => (rich || []).map((t) => t.plain_text).join("").trim();

function read(props, name) {
  const p = props[name];
  if (!p) return null;
  switch (p.type) {
    case "title":
      return plain(p.title) || null;
    case "rich_text":
      return plain(p.rich_text) || null;
    case "select":
      return p.select?.name ?? null;
    case "multi_select":
      return p.multi_select.map((o) => o.name);
    case "number":
      return p.number ?? null;
    case "url":
      return p.url ?? null;
    case "email":
      return p.email ?? null;
    case "files": {
      const f = p.files?.[0];
      if (!f) return null;
      // 주의: Notion에 직접 업로드한 파일의 URL은 약 1시간 뒤 만료됩니다.
      // 안정적인 썸네일을 원하면 '외부 링크'로 등록하세요.
      return f.type === "external" ? f.external.url : f.file?.url ?? null;
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// 썸네일이 없을 때 쓸 자동 색상/아이콘
// ─────────────────────────────────────────────
const PALETTE = [
  "linear-gradient(135deg,#2E3A4E,#5B6E8C)",
  "linear-gradient(135deg,#C4593A,#E0A83C)",
  "linear-gradient(135deg,#E0A83C,#F3D08A)",
  "linear-gradient(135deg,#1F2938,#2E3A4E)",
  "linear-gradient(135deg,#5B6E8C,#8A9BB8)",
  "linear-gradient(135deg,#7A5C3E,#A8845C)",
  "linear-gradient(135deg,#4C7A3F,#8FB77F)",
  "linear-gradient(135deg,#8C4A5B,#C4818F)",
];

// 테마 → 이모지. 테마가 비어 있으면 제목 해시로 기본 아이콘 배정.
const THEME_ICON = {
  판타지: "🏰",
  SF: "🛰️",
  공포: "👻",
  역사: "🏯",
  현대: "🏙️",
  추상: "🔷",
  동물: "🦊",
  기타: "🎲",
};
const FALLBACK_ICONS = ["🎲", "🃏", "🧩", "🗺️", "⚔️", "🎯", "📦", "🔖"];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// ─────────────────────────────────────────────
// slug (상세 페이지 주소용)
// ─────────────────────────────────────────────
function slugify(en, ko, id) {
  const base = (en || ko || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "");
  return base ? `${base}-${id.slice(0, 6)}` : id.slice(0, 12);
}

// ─────────────────────────────────────────────
// 변환
// ─────────────────────────────────────────────
function transform(page) {
  const p = page.properties;
  const id = page.id.replace(/-/g, "");

  const ko = read(p, "제목(국문)");
  const en = read(p, "제목(영문)");
  if (!ko && !en) return null; // 빈 행 제외

  const theme = read(p, "테마") || [];
  const h = hash(id);

  // 썸네일 속성 이름이 '썸네일' 또는 '썸네일 URL' 어느 쪽이든 잡습니다.
  const thumb = read(p, "썸네일") || read(p, "썸네일 URL") || null;

  return {
    id,
    slug: slugify(en, ko, id),
    ko: ko || en,
    en: en || "",
    author: read(p, "작가") || "작자 미상",
    desc: read(p, "게임 설명") || "",
    players: read(p, "인원수") || "",
    playtime: read(p, "플레이타임") || "",
    age: read(p, "권장연령") || "",
    mech: read(p, "메인 메커니즘") || [],
    mechEtc: read(p, "메인 메커니즘 - 기타 내용") || "",
    theme,
    diff: read(p, "제작 난이도") || "",
    price: read(p, "무료/유료") || "무료",
    year: read(p, "발표연도"),
    lang: read(p, "언어") || [],
    url: read(p, "파일 다운로드 위치") || "",
    thumb,
    // 썸네일이 없을 때 카드에 쓸 대체 비주얼
    grad: PALETTE[h % PALETTE.length],
    icon: THEME_ICON[theme[0]] || FALLBACK_ICONS[h % FALLBACK_ICONS.length],
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
  };
  // 주의: 제출자 이메일 / 검토상태는 의도적으로 내보내지 않습니다(비공개 정보).
}

// ─────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────
async function main() {
  console.log("→ Notion에서 데이터를 가져오는 중…");
  const pages = await fetchAllPages();
  console.log(`  ${pages.length}건 수신 (검토상태=${PUBLISH_STATUS})`);

  const games = pages.map(transform).filter(Boolean);

  // 최신 등록순 정렬
  games.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 필터 UI에 쓸 옵션 목록을 실제 데이터에서 추출
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const facets = {
    playtime: uniq(games.map((g) => g.playtime)),
    age: uniq(games.map((g) => g.age)),
    theme: uniq(games.flatMap((g) => g.theme)),
    mech: uniq(games.flatMap((g) => g.mech)),
    diff: uniq(games.map((g) => g.diff)),
    lang: uniq(games.flatMap((g) => g.lang)),
    price: uniq(games.map((g) => g.price)),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    count: games.length,
    facets,
    games,
  };

  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, "games.json"), JSON.stringify(out, null, 2), "utf8");

  console.log(`✓ games.json 생성 완료 — ${games.length}개 게임`);

  // 데이터 품질 경고
  const noDesc = games.filter((g) => !g.desc).length;
  const noThumb = games.filter((g) => !g.thumb).length;
  const noMech = games.filter((g) => !g.mech.length).length;
  const noTheme = games.filter((g) => !g.theme.length).length;
  if (noDesc || noThumb || noMech || noTheme) {
    console.log("\n[데이터 품질 안내]");
    if (noDesc) console.log(`  · 게임 설명 없음: ${noDesc}건`);
    if (noThumb) console.log(`  · 썸네일 없음: ${noThumb}건 (자동 색상 카드로 대체)`);
    if (noMech) console.log(`  · 메인 메커니즘 없음: ${noMech}건 (필터에 안 잡힘)`);
    if (noTheme) console.log(`  · 테마 없음: ${noTheme}건 (필터에 안 잡힘)`);
  }
}

main().catch((e) => {
  console.error("✗ 빌드 실패:", e.message);
  process.exit(1);
});
