/**
 * PnP 아카이브 KOREA — Notion → games.json 빌드 스크립트
 *
 * 실행:  NOTION_TOKEN=ntn_xxx node scripts/build.mjs
 * 산출물:
 *   games.json               사이트가 fetch 하는 데이터
 *   sitemap.xml, robots.txt  검색엔진용
 *   game/<slug>/index.html   게임별 정적 페이지 (링크 미리보기 + SEO)
 *
 * 의존성 없음 (Node 18+ 내장 fetch 사용)
 */

import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 공개 사이트 주소. GitHub Actions에서는 저장소 Variables의 SITE_URL을 읽습니다.
// 커스텀 도메인을 붙이면 이 값만 바꾸면 됩니다.
const SITE_URL = (process.env.SITE_URL || "https://pnparchive.com")
  .replace(/\/+$/, "");

// index.html과 동일한 GA4 측정 ID — 정적 게임 페이지도 같은 속성으로 집계됩니다.
const GA_MEASUREMENT_ID = "G-NJDJMDKBE0";

// 슬러그 고정용 레지스트리 파일. 한 번 정해진 슬러그는 제목이 바뀌어도 유지됩니다.
const SLUG_REGISTRY_PATH = join(ROOT, "slug-registry.json");

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
// 인원수 자유 텍스트 → 최소/최대 숫자 파싱
// "2-4명" "2-4인" "2-7명(권장 3-5명)" "1-100명" 등 실데이터 포맷을 모두 처리합니다.
// ─────────────────────────────────────────────
function parsePlayers(raw) {
  if (!raw) return { min: null, max: null };
  // 괄호 안 보충설명(예: "(권장 3-5명)")은 제외하고 본문 숫자만 사용
  const stripped = String(raw).replace(/\([^)]*\)/g, "");
  const nums = (stripped.match(/\d+/g) || []).map(Number);
  if (!nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

// ─────────────────────────────────────────────
// 슬러그 레지스트리 — game/<slug>/ URL을 고정합니다.
// Notion 제목이 나중에 바뀌어도 이미 배포된 링크가 깨지지 않도록,
// 각 게임이 "처음 게시됐을 때" 계산된 슬러그를 이 파일에 기록해두고 계속 재사용합니다.
// ─────────────────────────────────────────────
async function loadSlugRegistry() {
  try {
    return JSON.parse(await readFile(SLUG_REGISTRY_PATH, "utf8"));
  } catch {
    return {}; // 파일이 없으면(최초 실행) 빈 레지스트리로 시작
  }
}

function resolveSlug(game, registry) {
  const existing = registry[game.id];
  if (existing) return existing;
  registry[game.id] = game.slug; // transform()이 계산해둔 기본값을 첫 슬러그로 확정
  return game.slug;
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

  const playersRaw = read(p, "인원수") || "";
  const { min: playersMin, max: playersMax } = parsePlayers(playersRaw);

  return {
    id,
    // slugify()는 "이 id를 처음 봤을 때" 쓸 기본값입니다.
    // 실제 URL에 쓰이는 값은 main()에서 슬러그 레지스트리로 확정합니다.
    slug: slugify(en, ko, id),
    ko: ko || en,
    en: en || "",
    author: read(p, "작가") || "작자 미상",
    desc: read(p, "게임 설명") || "",
    players: playersRaw,
    playersMin,
    playersMax,
    playtime: read(p, "플레이타임") || "",
    age: read(p, "권장연령") || "",
    mech: read(p, "메인 메커니즘") || [],
    theme,
    price: read(p, "무료/유료") || "무료",
    year: read(p, "발표연도"),
    lang: read(p, "언어") || [],
    url: read(p, "파일 다운로드 주소") || read(p, "파일 다운로드 위치") || "",
    // 게임 하나에 링크가 여러 개 붙을 수 있습니다. 값이 있는 것만 버튼으로 나갑니다.
    //   url     = PnP 자료(파일/자료 게시글)
    //   infoUrl = 원문·게임 정보 페이지 (해외 원작 페이지, BGG, 창작일지 등)
    //   playUrl = 온라인으로 바로 플레이할 수 있는 구현체
    infoUrl: read(p, "원문/정보 링크") || "",
    playUrl: read(p, "온라인 플레이 링크") || "",
    // 출처: "국내 창작" / "해외 번역" (비어 있으면 필터·배지에 나타나지 않음)
    origin: read(p, "출처") || "",
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
// 정적 SEO 산출물 (sitemap / robots / 게임별 페이지)
// ─────────────────────────────────────────────
const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// http/https만 허용 (javascript: 같은 주소 차단)
function safeHttpUrl(u) {
  if (!u) return "";
  try {
    const p = new URL(String(u).trim());
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : "";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────
// 관련 게임 (정적 페이지용 — 빌드 시점에 고정)
// 테마·메커니즘이 겹치는 게임을 우선하고, 부족하면 결정론적으로 채웁니다.
// (SPA 쪽 "이런 게임은 어때요?"는 방문마다 무작위로 따로 동작합니다 — index.html 참고)
// ─────────────────────────────────────────────
function pickRelated(games, g, n = 3) {
  const others = games.filter((x) => x.id !== g.id);
  const scored = others.map((x) => {
    const shared =
      x.theme.filter((t) => g.theme.includes(t)).length +
      x.mech.filter((m) => g.mech.includes(m)).length;
    return { x, shared, tie: hash(g.id + x.id) };
  });
  scored.sort((a, b) => b.shared - a.shared || a.tie - b.tie);
  return scored.slice(0, n).map((s) => s.x);
}

function gamePageHtml(g, related) {
  const title = `${g.ko}${g.en ? ` (${g.en})` : ""} · PnP 아카이브 KOREA`;
  const desc =
    g.desc || `${g.ko} — ${g.author || "작자 미상"}의 한국 창작 PnP 보드게임.`;
  const canonical = `${SITE_URL}/game/${g.slug}/`;
  const image = safeHttpUrl(g.thumb) || `${SITE_URL}/assets/og-default.png`;
  // 값이 있는 링크만 버튼으로 만듭니다 — 1개면 버튼 1개, 2개면 2개.
  // 맨 앞 버튼이 주 버튼(주황), 나머지는 보조 버튼(테두리)입니다.
  const links = [
    { url: safeHttpUrl(g.url), label: "⬇ 파일 다운로드" },
    { url: safeHttpUrl(g.playUrl), label: "▶ 온라인으로 플레이" },
    { url: safeHttpUrl(g.infoUrl), label: "🔗 원문·게임 정보" },
  ].filter((l) => l.url);

  const spec = [
    ["인원수", g.players],
    ["플레이타임", g.playtime],
    ["권장연령", g.age],
    ["발표연도", g.year],
    ["언어", (g.lang || []).join(", ")],
    ["테마", (g.theme || []).join(", ")],
    ["메인 메커니즘", (g.mech || []).join(", ")],
    ["가격", g.price],
    ["출처", g.origin],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  // 주의: meta-refresh 자동 리다이렉트를 넣지 않습니다.
  // 카카오톡 등 링크 미리보기 봇은 자바스크립트를 실행하지 않으므로
  // 이 정적 페이지 자체가 사람이 읽어도 되는 완결된 콘텐츠여야 합니다.
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(desc)}">
<link rel="canonical" href="${escHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="PnP 아카이브 KOREA">
<meta property="og:locale" content="ko_KR">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${escHtml(canonical)}">
<meta property="og:image" content="${escHtml(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${escHtml(image)}">
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){ dataLayer.push(arguments); }
gtag("js", new Date());
gtag("config", "${GA_MEASUREMENT_ID}");
</script>
<style>
:root{--bg:#FAF6EF;--surface:#fff;--main:#C4593A;--navy:#2E3A4E;--text:#3B322C;--muted:#8A7E74;--line:#E7DFD2}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;background:var(--bg);color:var(--text);line-height:1.65}
a{color:inherit}
.topnav{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:720px;margin:0 auto;padding:20px 24px 0;font-size:14px}
.topnav .brand{font-weight:800;text-decoration:none;color:var(--navy)}
.topnav .navlinks a{margin-left:18px;color:var(--muted);text-decoration:none;font-weight:600}
.topnav .navlinks a:hover{color:var(--main)}
.wrap{max-width:720px;margin:0 auto;padding:24px 24px 72px}
.crumb{font-size:14px;color:var(--muted);margin-bottom:28px}
.crumb a{color:var(--main);text-decoration:none}
h1{font-size:clamp(28px,5vw,40px);font-weight:800;letter-spacing:-.03em;line-height:1.2}
.en{color:var(--muted);font-size:16px;margin-top:6px}
.by{margin-top:14px;font-size:15px;color:var(--muted)}
.desc{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px;margin:28px 0;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
th,td{text-align:left;padding:12px 18px;font-size:15px;border-bottom:1px solid var(--line)}
tr:last-child th,tr:last-child td{border-bottom:none}
th{width:34%;color:var(--muted);font-weight:600}
.btn{display:inline-block;margin:28px 8px 8px 0;background:var(--main);color:#fff;padding:14px 28px;border-radius:999px;font-weight:700;text-decoration:none}
.btn.off{background:var(--surface);color:var(--muted);border:1px solid var(--line)}
.btn.sub{background:var(--surface);color:var(--navy);border:1.5px solid var(--line)}
.takedown-note{margin:8px 0;font-size:12.5px;color:var(--muted)}
.back{display:inline-block;margin-top:32px;color:var(--main);text-decoration:none;font-weight:600}
.related{margin-top:44px}
.related h2{font-size:19px;font-weight:800;margin-bottom:16px}
.related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:600px){.related-grid{grid-template-columns:1fr}}
.related-card{display:block;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none;color:inherit}
.related-thumb{aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;font-size:28px;background-size:cover;background-position:center}
.related-title{padding:10px 12px;font-size:13.5px;font-weight:700}
footer{margin-top:48px;padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<div class="topnav">
  <a class="brand" href="${escHtml(SITE_URL)}/">🎲 PnP 아카이브 KOREA</a>
  <div class="navlinks">
    <a href="${escHtml(SITE_URL)}/#/archive">게임 아카이브</a>
    <a href="${escHtml(SITE_URL)}/#/submit">게임 등록하기</a>
  </div>
</div>
<div class="wrap">
  <div class="crumb"><a href="${escHtml(SITE_URL)}/#/archive">게임 아카이브</a> › ${escHtml(g.ko)}</div>
  <h1>${escHtml(g.ko)}</h1>
  ${g.en ? `<div class="en">${escHtml(g.en)}</div>` : ""}
  <div class="by">작가 · <strong>${escHtml(g.author || "작자 미상")}</strong></div>
  ${g.desc ? `<div class="desc">${escHtml(g.desc)}</div>` : ""}
  <table>
    ${spec
      .map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`)
      .join("\n    ")}
  </table>
  <div>
    ${
      links.length
        ? links
            .map(
              (l, i) =>
                `<a class="btn${i ? " sub" : ""}" href="${escHtml(l.url)}" rel="noopener noreferrer">${escHtml(l.label)}</a>`
            )
            .join("\n    ")
        : `<span class="btn off">다운로드 링크 준비 중</span>`
    }
  </div>
  <div class="takedown-note">🔒 이 게임의 저작권자이신가요? 정보 수정, 게시 중단, 기타 문의 사항은 <strong>GameSmithLab@gmail.com</strong>으로 연락부탁드립니다.</div>
  <div><a class="back" href="${escHtml(SITE_URL)}/#/archive">← 아카이브에서 다른 게임 보기</a></div>
  ${
    related.length
      ? `<div class="related">
    <h2>이런 게임은 어때요?</h2>
    <div class="related-grid">
      ${related
        .map(
          (r) => `<a class="related-card" href="${escHtml(SITE_URL)}/game/${escHtml(r.slug)}/">
        <div class="related-thumb" style="${
          r.thumb
            ? `background-image:url('${escHtml(r.thumb)}')`
            : `background:${r.grad || "linear-gradient(135deg,#2E3A4E,#5B6E8C)"}`
        }">${r.thumb ? "" : escHtml(r.icon || "🎲")}</div>
        <div class="related-title">${escHtml(r.ko)}</div>
      </a>`
        )
        .join("\n      ")}
    </div>
  </div>`
      : ""
  }
  <footer>© 2026 PnP 아카이브 KOREA · 모든 게임의 권리는 각 창작자에게 있습니다. 등록은 비독점적이며, 창작자는 언제든지 게시 중단을 요청할 수 있습니다. 제3자의 저작권 등을 침해하는 게임 등록, 본 사이트 제공 정보를 대량 수집 및 재배포하는 행위를 금지합니다.</footer>
</div>
</body>
</html>
`;
}

async function writeStaticSEO(games) {
  // 삭제된 게임의 페이지가 남지 않도록 game/ 디렉터리를 매번 새로 만듭니다.
  await rm(join(ROOT, "game"), { recursive: true, force: true });

  for (const g of games) {
    const dir = join(ROOT, "game", g.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), gamePageHtml(g, pickRelated(games, g)), "utf8");
  }

  const urls = [
    { loc: `${SITE_URL}/`, priority: "1.0" },
    ...games.map((g) => ({
      loc: `${SITE_URL}/game/${g.slug}/`,
      lastmod: (g.updatedAt || "").slice(0, 10),
      priority: "0.7",
    })),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${escHtml(u.loc)}</loc>${
        u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""
      }<priority>${u.priority}</priority></url>`
  )
  .join("\n")}
</urlset>
`;
  await writeFile(join(ROOT, "sitemap.xml"), sitemap, "utf8");

  const robots = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
  await writeFile(join(ROOT, "robots.txt"), robots, "utf8");

  console.log(
    `✓ 정적 SEO 생성 완료 — game/*/index.html ${games.length}개, sitemap.xml, robots.txt`
  );
  console.log(`  사이트 주소: ${SITE_URL}`);
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

  // 슬러그 확정 — 이미 레지스트리에 있으면 그 값을 쓰고(제목이 바뀌어도 URL 유지),
  // 처음 보는 게임이면 지금 계산한 슬러그를 레지스트리에 등록해 이후로 고정합니다.
  const slugRegistry = await loadSlugRegistry();
  let newSlugCount = 0;
  for (const g of games) {
    const before = slugRegistry[g.id];
    g.slug = resolveSlug(g, slugRegistry);
    if (!before) newSlugCount++;
  }
  if (newSlugCount > 0) {
    await writeFile(SLUG_REGISTRY_PATH, JSON.stringify(slugRegistry, null, 2), "utf8");
    console.log(`✓ slug-registry.json 갱신 — 신규 슬러그 ${newSlugCount}건 등록`);
  }

  // 필터 UI에 쓸 옵션 목록을 실제 데이터에서 추출
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const facets = {
    playtime: uniq(games.map((g) => g.playtime)),
    age: uniq(games.map((g) => g.age)),
    theme: uniq(games.flatMap((g) => g.theme)),
    mech: uniq(games.flatMap((g) => g.mech)),
    lang: uniq(games.flatMap((g) => g.lang)),
    price: uniq(games.map((g) => g.price)),
    origin: uniq(games.map((g) => g.origin)),
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

  await writeStaticSEO(games);

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
