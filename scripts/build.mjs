/**
 * PnP 아카이브 KOREA — Notion → games.json 빌드 스크립트
 *
 * 실행:  npm install && NOTION_TOKEN=ntn_xxx node scripts/build.mjs
 * 산출물:
 *   games.json                  사이트가 fetch 하는 데이터
 *   sitemap.xml, robots.txt     검색엔진용
 *   game/<slug>/index.html      게임별 정적 페이지 (링크 미리보기 + SEO)
 *   assets/thumbs/<slug>-*.webp 게임별 썸네일 (grid 600×450 / detail 1200×900)
 *   review-queue.json           운영자 검토 큐 (PDF 자동 추출 썸네일 목록) — review.html이 읽음
 *
 * 의존성: sharp(이미지 리사이즈), pdf-to-img(PDF 1페이지 렌더링) — package.json 참고.
 * 2026-08-31 이전에는 의존성이 없었지만, 썸네일 파이프라인 추가로 npm install이
 * 필요해졌습니다. GitHub Actions 워크플로(sync-notion.yml)에도 npm ci 단계가
 * 추가돼 있습니다.
 */

import { writeFile, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildThumbnails, isFresh, setReviewFlag } from "./thumbnails.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THUMB_DIR = join(ROOT, "assets", "thumbs");
const THUMB_MANIFEST_PATH = join(THUMB_DIR, ".manifest.json");
const THUMB_URL_PREFIX = "/assets/thumbs";

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

// "A,B ,  C" → "A, B, C" (빈 이름·공백 정리)
function normalizeNames(v) {
  return String(v || "")
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
}

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
      // 주의: Notion에 직접 업로드한 파일의 URL(f.file.url)은 약 1시간 뒤 만료됩니다.
      // 이 URL을 games.json에 그대로 내보내면 안 됩니다 — 반드시 이 빌드 실행
      // 안에서(=아직 유효할 때) 다운로드까지 끝내야 합니다. 썸네일 처리는
      // processThumbnails()/thumbnails.mjs가 담당합니다.
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

  // 썸네일 원본 소스 — 창작자가 올린 이미지. 속성 이름이 '썸네일 이미지'
  // '썸네일' '썸네일 URL' 중 어느 쪽이든 잡습니다(과거 명칭 호환용).
  // 주의: 여기 담기는 건 아직 "원본 소스 URL"일 뿐입니다. 사이트가 실제로
  // 서빙하는 값(g.thumb / g.thumbLarge)은 main()에서 buildThumbnails()가
  // 이 URL을 다운로드·정규화한 뒤에 만들어집니다 — Notion 파일 URL은 약
  // 1시간 뒤 만료되므로 원본 URL을 games.json에 그대로 남겨두지 않습니다.
  const thumbSourceUrl =
    read(p, "썸네일 이미지") || read(p, "썸네일") || read(p, "썸네일 URL") || null;

  // PDF 자동 추출용 원본 파일. 주의: "파일 다운로드 주소"는 여기 쓰면 안 된다 —
  // 실제 데이터로 확인해보니 그 값은 boardlife.co.kr 게시글(사람이 보는 HTML
  // 페이지) 링크이지 바로 받을 수 있는 PDF 파일이 아니다. 스크립트가 직접
  // fetch할 수 있는 진짜 PDF는 운영자가 Notion "PDF 원본 파일"(File 속성)에
  // 직접 올린 것뿐이다(Boardlife 다운로드는 로그인·JS 처리라 자동화 불가 —
  // 2026-08-31 자정 무렵 조사 기록 참고).
  const pdfSourceUrl = read(p, "PDF 원본 파일") || null;

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
    // 번역자: 해외 번역작의 한국어 번역자(Notion '번역자', 텍스트). 여러 명이면
    // 쉼표로 구분해 입력 → "A, B"로 정리. 출처가 '해외 번역'인 게임만 내보내고,
    // 비어 있으면 카드·상세 페이지에 번역자 표기가 나오지 않습니다.
    translator: read(p, "출처") === "해외 번역" ? normalizeNames(read(p, "번역자")) : "",
    // 공용 기물: 인쇄물 외에 따로 준비해야 하는 시판 기물(트럼프 카드/주사위/
    // 큐브·토큰·미플/필기구). 비어 있으면 필터·스펙 표에 나타나지 않습니다.
    // 주의: "공용 기물 근거"는 운영용 내부 메모라 내보내지 않습니다.
    components: read(p, "공용 기물") || [],
    // 원본 소스 URL (창작자 업로드 이미지). main()에서 다운로드·정규화된 뒤
    // thumb/thumbLarge로 대체되고, 이 필드 자체는 games.json에 나가지 않습니다.
    thumbSourceUrl,
    // PDF 자동 추출용 원본(운영자가 Notion에 직접 올린 File). main()에서
    // buildThumbnails()에 pdfUrl로 전달된 뒤 games.json에는 나가지 않습니다.
    pdfSourceUrl,
    // Notion 페이지 ID(대시 포함 원본). "썸네일 검토 필요" 체크박스를 다시
    // 써넣을 때만 씁니다 — games.json에는 나가지 않습니다.
    notionPageId: page.id,
    // thumb(그리드용, 600×450) / thumbLarge(상세·og:image용, 1200×900) /
    // thumbRaw(원본 비율 유지, 정적 게임 페이지 히어로 밴드용) —
    // main()의 buildThumbnails() 처리 이후 채워집니다. 처리 실패/미제공 시 null.
    thumb: null,
    thumbLarge: null,
    thumbRaw: null,
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

