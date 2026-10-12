/**
 * 믿음의 경주 - 경건생활 체크 백엔드 (Google Apps Script 웹앱)
 *
 * 개인이 매일 4항목(말씀·기도·통독·예배)을 체크해 보내면 구글 시트에 한 줄씩 저장하고,
 * 결과 화면은 목장별 이번 주 실천율을 읽어 간다.
 *
 * POST  { group, name, date: "YYYY-MM-DD", word, prayer, reading, worship }  -> 기록 저장(같은 날 재입력 시 덮어씀)
 * POST  { group, name, records: [{ date, word, prayer, reading, worship }, ...] } -> 여러 날 한 번에 저장
 * GET   ?action=summary[&week=YYYY-MM-DD]                                     -> 목장별 주간 실천율
 * GET   ?action=mine&group=..&name=..[&week=YYYY-MM-DD | &month=YYYY-MM]       -> 내 기록(체크 달력 복원용)
 */

var GROUPS = ['나종혁 목장', '임백호 목장', '정찬민 목장'];
var ITEMS = ['word', 'prayer', 'reading', 'worship'];
var ITEM_LABELS = ['말씀', '기도', '통독', '예배'];

// 한 주의 시작 요일 (0 = 주일, 1 = 월요일)
var WEEK_START_DAY = 0;

var SHEET_NAME = '기록';
var HEADER = ['날짜', '주시작', '목장', '이름'].concat(ITEM_LABELS, ['실천율', '수정시각']);
var TZ = 'Asia/Seoul';

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'summary') return json_(summary_(p.week));
    if (p.action === 'mine') return json_(mine_(p.group, p.name, p.week, p.month));
    return json_({ ok: true, groups: GROUPS });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (Array.isArray(body.records)) {
      var saved = body.records.slice(0, 62).map(function (r) {
        var one = { group: body.group, name: body.name };
        for (var k in r) one[k] = r[k];
        return saveCheck_(one);
      });
      return json_({ ok: true, saved: saved.length });
    }
    return json_(saveCheck_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function saveCheck_(b) {
  var group = String(b.group || '').trim();
  var name = String(b.name || '').trim();
  var date = String(b.date || today_());
  if (GROUPS.indexOf(group) < 0) throw new Error('알 수 없는 목장입니다: ' + group);
  if (!name || name.length > 20) throw new Error('이름을 확인해 주세요.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  if (date > today_()) throw new Error('미래 날짜는 기록할 수 없습니다.');

  var checks = ITEMS.map(function (k) { return b[k] ? 1 : 0; });
  var rate = checks.reduce(function (a, c) { return a + c; }, 0) / ITEMS.length;
  var row = [date, weekStart_(date), group, name].concat(checks, [rate, new Date()]);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = sheet_();
    var values = sheet.getDataRange().getDisplayValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === date && values[i][2] === group && values[i][3] === name) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return { ok: true, updated: true, rate: rate };
      }
    }
    sheet.appendRow(row);
    return { ok: true, updated: false, rate: rate };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 목장 실천율 = 목장원 전원의 (이번 주 체크 수 합) / (목장원 수 × 지난 일수 × 4)
 * 목장원 = 그 목장으로 한 번이라도 기록한 사람. 기록하지 않은 날은 0으로 계산한다.
 */
function summary_(week) {
  var start = week || weekStart_(today_());
  var days = elapsedDays_(start);
  var rows = rows_();

  var result = GROUPS.map(function (g) {
    var members = {};
    var checked = 0;
    var itemTotals = [0, 0, 0, 0];
    rows.forEach(function (r) {
      if (r.group !== g || r.date > addDays_(start, 6)) return;
      members[r.name] = true;
      if (r.weekStart !== start) return;
      ITEMS.forEach(function (k, i) { checked += r[k]; itemTotals[i] += r[k]; });
    });
    var memberCount = Object.keys(members).length;
    var possible = memberCount * days;
    return {
      group: g,
      members: memberCount,
      rate: possible ? checked / (possible * ITEMS.length) : 0,
      items: ITEM_LABELS.map(function (label, i) {
        return { label: label, rate: possible ? itemTotals[i] / possible : 0 };
      })
    };
  });

  return { ok: true, weekStart: start, days: days, updatedAt: new Date().toISOString(), groups: result };
}

function mine_(group, name, week, month) {
  var start = week || weekStart_(today_());
  var inRange = month
    ? function (r) { return r.date.slice(0, 7) === month; }
    : function (r) { return r.weekStart === start; };
  var records = rows_()
    .filter(function (r) { return r.group === group && r.name === name && inRange(r); })
    .map(function (r) {
      var o = { date: r.date };
      ITEMS.forEach(function (k) { o[k] = !!r[k]; });
      return o;
    });
  return month ? { ok: true, month: month, records: records } : { ok: true, weekStart: start, records: records };
}

function rows_() {
  var values = sheet_().getDataRange().getDisplayValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (!v[0]) continue;
    out.push({
      date: v[0], weekStart: v[1], group: v[2], name: v[3],
      word: Number(v[4]) || 0, prayer: Number(v[5]) || 0, reading: Number(v[6]) || 0, worship: Number(v[7]) || 0
    });
  }
  return out;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
    // 날짜가 자동 변환되지 않도록 텍스트로 고정
    sheet.getRange('A:B').setNumberFormat('@');
  }
  return sheet;
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function parse_(ymd) {
  var p = ymd.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
}

function fmt_(d) {
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function addDays_(ymd, n) {
  var d = parse_(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt_(d);
}

function weekStart_(ymd) {
  var d = parse_(ymd);
  var diff = (d.getUTCDay() - WEEK_START_DAY + 7) % 7;
  return addDays_(ymd, -diff);
}

// 이번 주라면 오늘까지 지난 일수, 지난 주라면 7
function elapsedDays_(start) {
  var diff = Math.round((parse_(today_()) - parse_(start)) / 86400000) + 1;
  return Math.max(1, Math.min(7, diff));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
