var API_URL = 'https://script.google.com/macros/s/AKfycbxVcHLhVvfB8o-lws8-Ze9KORFctZevDR-vVkmsKLfQN8p6Qfkfo6UN-SZ_7VmvhHrjSg/exec';

var STATUS_LABEL = {
  'Запланировано': 'план',
  'Проведено': 'проведено',
  'Отменено': 'отменено'
};
var STATUS_CLASS = {
  'Запланировано': 'planned',
  'Проведено': 'done',
  'Отменено': 'cancelled'
};
var OVERLOAD_THRESHOLD = 8; // сколько "Запланировано" считать перегрузом — поправь под себя

function getSession() {
  try { return JSON.parse(localStorage.getItem('session') || 'null'); }
  catch (e) { return null; }
}
function setSession(s) { localStorage.setItem('session', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('session'); }

function apiGet(action, extra) {
  var params = Object.assign({ action: action }, extra || {});
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetch(API_URL + '?' + qs).then(function (r) { return r.json(); });
}

function apiPost(action, extra) {
  // Apps Script отвечает 302-редиректом на script.googleusercontent.com — при follow браузер
  // на POST теряет тело запроса. Поэтому все действия идут через GET с query-параметрами.
  return apiGet(action, extra);
}

function el(id) { return document.getElementById(id); }

function showLogin() {
  el('login-screen').classList.remove('hidden');
  el('app-screen').classList.add('hidden');
}

function showApp(session) {
  el('login-screen').classList.add('hidden');
  el('app-screen').classList.remove('hidden');
  el('who-name').textContent = session.name;
  if (session.role === 'admin') {
    el('admin-view').classList.remove('hidden');
    el('teacher-view').classList.add('hidden');
    loadAdmin(session);
  } else {
    el('teacher-view').classList.remove('hidden');
    el('admin-view').classList.add('hidden');
    loadTeacher(session);
  }
}

// ---- вход ----
el('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var name = el('login-name').value.trim();
  var pin = el('login-pin').value.trim();
  el('login-error').textContent = '';
  apiPost('login', { name: name, pin: pin }).then(function (res) {
    if (!res.ok) { el('login-error').textContent = res.error; return; }
    setSession(res.data);
    showApp(res.data);
  }).catch(function () {
    el('login-error').textContent = 'Не удалось связаться с сервером. Проверьте интернет и попробуйте снова.';
  });
});

el('logout-btn').addEventListener('click', function () {
  clearSession();
  showLogin();
});

// ---- добавление занятия (учитель) ----
el('add-lesson-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var session = getSession();
  if (!session) return;
  var student = el('add-student').value.trim();
  var date = el('add-date').value;
  var time = el('add-time').value;
  el('add-lesson-error').textContent = '';
  apiPost('addLesson', { token: session.token, student: student, date: date, time: time }).then(function (res) {
    if (!res.ok) {
      if (res.error === 'Нет доступа: войдите заново' || res.error === 'Сессия истекла, войдите заново') return handleAuthError(res);
      el('add-lesson-error').textContent = res.error;
      return;
    }
    el('add-student').value = '';
    el('add-date').value = '';
    el('add-time').value = '';
    loadTeacher(session);
  }).catch(function () {
    el('add-lesson-error').textContent = 'Не удалось связаться с сервером. Попробуйте снова.';
  });
});

// ---- вид учителя ----
function loadTeacher(session) {
  var box = el('lessons-list');
  box.className = 'loading';
  box.textContent = 'Загрузка…';
  apiGet('list', { token: session.token }).then(function (res) {
    if (!res.ok) { return handleAuthError(res); }
    renderLessons(box, res.data, session, false);
  });
}