// g.thumb/g.thumbLarge는 "/assets/thumbs/<slug>-grid.webp" 같은 사이트 상대경로.
// og:image 등 메타 태그는 절대 URL이 필요하므로 SITE_URL을 붙여서 반환한다.
function absoluteThumbUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  const already = safeHttpUrl(pathOrUrl);
  if (already) return already; // 혹시 절대 URL이 들어와도 그대로 통과
  return `${SITE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
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

// ─────────────────────────────────────────────
// 히어로 밴드 (정적 게임 페이지 상단, 풀블리드)
//
// 흐리게 확대한 표지를 배경으로 깔고, 그 위에 표지 원본을 비율 그대로 얹는다.
// 창작자가 정사각형을 올리든 세로로 긴 스캔본을 올리든 잘리지도 늘어나지도
// 않는 배치라, 200건 넘는 이미지를 사람 검수 없이 자동으로 받아야 하는 이
// 아카이브의 성질에 맞는다.
//
// 앞면(hero-art)은 여백을 굽지 않은 raw 판본을 쓴다 — 4:3으로 이미 블러 여백을
// 구워둔 detail 판본을 얹으면 블러가 두 겹이 된다. raw가 아직 없는 게임(2026-09-04
// 이전에 만들어진 파일)은 detail로 폴백하므로 화면이 깨지지는 않는다.
//
// 썸네일이 아예 없는 게임은 아카이브 카드와 같은 그라디언트+아이콘을 쓰되,
// 높이를 낮춰(340→200px) 빈 띠가 페이지를 지배하지 않게 한다.
// ─────────────────────────────────────────────
function heroHtml(g) {
  const art = g.thumbRaw || g.thumbLarge;
  if (!art) {
    // 표지가 없으면 사이트 카드처럼 커팅 매트 위에 아이콘만 둔다
    return `<div class="hero hero-empty" aria-hidden="true">${escHtml(g.icon || "🎲")}</div>`;
  }
  // 배경도 raw를 우선 쓴다 — detail 판본은 이미 블러 여백이 구워져 있어서,
  // 그걸 다시 블러 처리하면 색이 빠진 뿌연 띠가 된다.
  const bg = art;
  return `<div class="hero">
  <div class="hero-bg" style="background-image:url('${escHtml(bg)}')" aria-hidden="true"></div>
  <img class="hero-art" src="${escHtml(art)}" alt="${escHtml(g.ko)} 표지 이미지" decoding="async">
</div>`;
}

// ─────────────────────────────────────────────
// 상단 메뉴 (정적 게임 페이지) — index.html의 <header class="nav">와 같은 구성
//
// 로고·메뉴 5개·KO/EN·검색·디스코드·게임 등록하기·모바일 메뉴까지 그대로 옮긴다.
// 로고는 index.html에 인라인된 이미지를 빌드 때 읽어 와서, 메인에서 로고를 바꾸면
// 다음 동기화 때 게임 페이지에도 자동으로 반영된다(못 찾으면 글자만 표시).
// 아이콘은 lucide 스크립트를 불러오지 않도록 같은 모양의 SVG를 직접 넣는다.
// ─────────────────────────────────────────────
let LOGO_SRC = "";
async function loadLogo() {
  try {
    const html = await readFile(join(ROOT, "index.html"), "utf8");
    const m = html.match(/class="brand"[^>]*>\s*<img src="(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)"/);
    LOGO_SRC = m ? m[1] : "";
    if (!LOGO_SRC) console.warn("⚠️ index.html에서 로고 이미지를 찾지 못해 게임 페이지 로고를 글자만 표시합니다.");
  } catch (e) {
    console.warn("⚠️ index.html을 읽지 못해 게임 페이지 로고를 생략합니다:", e.message);
  }
}

const svgIcon = (body) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  search: svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  message: svgIcon('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  menu: svgIcon('<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>'),
};

const NAV_ITEMS = [
  ["home", "홈", "Home"],
  ["archive", "게임 아카이브", "Game Archive"],
  ["translated", "해외 번역 PnP", "Translated PnP"],
  ["submit", "게임 등록하기", "Submit a Game"],
  ["about", "소개 · 문의", "About · Contact"],
];

// 정적 페이지 고정 문구의 영문 (index.html의 EN 사전과 같은 표현)
const EN_LABEL = {
  인원수: "Players", 플레이타임: "Play time", 권장연령: "Age", 발표연도: "Release year",
  언어: "Language", 테마: "Theme", "메인 메커니즘": "Main mechanism", "공용 기물": "Common components",
  가격: "Price", 출처: "Source",
};
// data-en: 영어로 볼 때 바꿔 넣을 글자 (textContent로만 넣으므로 게임 제목도 안전)
const enAttr = (en) => (en ? ` data-en="${escHtml(en)}"` : "");

function siteHeaderHtml(g) {
  // 게임 페이지에서는 해당 목록 메뉴를 현재 위치로 표시 (번역작 → 해외 번역 PnP)
  const current = g.origin === "해외 번역" ? "translated" : "archive";
  const navLinks = NAV_ITEMS.map(
    ([k, ko, en]) =>
      `<a href="/#/${k}"${k === current ? ' aria-current="page"' : ""}${enAttr(en)}>${escHtml(ko)}</a>`
  );
  const lang = (cls) =>
    `<div class="lang${cls}" role="group" aria-label="Language"><button type="button" data-lang="ko" aria-pressed="true">KO</button><button type="button" data-lang="en" aria-pressed="false">EN</button></div>`;
  return `<header class="nav">
  <div class="nav-wrap nav-bar">
    <a class="brand" href="/#/home">
      ${LOGO_SRC ? `<img src="${LOGO_SRC}" alt="" width="36" height="36">` : ""}
      <span>PnP 아카이브 <span class="kr">KOREA</span></span>
    </a>
    <nav class="links" aria-label="주요 메뉴">
      ${navLinks.join("\n      ")}
    </nav>
    <div class="nav-right">
      ${lang("")}
      <form class="search" role="search" id="navSearch">
        <label class="sr" for="q"${enAttr("Search games")}>게임 검색</label>
        ${ICON.search}
        <input id="q" type="search" placeholder="게임 이름, 작가로 검색" data-en-ph="Search by title or designer">
      </form>
      <a class="btn-discord" href="/discord" target="_blank" rel="noopener">${ICON.message}<span${enAttr("Discord")}>디스코드</span></a>
      <a class="btn-brand" href="/#/submit"${enAttr("Submit a Game")}>게임 등록하기</a>
      <button class="menu-btn" id="menuBtn" type="button" aria-expanded="false" aria-controls="mobileMenu" aria-label="메뉴 열기">${ICON.menu}</button>
    </div>
  </div>
  <div class="nav-wrap mobile-menu" id="mobileMenu" hidden>
    ${navLinks.join("\n    ")}
    <a href="/discord" target="_blank" rel="noopener"${enAttr("Discord")}>디스코드</a>
    ${lang(" m-lang")}
  </div>
