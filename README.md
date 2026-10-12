# 세움 신앙점검표 · 믿음의 경주

천안세움교회 4대 신앙생활(말씀·기도·통독·예배) 체크 달력과, 목장별 실천율을 보여주는 "믿음의 경주".

- 체크 화면: https://hyukdani90-ux.github.io/seum-calendar/
- 믿음의 경주: https://hyukdani90-ux.github.io/seum-calendar/race.html

개인이 매일 체크하면 구글 시트에 자동으로 쌓이고, 목장별 실천율이 달리는 실루엣 트랙으로 표시됩니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 개인 체크 화면 ("말씀 및 묵상 달력" UI + 연·월 선택 + 목장 전송) |
| `race.html` | 믿음의 경주 (1분마다 자동 갱신) |
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

- 개인 화면: 그 달 체크 수 ÷ (그 달 일수 × 4) — 기존 앱과 같음
- 목장(믿음의 경주): 목장원 전원의 이번 달 체크 수 ÷ (목장원 수 × 이번 달 오늘까지 일수 × 4)
  - 목장원 = 그 목장으로 한 번이라도 기록한 사람, 기록하지 않은 날은 0
  - 매달 1일에 새 경주가 시작됩니다

## 구글 시트 백엔드

1. 스프레드시트 → 확장 프로그램 → Apps Script에 `apps-script/Code.gs`를 붙여넣고 저장
2. 배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자)
3. 나온 주소를 `config.js`의 `API_URL`에 넣기 (현재 설정됨)

코드를 고친 뒤에는 **배포 관리 → ✏️ → 새 버전**으로 다시 배포해야 반영됩니다.

```
POST {URL}   { group, name, date, word, prayer, reading, worship }        하루 저장 (같은 날은 덮어씀)
POST {URL}   { group, name, records: [{ date, word, ... }, ...] }          여러 날 한 번에
GET  {URL}?action=summary[&month=YYYY-MM]                                  목장별 월간 실천율 (기본: 이번 달)
GET  {URL}?action=summary&week=YYYY-MM-DD                                  목장별 주간 실천율
GET  {URL}?action=mine&group=..&name=..&month=YYYY-MM                      내 한 달 기록
```
본문은 `Content-Type: text/plain`으로 보내야 브라우저 CORS 사전 요청 없이 전달됩니다.

## 이미지 다시 만들기

```
# 실루엣 (흰 배경 검은 실루엣 가로 스프라이트 → 좌우 반전 벡터)
pip install potracer pillow numpy
python3 tools/trace_silhouette.py art/runner-silhouette-source.png assets/runner.svg

# 아이콘·카톡 미리보기 (Playwright)
node tools/render_icons.cjs
```
