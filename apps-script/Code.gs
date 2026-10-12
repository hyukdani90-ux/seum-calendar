/**
 * 믿음의 경주 - 경건생활 체크 백엔드 (Google Apps Script 웹앱)
 *
 * 개인이 매일 4항목(말씀·기도·통독·예배)을 체크해 보내면 구글 시트에 한 줄씩 저장하고,
 * 결과 화면은 목장별 이번 달 실천율을 읽어 간다.
 *
 * POST  { group, name, date: "YYYY-MM-DD", word, prayer, reading, worship }  -> 기록 저장(같은 날 재입력 시 덮어씀)
 * POST  { group, name, records: [{ date, word, prayer, reading, worship }, ...] } -> 여러 날 한 번에 저장
 * GET   ?action=summary[&period=month|quarter|year]                           -> 목장별 이번 달/분기/해 실천율 (기본: 월간)
 * GET   ?action=summary&month=YYYY-MM | &week=YYYY-MM-DD                      -> 특정 달 / 주
 * GET   ?action=mine&group=..&name=..[&week=YYYY-MM-DD | &month=YYYY-MM]       -> 내 기록(체크 달력 복원용)
 *
 * 관리자 (POST, 비밀번호는 Apps Script → 프로젝트 설정 → 스크립트 속성 ADMIN_KEY)
 * POST  { admin: 'login',    key }                                            -> 비밀번호 확인
 * POST  { admin: 'overview', key, period, anchor }                            -> 목장별·개인별 현황 (anchor 날짜가 든 달/분기/해)
 * POST  { admin: 'move',     key, group, name, newGroup, newName }            -> 이름 바꾸기 / 다른 목장으로 옮기기
 * POST  { admin: 'delete',   key, group, name }                               -> 그 사람의 기록 모두 삭제
 * POST  { admin: 'setting',  key, group, name, countStart, excluded }          -> 계수 시작일('' = 첫 체크일) · 계수 제외
 *
 * 실천율 계산: 사람마다 '계수 시작일'부터 오늘(또는 기간 끝)까지의 날만 센다.
 *   계수 시작일 기본값 = 그 사람이 처음 체크한 해의 1월 1일 (단 SERVICE_START 이전은 세지 않음).
 *   늦게 합류한 분 등은 관리자 페이지에서 따로 정한다.
 *   목장 실천율 = 목장원 체크 수 합 / (목장원별 계수 일수 합 × 4). '계수 제외'인 사람은 빠진다.
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
var SETTINGS_SHEET = '계수설정';
var SETTINGS_HEADER = ['목장', '이름', '계수 시작일', '계수 제외', '수정시각'];
var TZ = 'Asia/Seoul';

// 서비스 시작일: 이 날 이전은 실천율 계산에 넣지 않는다 (2026년은 10월부터)
var SERVICE_START = '2026-10-01';

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'summary') {
      if (p.week) return json_(periodSummary_(weekRange_(p.week)));
      if (p.month) return json_(periodSummary_(periodRange_('month', p.month + '-01')));
      return json_(periodSummary_(periodRange_(p.period || 'month', today_())));
    }
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

/** 기간: month | quarter | year, anchor 날짜가 들어 있는 기간 */
function periodRange_(period, anchor) {
  var a = /^\d{4}-\d{2}-\d{2}$/.test(anchor || '') ? anchor : today_();
  var y = +a.slice(0, 4), m = +a.slice(5, 7);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var lastDay = function (yy, mm) { return new Date(Date.UTC(yy, mm, 0)).getUTCDate(); };
  if (period === 'year') {
    return { period: 'year', start: y + '-01-01', end: y + '-12-31', label: y + '년' };
  }
  if (period === 'quarter') {
    var q = Math.floor((m - 1) / 3);
    var m1 = q * 3 + 1, m3 = q * 3 + 3;
    return { period: 'quarter', start: y + '-' + pad(m1) + '-01', end: y + '-' + pad(m3) + '-' + pad(lastDay(y, m3)),
      label: y + '년 ' + (q + 1) + '분기 (' + m1 + '~' + m3 + '월)' };
  }
  return { period: 'month', month: y + '-' + pad(m), start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-' + pad(lastDay(y, m)),
    label: y + '년 ' + m + '월' };
}

function weekRange_(week) {
  var start = weekStart_(week);
  return { period: 'week', weekStart: start, start: start, end: addDays_(start, 6), label: start + ' 주간' };
}

function daysBetween_(a, b) {
  return Math.round((parse_(b) - parse_(a)) / 86400000) + 1;
}

/**
 * 기간 안의 사람별 집계. 사람마다 max(기간 시작, 계수 시작일) ~ min(기간 끝, 오늘)의 날만 센다.
 * 계수 시작일 = 관리자가 정한 날, 없으면 처음 체크한 해의 1월 1일 (SERVICE_START보다 앞서지 않음).
 */
