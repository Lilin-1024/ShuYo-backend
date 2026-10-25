import { adminNav, escapeHtml, formatDateTime, shell } from './views.js';

const statusLabels = { open: '待处理', replied: '已回复', closed: '已关闭' };
const statusBadges = { open: 'warn', replied: 'ok', closed: 'bad' };

function notice(message) {
  return message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
}

function answerText(questions, answers) {
  return questions.filter((question) => answers[question.key]?.length).map((question) => {
    const labels = answers[question.key]
      .map((key) => question.options.find((option) => option.key === key)?.label ?? key);
    return `${question.title}：${labels.join('、')}`;
  }).join('；');
}

function blockForm({ accountId, blocked, returnTo, purge = false }) {
  return `<form method="post" action="/admin/rate/accounts/${encodeURIComponent(accountId)}/block" style="display: inline;">
    <input type="hidden" name="blocked" value="${blocked ? 'false' : 'true'}" />
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    ${purge ? '<input type="hidden" name="purge" value="true" />' : ''}
    <button class="${blocked ? 'small-btn' : 'small-btn danger'}" type="submit">${blocked ? '解除封禁' : purge ? '封禁并删除全部评价' : '封禁'}</button>
  </form>`;
}

function unitText(unit) {
  if (!unit) return '';
  return `${escapeHtml(unit.course.name)}（${escapeHtml(unit.course.id)}）· ${escapeHtml(unit.teacher.name)}`;
}

function renderRateReviewsPage({
  reviews, total, page, pageSize, query = '', accountId = '', blocks, imports, questions,
  message = '', csrfToken, admin
}) {
  const returnTo = `/admin/rate?${new URLSearchParams({ q: query, accountId, page: String(page) })}`;
  const rows = reviews.map((item) => `<div class="item">
    <div class="row" style="justify-content: space-between; align-items: start;">
      <div>
        <div style="font-weight: 600;">${escapeHtml(item.courseName)}（${escapeHtml(item.courseId)}）· ${escapeHtml(item.teacherName)}</div>
        <div class="small">${'★'.repeat(item.overall)}${'☆'.repeat(5 - item.overall)} · ${escapeHtml(answerText(questions, item.answers) || '未填写其他题目')}</div>
        <div class="small" style="margin-top: 6px;">提交 ${escapeHtml(formatDateTime(item.createdAt))} · 修改 ${escapeHtml(formatDateTime(item.updatedAt))}</div>
        <div class="small mono" style="margin-top: 4px;"><a href="/admin/rate?accountId=${encodeURIComponent(item.accountId)}">账户：${escapeHtml(item.accountId)}</a></div>
      </div>
      <div class="row" style="justify-content: flex-end;">
        ${item.blocked ? '<span class="badge bad">已封禁</span>' : ''}
        <form method="post" action="/admin/rate/reviews/${encodeURIComponent(item.id)}/delete" style="display: inline;">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
          <button class="small-btn danger" type="submit">删除</button>
        </form>
        ${blockForm({ accountId: item.accountId, blocked: item.blocked, returnTo })}
      </div>
    </div>
  </div>`).join('');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const link = (target) => `/admin/rate?${new URLSearchParams({ q: query, accountId, page: String(target) })}`;
  const lastImport = imports[0];
  return shell('课评管理', `${adminNav('rate', admin)}
    <div class="topbar">
      <div>
        <h1 class="title">课评管理</h1>
        <div class="subtitle">共 ${total} 条评价 · ${lastImport
          ? `课程库 ${escapeHtml(lastImport.term)}，${lastImport.report.courses} 门课程，导入于 ${escapeHtml(formatDateTime(lastImport.importedAt))}`
          : '尚未导入课程库'}</div>
      </div>
      <div class="row"><a class="btn secondary" href="/admin/rate/feedback">课评反馈</a></div>
    </div>
    ${notice(message)}
    <form method="get" action="/admin/rate" class="row" style="margin: 18px 0;">
      <input style="max-width: 320px;" name="q" aria-label="搜索" placeholder="课程号、课程名或教师" value="${escapeHtml(query)}" />
      <input style="max-width: 320px;" name="accountId" aria-label="账户 ID" placeholder="账户 ID" value="${escapeHtml(accountId)}" />
      <button type="submit">筛选</button>
      ${query || accountId ? '<a href="/admin/rate">清除</a>' : ''}
    </form>
    ${accountId ? `<div class="card"><div class="row" style="align-items: center;">
      <span class="small mono">账户 ${escapeHtml(accountId)}</span>
      ${blockForm({ accountId, blocked: blocks.some((item) => item.accountId === accountId), returnTo })}
      ${blocks.some((item) => item.accountId === accountId) ? '' : blockForm({ accountId, blocked: false, returnTo, purge: true })}
    </div></div>` : ''}
    <div class="card"><div class="item-list">${rows || '<div class="small">暂无评价。</div>'}</div>
      <div class="row" style="margin-top: 12px; justify-content: space-between;">
        <span class="small">第 ${page} / ${pages} 页</span>
        <span class="row">${page > 1 ? `<a href="${escapeHtml(link(page - 1))}">上一页</a>` : ''}${page < pages ? `<a href="${escapeHtml(link(page + 1))}">下一页</a>` : ''}</span>
      </div>
    </div>
    <div class="card">
      <h2 class="title" style="font-size: 20px;">已封禁账户</h2>
      <p class="subtitle">封禁后不能发布评价和课评反馈，与应用反馈的拉黑互不影响。</p>
      <div class="item-list">${blocks.map((item) => `<div class="item"><div class="row" style="justify-content: space-between;">
        <a class="small mono" href="/admin/rate?accountId=${encodeURIComponent(item.accountId)}">${escapeHtml(item.accountId)}</a>
        <span class="row"><span class="small">${escapeHtml(formatDateTime(item.blockedAt))}</span>
        ${blockForm({ accountId: item.accountId, blocked: true, returnTo: '/admin/rate' })}</span>
      </div></div>`).join('') || '<div class="small">暂无封禁账户。</div>'}</div>
    </div>`, csrfToken);
}

