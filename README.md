# PnP 아카이브 KOREA — 설치 가이드

Notion 데이터베이스를 그대로 백엔드로 쓰는 정적 웹사이트입니다.
GitHub Actions가 1시간마다 Notion에서 데이터를 가져와 `games.json`으로 만들고, 사이트는 그 파일을 읽습니다.

```
Notion DB ──(GitHub Actions, 1시간마다)──> games.json ──> index.html
```

**비용 $0 · 서버 없음 · API 토큰은 브라우저에 절대 노출되지 않음**

---

## 파일 구성

| 파일 | 설명 | 손댈 일 |
|---|---|---|
| `index.html` | 사이트 전체 (5페이지) | 폼 주소만 |
| `games.json` | Notion에서 뽑아낸 데이터 | ❌ 자동 생성 |
| `scripts/build.mjs` | Notion → JSON 변환 + 정적 SEO 생성 | ❌ |
| `.github/workflows/sync-notion.yml` | 1시간마다 자동 실행 | ❌ |
| `assets/og-default.png` | 기본 공유 미리보기 이미지 (1200×630) | 바꾸고 싶을 때만 |
| `sitemap.xml`, `robots.txt`, `game/*/` | 검색·공유용 정적 페이지 | ❌ 자동 생성 |

> 지금 들어 있는 `games.json`은 실제 Notion 데이터로 만든 **미리보기 샘플(16건)** 입니다. Actions가 처음 돌면 최신 데이터로 교체됩니다.

---

## 1단계 · Notion 통합(Integration) 만들기

1. https://www.notion.so/profile/integrations 접속
2. **New integration** 클릭
3. 이름: `PnP Archive Site`, 연결할 워크스페이스 선택
4. Capabilities는 **Read content**만 켜면 충분합니다 (안전)
5. 생성 후 **Internal Integration Secret** 복사 → `ntn_` 으로 시작하는 문자열

> ⚠️ 이 값은 비밀번호입니다. 채팅·문서·코드에 붙여넣지 마세요.

## 2단계 · DB에 통합 연결하기 (가장 많이 빠뜨리는 단계)

1. Notion에서 **PnP 게임 아카이브** 데이터베이스 페이지 열기
2. 우측 상단 `···` → **연결(Connections)** → **연결 추가**
3. 방금 만든 `PnP Archive Site` 선택

이걸 안 하면 API가 `object_not_found` 오류를 냅니다. Softr가 안 되던 원인도 대부분 여기입니다.

## 3단계 · GitHub 저장소 만들고 올리기

1. GitHub에서 새 저장소 생성 (Public/Private 무관, **Public이면 GitHub Pages 무료**)
2. 이 폴더의 파일 전부를 업로드
   - 웹에서 하려면: `Add file` → `Upload files` → 폴더째 드래그
   - **주의**: `.github` 폴더는 웹 드래그로 안 올라갈 수 있습니다. 그 경우 GitHub 웹에서 `Add file → Create new file`로 경로에 `.github/workflows/sync-notion.yml` 을 직접 입력해 붙여넣으세요.

## 4단계 · 토큰을 GitHub Secret에 등록

저장소 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Name | Value |
|---|---|
| `NOTION_TOKEN` | 1단계에서 복사한 `ntn_...` |
| `NOTION_DATABASE_ID` | `edc7c616d3e948b79780d48e4d211987` |

## 5단계 · 첫 동기화 실행

저장소 → **Actions** 탭 → 좌측 **Notion 동기화** → **Run workflow** 버튼

- 초록 체크 ✅ → `games.json`이 갱신되고 자동 커밋됩니다
- 빨간 X ❌ → 로그를 열어 오류 메시지 확인 (아래 문제 해결 참고)

## 6단계 · 배포

셋 중 아무거나 고르세요. 전부 무료입니다.

**A. GitHub Pages** (가장 간단)
Settings → Pages → Source: `Deploy from a branch` → `main` / `/ (root)` → Save
→ `https://아이디.github.io/저장소이름/`

**B. Vercel** (커스텀 도메인 편함)
vercel.com → Add New Project → 저장소 선택 → 설정 없이 Deploy

**C. Netlify**
netlify.com → Add new site → Import an existing project → 저장소 선택

## 7단계 · 제출 폼 연결

`index.html` 상단의 설정 부분을 열어

```js
const NOTION_FORM_URL = "";
```

여기에 Notion 폼("PNP 게임 아카이브 설문 조사")의 **공개 공유 링크**를 넣으세요.
넣는 순간 등록 페이지에 폼이 그대로 임베드됩니다.

---

## 운영 방법

**새 게임 등록**
창작자가 Notion 폼 제출 → `검토상태 = 검토중` → 검토 후 **게시완료**로 변경 → 최대 1시간 내 사이트 반영
(급하면 Actions 탭에서 Run workflow로 즉시 반영)

**게시 내리기**
`검토상태`를 `게시완료`가 아닌 값으로 바꾸면 다음 동기화 때 사이트에서 사라집니다.