function computePeople_(range) {
  var today = today_();
  var last = range.end < today ? range.end : today;
  var settings = settings_();
  var map = {};
  rows_().forEach(function (r) {
    var k = r.group + '\u0000' + r.name;
    var m = map[k] || (map[k] = { group: r.group, name: r.name, first: r.date, rows: [] });
    if (r.date < m.first) m.first = r.date;
    m.rows.push(r);
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var set = settings[k] || {};
    var yearStart = m.first.slice(0, 4) + '-01-01';
    var countStart = set.countStart || (yearStart > SERVICE_START ? yearStart : SERVICE_START);
    var from = countStart > range.start ? countStart : range.start;
    var eligible = from <= last ? daysBetween_(from, last) : 0;
    var items = [0, 0, 0, 0], checks = 0, days = 0, lastDate = '';
    m.rows.forEach(function (r) {
      if (r.date < from || r.date > last) return;
      var n = 0;
      ITEMS.forEach(function (it, i) { items[i] += r[it]; n += r[it]; });
      checks += n;
      if (n > 0) { days++; if (r.date > lastDate) lastDate = r.date; }
    });
    return {
      group: m.group, name: m.name, first: m.first,
      countStart: countStart, countStartSet: set.countStart || '', excluded: !!set.excluded,
      eligibleDays: eligible, checks: checks, days: days, last: lastDate, items: items,
      rate: eligible ? checks / (eligible * ITEMS.length) : null
    };
  });
}

function groupTotals_(people) {
  return GROUPS.map(function (g) {
    var members = 0, possible = 0, checked = 0, items = [0, 0, 0, 0];
    people.forEach(function (p) {
      if (p.group !== g || p.excluded || !p.eligibleDays) return;
      members++;
      possible += p.eligibleDays;
      checked += p.checks;
      p.items.forEach(function (v, i) { items[i] += v; });
    });
    return {
      group: g,
      members: members,
      rate: possible ? checked / (possible * ITEMS.length) : 0,
      items: ITEM_LABELS.map(function (label, i) {
        return { label: label, rate: possible ? items[i] / possible : 0 };
      })
    };
  });
}

function periodSummary_(range) {
  var today = today_();
  var last = range.end < today ? range.end : today;
  // 표시용 지난 일수도 서비스 시작일 이전은 세지 않음
  var from = range.start > SERVICE_START ? range.start : SERVICE_START;
  var out = {
    ok: true, period: range.period, label: range.label, start: range.start, end: range.end,
    countFrom: from,
    days: last >= from ? daysBetween_(from, last) : 0,
    updatedAt: new Date().toISOString(),
    groups: groupTotals_(computePeople_(range))
  };
  if (range.month) out.month = range.month;
  if (range.weekStart) out.weekStart = range.weekStart;
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
  if (b.admin === 'overview') return adminOverview_(b.period, b.anchor || (b.month ? b.month + '-01' : ''));
  if (b.admin === 'move') return adminMove_(b.group, b.name, b.newGroup, b.newName);
  if (b.admin === 'delete') return adminDelete_(b.group, b.name);
  if (b.admin === 'setting') return adminSetting_(b.group, b.name, b.countStart, b.excluded);
  throw new Error('알 수 없는 요청입니다.');
}

/** 목장별 현황 + 개인별 현황 (기간: 월·분기·연, anchor 날짜가 든 기간) */
function adminOverview_(period, anchor) {
  var range = periodRange_(period || 'month', anchor);
  var people = computePeople_(range).filter(function (p) { return p.eligibleDays > 0 || p.checks > 0; });
  var summary = periodSummary_(range);
  return {
    ok: true, period: range.period, label: range.label, start: range.start, end: range.end,
    countFrom: summary.countFrom, days: summary.days, groupNames: GROUPS, groups: groupTotals_(people), members: people,
    updatedAt: summary.updatedAt
  };
}

/** 계수 시작일('' 이면 첫 체크일) · 계수 제외 */
function adminSetting_(group, name, countStart, excluded) {
  group = String(group || '').trim();
  name = String(name || '').trim();
  countStart = String(countStart || '').trim();
  if (countStart && !/^\d{4}-\d{2}-\d{2}$/.test(countStart)) throw new Error('날짜 형식이 올바르지 않습니다.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = settingsSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === group && String(values[i][1]) === name) {
        if (!countStart && !excluded) sheet.deleteRow(i + 1);
        else sheet.getRange(i + 1, 1, 1, 5).setValues([[group, name, countStart, excluded ? 'Y' : '', new Date()]]);
        return { ok: true };
      }
    }
    if (countStart || excluded) sheet.appendRow([group, name, countStart, excluded ? 'Y' : '', new Date()]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
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
    moveSetting_(group, name, newGroup, newName);
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
    moveSetting_(group, name, null, null);
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

// ---------- 계수설정 ----------

function settingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.appendRow(SETTINGS_HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange('C:C').setNumberFormat('@');
  }
  return sheet;
}

/** '목장\u0000이름' -> { countStart, excluded } */
function settings_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  var out = {};
  if (!sheet) return out;
  sheet.getDataRange().getDisplayValues().slice(1).forEach(function (v) {
    if (!v[0]) return;
    out[v[0] + '\u0000' + v[1]] = { countStart: /^\d{4}-\d{2}-\d{2}$/.test(v[2]) ? v[2] : '', excluded: v[3] === 'Y' };
  });
  return out;
}

/** 옮긴 사람의 설정을 따라 옮김 (옮길 곳에 이미 설정이 있으면 그쪽 유지). newGroup이 null이면 삭제 */
function moveSetting_(group, name, newGroup, newName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) return;
  var values = sheet.getDataRange().getValues();
  var targetExists = newGroup !== null && values.some(function (v) { return String(v[0]) === newGroup && String(v[1]) === newName; });
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) !== group || String(values[i][1]) !== name) continue;
    if (newGroup === null || targetExists) sheet.deleteRow(i + 1);
    else sheet.getRange(i + 1, 1, 1, 2).setValues([[newGroup, newName]]);
  }
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
