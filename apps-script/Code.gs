/**
 * 믿음의 경주 - 경건생활 체크 백엔드 (Google Apps Script 웹앱)
 *
 * 개인이 매일 4항목(말씀·기도·통독·예배)을 체크해 보내면 구글 시트에 한 줄씩 저장하고,
 * 결과 화면은 목장별 이번 달 실천율을 읽어 간다.
 *
 * POST  { group, name, date: "YYYY-MM-DD", word, prayer, reading, worship }  -> 기록 저장(같은 날 재입력 시 덮어씀)
 * POST  { group, name, records: [{ date, word, prayer, reading, worship }, ...] } -> 여러 날 한 번에 저장
 * GET   ?action=summary[&month=YYYY-MM]                                       -> 목장별 월간 실천율 (기본: 이번 달)
 * GET   ?action=summary&week=YYYY-MM-DD                                       -> 목장별 주간 실천율
 * GET   ?action=mine&group=..&name=..[&week=YYYY-MM-DD | &month=YYYY-MM]       -> 내 기록(체크 달력 복원용)
 *
 * 관리자 (POST, 비밀번호는 Apps Script → 프로젝트 설정 → 스크립트 속성 ADMIN_KEY)
 * POST  { admin: 'login',    key }                                            -> 비밀번호 확인
 * POST  { admin: 'overview', key, month }                                     -> 목장별·개인별 월간 현황
 * POST  { admin: 'move',     key, group, name, newGroup, newName }            -> 이름 바꾸기 / 다른 목장으로 옮기기
 * POST  { admin: 'delete',   key, group, name }                               -> 그 사람의 기록 모두 삭제
 *
 * 관리자가 옮긴 사람은 '변경기록' 탭에 남고, 그 사람 휴대폰이 예전 목장·이름으로 보내도
 * 새 목장·이름으로 저장되며 휴대폰의 설정도 새 것으로 바뀐다.
 */

var GROUPS = ['나종혁 목장', '임백호 목장', '정찬민 목장'];
var ITEMS = ['word', 'prayer', 'reading', 'worship'];
var ITEM_LABELS = ['말씀', '기도', '통독', '예배'];

// 한 주의 시작 요일 (0 = 주일, 1 = 월요일)
var WEEK_START_DAY = 0;

var SHEET_NAME = '기록';
var HEADER = ['날짜', '주시작', '목장', '이름'].concat(ITEM_LABELS, ['실천율', '수정시각']);
var MOVES_SHEET = '변경기록';
var MOVES_HEADER = ['이전 목장', '이전 이름', '새 목장', '새 이름', '변경시각'];
var TZ = 'Asia/Seoul';

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'summary') return json_(p.week ? weekSummary_(p.week) : monthSummary_(p.month));
    if (p.action === 'mine') return json_(mine_(p.group, p.name, p.week, p.month));
    return json_({ ok: true, groups: GROUPS });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.admin) return json_(admin_(body));
    if (Array.isArray(body.records)) {
      var who = resolve_(body.group, body.name);
      var saved = body.records.slice(0, 62).map(function (r) {
        var one = { group: who.group, name: who.name };
        for (var k in r) if (k !== 'group' && k !== 'name') one[k] = r[k];
        return saveCheck_(one);
      });
      return json_({ ok: true, saved: saved.length, profile: who });
    }
    return json_(saveCheck_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function saveCheck_(b) {
  // 관리자가 옮긴 사람이면 새 목장·이름으로 저장
  var who = resolve_(b.group, b.name);
  var group = who.group;
  var name = who.name;
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
        return { ok: true, updated: true, rate: rate, profile: who };
      }
    }
    sheet.appendRow(row);
    return { ok: true, updated: false, rate: rate, profile: who };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 목장 실천율 = 목장원 전원의 기간 내 체크 수 / (목장원 수 × 지난 일수 × 4)
 * 목장원 = 그 목장으로 기간 끝까지 한 번이라도 기록한 사람. 기록하지 않은 날은 0으로 계산한다.
 * 지난 일수 = 진행 중인 기간이면 오늘까지, 지난 기간이면 기간 전체.
 */
