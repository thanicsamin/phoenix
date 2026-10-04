/* global texmath */
const markdown = window.markdownit({ html: false, linkify: true, breaks: true }).use(texmath, {
  engine: window.katex,
  delimiters: ['dollars', 'brackets'],
  katexOptions: { trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 },
});

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Raw HTML stays disabled. Only HTTPS images and authenticated attachment
// images are embedded; arbitrary same-origin endpoints and data URLs aren't.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') || '';
  const escape = markdown.utils.escapeHtml;
  let allowed = false;
  try {
    const url = new URL(src, 'https://phoenix.invalid');
    allowed = !url.username && !url.password && (url.origin === 'https://phoenix.invalid'
      ? url.pathname === '/api/files/image' && /^(main|[0-9a-f-]{36})$/.test(url.searchParams.get('chat')) && /^[0-9a-f-]{36}$/.test(url.searchParams.get('id'))
      : url.protocol === 'https:');
  } catch { /* Invalid image links remain text. */ }
  const alt = escape(token.content || 'Image');
  return allowed ? `<a href="${escape(src)}" target="_blank" rel="noopener noreferrer"><img src="${escape(src)}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>` : alt;
};

window.renderMarkdown = text => {
  try {
    return window.DOMPurify.sanitize(markdown.render(text), {
      RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'], ADD_TAGS: ['eq', 'eqn'],
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['id', 'name'],
    });
  } catch {
    // Incomplete streamed content must never interrupt the chat.
    const fallback = document.createElement('p'); fallback.textContent = text;
    return fallback;
  }
};
