(() => {
  const uploadForm = document.getElementById('tip-image-upload');
  const status = document.getElementById('tip-image-status');
  if (!uploadForm || !status) return;

  let editor = document.querySelector('textarea[data-tip-editor]');
  document.addEventListener('focusin', (event) => {
    if (event.target.matches?.('textarea[name="content"]')) {
      editor = event.target;
    }
  });

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = uploadForm.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = '正在上传图片…';

    try {
      const response = await fetch(uploadForm.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        body: new FormData(uploadForm),
      });
      if (!response.ok) {
        throw new Error((await response.text()).slice(0, 120) || '图片上传失败');
      }
      const result = await response.json();
      const url = result?.data?.url;
      if (typeof url !== 'string' ||
          !/^\/api\/v1\/tips\/images\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(url)) {
        throw new Error('服务器未返回有效的图片地址');
      }
      if (!editor) throw new Error('请先打开或填写提示正文');
      const markdown = `\n![图片](${url})\n`;
      editor.setRangeText(markdown, editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.focus();
      uploadForm.reset();
      status.textContent = '图片链接已插入正文，继续编辑或保存即可。';
    } catch (error) {
      status.textContent = error.message || '图片上传失败，请重试。';
    } finally {
      button.disabled = false;
    }
  });
})();