function aggregate_(start, end) {
  var last = end < today_() ? end : today_();
  var days = Math.max(1, Math.round((parse_(last) - parse_(start)) / 86400000) + 1);
  var rows = rows_();

  var groups = GROUPS.map(function (g) {
    var members = {};
    var checked = 0;
    var itemTotals = [0, 0, 0, 0];
    rows.forEach(function (r) {
      if (r.group !== g || r.date > end) return;
      members[r.name] = true;
      if (r.date < start) return;
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

  return { ok: true, start: start, end: end, days: days, updatedAt: new Date().toISOString(), groups: groups };
}

function monthRange_(month) {
  var ym = /^\d{4}-\d{2}$/.test(month || '') ? month : today_().slice(0, 7);
  var start = ym + '-01';
  var next = parse_(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { month: ym, start: start, end: addDays_(fmt_(next), -1) };
}

function monthSummary_(month) {
  var r = monthRange_(month);
  var out = aggregate_(r.start, r.end);
  out.period = 'month';
  out.month = r.month;
  return out;
}

function weekSummary_(week) {
  var start = weekStart_(week);
  var out = aggregate_(start, addDays_(start, 6));
  out.period = 'week';
  out.weekStart = start;
  return out;
}

function mine_(group, name, week, month) {
  var who = resolve_(group, name);
  group = who.group;
  name = who.name;
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
  return month
    ? { ok: true, month: month, records: records, profile: who }
    : { ok: true, weekStart: start, records: records, profile: who };
}

// ---------- 관리자 ----------

function admin_(b) {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!key) throw new Error('관리자 비밀번호가 아직 설정되지 않았습니다. Apps Script → 프로젝트 설정 → 스크립트 속성에 ADMIN_KEY를 추가해 주세요.');
  if (String(b.key || '') !== key) {
    Utilities.sleep(1000); // 비밀번호 마구 넣어보기 늦추기
    throw new Error('비밀번호가 맞지 않습니다.');
  }
  if (b.admin === 'login') return { ok: true };
  if (b.admin === 'overview') return adminOverview_(b.month);
  if (b.admin === 'move') return adminMove_(b.group, b.name, b.newGroup, b.newName);
  if (b.admin === 'delete') return adminDelete_(b.group, b.name);
  throw new Error('알 수 없는 요청입니다.');
}

/** 목장별 현황 + 개인별 현황 (개인 실천율 = 이번 달 체크 수 / (지난 일수 × 4)) */
function adminOverview_(month) {
  var range = monthRange_(month);
  var summary = aggregate_(range.start, range.end);
  var map = {};
  rows_().forEach(function (r) {
    if (r.date > range.end) return;
    var k = r.group + '\u0000' + r.name;
    var m = map[k] || (map[k] = { group: r.group, name: r.name, first: r.date, last: '', checks: 0, days: 0, items: [0, 0, 0, 0] });
    if (r.date < m.first) m.first = r.date;
    if (r.date < range.start) return;
    var n = 0;
    ITEMS.forEach(function (it, i) { m.items[i] += r[it]; n += r[it]; });
    m.checks += n;
    if (n > 0) {
      m.days++;
      if (r.date > m.last) m.last = r.date;
    }
  });
  var members = Object.keys(map).map(function (k) {
    var m = map[k];
    m.rate = m.checks / (summary.days * ITEMS.length);
    return m;
  });
  return {
    ok: true, month: range.month, days: summary.days, groupNames: GROUPS,
    groups: summary.groups, members: members, updatedAt: summary.updatedAt
  };
}

/** 이름 바꾸기 / 목장 옮기기. 옮길 곳에 같은 날 기록이 있으면 체크를 합친다. */
function adminMove_(group, name, newGroup, newName) {
  group = String(group || '').trim();
  name = String(name || '').trim();
  newGroup = String(newGroup || '').trim();
  newName = String(newName || '').trim();
  if (GROUPS.indexOf(newGroup) < 0) throw new Error('알 수 없는 목장입니다: ' + newGroup);
  if (!newName || newName.length > 20) throw new Error('새 이름을 확인해 주세요.');
  if (group === newGroup && name === newName) throw new Error('바뀐 내용이 없습니다.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = sheet_();
    var values = sheet.getDataRange().getValues();
    var width = values[0].length;
    var target = {};
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][2]) === newGroup && String(values[i][3]) === newName) target[String(values[i][0])] = i;
    }
    var drop = {};
    var moved = 0, merged = 0;
    for (var j = 1; j < values.length; j++) {
      var v = values[j];
      if (String(v[2]) !== group || String(v[3]) !== name) continue;
      var t = target[String(v[0])];
      if (t !== undefined) {
        var sum = 0;
        for (var c = 4; c < 8; c++) {
          values[t][c] = (Number(values[t][c]) || Number(v[c])) ? 1 : 0;
          sum += values[t][c];
        }
        values[t][8] = sum / ITEMS.length;
        values[t][9] = new Date();
        drop[j] = true;
        merged++;
      } else {
        v[2] = newGroup;
        v[3] = newName;
        v[9] = new Date();
        moved++;
      }
    }
    if (!moved && !merged) throw new Error('해당하는 기록이 없습니다.');
    writeAll_(sheet, values.filter(function (_, k) { return !drop[k]; }), values.length, width);
    addMove_(group, name, newGroup, newName);
    return { ok: true, moved: moved, merged: merged };
  } finally {
    lock.releaseLock();
  }
}