function renderRateFeedbackListPage({ items, status = '', kinds, message = '', csrfToken, admin }) {
  const filters = [['', '全部'], ['open', '待处理'], ['replied', '已回复'], ['closed', '已关闭']]
    .map(([key, label]) => key === status
      ? `<strong>${label}</strong>`
      : `<a href="/admin/rate/feedback${key ? `?status=${key}` : ''}">${label}</a>`).join(' · ');
  const rows = items.map((item) => `<div class="item">
    <div class="row" style="justify-content: space-between; align-items: start;">
      <div>
        <div style="font-weight: 600;"><a href="/admin/rate/feedback/${encodeURIComponent(item.id)}">${escapeHtml(kinds.find((kind) => kind.key === item.kind)?.label ?? item.kind)}</a></div>
        ${item.unit || item.course ? `<div class="small">关联：${item.unit ? unitText(item.unit) : `${escapeHtml(item.course.name)}（${escapeHtml(item.course.id)}）`}</div>` : ''}
        <div class="small">${escapeHtml(item.content.slice(0, 120))}${item.content.length > 120 ? '...' : ''}</div>
        <div class="small" style="margin-top: 6px;">${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(item.appVersion || '-')}</div>
        <div class="small mono" style="margin-top: 4px;">账户：${escapeHtml(item.accountId)}</div>
      </div>
      <div class="row" style="justify-content: flex-end;">
        ${item.blocked ? '<span class="badge bad">已封禁</span>' : ''}
        <span class="badge ${statusBadges[item.status]}">${statusLabels[item.status]}</span>
      </div>
    </div>
  </div>`).join('');
  return shell('课评反馈', `${adminNav('rate/feedback', admin)}
    <div class="topbar">
      <div>
        <h1 class="title">课评反馈</h1>
        <div class="subtitle"><a href="/admin/rate">返回课评管理</a> · ${filters}</div>
      </div>
    </div>
    ${notice(message)}
    <div class="card"><div class="item-list">${rows || '<div class="small">暂无课评反馈。</div>'}</div></div>`, csrfToken);
}