</header>`;
}

function gamePageHtml(g, related) {
  const title = `${g.ko}${g.en ? ` (${g.en})` : ""} · PnP 아카이브 KOREA`;
  const desc =
    g.desc ||
    (g.origin === "해외 번역"
      ? `${g.ko} — ${g.author || "작자 미상"}의 PnP 보드게임 한국어판${g.translator ? `(번역자: ${g.translator})` : ""}.`
      : `${g.ko} — ${g.author || "작자 미상"}의 한국 창작 PnP 보드게임.`);
  const canonical = `${SITE_URL}/game/${g.slug}/`;
  // og:image는 카드용(그리드, 600×450)보다 해상도가 큰 상세용(1200×900)을 우선 사용.
  const image =
    absoluteThumbUrl(g.thumbLarge || g.thumb) || `${SITE_URL}/assets/og-default.png`;
  // 값이 있는 링크만 버튼으로 만듭니다 — 1개면 버튼 1개, 2개면 2개.
  // 맨 앞 버튼이 주 버튼(주황), 나머지는 보조 버튼(테두리)입니다.
  const links = [
    { url: safeHttpUrl(g.url), label: "⬇ 파일 다운로드", en: "⬇ Download files", kind: "download" },
    { url: safeHttpUrl(g.playUrl), label: "▶ 온라인으로 플레이", en: "▶ Play online", kind: "play" },
    { url: safeHttpUrl(g.infoUrl), label: "🔗 원문·게임 정보", en: "🔗 Original post & info", kind: "info" },
  ].filter((l) => l.url);

  const spec = [
    ["인원수", g.players],
    ["플레이타임", g.playtime],
    ["권장연령", g.age],
    ["발표연도", g.year],
    ["언어", (g.lang || []).join(", ")],
    ["테마", (g.theme || []).join(", ")],
    ["메인 메커니즘", (g.mech || []).join(", ")],
    ["공용 기물", (g.components || []).join(", ")],
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&family=Outfit:wght@500;600;700&display=swap">
<style>
/* 사이트(index.html)와 같은 브랜드 토큰 — 골드 메인 + 그린 보조, 커팅 매트 모티프 */
/* 사이트(index.html)와 같은 브랜드 토큰 — 골드 메인 + 그린 보조, 커팅 매트 모티프 */
:root{--bg:#F1F3E8;--surface:#FBFCF5;--surface-2:#E6EBD6;--ink:#1B2410;--muted:#5C6747;--line:#D9DEC8;--brand:#314D03;--brand-mid:#476814;--gold:#F9B365;--gold-hi:#FCC175;--gold-deep:#A85F1A;--on-gold:#26360A;--mat:#2D4708;--mat-line:rgb(243 238 220 / .09);--mat-line-strong:rgb(243 238 220 / .2)}
@media (prefers-color-scheme:dark){:root{--bg:#10160B;--surface:#182112;--surface-2:#222D19;--ink:#ECEFE0;--muted:#A3AD8C;--line:#2C3823;--brand:#9DC45A;--brand-mid:#B5D57E;--gold-deep:#F2A65A;--mat:#1E3205}}
/* 상단 메뉴에서만 쓰는 추가 토큰 (index.html 값) — 아래 본문 색에는 영향 없음 */
:root{--line-strong:#B9C2A0;--ink-soft:#3F4A2B;--brand-hi:#5F8426;--on-brand:#F6F1E2;--nav-bg:rgba(241,243,232,.84)}
@media (prefers-color-scheme:dark){:root{--line-strong:#43532C;--ink-soft:#C6CEB0;--brand-hi:#B3D47A;--on-brand:#14200A;--nav-bg:rgba(16,22,10,.82)}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Noto Sans KR",system-ui,-apple-system,"Malgun Gothic",sans-serif;background:var(--bg);color:var(--ink);line-height:1.7;-webkit-font-smoothing:antialiased;word-break:keep-all}
a{color:inherit}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ic{width:1em;height:1em;display:inline-block;flex:none;vertical-align:-.125em}
/* ---------- 상단 메뉴: index.html의 .nav와 같은 모양 (클래스·수치 그대로) ---------- */
.nav{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;background:var(--nav-bg);backdrop-filter:saturate(160%) blur(14px);-webkit-backdrop-filter:saturate(160%) blur(14px);border-bottom:1px solid var(--line);line-height:1.65}
.nav a{text-decoration:none}
.nav-wrap{max-width:1240px;margin-inline:auto;padding-inline:clamp(16px,4vw,40px)}
.nav-bar{height:68px;display:flex;align-items:center;gap:24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.02em;font-size:17px;white-space:nowrap}
.brand img{width:36px;height:36px;border-radius:50%;display:block}
.links{display:flex;gap:2px}
.links a{padding:8px 12px;border-radius:999px;font-size:15px;font-weight:500;color:var(--ink-soft);white-space:nowrap;transition:background .2s,color .2s}
.links a:hover{background:var(--surface-2);color:var(--ink)}
.links a[aria-current="page"]{color:var(--ink);font-weight:700;background:var(--surface-2)}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.lang{display:inline-flex;height:40px;padding:3px;border-radius:999px;border:1px solid var(--line);background:var(--surface)}
.lang button{min-width:38px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--muted);font:600 13px/1 Outfit,sans-serif;letter-spacing:.04em;cursor:pointer;transition:background .2s,color .2s}
.lang button[aria-pressed="true"]{background:var(--brand);color:var(--on-brand)}
.lang button:not([aria-pressed="true"]):hover{color:var(--ink)}
.search{position:relative;display:flex;align-items:center}
.search .ic{position:absolute;left:14px;color:var(--muted);font-size:16px;pointer-events:none}
.search input{width:200px;height:40px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);padding:0 16px 0 38px;font:inherit;font-size:14px}
.search input::placeholder{color:var(--muted)}
.search input:focus{outline:none;border-color:var(--brand-mid);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand-hi) 25%,transparent)}
.btn-discord{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 16px 0 14px;border-radius:999px;font-size:14px;font-weight:700;white-space:nowrap;background:var(--gold);color:var(--on-gold);border:1px solid var(--gold-deep);transition:background .2s,transform .15s}
.btn-discord:hover{background:var(--gold-hi)}
.btn-discord .ic{font-size:16px}
.btn-brand{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border-radius:999px;font-size:14px;font-weight:700;white-space:nowrap;border:1px solid var(--brand);background:var(--brand);color:var(--on-brand);transition:background .2s,border-color .2s,transform .15s}
.btn-brand:hover{background:var(--brand-mid);border-color:var(--brand-mid)}
.btn-discord:active,.btn-brand:active{transform:scale(.98)}
.menu-btn{display:none;width:40px;height:40px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);align-items:center;justify-content:center;font-size:18px;cursor:pointer}
.mobile-menu{border-top:1px solid var(--line);padding-block:8px 16px}
.mobile-menu a{display:block;padding:12px 4px;font-weight:500;color:var(--ink-soft)}
.mobile-menu a[aria-current="page"]{color:var(--ink);font-weight:700}
.m-lang{display:none}
@media (max-width:1480px){.search{display:none}}
@media (max-width:1060px){.links a{padding:8px 9px;font-size:14px}.brand{font-size:16px}}
@media (max-width:1180px){.nav-bar{gap:14px}.links a{padding:8px 8px;font-size:14px}.brand{font-size:16px}.nav-right .btn-discord,.nav-right .btn-brand{padding:0 13px;font-size:13.5px}}
@media (max-width:1040px){.nav-bar{flex-wrap:wrap;height:auto;padding-block:12px 0;row-gap:6px}.links{order:3;flex-basis:100%;overflow-x:auto;scrollbar-width:none;margin-inline:-6px;padding:0 6px 8px}.links::-webkit-scrollbar{display:none}}
@media (max-width:1720px){html[lang="en"] .search{display:none}}
@media (max-width:1270px){html[lang="en"] .nav-bar{flex-wrap:wrap;height:auto;padding-block:12px 0;row-gap:6px}html[lang="en"] .links{order:3;flex-basis:100%;overflow-x:auto;scrollbar-width:none;margin-inline:-6px;padding:0 6px 8px}}
@media (max-width:640px){.links{-webkit-mask-image:linear-gradient(90deg,#000 82%,transparent);mask-image:linear-gradient(90deg,#000 82%,transparent)}.nav-right .btn-discord{display:none}.nav-bar{column-gap:12px}.menu-btn{display:inline-flex}}
@media (max-width:540px){.nav-right .lang{display:none}.m-lang{display:inline-flex;margin-top:8px}}
@media (max-width:420px){.brand .kr{display:none}}
.hero{position:relative;overflow:hidden;height:360px;display:flex;align-items:center;justify-content:center;max-width:880px;margin:28px auto 0;border-radius:28px;background-color:var(--mat);background-image:linear-gradient(var(--mat-line) 1px,transparent 1px),linear-gradient(90deg,var(--mat-line) 1px,transparent 1px),linear-gradient(var(--mat-line-strong) 1px,transparent 1px),linear-gradient(90deg,var(--mat-line-strong) 1px,transparent 1px);background-size:20px 20px,20px 20px,100px 100px,100px 100px}
.hero-bg{position:absolute;inset:-48px;background-size:cover;background-position:center;filter:blur(34px) brightness(.62) saturate(1.1);transform:scale(1.08)}
.hero-art{position:relative;height:calc(100% - 48px);width:auto;max-width:calc(100% - 48px);object-fit:contain;border-radius:6px;filter:drop-shadow(0 18px 30px rgba(0,0,0,.4))}
.hero-empty{height:220px;font-size:84px}
@media(max-width:920px){.hero{margin:20px 16px 0}}
@media(max-width:600px){.hero{height:250px;border-radius:20px}.hero-empty{height:160px;font-size:60px}}
.wrap{max-width:880px;margin:0 auto;padding:28px 24px 72px}
.crumb{font-size:14px;color:var(--muted);margin-bottom:24px}
.crumb a{color:var(--gold-deep);text-decoration:none;font-weight:700}
h1{font-size:clamp(30px,5vw,46px);font-weight:900;letter-spacing:-.045em;line-height:1.2}
.en{color:var(--muted);font-family:Outfit,"Noto Sans KR",sans-serif;font-weight:600;font-size:17px;margin-top:6px}
.by{margin-top:12px;font-size:15px;color:var(--muted);display:flex;flex-wrap:wrap;align-items:center;gap:4px 0}
.by-tr::before{content:"";display:inline-block;width:1px;height:12px;background:var(--line-strong);margin:0 12px;vertical-align:-1px}
@media(max-width:600px){.by{flex-direction:column;align-items:flex-start}.by-tr::before{display:none}}
.desc{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;margin:28px 0;white-space:pre-wrap}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
th,td{text-align:left;padding:13px 20px;font-size:15px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child th,tr:last-child td{border-bottom:none}
th{width:32%;color:var(--muted);font-weight:500}
.btn{display:inline-block;margin:28px 8px 8px 0;background:var(--gold);color:var(--on-gold);padding:14px 28px;border-radius:999px;font-weight:700;text-decoration:none;box-shadow:0 10px 24px -12px rgb(168 95 26 / .7);transition:background .2s,transform .15s}
.btn:hover{background:var(--gold-hi)}
.btn:active{transform:scale(.98)}
.btn.off{background:var(--surface);color:var(--muted);border:1px solid var(--line);box-shadow:none}
.btn.sub{background:var(--surface);color:var(--ink);border:1.5px solid var(--line);box-shadow:none}
.btn.sub:hover{border-color:var(--brand-mid)}
.takedown-note{margin:8px 0;font-size:12.5px;color:var(--muted)}
.back{display:inline-block;margin-top:28px;color:var(--gold-deep);text-decoration:none;font-weight:700}
.related{margin-top:48px}
.related h2{font-size:21px;font-weight:900;letter-spacing:-.03em;margin-bottom:16px}
.related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media(max-width:600px){.related-grid{grid-template-columns:1fr}}
.related-card{display:block;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:8px;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s}
.related-card:hover{transform:translateY(-3px);box-shadow:0 18px 30px -18px rgb(27 36 16 / .5)}
.related-thumb{aspect-ratio:4/3;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:30px;background-size:cover;background-position:center}
.related-title{padding:10px 6px 4px;font-size:14px;font-weight:700}
footer{margin-top:48px;padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
</style>
</head>
<body>
${siteHeaderHtml(g)}
${heroHtml(g)}
<div class="wrap">
  <div class="crumb"><a href="${escHtml(SITE_URL)}/#/archive"${enAttr("Game Archive")}>게임 아카이브</a> › <span${enAttr(g.en)}>${escHtml(g.ko)}</span></div>
  <h1${enAttr(g.en)}>${escHtml(g.ko)}</h1>
  ${g.en ? `<div class="en"${enAttr(g.ko)}>${escHtml(g.en)}</div>` : ""}
  <div class="by"><span class="by-item"><span${enAttr("Designer")}>작가</span> · <strong${g.author ? "" : enAttr("Unknown")}>${escHtml(g.author || "작자 미상")}</strong></span>${
    g.translator
      ? `<span class="by-item by-tr"><span${enAttr("Translator")}>번역자</span> · <strong>${escHtml(g.translator)}</strong></span>`
      : ""
  }</div>
  ${g.desc ? `<div class="desc">${escHtml(g.desc)}</div>` : ""}
  <table>
    ${spec
      .map(([k, v]) => `<tr><th${enAttr(EN_LABEL[k])}>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`)
      .join("\n    ")}
  </table>
  <div>
    ${
      links.length
        ? links
            .map(
              (l, i) =>
                `<a class="btn${i ? " sub" : ""}" href="${escHtml(l.url)}" rel="noopener noreferrer" data-link-type="${escHtml(l.kind)}" data-game-slug="${escHtml(g.slug)}" data-game-title="${escHtml(g.ko)}"${enAttr(l.en)}>${escHtml(l.label)}</a>`
            )
            .join("\n    ")
        : `<span class="btn off"${enAttr("Download link coming soon")}>다운로드 링크 준비 중</span>`
    }
  </div>
  <div class="takedown-note" data-en-html="🔒 Are you the rights holder of this game? For corrections, takedown requests or other inquiries, please contact &lt;strong&gt;contact@pnparchive.com&lt;/strong&gt;.">🔒 이 게임의 저작권자이신가요? 정보 수정, 게시 중단, 기타 문의 사항은 <strong>contact@pnparchive.com</strong>으로 연락부탁드립니다.</div>
  <div><a class="back" href="${escHtml(SITE_URL)}/#/archive"${enAttr("← Browse more games in the archive")}>← 아카이브에서 다른 게임 보기</a></div>
  ${
    related.length
      ? `<div class="related">
    <h2${enAttr("You might also like")}>이런 게임은 어때요?</h2>
    <div class="related-grid">
      ${related
        .map(
          (r) => `<a class="related-card" href="${escHtml(SITE_URL)}/game/${escHtml(r.slug)}/">
        <div class="related-thumb" style="${
          r.thumb
            ? `background-image:url('${escHtml(r.thumb)}')`
            : `background:${r.grad || "linear-gradient(135deg,#2E3A4E,#5B6E8C)"}`
        }">${r.thumb ? "" : escHtml(r.icon || "🎲")}</div>
        <div class="related-title"${enAttr(r.en)}>${escHtml(r.ko)}</div>
      </a>`
        )
        .join("\n      ")}
    </div>
  </div>`
      : ""
  }
  <footer${enAttr("© 2026 PnP Archive KOREA · All rights to each game belong to its creator. Listings are non-exclusive, and creators may request removal at any time. Submitting games that infringe third-party copyrights, and bulk collecting or redistributing information from this site, are prohibited.")}>© 2026 PnP 아카이브 KOREA · 모든 게임의 권리는 각 창작자에게 있습니다. 등록은 비독점적이며, 창작자는 언제든지 게시 중단을 요청할 수 있습니다. 제3자의 저작권 등을 침해하는 게임 등록, 본 사이트 제공 정보를 대량 수집 및 재배포하는 행위를 금지합니다.</footer>
</div>
<script>
/* 상단 메뉴 동작 — 모바일 메뉴 열기, 검색(아카이브로 이동), KO/EN 전환.
   언어 선택은 메인 사이트와 같은 키(pnp-lang)에 저장해 페이지를 오가도 유지됩니다.
   영어로 보면 메뉴·항목 이름·버튼과 게임 제목(영문 제목이 있을 때)만 바뀌고,
   소개 글·태그 값 등 Notion 데이터는 한국어 그대로입니다. */
(function(){
  var LANG = "ko";
  try { if (localStorage.getItem("pnp-lang") === "en") LANG = "en"; } catch (e) {}
  var KO = new Map();
  function apply(){
    document.documentElement.lang = LANG;
    document.querySelectorAll("[data-en]").forEach(function(el){
      if (!KO.has(el)) KO.set(el, el.textContent);
      el.textContent = LANG === "en" ? el.getAttribute("data-en") : KO.get(el);
    });
    document.querySelectorAll("[data-en-html]").forEach(function(el){
      if (!KO.has(el)) KO.set(el, el.innerHTML);
      el.innerHTML = LANG === "en" ? el.getAttribute("data-en-html") : KO.get(el);
    });
    document.querySelectorAll("[data-en-ph]").forEach(function(el){
      if (!KO.has(el)) KO.set(el, el.placeholder);
      el.placeholder = LANG === "en" ? el.getAttribute("data-en-ph") : KO.get(el);
    });
    document.querySelectorAll(".lang button").forEach(function(b){
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === LANG));
    });
  }
  document.querySelectorAll(".lang button").forEach(function(b){
    b.addEventListener("click", function(){
      var l = b.getAttribute("data-lang");
      if (l === LANG) return;
      LANG = l; try { localStorage.setItem("pnp-lang", l); } catch (e) {}
      apply();
    });
  });
  if (LANG === "en") apply();

  var btn = document.getElementById("menuBtn"), mm = document.getElementById("mobileMenu");
  btn.addEventListener("click", function(){
    var open = mm.hidden; mm.hidden = !open; btn.setAttribute("aria-expanded", String(open));
  });

  document.getElementById("navSearch").addEventListener("submit", function(e){
    e.preventDefault();
    var q = document.getElementById("q").value.trim();
    location.href = "/#/archive" + (q ? "?q=" + encodeURIComponent(q) : "");
  });

  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href="/discord"]') : null;
    if (a && typeof gtag === "function") gtag("event", "discord_click", { link_location: "nav", transport_type: "beacon" });
  }, true);
})();
</script>
<script>
/* GA4 — 링크 버튼 클릭 집계. 화면에는 아무 변화도 없습니다.
   같은 탭에서 이동해도 유실되지 않도록 beacon 전송을 사용합니다. */
document.addEventListener("click", function(e){
  var t = e.target;
  var a = t && t.closest ? t.closest("a[data-link-type]") : null;
  if(!a || typeof gtag !== "function") return;
  gtag("event", "download_click", {
    link_type:  a.getAttribute("data-link-type") || "",
    game_slug:  a.getAttribute("data-game-slug") || "",
    game_title: (a.getAttribute("data-game-title") || "").slice(0, 100),
    link_url:   (a.getAttribute("href") || "").slice(0, 100),
    transport_type: "beacon"
  });
}, true);
</script>
</body>
</html>
`;
}