function adminDelete_(group, name) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = sheet_();
    var values = sheet.getDataRange().getValues();
    var kept = values.filter(function (v, k) { return k === 0 || String(v[2]) !== group || String(v[3]) !== name; });
    var deleted = values.length - kept.length;
    if (!deleted) throw new Error('해당하는 기록이 없습니다.');
    writeAll_(sheet, kept, values.length, values[0].length);
    return { ok: true, deleted: deleted };
  } finally {
    lock.releaseLock();
  }
}

// 시트 내용을 통째로 다시 쓴다 (날짜 열의 텍스트 서식은 그대로 유지됨)
function writeAll_(sheet, rows, oldLength, width) {
  sheet.getRange(1, 1, oldLength, width).clearContent();
  sheet.getRange(1, 1, rows.length, width).setValues(rows);
}

// ---------- 목장·이름 변경 기록 ----------

function movesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MOVES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MOVES_SHEET);
    sheet.appendRow(MOVES_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function addMove_(group, name, newGroup, newName) {
  var sheet = movesSheet_();
  var values = sheet.getDataRange().getValues();
  // 새 목장·이름은 이제 실제 사람이므로, 그쪽에서 다른 곳으로 보내던 예전 기록은 지운다 (되돌리기 대비)
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === newGroup && String(values[i][1]) === newName) sheet.deleteRow(i + 1);
  }
  sheet.appendRow([group, name, newGroup, newName, new Date()]);
}

var movesCache_ = null;

/** 예전 목장·이름 → 지금 목장·이름 */
function resolve_(group, name) {
  var who = { group: String(group || '').trim(), name: String(name || '').trim() };
  if (!movesCache_) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(MOVES_SHEET);
    movesCache_ = sheet ? sheet.getDataRange().getValues().slice(1) : [];
  }
  for (var hop = 0; hop < 5; hop++) {
    var next = null;
    for (var i = movesCache_.length - 1; i >= 0; i--) {
      if (String(movesCache_[i][0]) === who.group && String(movesCache_[i][1]) === who.name) {
        next = { group: String(movesCache_[i][2]), name: String(movesCache_[i][3]) };
        break;
      }
    }
    if (!next) break;
    who = next;
  }
  return who;
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