function renderRateFeedbackDetail({ item, message = '', csrfToken, admin }) {
  const returnTo = `/admin/rate/feedback/${encodeURIComponent(item.id)}`;
  const target = item.unit ? unitText(item.unit)
    : item.course ? `${escapeHtml(item.course.name)}（${escapeHtml(item.course.id)}）` : '-';
  const targetQuery = item.unit?.course.id ?? item.course?.id ?? '';
  return shell('课评反馈详情', `${adminNav('rate/feedback', admin)}
    <div class="topbar">
      <div>
        <h1 class="title">课评反馈详情</h1>
        <div class="subtitle"><a href="/admin/rate/feedback">返回课评反馈</a> · ${escapeHtml(item.id)}</div>
      </div>
      <div class="row">
        <span class="badge ${statusBadges[item.status]}">${statusLabels[item.status]}</span>
        ${item.blocked ? '<span class="badge bad">账户已封禁</span>' : ''}
      </div>
    </div>
    ${notice(message)}
    <div class="card">
      <div class="grid">
        <div><div class="small">类型</div><div style="margin-top: 6px;">${escapeHtml(item.kindLabel)}</div></div>
        <div><div class="small">关联</div><div style="margin-top: 6px;">${target}
          ${targetQuery ? ` <a href="/admin/rate?q=${encodeURIComponent(targetQuery)}">查看评价</a>` : ''}</div></div>
        <div><div class="small">提交时间</div><div style="margin-top: 6px;">${escapeHtml(formatDateTime(item.createdAt))}</div></div>
        <div><div class="small">客户端</div><div style="margin-top: 6px;">${escapeHtml(item.appVersion || '-')} · ${escapeHtml(item.platform || '-')}</div></div>
        <div><div class="small">已核验账户标识</div><div class="mono" style="margin-top: 6px;">${escapeHtml(item.accountId)}</div>
          <a href="/admin/rate?accountId=${encodeURIComponent(item.accountId)}">查看该账户的评价</a></div>
      </div>
      <div class="row" style="margin-top: 16px;">
        ${blockForm({ accountId: item.accountId, blocked: item.blocked, returnTo })}
        ${item.status === 'closed' ? '' : `<form method="post" action="/admin/rate/feedback/${encodeURIComponent(item.id)}/close" style="display: inline;">
          <button class="small-btn" type="submit">关闭反馈</button></form>`}
      </div>
      <div style="margin-top: 16px;">
        <div class="small">内容</div>
        <div style="margin-top: 6px; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(item.content)}</div>
      </div>
    </div>
    <div class="split">
      <div class="card">
        <h2 class="title" style="font-size: 20px;">回复</h2>
        ${item.replies.map((reply) => `<div class="item">
          <div class="small">${escapeHtml(formatDateTime(reply.createdAt))} · ${escapeHtml(reply.author)}</div>
          <div style="margin-top: 6px; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(reply.message)}</div>
        </div>`).join('') || '<div class="small" style="margin-top: 10px;">暂无回复。</div>'}
      </div>
      <div class="card">
        <h2 class="title" style="font-size: 20px;">新增回复</h2>
        <form method="post" action="/admin/rate/feedback/${encodeURIComponent(item.id)}/reply">
          <div><label for="replyMessage">回复内容</label><textarea id="replyMessage" name="message" required></textarea></div>
          <div style="margin-top: 12px;"><label for="status">状态</label>
            <select id="status" name="status">
              <option value="replied" selected>回复后设为已回复</option>
              <option value="open">保持待处理</option>
              <option value="closed">回复并关闭</option>
            </select></div>
          <div style="margin-top: 12px;"><button type="submit">保存回复</button></div>
        </form>
      </div>
    </div>`, csrfToken);
}

export { renderRateFeedbackDetail, renderRateFeedbackListPage, renderRateReviewsPage };
