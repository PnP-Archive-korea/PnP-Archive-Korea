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
 *   detail 1200×900 (4:3) — 상세페이지 히어로 이미지 + og:image/twitter:image 겸용
 *
 * 두 크기 다 4:3인 이유: index.html의 .thumb / .detail-thumb 카드가 이미
 * `aspect-ratio:4/3; background-size:cover`로 고정돼 있다. 서버에서 만드는
 * 파일 자체를 4:3으로 딱 맞춰두면, 브라우저의 cover는 사실상 "그대로 표시"가
 * 되고 실제로는 아무것도 잘리지 않는다 — 크롭 여부를 브라우저의 무작위 판단이
 * 아니라 여기서 결정하겠다는 뜻.
 *
 * 소스별로 다른 처리 방식을 쓴다
 * ------------------------------
 *   창작자 업로드 이미지 → contain(전체 보존) + 블러 배경 채움.
 *     원본이 어떤 비율이든 내용을 절대 자르지 않는다. 사람이 매번 크롭 위치를
 *     확인할 수 없는 자동 파이프라인이라 "잘못 잘리는 사고"보다 "여백이 좀
 *     있는 카드"가 안전하다.
 *   PDF 1페이지 렌더링 → cover(꽉 채워 크롭) + 상단 정렬(gravity: north).
 *     PDF 1페이지는 보통 세로로 긴 A4/Letter라 contain으로 넣으면 좌우로 큰
 *     여백만 남고 정작 페이지는 작게 쪼그라든다. 대부분 제목/타이틀 아트가
 *     페이지 상단에 있으므로, 위쪽을 기준으로 꽉 채워 자르는 쪽이 실제로
 *     더 알아볼 수 있는 카드가 된다.
 *
 * 최소 해상도 가드
 * -----------------
 * 원본의 긴 변이 MIN_SOURCE_EDGE보다 작으면 확대하지 않고 실패 처리한다(호출
 * 쪽에서 그라디언트 대체 카드로 폴백). 뿌옇게 늘린 이미지보다 지금의 깔끔한
 * 대체 카드가 낫다는 원칙.
 *
 * 주의 — 이 세션은 npm 레지스트리에 접근할 수 없어 아래 코드를 실제로
 * `npm install` 해서 실행 테스트하지 못했다. sharp / pdf-to-img API 자체는
 * 공식 문서 기준으로 정확하나, 병합 전에 반드시 한 번은 실제로 돌려봐야 한다
 * (README의 "테스트 방법" 참고).
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const SIZES = {
  grid: { width: 600, height: 450 },
  detail: { width: 1200, height: 900 },
};

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
// 창작자 업로드 이미지 → contain + 블러 배경
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
// PDF 1페이지 렌더링 → cover + 상단 정렬
// ─────────────────────────────────────────────
async function renderCoverTop(srcBuf, { width, height }) {
  const meta = await sharp(srcBuf).metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (longEdge < MIN_SOURCE_EDGE) {
    throw new Error(`원본 해상도가 너무 작음 (${meta.width}×${meta.height})`);
  }
  return sharp(srcBuf)
    .resize(width, height, { fit: "cover", position: "top" })
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

  // 1순위 — 창작자가 올린 이미지
  if (imageUrl) {
    try {
      const { buf, contentType } = await fetchBuffer(imageUrl);
      if (!contentType.startsWith("image/")) {
        throw new Error(`이미지가 아님 (content-type: ${contentType || "알 수 없음"})`);
      }
      return await writeVariants(slug, buf, renderContainPadded, outDir);
    } catch (e) {
      log(`  ⚠ [${slug}] 업로드 이미지 처리 실패 → PDF 추출로 대체: ${e.message}`);
    }
  }

  // 2순위 — 게임 PDF의 1페이지
  if (pdfUrl) {
    try {
      const { buf } = await fetchBuffer(pdfUrl, { expectContentType: "pdf" });
      const pageImage = await renderPdfFirstPageToPng(buf);
      return await writeVariants(slug, pageImage, renderCoverTop, outDir);
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
  const gridPath = join(outDir, `${slug}-grid.webp`);
  const detailPath = join(outDir, `${slug}-detail.webp`);
  await writeFile(gridPath, gridBuf);
  await writeFile(detailPath, detailBuf);
  return { gridPath, detailPath };
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
    return true;
  } catch {
    return false;
  }
}
