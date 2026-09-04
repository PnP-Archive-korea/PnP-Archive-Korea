/**
 * 썸네일 소싱·정규화 파이프라인
 *
 * 목적
 * ----
 * 창작자가 무엇을 올리든(크기·비율·해상도 제각각) 사이트에는 항상 같은 규격의
 * 파일만 나가도록 만든다. "원본이 제각각이라 화면에서 깨진다"는 문제는 원본을
 * 그대로 서빙할 때만 생기는데, 이 모듈을 거치면 원본은 절대 그대로 서빙되지 않는다.
 *
 * 출력 규격 (assets/thumbs/<slug>-{grid,detail}.webp)
 * ----------------------------------------------------
 *   grid   600×450  (4:3) — 아카이브/홈 그리드 카드, 상세페이지 "관련 게임" 미니카드
 *   detail 1200×900 (4:3) — SPA 상세 히어로 + og:image/twitter:image 겸용
 *   raw    원본 비율 유지, 긴 변 최대 1200 — 정적 게임 페이지의 히어로 밴드용
 *
 * 두 크기 다 4:3인 이유: index.html의 .thumb / .detail-thumb 카드가 이미
 * `aspect-ratio:4/3; background-size:cover`로 고정돼 있다. 서버에서 만드는
 * 파일 자체를 4:3으로 딱 맞춰두면, 브라우저의 cover는 사실상 "그대로 표시"가
 * 되고 실제로는 아무것도 잘리지 않는다 — 크롭 여부를 브라우저의 무작위 판단이
 * 아니라 여기서 결정하겠다는 뜻.
 *
 * 소스 구분 없이 같은 처리 방식을 쓴다 — contain(전체 보존) + 블러 배경 채움
 * ---------------------------------------------------------------------
 * 원래는 창작자 업로드는 contain, PDF 1페이지 렌더링은 cover+상단크롭으로
 * 나눠서 처리했었다("PDF는 보통 세로로 긴 A4라 contain으로 넣으면 좌우
 * 여백만 남는다"는 추측 때문). 그런데 2026-08-31 밤, 사용자가 제출한 실제
 * PnP 룰북 PDF(A4 세로형 표지 페이지, 제목+아이콘+제작자 표기가 페이지
 * 중앙~하단에 퍼져 있는 전형적인 레이아웃)로 두 방식을 직접 렌더링해서
 * 비교해봤더니 예상이 틀렸다:
 *   - cover+상단크롭: 페이지 상단의 빈 여백만 크게 잡히고, 정작 제목 밑에
 *     있던 인원/시간/연령 아이콘 줄은 카드 맨 아래에서 어중간하게 잘려
 *     마치 렌더링이 깨진 것처럼 보였다.
 *   - contain+블러배경: 제목·아이콘·제작자 표기가 전부 온전히 들어가고,
 *     좌우 여백은 블러 처리된 배경으로 자연스럽게 채워져 훨씬 완성도 있는
 *     카드가 나왔다.
 * "제목/타이틀 아트가 페이지 상단에 있다"는 가정 자체가 실제 PnP 룰북
 * (특히 Word/한글로 만든 표지)에는 잘 안 맞았던 것 — 내용이 페이지
 * 중앙~하단까지 퍼져 있는 경우가 많다. 그래서 소스 구분 없이 항상
 * renderContainPadded() 하나만 쓰도록 통일했다. (표본이 1건뿐이라 모든
 * PDF에 대한 결론은 아니지만, "상단 크롭이 항상 안전하다"는 가정이
 * 깨졌으니 더 안전한 쪽인 contain을 기본값으로 삼는다.)
 *
 * 최소 해상도 가드
 * -----------------
 * 원본의 긴 변이 MIN_SOURCE_EDGE보다 작으면 확대하지 않고 실패 처리한다(호출
 * 쪽에서 그라디언트 대체 카드로 폴백). 뿌옇게 늘린 이미지보다 지금의 깔끔한
 * 대체 카드가 낫다는 원칙.
 *
 * 검증 상태 — sharp/pdf-to-img 자체(제어 흐름)는 가짜 모듈로, 그리고
 * "contain vs cover+top" 렌더링 결과는 poppler(pdftoppm)+Python PIL로 실제
 * PDF에 대해 검증했다(둘 다 이 세션에서 npm install이 막혀 있어 sharp를
 * 직접 실행하지는 못했지만, 리사이즈 로직 자체는 동일 알고리즘). 병합 전에
 * `npm install && NOTION_TOKEN=... node scripts/build.mjs`를 실제로 한 번
 * 돌려보는 걸 권장한다.
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const SIZES = {
  grid: { width: 600, height: 450 },
  detail: { width: 1200, height: 900 },
};

// raw — 여백을 굽지 않은 "원본 비율 그대로" 판본. 정적 게임 페이지(/game/<slug>/)의
// 히어로 밴드가 쓴다: 흐리게 확대한 배경 위에 표지를 통째로 얹는 배치라, 이미 4:3
// 캔버스에 블러 여백까지 구워둔 grid/detail을 그대로 얹으면 블러 바가 두 겹으로
// 겹쳐 보인다. 그래서 "비율은 원본 그대로, 긴 변만 제한"하는 판본을 하나 더 만든다.
// og:image와 그리드 카드는 지금처럼 4:3 고정 판본(detail/grid)을 계속 쓴다.
const RAW_MAX_EDGE = 1200;

const MIN_SOURCE_EDGE = 500; // 이보다 작은 원본은 확대하지 않고 폴백
const FETCH_TIMEOUT_MS = 20_000;

// ─────────────────────────────────────────────
// 원본 다운로드
// ─────────────────────────────────────────────
async function fetchBuffer(url, { expectContentType } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (expectContentType && !contentType.includes(expectContentType)) {
      throw new Error(
        `기대한 파일 형식이 아님 (content-type: ${contentType || "알 수 없음"})`
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, contentType };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// contain + 블러 배경 (창작자 업로드 이미지 / PDF 1페이지 렌더링 공통)
// ─────────────────────────────────────────────
async function renderContainPadded(srcBuf, { width, height }) {
  const meta = await sharp(srcBuf).metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (longEdge < MIN_SOURCE_EDGE) {
    throw new Error(`원본 해상도가 너무 작음 (${meta.width}×${meta.height})`);
  }

  // 배경 — 원본을 캔버스 전체 채우기(cover)로 깔고 블러+살짝 어둡게.
  const background = await sharp(srcBuf)
    .resize(width, height, { fit: "cover", position: "attention" })
    .blur(28)
    .modulate({ brightness: 0.75 })
    .toBuffer();

  // 전경 — 원본 전체를 잘리지 않게(contain) 캔버스 안에 배치.
  const foreground = await sharp(srcBuf)
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground }])
    .webp({ quality: 82 })
    .toBuffer();
}

// ─────────────────────────────────────────────
// raw — 원본 비율 유지, 긴 변만 RAW_MAX_EDGE로 제한 (확대는 하지 않음)
// ─────────────────────────────────────────────
async function renderRaw(srcBuf) {
  const meta = await sharp(srcBuf).metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (longEdge < MIN_SOURCE_EDGE) {
    throw new Error(`원본 해상도가 너무 작음 (${meta.width}×${meta.height})`);
  }
  return sharp(srcBuf)
    .resize(RAW_MAX_EDGE, RAW_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

// ─────────────────────────────────────────────
// PDF 1페이지를 래스터 이미지로 변환
// 동적 import — 이 모듈이 없어도(설치 실패해도) 나머지 파이프라인은 죽지 않게.
// ─────────────────────────────────────────────
async function renderPdfFirstPageToPng(pdfBuf) {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(pdfBuf, { scale: 2.5 }); // 카드 해상도에 여유 있게 렌더링
  for await (const page of doc) {
    return page; // 첫 페이지 PNG 버퍼만 사용
  }
  throw new Error("PDF에 페이지가 없음");
}

// ─────────────────────────────────────────────
// 공개 API — 게임 1건의 grid/detail 썸네일을 만든다.
// 우선순위: 창작자 업로드 이미지 → PDF 1페이지 자동 추출 → (둘 다 실패) null
// null이면 호출 쪽(build.mjs)이 기존 그라디언트 카드로 자연스럽게 폴백한다.
// ─────────────────────────────────────────────
export async function buildThumbnails({ slug, imageUrl, pdfUrl, outDir, log = console.log }) {
  await mkdir(outDir, { recursive: true });

  // 1순위 — 창작자가 올린 이미지. source:'upload'는 사람이 직접 고른 이미지라는
  // 뜻이라 "검토 필요" 플래그를 세우지 않는다(호출 쪽 build.mjs 참고).
  if (imageUrl) {
    try {
      const { buf, contentType } = await fetchBuffer(imageUrl);
      if (!contentType.startsWith("image/")) {
        throw new Error(`이미지가 아님 (content-type: ${contentType || "알 수 없음"})`);
      }
      const paths = await writeVariants(slug, buf, renderContainPadded, outDir);
      return { ...paths, source: "upload" };
    } catch (e) {
      log(`  ⚠ [${slug}] 업로드 이미지 처리 실패 → PDF 추출로 대체: ${e.message}`);
    }
  }

  // 2순위 — 게임 PDF의 1페이지. source:'pdf'는 휴리스틱 추출 결과라 품질이
  // 들쭉날쭉할 수 있으므로, 호출 쪽에서 "썸네일 검토 필요" 플래그를 세운다.
  if (pdfUrl) {
    try {
      const { buf } = await fetchBuffer(pdfUrl, { expectContentType: "pdf" });
      const pageImage = await renderPdfFirstPageToPng(buf);
      const paths = await writeVariants(slug, pageImage, renderContainPadded, outDir);
      return { ...paths, source: "pdf" };
    } catch (e) {
      log(`  ⚠ [${slug}] PDF 자동 추출 실패 → 대체 카드 사용: ${e.message}`);
    }
  }

  // 3순위 — 실패. 호출 쪽이 그라디언트 카드를 쓴다.
  return null;
}

async function writeVariants(slug, srcBuf, renderFn, outDir) {
  const gridBuf = await renderFn(srcBuf, SIZES.grid);
  const detailBuf = await renderFn(srcBuf, SIZES.detail);
  const rawBuf = await renderRaw(srcBuf);
  const gridPath = join(outDir, `${slug}-grid.webp`);
  const detailPath = join(outDir, `${slug}-detail.webp`);
  const rawPath = join(outDir, `${slug}-raw.webp`);
  await writeFile(gridPath, gridBuf);
  await writeFile(detailPath, detailBuf);
  await writeFile(rawPath, rawBuf);
  return { gridPath, detailPath, rawPath };
}

// ─────────────────────────────────────────────
// 운영자 검토 단계 연동 (보조 수단) — Notion의 "썸네일 검토 필요" 체크박스를
// 갱신한다.
//
// 규칙: PDF 자동 추출 결과는 사람이 고른 게 아니므로 체크박스를 true로 세워
// 운영자가 Notion의 "썸네일 검토 대기" 뷰에서 한눈에 찾아볼 수 있게 한다.
// 창작자 업로드 이미지는 이미 사람이 고른 것이므로 false로 내린다. 캐시로
// 스킵된 게임(내용이 안 바뀐 게임)은 아예 건드리지 않는다 — 운영자가 이미
// 검토하고 체크를 해제해둔 걸 스크립트가 다시 체크하는 걸 막기 위함이다.
//
// 이 API를 쓰려면 NOTION_TOKEN을 발급한 Integration에 이 데이터베이스에 대한
// "콘텐츠 업데이트" 권한이 있어야 한다(Notion 설정 → 해당 데이터베이스 우측
// 상단 ··· → Connections → 이 Integration → my-integrations의 Capabilities
// 탭에서 "Update content" 켜기). 이 권한은 워크스페이스 요금제와 무관하게
// 모든 플랜에서 제공되는 표준 API 기능이지만, 워크스페이스 소유자만 바꿀 수
// 있거나 다른 이유로 막혀 있을 수 있다.
//
// 권한이 없어도 무방하다 — 이건 어디까지나 "있으면 편한" 보조 수단이고,
// 실제 운영에 필요한 검토 큐는 build.mjs의 writeReviewQueue()가 만드는
// review-queue.json(→ review.html)이 Notion 쓰기 권한과 무관하게 담당한다.
// 권한이 없으면 첫 실패에서 경고 한 번만 남기고 이후 이번 실행에서는 더
// 시도하지 않는다 — build 전체를 막지 않기 위함.
// ─────────────────────────────────────────────
let reviewFlagWriteDisabled = false;

export async function setReviewFlag(pageId, needsReview, { token, log = console.log } = {}) {
  if (!pageId || !token || reviewFlagWriteDisabled) return;
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { "썸네일 검토 필요": { checkbox: needsReview } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    reviewFlagWriteDisabled = true;
    log(
      `  ⚠ "썸네일 검토 필요" 체크박스 갱신 실패 — 이후로는 시도하지 않습니다. ` +
        `Notion Integration에 이 데이터베이스 콘텐츠 업데이트 권한이 있는지 확인하세요. (${e.message})`
    );
  }
}

// ─────────────────────────────────────────────
// 캐시 확인 — 이미 처리된 게임을 매시간 다시 다운로드하지 않기 위한 헬퍼.
// updatedAt(Notion last_edited_time)이 마지막 처리 시점보다 새롭지 않고
// 결과 파일 두 개가 이미 존재하면 스킵해도 안전하다고 판단한다.
// ─────────────────────────────────────────────
export async function isFresh(slug, outDir, updatedAt, manifest) {
  const recorded = manifest[slug];
  if (!recorded || recorded.updatedAt !== updatedAt) return false;
  try {
    await stat(join(outDir, `${slug}-grid.webp`));
    await stat(join(outDir, `${slug}-detail.webp`));
    // raw는 2026-09-04에 추가된 판본이라, 그 전에 만들어진 게임은 이 파일이
    // 없다. 없으면 fresh가 아니라고 판단해 한 번만 다시 굽게 한다.
    await stat(join(outDir, `${slug}-raw.webp`));
    return true;
  } catch {
    return false;
  }
}
