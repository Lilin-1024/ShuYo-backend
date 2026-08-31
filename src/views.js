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

function shell(title, body) {
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
      --line: #000000;
      --text: #000000;
      --muted: #000000;
      --accent: #000000;
      --input: #ffffff;
      --accent-soft: #ffffff;
      --warn: #000000;
      --ok: #000000;
      --bad: #000000;
      --shadow: none;
      --stat-line: #000000;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page {
      max-width: 980px;
      margin: 0;
      padding: 16px 20px 40px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 12px;
    }
    .title {
      font-size: 24px;
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
      background: #fff;
      color: #000;
      padding: 4px 0;
      border-radius: 0;
      font-size: 14px;
      cursor: pointer;
    }
    .btn:hover, button:hover { text-decoration: underline; }
    .btn.secondary {
      background: var(--accent-soft);
      color: var(--text);
    }
    .btn.danger,
    button.danger {
      background: #fff;
      color: #000;
    }
    .btn.small-btn,
    button.small-btn {
      padding: 6px 9px;
      border-radius: 0;
      font-size: 12px;
    }
    .card {
      background: var(--panel);
      border: 0;
      border-radius: 0;
      padding: 0;
      margin-bottom: 18px;
      box-shadow: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    input[type="text"],
    input[type="number"],
    input[type="password"],
    textarea,
    select {
      width: 100%;
      border: 1px solid #aaa;
      border-radius: 0;
      padding: 8px 6px;
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
      gap: 0;
    }
    .stats-card {
      background: var(--panel);
      border: 0;
      border-radius: 0;
      margin-bottom: 22px;
      overflow: hidden;
      box-shadow: none;
    }
    .stat {
      border-right: 0;
      padding: 0 20px 0 0;
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
    .version-form { display: grid; grid-template-columns: 1fr; gap: 12px; max-width: 760px; }
    .version-form .grid { grid-template-columns: 1fr; gap: 12px; }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .table th, .table td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 0;
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
    .badge.bad { background: #000; color: #fff; }
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
      border-bottom: 0;
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
    .nav { display: flex; gap: 14px; margin-bottom: 16px; }
    .nav a { color: #000; padding: 0; }
    .nav a.active { font-weight: 700; }
    .stat .value { color: var(--accent); font-size: 28px; }
    .card, .stats-card { box-shadow: none; }
    @media (max-width: 900px) {
      .grid, .grid-3, .stats, .split {
        grid-template-columns: 1fr;
      }
      .stat {
        border-right: 0;
        border-bottom: 1px solid var(--stat-line);
      }
      .stat:last-child {
        border-bottom: 0;
      }
      .page { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="page">
    ${body}
  </div>
</body>
</html>`;
}

function renderLoginPage({ errorMessage = '' } = {}) {
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
        <label for="password">管理员密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <div style="margin-top: 16px;">
          <button type="submit">登录</button>
        </div>
      </form>
    </div>`
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

function renderFeedbackItems(feedbackItems, state, returnTo) {
  if (!feedbackItems.length) {
    return '<div class="small">暂无反馈。</div>';
  }

  return feedbackItems
    .map((item) => {
      const deviceId = feedbackDeviceText(item);
      const blocked = Boolean(blockedFeedbackDevice(state, deviceId));
      return `
        <div class="item">
          <div class="row" style="justify-content: space-between; align-items: start;">
            <div>
              <div style="font-weight: 600;">
                <a href="/admin/feedback/${encodeURIComponent(item.id)}">${escapeHtml(item.title || '未命名反馈')}</a>
              </div>
              <div class="small">${previewText(item.content, 120)}</div>
              <div class="small" style="margin-top: 6px;">${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(item.appVersion || '-')}</div>
              <div class="small mono" style="margin-top: 4px;">发送者：${escapeHtml(deviceId)}</div>
            </div>
            <div class="row" style="justify-content: flex-end;">
              ${blocked ? '<span class="badge bad">已拉黑</span>' : ''}
              <span class="badge ${feedbackBadgeClass(item.status)}">${escapeHtml(item.status)}</span>
              ${renderFeedbackDeviceBlockForm({ deviceId, blocked, returnTo })}
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

function renderAnnouncementItems(announcementItems, returnTo) {
  if (!announcementItems.length) {
    return '<div class="small">暂无公告。</div>';
  }

  return announcementItems
    .map((item) => {
      const active = item.active !== false;
      const action = active
        ? `<form method="post" action="/admin/announcements/${encodeURIComponent(item.id)}/active">
            <input type="hidden" name="active" value="false" />
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
            <button class="btn danger" type="submit">关闭公告</button>
          </form>`
        : `<form method="post" action="/admin/announcements/${encodeURIComponent(item.id)}/active">
            <input type="hidden" name="active" value="true" />
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
            <button type="submit">启用公告</button>
          </form>`;

      return `
        <div class="item">
          <div class="row" style="justify-content: space-between; align-items: start;">
            <div>
              <div style="font-weight: 600;">${escapeHtml(item.title)}</div>
              <div class="small" style="margin-top: 4px;">${previewText(item.content, 140)}</div>
              <div class="small" style="margin-top: 4px;">${escapeHtml(formatDateTime(item.createdAt))}</div>
            </div>
            <span class="badge ${active ? 'ok' : ''}">${active ? '当前启用' : '未启用'}</span>
          </div>
          <div class="row" style="margin-top: 10px;">
            ${action}
          </div>
        </div>`;
    })
    .join('');
}

function adminNav(active) {
  const links = [['', '仪表盘'], ['version', '版本'], ['announcements', '公告'], ['feedback', '反馈']];
  return `<div class="nav">${links.map(([path, label]) => `<a class="${active === (path || 'dashboard') ? 'active' : ''}" href="/admin${path ? `/${path}` : ''}">${label}</a>`).join('')}<a style="margin-left:auto" href="/admin/logout">退出</a></div>`;
}

function renderDashboard({ state, feedbackItems, announcementItems, presence = {}, message = '' }) {
  const meta = state.meta;
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const openCount = feedbackItems.filter((item) => item.status === 'open').length;
  const repliedCount = feedbackItems.filter((item) => item.status === 'replied').length;
  const closedCount = feedbackItems.filter((item) => item.status === 'closed').length;
  const latestFeedback = feedbackItems.slice(0, 6);

  return shell(
    'Lehu 后台',
    `<div class="nav"><a class="active" href="/admin">仪表盘</a><a href="/admin/version">版本</a><a href="/admin/announcements">公告</a><a href="/admin/feedback">反馈</a><a style="margin-left:auto" href="/admin/logout">退出</a></div>
    <div class="topbar">
      <div>
        <h1 class="title">${escapeHtml(meta.appName)} 后台</h1>
      </div>
      <div class="row">
        <a class="btn secondary" href="/admin/feedback">查看反馈</a>
      </div>
    </div>
    ${notice}
    <div class="stats-card">
      <div class="stats">
        <div class="stat"><div class="muted">近 1 日活跃用户</div><div class="value">${Number(presence.active1d ?? 0)}</div></div>
        <div class="stat"><div class="muted">近 3 日活跃用户</div><div class="value">${Number(presence.active3d ?? 0)}</div></div>
        <div class="stat"><div class="muted">近 7 日活跃用户</div><div class="value">${Number(presence.active7d ?? 0)}</div></div>
        <div class="stat"><div class="muted">累计用户</div><div class="value">${Number(presence.total ?? 0)}</div></div>
      </div>
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
    </div>`
  );
}

function renderVersionPage({ state, message = '' }) {
  const meta = state.meta;
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  return shell('版本设置', `<div class="nav"><a href="/admin">仪表盘</a><a class="active" href="/admin/version">版本</a><a href="/admin/announcements">公告</a><a href="/admin/feedback">反馈</a><a style="margin-left:auto" href="/admin/logout">退出</a></div>${notice}<div class="card"><h1 class="title">版本设置</h1><form class="version-form" method="post" action="/admin/version"><div class="grid"><div><label>应用名称</label><input name="appName" value="${escapeHtml(meta.appName)}" /></div><div><label>下载地址</label><input name="downloadUrl" value="${escapeHtml(meta.downloadUrl)}" /></div><div><label>最新版本号</label><input name="latestVersion" value="${escapeHtml(meta.latestVersion)}" required /></div><div><label>Build 号</label><input name="latestBuild" type="number" min="1" value="${escapeHtml(meta.latestBuild)}" required /></div><div><label>更新标题</label><input name="updateTitle" value="${escapeHtml(meta.updateTitle)}" /></div><div><label>强制更新</label><select name="forceUpdate"><option value="false"${meta.forceUpdate ? '' : ' selected'}>否</option><option value="true"${meta.forceUpdate ? ' selected' : ''}>是</option></select></div></div><label>更新说明</label><textarea name="updateMessage">${escapeHtml(meta.updateMessage)}</textarea><label>弹窗通告</label><textarea name="noticeText">${escapeHtml(meta.noticeText)}</textarea><button type="submit">保存</button></form></div>`);
}

function renderFeedbackListPage({ state, feedbackItems, message = '' }) {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const openCount = feedbackItems.filter((item) => item.status === 'open').length;

  return shell(
    '反馈列表',
    `${adminNav('feedback')}<div class="topbar">
      <div>
        <h1 class="title">反馈列表</h1>
        <div class="subtitle"><a href="/admin">返回后台</a> · 共 ${feedbackItems.length} 条，${openCount} 条待处理</div>
      </div>
      <div class="row">
        <a class="btn secondary" href="/admin/logout">退出登录</a>
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
      <p class="subtitle">命中的客户端将无法继续提交问题反馈。</p>
      <div class="item-list">
        ${renderBlockedFeedbackDevices(state)}
      </div>
    </div>`
  );
}

function renderAnnouncementListPage({ state, announcementItems, message = '' }) {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const activeCount = announcementItems.filter((item) => item.active !== false).length;

  return shell(
    '公告列表',
    `${adminNav('announcements')}<div class="topbar">
      <div>
        <h1 class="title">公告列表</h1>
        <div class="subtitle"><a href="/admin">返回后台</a> · 共 ${announcementItems.length} 条，${activeCount} 条启用中</div>
      </div>
      <div class="row">
        <a class="btn secondary" href="/admin/logout">退出登录</a>
      </div>
    </div>
    ${notice}
    <div class="split">
      <div class="card">
        <h2 class="title" style="font-size: 20px;">发布公告</h2>
        <form method="post" action="/admin/announcements">
          <input type="hidden" name="returnTo" value="/admin/announcements" />
          <label for="announcementTitle">公告标题</label>
          <input id="announcementTitle" name="title" type="text" required />
          <div style="margin-top: 12px;">
            <label for="announcementContent">公告内容</label>
            <textarea id="announcementContent" name="content" required></textarea>
          </div>
          <div class="row" style="margin-top: 12px;">
            <label style="margin: 0; display: flex; align-items: center; gap: 8px;">
              <input type="checkbox" name="active" checked />
              启用为当前公告
            </label>
          </div>
          <div style="margin-top: 12px;">
            <button type="submit">发布公告</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 class="title" style="font-size: 20px;">全部公告</h2>
        <div style="margin-top: 8px;">
          ${renderAnnouncementItems(announcementItems, '/admin/announcements')}
        </div>
      </div>
    </div>`
  );
}

function renderFeedbackDetail({ state, item, message = '' }) {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const replies = Array.isArray(item.replies) ? item.replies : [];
  const deviceId = feedbackDeviceText(item);
  const blockedDevice = blockedFeedbackDevice(state, deviceId);
  const isBlocked = Boolean(blockedDevice);

  return shell(
    `反馈 ${item.id}`,
    `${adminNav('feedback')}<div class="topbar">
      <div>
        <h1 class="title">反馈详情</h1>
        <div class="subtitle"><a href="/admin">返回后台</a> · ${escapeHtml(item.id)}</div>
      </div>
      <div class="row">
        <span class="badge ${item.status === 'open' ? 'warn' : item.status === 'closed' ? 'bad' : 'ok'}">${escapeHtml(item.status)}</span>
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
          <div class="small">发送者唯一标识</div>
          <div class="mono" style="margin-top: 6px;">${escapeHtml(deviceId)}</div>
        </div>
      </div>
      <div class="row" style="margin-top: 16px;">
        ${isBlocked ? `<span class="small">已于 ${escapeHtml(formatDateTime(blockedDevice.blockedAt))} 拉黑。</span>` : '<span class="small">该发送者当前未被拉黑。</span>'}
        ${renderFeedbackDeviceBlockForm({
          deviceId,
          blocked: isBlocked,
          returnTo: `/admin/feedback/${encodeURIComponent(item.id)}`
        })}
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
    </div>`
  );
}

export {
  escapeHtml,
  formatDateTime,
  renderAnnouncementListPage,
  renderDashboard,
  renderFeedbackDetail,
  renderFeedbackListPage,
  renderLoginPage,
  renderVersionPage,
  shell
};
