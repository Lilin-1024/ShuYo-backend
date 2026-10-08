import { adminNav, escapeHtml, formatDateTime, shell } from './views.js';

function renderContentListPage({
  kind, label, items, message = '', image = '', csrfToken, admin, renderMarkdown
}) {
  const route = kind === 'tips' ? '/admin/tips' : '/admin/announcements';
  const isTip = kind === 'tips';
  const published = items.filter((item) => item.active !== false);
  const pending = items.filter((item) => item.active === false)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const renderCard = (item, index, listLength) => {
    const itemRoute = route + '/' + encodeURIComponent(item.id);
    const publicItem = item.active !== false;
    const preview = isTip
      ? '<div class="markdown-preview">' + renderMarkdown(item.content)
        .replaceAll('src="/api/v1/tips/images/', 'src="/admin/tips/images/') + '</div>'
      : '<p class="publication-excerpt">' + escapeHtml(item.content) + '</p>';
    return `<article class="publication-card">
      <div class="publication-heading">
        <div>
          <div class="publication-title-row">
            <h3>${escapeHtml(item.title)}</h3>
            <span class="badge ${publicItem ? 'ok' : 'bad'}">${publicItem ? '公开' : '待选择'}</span>
          </div>
          <p class="publication-meta">创建于 ${escapeHtml(formatDateTime(item.createdAt))} · 更新于 ${escapeHtml(formatDateTime(item.updatedAt))}</p>
        </div>
      </div>
      ${preview}
      <div class="publication-actions">
        <form method="post" action="${itemRoute}/visibility">
          <input type="hidden" name="active" value="${publicItem ? 'false' : 'true'}" />
          <button class="btn secondary" type="submit">${publicItem ? '撤回到待选择' : '公开'}</button>
        </form>
        ${publicItem ? `
        <form method="post" action="${itemRoute}/move">
          <input type="hidden" name="direction" value="up" />
          <button class="btn secondary" type="submit" ${index === 0 ? 'disabled' : ''} aria-label="上移 ${escapeHtml(item.title)}">上移</button>
        </form>
        <form method="post" action="${itemRoute}/move">
          <input type="hidden" name="direction" value="down" />
          <button class="btn secondary" type="submit" ${index === listLength - 1 ? 'disabled' : ''} aria-label="下移 ${escapeHtml(item.title)}">下移</button>
        </form>` : ''}
      </div>
      <details class="publication-editor">
        <summary>编辑内容</summary>
        <form method="post" action="${itemRoute}/edit" class="editor-form">
          <label>标题<input name="title" value="${escapeHtml(item.title)}" maxlength="160" required /></label>
          <label>正文<textarea name="content" rows="${isTip ? 12 : 8}" required>${escapeHtml(item.content)}</textarea></label>
          <button type="submit">保存修改</button>
        </form>
      </details>
      ${publicItem ? '' : `<details class="publication-delete">
        <summary>删除</summary>
        <p>删除后将从待选择列表移除，操作记录会保留。</p>
        <form method="post" action="${itemRoute}/delete">
          <button class="btn danger" type="submit">确认删除</button>
        </form>
      </details>`}
    </article>`;
  };
  const upload = isTip ? `<section class="panel">
    <div class="section-heading"><h2>上传图片</h2><p>图片链接会插入当前正在编辑的正文。支持 PNG、JPEG、WebP，单张不超过 2 MB。</p></div>
    <form id="tip-image-upload" method="post" action="/admin/tips/images" enctype="multipart/form-data" class="upload-form">
      <label>图片文件<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required /></label>
      <button type="submit">上传图片</button>
    </form>
    <p id="tip-image-status" class="small" role="status" aria-live="polite"></p>
    ${/^\/api\/v1\/tips\/images\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(image)
      ? `<label>将这一行插入提示正文<input readonly value="![图片](${escapeHtml(image)})" /></label>`
      : ''}
  </section>` : '';
  return shell(label + '管理', `${adminNav(kind, admin)}
    <header class="content-header">
      <div><p class="eyebrow">内容管理</p><h1>${escapeHtml(label)}</h1>
        <p>公开 ${published.length} 条 · 待选择 ${pending.length} 条</p></div>
      <a class="btn secondary" href="${isTip ? '/api/v1/tips' : '/api/v1/announcements'}" target="_blank" rel="noopener noreferrer">查看公开列表</a>
    </header>
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}
    <section class="panel">
      <div class="section-heading"><h2>新建${escapeHtml(label)}</h2>
        <p>${isTip ? '正文支持 Markdown；上传图片后可继续写作。' : '可同时公开多条公告，排序由下方列表控制。'}</p></div>
      <form method="post" action="${route}" class="editor-form">
        <label>标题<input name="title" maxlength="160" required /></label>
        <label>正文<textarea name="content" rows="${isTip ? 12 : 8}" ${isTip ? 'data-tip-editor' : ''} required></textarea></label>
        <label class="checkbox-row"><input type="checkbox" name="active" /> 立即公开</label>
        <div><button type="submit">创建${escapeHtml(label)}</button></div>
      </form>
    </section>
    ${upload}
    <section class="panel">
      <div class="section-heading"><h2>公开</h2><p>此处从上到下，就是客户端的显示次序。</p></div>
      <div class="publication-list">${published.map((item, index) => renderCard(item, index, published.length)).join('') || '<p class="muted">暂无公开内容。</p>'}</div>
    </section>
    <section class="panel">
      <div class="section-heading"><h2>待选择</h2><p>此处的内容不会在客户端显示，可继续编辑、公开或删除。</p></div>
      <div class="publication-list">${pending.map((item, index) => renderCard(item, index, pending.length)).join('') || '<p class="muted">暂无待选择内容。</p>'}</div>
    </section>
    ${isTip ? '<script src="/admin/assets/tip-editor.js" defer></script>' : ''}`, csrfToken);
}

export { renderContentListPage };
