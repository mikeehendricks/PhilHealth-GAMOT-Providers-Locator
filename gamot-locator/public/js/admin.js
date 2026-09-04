/* GAMOT Locator — Admin portal client */
(function () {
  'use strict';

  var viewAuth = document.getElementById('view-auth');
  var viewDashboard = document.getElementById('view-dashboard');
  var authForm = document.getElementById('auth-form');
  var authMode = document.getElementById('auth-mode');
  var authTitle = document.getElementById('auth-title');
  var authSubtitle = document.getElementById('auth-subtitle');
  var authEmail = document.getElementById('auth-email');
  var authPassword = document.getElementById('auth-password');
  var authSubmit = document.getElementById('auth-submit');
  var authHint = document.getElementById('auth-hint');
  var authError = document.getElementById('auth-error');

  function api(path, method, body) {
    var opts = {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'gamot-admin' }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : 'Request failed');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function showAuth(mode) {
    viewDashboard.classList.add('hidden');
    viewAuth.classList.remove('hidden');
    authError.textContent = '';
    if (mode === 'register') {
      authMode.value = 'register';
      authTitle.textContent = 'Create first administrator';
      authSubtitle.textContent = 'This is a one-time setup. Register the first admin account.';
      authSubmit.textContent = 'Create account';
      authHint.textContent = 'This can only be done once.';
    } else {
      authMode.value = 'login';
      authTitle.textContent = 'GAMOT Locator Admin';
      authSubtitle.textContent = 'Sign in to view website analytics.';
      authSubmit.textContent = 'Sign in';
      authHint.textContent = '';
    }
  }

  function showDashboard() {
    viewAuth.classList.add('hidden');
    viewDashboard.classList.remove('hidden');
    loadStats();
    loadVisitors();
    loadAdmins();
  }

  // ---------------- auth flow ----------------
  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authError.textContent = '';
    var email = authEmail.value.trim();
    var password = authPassword.value;
    var mode = authMode.value;
    if (!email || !password) return;

    authSubmit.disabled = true;
    api('/api/admin/' + (mode === 'register' ? 'register' : 'login'), 'POST', {
      email: email, password: password
    }).then(function () {
      authSubmit.disabled = false;
      showDashboard();
    }).catch(function (err) {
      authSubmit.disabled = false;
      authError.textContent = err.message || 'Something went wrong.';
    });
  });

  document.getElementById('btn-logout').addEventListener('click', function () {
    api('/api/admin/logout', 'POST').finally(function () {
      location.reload();
    });
  });

  // ---------------- stats ----------------
  function fmtNum(n) { return (n || 0).toLocaleString(); }

  function loadStats() {
    api('/api/admin/stats').then(function (s) {
      document.getElementById('stat-daily').textContent = fmtNum(s.daily);
      document.getElementById('stat-weekly').textContent = fmtNum(s.weekly);
      document.getElementById('stat-monthly').textContent = fmtNum(s.monthly);
      if (s.updatedAt) {
        document.getElementById('stats-updated').textContent =
          'Updated ' + new Date(s.updatedAt).toLocaleTimeString();
      }
      renderChart(s.byDay || []);
    }).catch(function (err) {
      if (err.status === 401) showAuth('login');
    });
  }

  function renderChart(byDay) {
    var chart = document.getElementById('chart');
    chart.innerHTML = '';
    if (!byDay.length) return;
    var max = 1;
    byDay.forEach(function (d) { if (d.count > max) max = d.count; });
    byDay.forEach(function (d) {
      var h = Math.max(d.count > 0 ? 4 : 2, Math.round((d.count / max) * 150));
      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = h + 'px';
      var tip = document.createElement('span');
      tip.className = 'tip';
      tip.textContent = d.count + ' view' + (d.count === 1 ? '' : 's');
      var label = document.createElement('span');
      label.className = 'xlabel';
      var parts = (d.date || '').split('-');
      label.textContent = parts.length === 3 ? (parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10)) : d.date;
      bar.appendChild(tip);
      bar.appendChild(label);
      chart.appendChild(bar);
    });
  }

  // ---------------- visitors ----------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtWhen(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function locationText(v) {
    var parts = [];
    if (v.city) parts.push(v.city);
    if (v.region) parts.push(v.region);
    if (v.country) parts.push(v.country);
    if (!parts.length) parts.push(v.isLocal ? 'Local network' : 'Unknown');
    return parts.join(', ');
  }

  function loadVisitors() {
    api('/api/admin/visitors').then(function (data) {
      document.getElementById('stat-online').textContent = fmtNum(data.online);
      var rows = document.getElementById('visitor-rows');
      rows.innerHTML = '';
      if (!data.visitors || !data.visitors.length) {
        rows.innerHTML = '<tr><td colspan="5" class="empty">No visitors online right now.</td></tr>';
        return;
      }
      data.visitors.forEach(function (v) {
        var tr = document.createElement('tr');
        var tdIp = document.createElement('td');
        tdIp.className = 'ip';
        tdIp.textContent = v.ip;
        if (v.isLocal) {
          var badge = document.createElement('span');
          badge.className = 'badge-local';
          badge.textContent = 'local';
          tdIp.appendChild(badge);
        }
        var tdLoc = document.createElement('td');
        tdLoc.className = 'loc';
        tdLoc.textContent = locationText(v);
        if (v.lat != null && v.lon != null) {
          var small = document.createElement('small');
          small.textContent = v.lat.toFixed(3) + ', ' + v.lon.toFixed(3);
          tdLoc.appendChild(small);
        }
        var tdFirst = document.createElement('td');
        tdFirst.textContent = fmtWhen(v.firstSeen);
        var tdLast = document.createElement('td');
        tdLast.textContent = fmtWhen(v.lastSeen);
        var tdViews = document.createElement('td');
        tdViews.className = 'num';
        tdViews.textContent = fmtNum(v.views);

        tr.appendChild(tdIp);
        tr.appendChild(tdLoc);
        tr.appendChild(tdFirst);
        tr.appendChild(tdLast);
        tr.appendChild(tdViews);
        rows.appendChild(tr);
      });
    }).catch(function (err) {
      if (err.status === 401) showAuth('login');
    });
  }

  // ---------------- administrators ----------------
  function loadAdmins() {
    api('/api/admin/admins').then(function (data) {
      var rows = document.getElementById('admin-rows');
      rows.innerHTML = '';
      (data.admins || []).forEach(function (a) {
        var tr = document.createElement('tr');
        var tdEmail = document.createElement('td');
        tdEmail.textContent = a.email;
        var tdRole = document.createElement('td');
        tdRole.textContent = a.role === 'admin' ? 'Administrator' : a.role;
        var tdCreated = document.createElement('td');
        tdCreated.textContent = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—';
        tr.appendChild(tdEmail);
        tr.appendChild(tdRole);
        tr.appendChild(tdCreated);
        rows.appendChild(tr);
      });
    }).catch(function (err) {
      if (err.status === 401) showAuth('login');
    });

    api('/api/admin/me').then(function (me) {
      document.getElementById('admin-email').textContent = me.email;
    }).catch(function (err) {
      if (err.status === 401) showAuth('login');
    });
  }

  document.getElementById('add-admin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('add-admin-error');
    err.textContent = '';
    var email = document.getElementById('new-admin-email').value.trim();
    var password = document.getElementById('new-admin-password').value;
    if (!email || !password) return;
    var btn = this.querySelector('button[type="submit"]');
    btn.disabled = true;
    api('/api/admin/add-admin', 'POST', { email: email, password: password })
      .then(function () {
        document.getElementById('new-admin-email').value = '';
        document.getElementById('new-admin-password').value = '';
        err.textContent = 'Administrator added.';
        err.style.color = 'var(--green)';
      })
      .catch(function (e2) {
        err.textContent = e2.message || 'Failed to add administrator.';
        err.style.color = '';
      })
      .finally(function () { btn.disabled = false; });
  });

  // ---------------- boot ----------------
  api('/api/admin/status').then(function (s) {
    if (s.setupRequired) {
      showAuth('register');
    } else {
      api('/api/admin/me').then(function () {
        showDashboard();
      }).catch(function () {
        showAuth('login');
      });
    }
  }).catch(function () {
    showAuth('login');
  });

  // auto-refresh visitors + stats
  setInterval(function () {
    if (!viewDashboard.classList.contains('hidden')) {
      loadVisitors();
      loadStats();
    }
  }, 30000);
})();
