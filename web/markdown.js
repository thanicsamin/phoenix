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
// Link images without fetching remote resources from untrusted messages.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  return `<a href="${markdown.utils.escapeHtml(token.attrGet('src'))}" target="_blank" rel="noopener noreferrer">${markdown.utils.escapeHtml(token.content || 'Image')}</a>`;
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