async function writeStaticSEO(games) {
  // 삭제된 게임의 페이지가 남지 않도록 game/ 디렉터리를 매번 새로 만듭니다.
  await rm(join(ROOT, "game"), { recursive: true, force: true });
  await loadLogo();

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
// 썸네일 처리 — 각 게임의 grid/detail 이미지를 만들어 g.thumb/g.thumbLarge를 채운다.
// 실패해도(다운로드 오류, PDF 파싱 실패 등) 절대 build 전체를 중단시키지 않는다 —
// 실패한 게임은 그냥 기존 그라디언트 대체 카드로 남는다(g.thumb=null 그대로).
// ─────────────────────────────────────────────
async function processThumbnails(games) {
  await mkdir(THUMB_DIR, { recursive: true });

  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(THUMB_MANIFEST_PATH, "utf8"));
  } catch {
    manifest = {};
  }

  let made = 0;
  let skipped = 0;
  let failed = 0;

  for (const g of games) {
    // 이미 같은 updatedAt으로 처리된 파일이 남아 있으면 다시 다운로드하지 않는다.
    // (Notion·외부 호스트에 매시간 불필요하게 요청하지 않기 위한 캐시.)
    if (await isFresh(g.slug, THUMB_DIR, g.updatedAt, manifest)) {
      g.thumb = `${THUMB_URL_PREFIX}/${g.slug}-grid.webp`;
      g.thumbLarge = `${THUMB_URL_PREFIX}/${g.slug}-detail.webp`;
      g.thumbRaw = `${THUMB_URL_PREFIX}/${g.slug}-raw.webp`;
      skipped++;
      continue;
    }

    const result = await buildThumbnails({
      slug: g.slug,
      imageUrl: g.thumbSourceUrl,
      // 주의: g.url("파일 다운로드 주소")이 아니라 g.pdfSourceUrl("PDF 원본
      // 파일" Notion File 속성)을 써야 한다 — g.url은 boardlife.co.kr 게시글
      // 링크라 PDF로 바로 fetch되지 않는다.
      pdfUrl: g.pdfSourceUrl,
      outDir: THUMB_DIR,
    });

    if (result) {
      g.thumb = `${THUMB_URL_PREFIX}/${g.slug}-grid.webp`;
      g.thumbLarge = `${THUMB_URL_PREFIX}/${g.slug}-detail.webp`;
      g.thumbRaw = `${THUMB_URL_PREFIX}/${g.slug}-raw.webp`;
      manifest[g.slug] = { updatedAt: g.updatedAt, source: result.source };
      made++;

      // 운영자 검토 단계 연동 — PDF 자동 추출(사람이 안 고른 이미지)이면
      // Notion의 "썸네일 검토 필요" 체크박스를 세운다. 창작자가 직접 올린
      // 이미지라면 반대로 내린다(다시 검토할 필요가 없다는 뜻).
      await setReviewFlag(g.notionPageId, result.source === "pdf", { token: TOKEN });
    } else {
      // 이 게임은 처리 실패 — g.thumb는 null로 남고 그라디언트 카드로 폴백.
      // 보여줄 썸네일 자체가 없으니 검토 플래그도 내려둔다.
      delete manifest[g.slug];
      await setReviewFlag(g.notionPageId, false, { token: TOKEN });
      failed++;
    }
  }

  await writeFile(THUMB_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  await pruneOrphanedThumbnails(games, manifest);
  await writeReviewQueue(games, manifest);

  console.log(
    `✓ 썸네일 처리 완료 — 신규/갱신 ${made}건, 캐시 재사용 ${skipped}건, 실패(대체 카드) ${failed}건`
  );
}

