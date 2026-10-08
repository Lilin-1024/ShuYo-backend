function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function shell(title, body, csrfToken = '') {
  const pageBody = csrfToken
    ? body.replace(/(<form\b[^>]*method="post"[^>]*>)/gi,
      (form) => form + '<input type="hidden" name="_csrf" value="' + escapeHtml(csrfToken) + '" />')
    : body;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --panel: #ffffff;
      --line: #e4ebf2;
      --text: #243447;
      --muted: #6b7785;
      --accent: #1976d2;
      --input: #ffffff;
      --accent-soft: #edf4fb;
      --warn: #ad6a00;
      --ok: #1976d2;
      --bad: #a63a32;
      --shadow: none;
      --stat-line: #e4ebf2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page {
      max-width: 1080px;
      margin: auto;
      padding: 30px 24px 60px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
      margin-bottom: 28px;
    }
    .title {
      font-size: 28px;
      font-weight: 700;
      margin: 0;
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
      margin-top: 6px;
    }
    .btn, button {
      border: 0;
      background: var(--accent);
      color: #fff;
      padding: 8px 14px;
      border-radius: 0;
      font-size: 14px;
      cursor: pointer;
    }
    .btn:hover, button:hover { text-decoration: underline; }
    .btn.secondary {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .btn.danger,
    button.danger {
      background: var(--accent-soft);
      color: var(--bad);
    }
    .btn.small-btn,
    button.small-btn {
      padding: 6px 9px;
      border-radius: 0;
      font-size: 12px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 22px;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    label {
      display: block;
      font-size: 14px;
      color: var(--text);
      margin-bottom: 12px;
    }
    input[type="text"],
    input:not([type]),
    input[type="number"],
    input[type="password"],
    textarea,
    select {
      width: 100%;
      border: 1px solid #b8c5d1;
      border-radius: 0;
      padding: 10px 12px;
      font: inherit;
      background: var(--input);
      color: var(--text);
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    .row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }
    .stats-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 0;
      margin-bottom: 24px;
      padding: 24px;
      overflow: hidden;
      box-shadow: none;
    }
    .stat {
      border-right: 0;
      padding: 0 12px 0 0;
    }
    .stat:last-child {
      border-right: 0;
    }
    .stat .value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.1;
      margin-top: 8px;
    }
    .muted { color: var(--muted); }
    .version-form { display: grid; grid-template-columns: 1fr; gap: 20px; max-width: 820px; }
    .version-form .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
    .version-form label { margin: 0; font-weight: 600; }
    .version-form label input, .version-form label select { display: block; margin-top: 8px; }
    .version-form button { justify-self: start; min-width: 116px; min-height: 42px; }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .table th, .table td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 0;
      font-size: 12px;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .badge.ok, .badge.warn { background: var(--accent-soft); color: var(--accent); }
    .badge.bad { background: #fff1ef; color: var(--bad); }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      gap: 16px;
    }
    .item-list {
      display: grid;
      gap: 12px;
    }
    .item {
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
    }
    .item:last-child { border-bottom: 0; }
    .small {
      font-size: 12px;
      color: var(--muted);
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      word-break: break-all;
    }
    .notice {
      background: var(--accent-soft);
      border: 0;
      padding: 12px 14px;
      border-radius: 0;
      margin-bottom: 16px;
    }
    .error {
      background: var(--accent-soft);
      border: 0;
      color: var(--text);
      padding: 12px 14px;
      border-radius: 0;
      margin-bottom: 16px;
    }
    .nav { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-bottom: 28px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
    .nav a { color: var(--muted); padding: 0; }
    .nav a.active { font-weight: 700; color: var(--accent); }
    .nav-account { margin-left: auto; font-size: 13px; }
    .nav form { margin: 0; }
    .nav button { background: transparent; color: var(--muted); padding: 0; }
    .admin-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; border-bottom: 1px solid var(--line); padding: 14px 0; }
    .admin-row form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; }
    .admin-row button { min-height: 39px; }
    .admin-row select, .admin-row input { width: auto; max-width: 240px; }
    .admin-row .mono { font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    .content-header { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin: 24px 0 32px; }
    .content-header h1 { font-size: 32px; margin: 0 0 8px; color: var(--accent); }
    .content-header p { color: var(--muted); margin: 0; }
    .eyebrow { color: var(--accent) !important; font-size: 12px; letter-spacing: .12em; margin-bottom: 6px !important; }
    .panel { border: 1px solid var(--line); padding: 28px; margin-bottom: 24px; background: #fff; }
    .section-heading { margin-bottom: 22px; }
    .section-heading h2 { margin: 0 0 6px; color: var(--text); font-size: 20px; }
    .section-heading p { margin: 0; color: var(--muted); font-size: 14px; }
    .editor-form { display: grid; gap: 20px; max-width: 800px; }
    .editor-form label { color: var(--text); font-weight: 600; margin: 0; }
    .editor-form input, .editor-form textarea { display: block; margin-top: 8px; }
    .editor-form textarea { min-height: 160px; line-height: 1.65; }
    .editor-form button, .upload-form button { min-width: 118px; min-height: 42px; }
    .editor-form .checkbox-row { display: flex; align-items: center; gap: 10px; font-weight: 400; }
    .checkbox-row input { width: 18px; height: 18px; margin: 0; }
    .upload-form { display: flex; align-items: end; gap: 20px; flex-wrap: wrap; }
    .upload-form label { margin: 0; }
    .upload-form input { display: block; margin-top: 8px; }
    .publication-list { display: grid; gap: 16px; }
    .publication-card { border: 1px solid var(--line); padding: 22px; }
    .publication-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .publication-title-row h3 { font-size: 18px; margin: 0; }
    .publication-meta { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
    .publication-excerpt { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: hidden; margin: 16px 0; }
    .publication-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 18px 0 6px; }
    .publication-actions form { margin: 0; }
    .publication-actions button { min-height: 36px; }
    button:disabled { opacity: .45; cursor: default; }
    details { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 14px; }
    details summary { color: var(--accent); cursor: pointer; font-weight: 600; }
    details .editor-form { margin-top: 20px; }
    .publication-delete p { color: var(--muted); font-size: 13px; }
    .markdown-preview { max-height: 230px; overflow: auto; line-height: 1.65; margin: 16px 0; }
    .markdown-preview img { display: block; max-width: 100%; height: auto; margin: 12px 0; }
    .markdown-preview pre { overflow: auto; background: var(--accent-soft); padding: 12px; }
    .stat .value { color: var(--accent); font-size: 28px; }
    .card, .stats-card { box-shadow: none; }
    @media (max-width: 900px) {
      .grid, .grid-3, .stats, .split {
        grid-template-columns: 1fr;
      }
      .version-form .grid { grid-template-columns: 1fr; }
      .stat {
        border-right: 0;
        border-bottom: 1px solid var(--stat-line);
      }
      .stat:last-child {
        border-bottom: 0;
      }
      .page { padding: 16px; }
      .card, .stats-card { padding: 18px; }
      .nav-account { margin-left: 0; }
      .admin-row { grid-template-columns: 1fr; }
      .content-header { align-items: start; flex-direction: column; }
      .panel { padding: 18px; }
      .publication-card { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="page">
    ${pageBody}
  </div>
</body>
</html>`;
}

function renderLoginPage({ errorMessage = '', csrfToken = '' } = {}) {
  const error = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : '';

  return shell(
    '管理员登录',
    `<div class="card" style="max-width: 480px; margin: 72px auto 0;">
      <h1 class="title">管理员登录</h1>
      <p class="subtitle">用于管理版本、公告和反馈回复。</p>
      ${error}
      <form method="post" action="/admin/login">
        <label for="username">登录名</label>
        <input id="username" name="username" type="text" autocomplete="username" required />
        <label for="password">管理员密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <div style="margin-top: 16px;">
          <button type="submit">登录</button>
        </div>
      </form>
    </div>`,
    csrfToken
  );
}

function previewText(value, maxLength) {
  const text = String(value ?? '');
  return `${escapeHtml(text.slice(0, maxLength))}${text.length > maxLength ? '...' : ''}`;
}

function feedbackBadgeClass(status) {
  if (status === 'open') {
    return 'warn';
  }

  if (status === 'closed') {
    return 'bad';
  }

  return 'ok';
}

function blockedFeedbackDevice(state, deviceId) {
  const normalized = String(deviceId ?? '').trim();
  if (!normalized) {
    return null;
  }

  return (state?.blockedFeedbackDevices ?? []).find((item) => item.deviceId === normalized) ?? null;
}

function feedbackDeviceText(item) {
  const deviceId = String(item?.deviceId ?? '').trim();
  return deviceId || '-';
}

function renderFeedbackDeviceBlockForm({ deviceId, blocked, returnTo }) {
  const normalized = String(deviceId ?? '').trim();
  if (!normalized || normalized === '-') {
    return '';
  }

  return `<form method="post" action="/admin/feedback/device-block" style="display: inline;">
    <input type="hidden" name="deviceId" value="${escapeHtml(normalized)}" />
    <input type="hidden" name="blocked" value="${blocked ? 'false' : 'true'}" />
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    <button class="${blocked ? 'small-btn' : 'small-btn danger'}" type="submit">${blocked ? '解除拉黑' : '拉黑'}</button>
  </form>`;
}

function renderFeedbackAccountBlockForm({ accountId, blocked, returnTo }) {
  if (!accountId) return '';
  return `<form method="post" action="/admin/feedback/account-block" style="display: inline;">
    <input type="hidden" name="accountId" value="${escapeHtml(accountId)}" />
    <input type="hidden" name="blocked" value="${blocked ? 'false' : 'true'}" />
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    <button class="${blocked ? 'small-btn' : 'small-btn danger'}" type="submit">${blocked ? '解除账户拉黑' : '拉黑账户'}</button>
  </form>`;
}

function renderFeedbackItems(feedbackItems, state, returnTo) {
  if (!feedbackItems.length) {
    return '<div class="small">暂无反馈。</div>';
  }

  return feedbackItems
    .map((item) => {
      const deviceId = feedbackDeviceText(item);
      const student = item.source === 'student';
      const blocked = student ? item.blocked : Boolean(blockedFeedbackDevice(state, deviceId));
      return `
        <div class="item">
          <div class="row" style="justify-content: space-between; align-items: start;">
            <div>
              <div style="font-weight: 600;">
                <a href="/admin/feedback/${encodeURIComponent(item.id)}">${escapeHtml(item.title || '未命名反馈')}</a>
              </div>
              <div class="small">${previewText(item.content, 120)}</div>
              <div class="small" style="margin-top: 6px;">${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(item.appVersion || '-')}</div>
              <div class="small mono" style="margin-top: 4px;">${student ? '已核验账户：' + escapeHtml(item.accountId) : '旧版设备码：' + escapeHtml(deviceId)}</div>
            </div>
            <div class="row" style="justify-content: flex-end;">
              ${blocked ? '<span class="badge bad">已拉黑</span>' : ''}
              <span class="badge ${student ? 'ok' : 'warn'}">${student ? '账户反馈' : '旧版反馈'}</span>
              <span class="badge ${feedbackBadgeClass(item.status)}">${escapeHtml(item.status)}</span>
              ${student
                ? renderFeedbackAccountBlockForm({ accountId: item.accountId, blocked, returnTo })
                : renderFeedbackDeviceBlockForm({ deviceId, blocked, returnTo })}
            </div>
          </div>
        </div>`;
    })
    .join('');
}

function renderBlockedFeedbackDevices(state) {
  const devices = state.blockedFeedbackDevices ?? [];
  if (!devices.length) {
    return '<div class="small">暂无拉黑标识。</div>';
  }

  return devices
    .map(
      (item) => `
        <div class="item">
          <div class="row" style="justify-content: space-between; align-items: start;">
            <div>
              <div class="mono">${escapeHtml(item.deviceId)}</div>
              <div class="small" style="margin-top: 4px;">拉黑时间：${escapeHtml(formatDateTime(item.blockedAt))}</div>
            </div>
            ${renderFeedbackDeviceBlockForm({
              deviceId: item.deviceId,
              blocked: true,
              returnTo: '/admin/feedback'
            })}
          </div>
        </div>`
    )
    .join('');
}

function renderAnnouncementItems(items) {
  if (!items.length) return '<p class="muted">暂无公告。</p>';
  return items.map((item) => `<div class="item">
    <strong>${escapeHtml(item.title)}</strong>
    <span class="badge ${item.active !== false ? 'ok' : 'bad'}">${item.active !== false ? '公开' : '待选择'}</span>
    <p class="muted">${previewText(item.content, 140)}</p>
    <small>${escapeHtml(formatDateTime(item.createdAt))}</small>
  </div>`).join('');
}

function adminNav(active, admin) {
  const links = [['', '仪表盘'], ['version', '版本'], ['announcements', '公告'], ['tips', '使用提示'], ['feedback', '反馈'], ['account', '我的账号']];
  if (admin?.role === 'superadmin') links.push(['admins', '管理员'], ['students', '学生身份'], ['audit', '操作记录']);
  return `<nav class="nav" aria-label="后台导航">${links.map(([route, label]) => `<a class="${active === (route || 'dashboard') ? 'active' : ''}" href="/admin${route ? `/${route}` : ''}">${label}</a>`).join('')}<span class="nav-account">${escapeHtml(admin?.username ?? '')}</span><form method="post" action="/admin/logout"><button type="submit">退出</button></form></nav>`;
}

function renderAccountPage({ admin, csrfToken, message = '' }) {
  return shell('我的账号', `${adminNav('account', admin)}
    <h1 class="title">我的账号</h1>
    <p class="subtitle">${escapeHtml(admin.username)} · ${admin.role === 'superadmin' ? '总管理员' : '内容管理员'}</p>
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}
    <form class="version-form" method="post" action="/admin/account/password">
      <label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required /></label>
      <label>新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="12" required /></label>
      <button type="submit">修改密码</button>
    </form>`, csrfToken);
}

function renderAdminListPage({ admins, admin, csrfToken, message = '' }) {
  const rows = admins.map((item) => `
    <div class="admin-row">
      <div><strong>${escapeHtml(item.username)}</strong>
        <span class="badge ${item.active ? 'ok' : 'bad'}">${item.active ? '正常' : '已停用'}</span>
        <div class="small mono">${escapeHtml(item.id)}</div></div>
      <div>
        <form method="post" action="/admin/admins/${encodeURIComponent(item.id)}/update">
          <select name="role" aria-label="角色">
            <option value="content"${item.role === 'content' ? ' selected' : ''}>内容管理员</option>
            <option value="superadmin"${item.role === 'superadmin' ? ' selected' : ''}>总管理员</option>
          </select>
          <select name="active" aria-label="账号状态">
            <option value="true"${item.active ? ' selected' : ''}>正常</option>
            <option value="false"${item.active ? '' : ' selected'}>停用</option>
          </select>
          <button type="submit">保存</button>
        </form>
        <form method="post" action="/admin/admins/${encodeURIComponent(item.id)}/password">
          <input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="新密码" aria-label="新密码" required />
          <button type="submit">重设密码</button>
        </form>
      </div>
    </div>`).join('');
  return shell('管理员', `${adminNav('admins', admin)}
    <h1 class="title">管理员</h1>
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}
    <div class="split" style="margin-top: 20px;">
      <section class="card">
        <h2>现有账号</h2>${rows || '<p>暂无账号。</p>'}
      </section>
      <section class="card">
        <h2>添加管理员</h2>
        <form class="version-form" method="post" action="/admin/admins">
          <label>登录名<input name="username" type="text" pattern="[a-z][a-z0-9_-]{2,31}" required /></label>
          <label>初始密码<input name="password" type="password" minlength="12" autocomplete="new-password" required /></label>
          <label>权限<select name="role"><option value="content">内容管理员</option><option value="superadmin">总管理员</option></select></label>
          <button type="submit">创建账号</button>
        </form>
      </section>
    </div>`, csrfToken);
}

function renderStudentListPage({ accounts, accountId = '', admin, csrfToken }) {
  const rows = accounts.map((item) => `
    <div class="admin-row">
      <div><strong>${escapeHtml(item.student_id_masked)}</strong>
        <div class="small mono">${escapeHtml(item.id)}</div>
        <div class="small">最近核验：${escapeHtml(formatDateTime(item.last_verified_at))}</div></div>
      <form method="post" action="/admin/students/${encodeURIComponent(item.id)}/reveal">
        <select name="reason" aria-label="查看原因" required>
          <option value="feedback">反馈处理</option>
          <option value="appeal">账号申诉</option>
          <option value="security">安全排查</option>
        </select>
        <button type="submit">查看完整学号</button>
      </form>
    </div>`).join('');
  return shell('学生身份', `${adminNav('students', admin)}
    <h1 class="title">学生身份</h1>
    <form method="get" action="/admin/students" class="row" style="margin: 18px 0;">
      <input style="max-width: 360px;" name="accountId" aria-label="账户 ID" placeholder="按账户 ID 查找" value="${escapeHtml(accountId)}" />
      <button type="submit">查找</button>
    </form>
    <div class="card">${rows || '<p>暂无已核验账户。</p>'}</div>`, csrfToken);
}

function renderStudentRevealPage({ account, studentId, admin, csrfToken }) {
  return shell('完整学号', `${adminNav('students', admin)}
    <h1 class="title">完整学号</h1>
    <p class="mono">${escapeHtml(studentId)}</p>
    <p class="small mono">账户 ${escapeHtml(account.id)}</p>
    <a href="/admin/students">返回学生身份</a>`, csrfToken);
}

function renderAuditPage({ entries, admin, csrfToken }) {
  const rows = entries.map((item) => `<tr>
    <td>${escapeHtml(formatDateTime(item.occurred_at))}</td>
    <td>${escapeHtml(item.actor_name || '-')}</td>
    <td>${escapeHtml(item.action)}</td>
    <td class="mono">${escapeHtml(item.target_id || '-')}</td>
    <td>${escapeHtml(item.detail)}</td>
  </tr>`).join('');
  return shell('操作记录', `${adminNav('audit', admin)}
    <h1 class="title">操作记录</h1>
    <p class="subtitle">仅保留最近 100 条。</p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`, csrfToken);
}

function renderDashboard({
  state,
  feedbackItems,
  announcementItems,
  presence = {},
  webVpnStatus = {},
  message = '',
  csrfToken = '',
  admin
}) {
  const meta = state.meta;
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const openCount = feedbackItems.filter((item) => item.status === 'open').length;
  const repliedCount = feedbackItems.filter((item) => item.status === 'replied').length;
  const closedCount = feedbackItems.filter((item) => item.status === 'closed').length;
  const latestFeedback = feedbackItems.slice(0, 6);
  const webVpnPresentation = {
    available: { label: '正常', badge: 'ok' },
    degraded: { label: '可能不稳定', badge: 'warn' },
    unavailable: { label: '不可用', badge: 'bad' },
    unknown: { label: '状态未知', badge: 'warn' }
  }[webVpnStatus.status] ?? { label: '状态未知', badge: 'warn' };
  const webVpnCheckedAt = webVpnStatus.checkedAt
    ? formatDateTime(webVpnStatus.checkedAt)
    : '尚未检查';

  return shell(
    'ShuYo 后台',
    `${adminNav('dashboard', admin)}
    <div class="topbar">
      <div>
        <h1 class="title">${escapeHtml(meta.appName)} 后台</h1>
      </div>
      <div class="row">
        <a class="btn secondary" href="/admin/feedback">查看反馈</a>
      </div>
    </div>
    ${notice}
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="muted">WebVPN 服务状态</div>
          <div style="margin-top: 8px;">最近检查：${escapeHtml(webVpnCheckedAt)}</div>
        </div>
        <span class="badge ${webVpnPresentation.badge}">${webVpnPresentation.label}</span>
      </div>
    </div>
    <div class="stats-card">
      <div class="stats">
        <div class="stat"><div class="muted">近 1 日活跃用户</div><div class="value">${Number(presence.active1d ?? 0)}</div></div>
        <div class="stat"><div class="muted">近 3 日活跃用户</div><div class="value">${Number(presence.active3d ?? 0)}</div></div>
        <div class="stat"><div class="muted">近 7 日活跃用户</div><div class="value">${Number(presence.active7d ?? 0)}</div></div>
        <div class="stat"><div class="muted">累计已核验活跃账户</div><div class="value">${Number(presence.total ?? 0)}</div></div>
      </div>
      <p class="small">按北京时间自然日及已核验学生账户去重；未核验用户不计入。旧版自报数据已退出统计口径。</p>
    </div>
    <div class="stats-card">
      <div class="stats">
        <div class="stat"><div class="muted">总反馈</div><div class="value">${feedbackItems.length}</div></div>
        <div class="stat"><div class="muted">待处理</div><div class="value">${openCount}</div></div>
        <div class="stat"><div class="muted">已回复</div><div class="value">${repliedCount}</div></div>
        <div class="stat"><div class="muted">已关闭</div><div class="value">${closedCount}</div></div>
      </div>
    </div>

    <div class="card">
        <div class="row" style="justify-content: space-between; align-items: center;"><h2 class="title" style="font-size: 20px;">反馈概况</h2><a href="/admin/feedback">全部反馈</a></div>
        <div class="item-list">
          ${renderFeedbackItems(latestFeedback, state, '/admin')}
        </div>
    </div>`,
    csrfToken
  );
}

function renderVersionPage({ state, message = '', csrfToken = '', admin }) {
  const meta = state.meta;
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  return shell('版本设置', `${adminNav('version', admin)}
    <header class="content-header">
      <div><p class="eyebrow">应用管理</p><h1>版本设置</h1><p>更新应用版本和启动提示。</p></div>
    </header>
    ${notice}
    <section class="panel">
      <form class="version-form" method="post" action="/admin/version">
        <div class="grid">
          <label>应用名称<input name="appName" value="${escapeHtml(meta.appName)}" /></label>
          <label>最新版本号<input name="latestVersion" value="${escapeHtml(meta.latestVersion)}" required /></label>
          <label>Build 号<input name="latestBuild" type="number" min="1" value="${escapeHtml(meta.latestBuild)}" required /></label>
          <label>下载地址<input name="downloadUrl" value="${escapeHtml(meta.downloadUrl)}" /></label>
          <label>更新标题<input name="updateTitle" value="${escapeHtml(meta.updateTitle)}" /></label>
          <label>强制更新<select name="forceUpdate">
            <option value="false"${meta.forceUpdate ? '' : ' selected'}>否</option>
            <option value="true"${meta.forceUpdate ? ' selected' : ''}>是</option>
          </select></label>
        </div>
        <label>更新说明<textarea name="updateMessage">${escapeHtml(meta.updateMessage)}</textarea></label>
        <label>弹窗通告<textarea name="noticeText">${escapeHtml(meta.noticeText)}</textarea></label>
        <button type="submit">保存版本设置</button>
      </form>
    </section>`, csrfToken);
}

function renderFeedbackListPage({ state, feedbackItems, accountBlocks = [], message = '', csrfToken = '', admin }) {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const openCount = feedbackItems.filter((item) => item.status === 'open').length;

  return shell(
    '反馈列表',
    `${adminNav('feedback', admin)}<div class="topbar">
      <div>
        <h1 class="title">反馈列表</h1>
        <div class="subtitle"><a href="/admin">返回后台</a> · 共 ${feedbackItems.length} 条，${openCount} 条待处理</div>
      </div>

    </div>
    ${notice}
    <div class="card">
      <div class="item-list">
        ${renderFeedbackItems(feedbackItems, state, '/admin/feedback')}
      </div>
    </div>
    <div class="card">
      <h2 class="title" style="font-size: 20px;">已拉黑发送者</h2>
      <p class="subtitle">旧版按设备码拉黑；新版按已核验学生账户拉黑。</p>
      <div class="item-list">
        ${renderBlockedFeedbackDevices(state)}
        ${accountBlocks.map((item) => `<div class="item"><div class="small mono">已核验账户：${escapeHtml(item.accountId)} · ${escapeHtml(formatDateTime(item.blockedAt))}</div>${renderFeedbackAccountBlockForm({ accountId: item.accountId, blocked: true, returnTo: '/admin/feedback' })}</div>`).join('')}
      </div>
    </div>`,
    csrfToken
  );
}

function renderFeedbackDetail({ state, item, message = '', csrfToken = '', admin }) {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const replies = Array.isArray(item.replies) ? item.replies : [];
  const deviceId = feedbackDeviceText(item);
  const student = item.source === 'student';
  const blockedDevice = student ? null : blockedFeedbackDevice(state, deviceId);
  const isBlocked = student ? item.blocked : Boolean(blockedDevice);

  return shell(
    `反馈 ${item.id}`,
    `${adminNav('feedback', admin)}<div class="topbar">
      <div>
        <h1 class="title">反馈详情</h1>
        <div class="subtitle"><a href="/admin">返回后台</a> · ${escapeHtml(item.id)}</div>
      </div>
      <div class="row">
        <span class="badge ${item.status === 'open' ? 'warn' : item.status === 'closed' ? 'bad' : 'ok'}">${escapeHtml(item.status)}</span>
        <span class="badge ${student ? 'ok' : 'warn'}">${student ? '账户反馈' : '旧版反馈'}</span>
        ${isBlocked ? '<span class="badge bad">发送者已拉黑</span>' : ''}
      </div>
    </div>
    ${notice}
    <div class="card">
      <div class="grid">
        <div>
          <div class="small">标题</div>
          <div style="font-size: 18px; font-weight: 700; margin-top: 6px;">${escapeHtml(item.title || '未命名反馈')}</div>
        </div>
        <div>
          <div class="small">提交时间</div>
          <div style="margin-top: 6px;">${escapeHtml(formatDateTime(item.createdAt))}</div>
        </div>
        <div>
          <div class="small">客户端版本</div>
          <div style="margin-top: 6px;">${escapeHtml(item.appVersion || '-')}</div>
        </div>
        <div>
          <div class="small">联系方式</div>
          <div style="margin-top: 6px;">${escapeHtml(item.contact || '-')}</div>
        </div>
        <div>
          <div class="small">平台</div>
          <div style="margin-top: 6px;">${escapeHtml(item.platform || '-')}</div>
        </div>
        <div>
          <div class="small">${student ? '已核验账户标识' : '旧版设备码'}</div>
          <div class="mono" style="margin-top: 6px;">${escapeHtml(student ? item.accountId : deviceId)}</div>
          ${student && admin.role === 'superadmin' ? `<a href="/admin/students?accountId=${encodeURIComponent(item.accountId)}">按用途查看学号</a>` : ''}
        </div>
      </div>
      <div class="row" style="margin-top: 16px;">
        ${isBlocked ? '<span class="small">该发送者已被拉黑。</span>' : '<span class="small">该发送者当前未被拉黑。</span>'}
        ${student
          ? renderFeedbackAccountBlockForm({ accountId: item.accountId, blocked: isBlocked, returnTo: `/admin/feedback/${encodeURIComponent(item.id)}` })
          : renderFeedbackDeviceBlockForm({ deviceId, blocked: isBlocked, returnTo: `/admin/feedback/${encodeURIComponent(item.id)}` })}
      </div>
      <div style="margin-top: 16px;">
        <div class="small">内容</div>
        <div style="margin-top: 6px; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(item.content)}</div>
      </div>
    </div>

    <div class="split">
      <div class="card">
        <h2 class="title" style="font-size: 20px;">回复</h2>
        ${
          replies.length
            ? replies
                .map(
                  (reply) => `
              <div class="item">
                <div class="small">${escapeHtml(formatDateTime(reply.createdAt))} · ${escapeHtml(reply.author || 'admin')}</div>
                <div style="margin-top: 6px; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(reply.message)}</div>
              </div>`
                )
                .join('')
            : '<div class="small" style="margin-top: 10px;">暂无回复。</div>'
        }
      </div>

      <div class="card">
        <h2 class="title" style="font-size: 20px;">新增回复</h2>
        <form method="post" action="/admin/feedback/${encodeURIComponent(item.id)}/reply">
          <div>
            <label for="replyMessage">回复内容</label>
            <textarea id="replyMessage" name="message" required></textarea>
          </div>
          <div style="margin-top: 12px;">
            <label for="status">状态</label>
            <select id="status" name="status">
              <option value="auto"${item.status === 'closed' ? '' : ' selected'}>回复后设为已回复</option>
              <option value="open">保持待处理</option>
              <option value="closed"${item.status === 'closed' ? ' selected' : ''}>关闭</option>
            </select>
          </div>
          <div style="margin-top: 12px;">
            <button type="submit">保存回复</button>
          </div>
        </form>
      </div>
    </div>`,
    csrfToken
  );
}

export {
  adminNav,
  escapeHtml,
  formatDateTime,
  renderAccountPage,
  renderAdminListPage,
  renderAuditPage,
  renderDashboard,
  renderFeedbackDetail,
  renderFeedbackListPage,
  renderLoginPage,
  renderStudentListPage,
  renderStudentRevealPage,
  renderVersionPage,
  shell
};
