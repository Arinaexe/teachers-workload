// ==== Нагрузка учителей — API поверх Google-таблицы ====
// Этот файл — bound-скрипт таблицы "Нагрузка_Учителей" (Extensions > Apps Script).
// Инструкция по установке — в README.md рядом.

var TAB_TEACHERS = 'Учителя';
var TAB_LESSONS = 'Занятия';
var TOKEN_TTL_DAYS = 90;

// Запусти один раз вручную (выбрать функцию setupAdmin -> Run),
// предварительно поменяв ADMIN_PIN на свой.
function setupAdmin() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_NAME', 'Арина');
  props.setProperty('ADMIN_PIN', '0000'); // ЗАМЕНИ на свой PIN перед запуском
}

function getSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function doGet(e) { return handle_(e); }
function doPost(e) { return handle_(e); }

function handle_(e) {
  var params = (e && e.parameter) || {};
  if (e && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      for (var k in body) params[k] = body[k];
    } catch (err) {}
  }
  try {
    var action = params.action;
    var out;
    if (action === 'login') out = login_(params.name, params.pin);
    else if (action === 'list') out = listLessons_(auth_(params.token));
    else if (action === 'toggle') out = toggleStatus_(auth_(params.token), params.rowId, params.status);
    else if (action === 'admin') out = adminSummary_(auth_(params.token));
    else throw new Error('Неизвестное действие: ' + action);
    return json_({ ok: true, data: out });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- авторизация ----
function login_(name, pin) {
  name = (name || '').trim();
  pin = String(pin || '').trim();
  if (!name || !pin) throw new Error('Введите имя и PIN');

  var props = PropertiesService.getScriptProperties();
  var adminName = props.getProperty('ADMIN_NAME');
  var adminPin = props.getProperty('ADMIN_PIN');
  if (adminName && adminPin && name === adminName && pin === adminPin) {
    return { token: makeToken_(name, 'admin'), name: name, role: 'admin' };
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_TEACHERS);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var rowName = String(rows[i][0] || '').trim();
    var rowPin = String(rows[i][1] || '').trim();
    var active = String(rows[i][3] || '').toUpperCase() !== 'FALSE';
    if (rowName && rowName === name && rowPin === pin && active) {
      return { token: makeToken_(name, 'teacher'), name: name, role: 'teacher' };
    }
  }
  throw new Error('Неверное имя или PIN');
}

function makeToken_(name, role) {
  var expires = Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  var payload = JSON.stringify({ n: name, r: role, e: expires });
  var payloadB64 = Utilities.base64EncodeWebSafe(payload);
  var sig = Utilities.computeHmacSha256Signature(payloadB64, getSecret_());
  var sigB64 = Utilities.base64EncodeWebSafe(sig);
  return payloadB64 + '.' + sigB64;
}

function auth_(token) {
  if (!token) throw new Error('Нет доступа: войдите заново');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('Нет доступа: войдите заново');
  var payloadB64 = parts[0], sigB64 = parts[1];
  var expectedSig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getSecret_()));
  if (expectedSig !== sigB64) throw new Error('Нет доступа: войдите заново');
  var payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString());
  if (Date.now() > payload.e) throw new Error('Сессия истекла, войдите заново');
  return { name: payload.n, role: payload.r };
}

// ---- данные ----
function listLessons_(user) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_LESSONS);
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var teacher = String(rows[i][1] || '').trim();
    if (!teacher || teacher !== user.name) continue;
    out.push(rowToLesson_(rows[i], i + 1));
  }
  return out;
}

function rowToLesson_(row, rowIndex) {
  return {
    rowId: rowIndex,
    teacher: row[1],
    student: row[2],
    date: formatDate_(row[3]),
    time: row[4],
    status: row[5],
    comment: row[6]
  };
}

function formatDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return v;
}

function toggleStatus_(user, rowId, newStatus) {
  rowId = Number(rowId);
  var allowed = ['Запланировано', 'Проведено', 'Отменено'];
  if (allowed.indexOf(newStatus) === -1) throw new Error('Недопустимый статус');
  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_LESSONS);
  var teacherCell = sheet.getRange(rowId, 2).getValue();
  if (!teacherCell) throw new Error('Занятие не найдено');
  if (user.role !== 'admin' && String(teacherCell).trim() !== user.name) {
    throw new Error('Это не ваше занятие');
  }
  sheet.getRange(rowId, 6).setValue(newStatus);
  sheet.getRange(rowId, 8).setValue(new Date());
  return { rowId: rowId, status: newStatus };
}

function adminSummary_(user) {
  if (user.role !== 'admin') throw new Error('Только для админа');
  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_LESSONS);
  var rows = sheet.getDataRange().getValues();
  var byTeacher = {};
  var lessons = [];
  for (var i = 1; i < rows.length; i++) {
    var teacher = String(rows[i][1] || '').trim();
    if (!teacher) continue;
    var lesson = rowToLesson_(rows[i], i + 1);
    lessons.push(lesson);
    if (!byTeacher[teacher]) byTeacher[teacher] = { teacher: teacher, planned: 0, done: 0, cancelled: 0 };
    if (lesson.status === 'Проведено') byTeacher[teacher].done++;
    else if (lesson.status === 'Отменено') byTeacher[teacher].cancelled++;
    else byTeacher[teacher].planned++;
  }
  return {
    summary: Object.keys(byTeacher).map(function (k) { return byTeacher[k]; }),
    lessons: lessons
  };
}
