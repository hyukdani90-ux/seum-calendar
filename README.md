# 세움 신앙점검표 · 믿음의 경주

천안세움교회 4대 신앙생활(말씀·기도·통독·예배) 체크 달력과, 목장별 실천율을 보여주는 "믿음의 경주".

- 체크 화면: https://hyukdani90-ux.github.io/seum-calendar/
- 믿음의 경주: https://hyukdani90-ux.github.io/seum-calendar/race.html
- 관리자: https://hyukdani90-ux.github.io/seum-calendar/admin.html (비밀번호 필요)

개인이 매일 체크하면 구글 시트에 자동으로 쌓이고, 목장별 실천율이 달리는 실루엣 트랙으로 표시됩니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 개인 체크 화면 ("말씀 및 묵상 달력" UI + 연·월 선택 + 목장 전송) |
| `race.html` | 믿음의 경주 (1분마다 자동 갱신) |
| `admin.html` | 관리자: 목장별·개인별 현황(월·분기·연, 지난 기간), 이름·목장 변경, 계수 시작일·제외, 삭제 |
| `config.js` | Apps Script 주소 · 목장 목록 · 선택 가능 연도 · **달마다 묵상할 성경** |
| `holidays.js` | 2026~2030년 공휴일 (설·추석·대체공휴일·선거일) |
| `assets/runner.svg` | 달리기 실루엣 9프레임 (CSS 마스크로 목장 색을 입힘) |
| `icons/`, `manifest.webmanifest`, `sw.js` | 홈 화면 아이콘 · 오프라인 · 카톡 공유 미리보기 |
| `apps-script/` | 구글 시트 백엔드 (저장·집계 API) |
| `tools/` | 실루엣 벡터 변환, 아이콘·미리보기 이미지 생성 |

## 매달 할 일

`config.js`의 `BOOKS`에 그 달 성경을 추가합니다. GitHub에서 파일을 열고 ✏️로 고친 뒤 저장(Commit)하면
1~2분 뒤 사이트에 반영됩니다.

```js
BOOKS: {
  '2026-10': '열왕기상',
  '2026-11': '열왕기하',
},
```

## 실천율 계산

- 개인 체크 화면: 그 달 체크 수 ÷ (그 달 일수 × 4) — 기존 앱과 같음
- 믿음의 경주 · 관리자: **월간(기본) / 분기 / 연간**
  - **기간 전체가 목표**: 목표 = 하루 4개 × 기간 일수 (월 31일 → 124, 4분기 92일 → 368, 1년 → 1,460)
  - 목장 실천율 = 목장원 체크 수 합 ÷ (목장원별 계수 일수 합 × 4), 기간이 진행될수록 차오름
  - 계수 일수 = 그 사람의 **계수 시작일**(또는 기간 시작)부터 기간 끝까지
  - 계수 시작일 기본값 = 처음 체크한 해의 1월 1일. **2026년은 10월 1일**(`Code.gs`의 `SERVICE_START`)
  - 늦게 합류한 분은 관리자 페이지에서 계수 시작일을 따로 정하고, 떠나신 분은 '계수 제외'
  - 해가 바뀌면 연간·분기도 새로 시작
- 믿음의 경주 화면은 열 때마다 월간으로 시작하고, 지난 기간 조회는 관리자 페이지에서만 됩니다

## 구글 시트 백엔드

1. 스프레드시트 → 확장 프로그램 → Apps Script에 `apps-script/Code.gs`를 붙여넣고 저장
2. 배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자)
3. 나온 주소를 `config.js`의 `API_URL`에 넣기 (현재 설정됨)

코드를 고친 뒤에는 **배포 관리 → ✏️ → 새 버전**으로 다시 배포해야 반영됩니다.

```
POST {URL}   { group, name, date, word, prayer, reading, worship }        하루 저장 (같은 날은 덮어씀)
POST {URL}   { group, name, records: [{ date, word, ... }, ...] }          여러 날 한 번에
GET  {URL}?action=summary[&period=month|quarter|year]                      목장별 이번 달/분기/해 실천율 (기본: 월간)
GET  {URL}?action=summary&month=YYYY-MM | &week=YYYY-MM-DD                 특정 달 / 주
GET  {URL}?action=mine&group=..&name=..&month=YYYY-MM                      내 한 달 기록
```
본문은 `Content-Type: text/plain`으로 보내야 브라우저 CORS 사전 요청 없이 전달됩니다.

## 관리자 페이지

1. Apps Script → ⚙️ 프로젝트 설정 → 맨 아래 **스크립트 속성** → 속성 추가
   - 속성: `ADMIN_KEY` / 값: 관리자 비밀번호
2. `admin.html`에서 그 비밀번호로 들어갑니다. 비밀번호는 시트 쪽에서만 확인하므로 공개 저장소에 드러나지 않습니다.

- **목장 옮기기**: 잘못된 목장으로 등록한 사람을 옮기면 기록이 함께 옮겨지고, 그 사람 휴대폰도
  다음 체크(또는 앱을 열 때) 자동으로 새 목장·이름으로 바뀝니다. 옮긴 내역은 시트의 `변경기록` 탭에 남습니다.
  옮길 곳에 같은 이름이 이미 있으면 같은 날 체크는 하나로 합쳐집니다.
- **삭제**: 그 사람의 모든 기록을 지웁니다. 되돌릴 수 없고, 그 휴대폰에서 다시 체크하면 다시 생깁니다.
- `변경기록` 탭의 줄을 지우면 그 옮김 안내(휴대폰 자동 변경)가 멈춥니다.
- **계수 시작일 · 계수 제외**: 시트의 `계수설정` 탭에 저장됩니다.

## 이미지 다시 만들기

```
# 실루엣 (흰 배경 검은 실루엣 가로 스프라이트 → 좌우 반전 벡터)
pip install potracer pillow numpy
python3 tools/trace_silhouette.py art/runner-silhouette-source.png assets/runner.svg

# 아이콘·카톡 미리보기 (Playwright)
node tools/render_icons.cjs
```