// ─────────────────────────────────────────────
// 운영자 검토 큐 — Notion API 쓰기 권한(Update content) 없이도 항상 동작한다.
//
// 위의 setReviewFlag()는 Notion 체크박스를 되쓰는 "있으면 편한" 보조 수단일
// 뿐이고, 이 함수가 만드는 review-queue.json이 실제 운영에 필요한 원본이다.
// PDF에서 자동 추출된(=사람이 안 고른) 썸네일을 가진 게임만 골라 파일로
// 내보내고, repo 루트의 review.html이 이 파일을 읽어 화면에 그린다.
//
// 매시간 games/manifest를 기준으로 통째로 다시 계산하므로(캐시로 스킵된
// 게임도 manifest[slug].source로 판단), 운영자가 Notion에서 썸네일 이미지를
// 올려 source가 'upload'로 바뀌면 다음 동기화 때 이 목록에서 자동으로
// 빠진다 — 별도의 "완료 체크" 조작이 필요 없다.
// ─────────────────────────────────────────────
async function writeReviewQueue(games, manifest) {
  const items = games
    .filter((g) => manifest[g.slug]?.source === "pdf")
    .map((g) => ({
      slug: g.slug,
      title: g.ko,
      titleEn: g.en || "",
      author: g.author,
      thumb: `${THUMB_URL_PREFIX}/${g.slug}-grid.webp`,
      pageUrl: `${SITE_URL}/game/${g.slug}/`,
      // 대시 없는 페이지 ID로 만든 주소 — 로그인된 브라우저에서는 워크스페이스
      // 이름 없이도 정상적으로 해당 페이지로 리다이렉트된다.
      notionUrl: g.notionPageId
        ? `https://www.notion.so/${g.notionPageId.replace(/-/g, "")}`
        : null,
    }));

  await writeFile(
    join(ROOT, "review-queue.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: items.length, items },
      null,
      2
    ),
    "utf8"
  );
  console.log(`  · 운영자 검토 큐 갱신 — review-queue.json (검토 대상 ${items.length}건)`);
}