function renderLessons(box, lessons, session, isAdmin) {
  box.className = '';
  box.innerHTML = '';
  if (!lessons.length) {
    box.innerHTML = '<div class="empty">Занятий пока нет</div>';
    return;
  }
  lessons.sort(function (a, b) {
    return (a.date + a.time).localeCompare(b.date + b.time);
  });
  lessons.forEach(function (lesson) {
    var item = document.createElement('div');
    item.className = 'lesson-item';

    var row = document.createElement('div');
    row.className = 'lesson';
    var studentOrTeacher = isAdmin ? lesson.teacher + ' → ' + lesson.student : lesson.student;
    row.innerHTML =
      '<div class="date">' + lesson.date + '</div>' +
      '<div><div class="student">' + escapeHtml(studentOrTeacher) + '</div><div class="time">' + lesson.time + '</div></div>' +
      '<span class="badge ' + STATUS_CLASS[lesson.status] + '">' + STATUS_LABEL[lesson.status] + '</span>';

    var actionCell = document.createElement('div');
    if (!isAdmin) {
      if (lesson.status === 'Запланировано') {
        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Отметить проведённым';
        doneBtn.addEventListener('click', function () { toggle(lesson.rowId, 'Проведено', session); });
        actionCell.appendChild(doneBtn);
      } else if (lesson.status === 'Проведено') {
        var undoBtn = document.createElement('button');
        undoBtn.className = 'secondary';
        undoBtn.textContent = 'Отменить отметку';
        undoBtn.addEventListener('click', function () { toggle(lesson.rowId, 'Запланировано', session); });
        actionCell.appendChild(undoBtn);
      }
    }
    row.appendChild(actionCell);
    item.appendChild(row);

    if (isAdmin) {
      if (lesson.comment) {
        var viewComment = document.createElement('div');
        viewComment.className = 'comment-view';
        viewComment.textContent = lesson.comment;
        item.appendChild(viewComment);
      }
    } else {
      var commentInput = document.createElement('input');
      commentInput.type = 'text';
      commentInput.className = 'comment-input';
      commentInput.placeholder = 'Заметка к занятию (время, о чём договорились...)';
      commentInput.value = lesson.comment || '';
      commentInput.addEventListener('change', function () {
        saveLessonComment(lesson.rowId, commentInput.value, session);
      });
      item.appendChild(commentInput);
    }

    box.appendChild(item);
  });
}

function saveLessonComment(rowId, comment, session) {
  apiPost('setLessonComment', { token: session.token, rowId: rowId, comment: comment }).then(function (res) {
    if (!res.ok) handleAuthError(res);
  });
}

function toggle(rowId, status, session) {
  apiPost('toggle', { token: session.token, rowId: rowId, status: status }).then(function (res) {
    if (!res.ok) { return handleAuthError(res); }
    if (session.role === 'admin') loadAdmin(session); else loadTeacher(session);
  });
}

// ---- вид админа ----
var currentFilter = 'all';

function loadAdmin(session) {
  el('summary-table').className = 'loading';
  el('summary-table').textContent = 'Загрузка…';
  el('all-lessons').className = 'loading';
  el('all-lessons').textContent = 'Загрузка…';
  apiGet('admin', { token: session.token }).then(function (res) {
    if (!res.ok) { return handleAuthError(res); }
    renderSummary(res.data.summary, session);
    renderFilters(session);
    renderAllLessons(res.data.lessons, session);
  });
}

function renderSummary(summary, session) {
  var box = el('summary-table');
  box.className = '';
  if (!summary.length) { box.innerHTML = '<div class="empty">Пока нет данных</div>'; return; }
  summary.sort(function (a, b) { return b.planned - a.planned; });
  box.innerHTML = '';
  var table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Учитель</th><th>Проведено</th><th>Запланировано</th><th>Отменено</th><th>Комментарий (видишь только ты)</th></tr></thead>';
  var tbody = document.createElement('tbody');
  summary.forEach(function (t) {
    var overload = t.planned >= OVERLOAD_THRESHOLD;
    var tr = document.createElement('tr');
    if (overload) tr.className = 'overload';
    tr.innerHTML =
      '<td>' + escapeHtml(t.teacher) + (overload ? ' ⚠' : '') + '</td>' +
      '<td class="count">' + t.done + '</td>' +
      '<td class="count">' + t.planned + '</td>' +
      '<td class="count">' + t.cancelled + '</td>';
    var commentTd = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'comment-input';
    input.placeholder = 'Заметка об учителе...';
    input.value = t.comment || '';
    input.addEventListener('change', function () {
      apiPost('setTeacherComment', { token: session.token, teacher: t.teacher, comment: input.value }).then(function (res) {
        if (!res.ok) handleAuthError(res);
      });
    });
    commentTd.appendChild(input);
    tr.appendChild(commentTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
}

function renderFilters(session) {
  var box = el('admin-filters');
  box.innerHTML = '';
  [['all', 'Все'], ['Запланировано', 'План'], ['Проведено', 'Проведено'], ['Отменено', 'Отменено']].forEach(function (pair) {
    var btn = document.createElement('button');
    btn.className = 'secondary' + (currentFilter === pair[0] ? ' active' : '');
    btn.textContent = pair[1];
    btn.addEventListener('click', function () {
      currentFilter = pair[0];
      loadAdmin(session);
    });
    box.appendChild(btn);
  });
}

function renderAllLessons(lessons, session) {
  var filtered = currentFilter === 'all' ? lessons : lessons.filter(function (l) { return l.status === currentFilter; });
  renderLessons(el('all-lessons'), filtered, session, true);
}

// ---- утилиты ----
function handleAuthError(res) {
  el('login-error').textContent = '';
  clearSession();
  showLogin();
  el('login-error').textContent = res.error || 'Войдите заново';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---- старт ----
(function init() {
  var session = getSession();
  if (session && session.token) showApp(session); else showLogin();
})();