**이번 주 인기 PnP 바꾸기**
`index.html`의 `WEEKLY_PICKS` 배열에 게임 제목을 넣으세요.

```js
const WEEKLY_PICKS = ["룬 월드", "검은 도시", "다이스 포커"];
```

비워두면 최신 3개가 자동으로 들어갑니다.

---

## ⚠️ 지금 Notion 데이터에서 손봐야 할 것

실제 데이터를 확인해 보니 **필터의 핵심 필드가 대부분 비어 있습니다.**

| 항목 | 상태 | 영향 |
|---|---|---|
| 테마 | 전 건 비어 있음 | 테마 필터가 화면에 안 나옴 |
| 메인 메커니즘 | 전 건 비어 있음 | 메커니즘 필터가 안 나옴 |
| 게임 설명 | 약 2/3 비어 있음 | 상세 페이지가 허전함 |
| 썸네일 | 속성 자체가 없음 | 카드가 전부 색상 블록 |

원본 값은 `메인 메커니즘 - 기타 내용` 필드에 `[메커니즘 원본] 운걸기, 조립 보드…` 형태의 텍스트로 남아 있습니다. 이걸 정식 다중선택 필드로 옮기면 필터가 살아납니다.

> 빌드 스크립트는 **비어 있는 필터를 자동으로 숨깁니다.** 데이터를 채우면 필터가 저절로 나타나니 코드를 고칠 필요는 없습니다.

**썸네일 추가 방법**
Notion DB에 `썸네일`이라는 **URL 타입** 속성을 만들고 이미지 주소를 넣으세요.
(파일 타입으로 직접 업로드하면 Notion이 주는 URL이 1시간 뒤 만료되어 이미지가 깨집니다. 반드시 외부 URL 권장)

---

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `object_not_found` | 2단계(DB에 통합 연결)를 안 함 |
| `unauthorized` | 토큰 오타, 또는 Secret 이름이 `NOTION_TOKEN`이 아님 |
| `Could not find property 검토상태` | Notion에서 속성 이름을 바꿨음. `build.mjs`의 이름도 같이 수정 |
| Actions가 안 돌아감 | Actions 탭 → "I understand..." 활성화 버튼 클릭 필요 |
| 커밋 실패 (403) | Settings → Actions → General → Workflow permissions → **Read and write** 로 변경 |
| 사이트는 뜨는데 게임이 0개 | `games.json` 경로 문제. 브라우저 개발자도구 Network 탭 확인 |
| 로컬에서 열면 빈 화면 | `file://`로 열면 fetch가 막힙니다. 폴더에서 `npx serve` 실행 후 접속 |

## 로컬에서 테스트

```bash
# 데이터 새로 뽑기 (games.json + sitemap.xml + robots.txt + game/*/index.html)
NOTION_TOKEN=ntn_xxx node scripts/build.mjs

# 사이트 띄우기
npx serve .
```

---

## 공유 미리보기 · 검색엔진 (SEO)

이 사이트는 해시 라우팅 SPA라서 `#/game/xxx` 주소를 카카오톡·트위터 미리보기 봇이
읽지 못합니다. 봇은 자바스크립트를 실행하지 않기 때문입니다.
그래서 `build.mjs`가 매 동기화마다 **게임별 정적 페이지**를 따로 만듭니다.

| 산출물 | 용도 |
|---|---|
| `game/<slug>/index.html` | 게임 1개당 1페이지. og:title·description·image + 사람이 읽어도 되는 본문(제목·설명·스펙표·다운로드 버튼) |
| `sitemap.xml` | 검색엔진에 전체 페이지 목록 제출 |
| `robots.txt` | 크롤링 허용 + sitemap 위치 안내 |

정적 페이지에는 **자동 리다이렉트를 넣지 않았습니다.** 미리보기 봇이 리다이렉트를 따라가면
메타 정보를 못 읽으므로, 이 페이지 자체가 완결된 콘텐츠여야 합니다.

### 커스텀 도메인을 붙일 때

기본 주소는 `https://gamesmithlab.github.io/PnP-Archive-Korea`입니다.
도메인을 바꾸면 저장소 **Settings → Secrets and variables → Actions → Variables**에
`SITE_URL`을 새 주소로 등록하세요. 워크플로가 이 값을 읽어 정적 페이지·sitemap의 주소를 맞춥니다.
(로컬 실행 시에는 `SITE_URL=https://... node scripts/build.mjs`)

---

## 방문자 분석 (GA4)

`index.html` `<head>`에 측정 ID가 들어 있습니다 (`window.GA_MEASUREMENT_ID`).
SPA라서 자동 page_view를 끄고, 해시가 바뀔 때마다 `trackPageview()`가 직접 이벤트를 보냅니다.
측정 ID를 바꾸려면 `<head>`의 `GA_MEASUREMENT_ID` 값과 `gtag/js?id=` 주소를 함께 수정하세요.