// 반려·삭제 등으로 더 이상 게시되지 않는 게임의 썸네일 파일을 정리한다.
// (안 그러면 assets/thumbs가 계속 늘어나기만 함 — 리포 용량 관리 차원.)
async function pruneOrphanedThumbnails(games, manifest) {
  const activeSlugs = new Set(games.map((g) => g.slug));
  let files;
  try {
    files = await readdir(THUMB_DIR);
  } catch {
    return;
  }
  let removed = 0;
  for (const file of files) {
    if (file === ".manifest.json") continue;
    const slug = file.replace(/-(grid|detail|raw)\.webp$/, "");
    if (!activeSlugs.has(slug)) {
      await rm(join(THUMB_DIR, file), { force: true });
      removed++;
    }
  }
  if (removed) console.log(`  · 게시 중단된 게임의 썸네일 파일 ${removed}개 정리`);
}

// ─────────────────────────────────────────────
// 게시일(publishedAt) — 홈 '최근 일주일 동안 새로 들어온 게임'의 기준
//
// Notion API로는 '검토상태가 게시완료로 바뀐 시각'을 읽을 수 없어서,
// 직전에 커밋된 games.json과 비교해 "처음 사이트에 올라간 시각"을 정한다.
//  - 직전 games.json에 이미 있던 게임 → 그때 기록된 publishedAt을 그대로 유지
//    (publishedAt 필드가 생기기 전 데이터라 값이 없으면 createdAt으로 한 번 채운다)
//  - 직전 games.json에 없던 게임(이번에 새로 게시완료) → 이번 빌드 시각.
//    동기화가 매시 정각이라 실제로 게시완료로 바꾼 뒤 최대 약 1시간 늦게 찍힌다.
//    게시를 내렸다가 다시 올리면 다시 올린 시각이 새 게시일이 된다.
//  - games.json을 읽지 못하면(최초 빌드 등) 모두 createdAt으로 채운다.
// 운영자가 따로 입력할 것은 없고, games.json이 매번 커밋되므로 별도 파일도 필요 없다.
// ─────────────────────────────────────────────
async function loadPrevPublished() {
  try {
    const prev = JSON.parse(await readFile(join(ROOT, "games.json"), "utf8"));
    const map = new Map();
    for (const g of prev.games || []) map.set(g.id, g.publishedAt || g.createdAt || null);
    return map;
  } catch {
    return null;
  }
}

