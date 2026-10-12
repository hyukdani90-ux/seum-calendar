// Apps Script 웹앱 배포 주소 (https://script.google.com/macros/s/.../exec)
// 비워두면 체크 화면은 이 기기에만 저장되고, 결과 화면은 예시 데이터로 보입니다.
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxk_ImMrxAgPSl_NszByyRck7opzlRNtiKETrsb1-GmyIsu2suAlczayRus-73FULOt/exec',
  GROUPS: ['나종혁 목장', '임백호 목장', '정찬민 목장'],

  // 달력에서 고를 수 있는 기간. 마지막 해는 (올해 + 3)년과 LAST_YEAR 중 늦은 해로 자동으로 늘어납니다.
  FIRST_YEAR: 2026,
  LAST_YEAR: 2030,

  // 달마다 묵상하는 성경. 없는 달은 "말씀 묵상"으로 표시됩니다.
  BOOKS: {
    '2026-10': '열왕기상',
  },
};