function assignPublishedAt(games, prevPublished, buildTime) {
  let fresh = 0;
  for (const g of games) {
    if (!prevPublished) {
      g.publishedAt = g.createdAt;
    } else if (prevPublished.has(g.id)) {
      g.publishedAt = prevPublished.get(g.id) || g.createdAt;
    } else {
      g.publishedAt = buildTime;
      fresh++;
    }
  }
  return fresh;
}

// ─────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────
async function main() {
  console.log("→ Notion에서 데이터를 가져오는 중…");
  const pages = await fetchAllPages();
  console.log(`  ${pages.length}건 수신 (검토상태=${PUBLISH_STATUS})`);

  const games = pages.map(transform).filter(Boolean);

  // 게시일 기록 후 최신 게시순 정렬(같으면 최신 등록순)
  const prevPublished = await loadPrevPublished();
  const freshCount = assignPublishedAt(games, prevPublished, new Date().toISOString());
  console.log(
    prevPublished
      ? `  새로 게시된 게임 ${freshCount}건 (게시일 = 이번 동기화 시각)`
      : "  직전 games.json 없음 — 게시일을 등록일(createdAt)로 채움"
  );
  games.sort(
    (a, b) =>
      new Date(b.publishedAt) - new Date(a.publishedAt) ||
      new Date(b.createdAt) - new Date(a.createdAt)
  );

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

  await processThumbnails(games);

  // 내부 처리용 필드는 games.json에 내보내지 않습니다(제출자 이메일 등과 같은 원칙).
  // 특히 thumbSourceUrl은 Notion의 임시 서명 URL일 수 있어 그대로 노출하면 안 됩니다.
  for (const g of games) {
    delete g.thumbSourceUrl;
    delete g.pdfSourceUrl;
    delete g.notionPageId;
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
    components: uniq(games.flatMap((g) => g.components)),
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
