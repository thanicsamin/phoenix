import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import markdownit from 'markdown-it';
import katex from 'katex';
import texmath from 'markdown-it-texmath';

// Check the actual browser renderer's parsing; Chromium smoke tests cover sanitization.
const window = { markdownit, katex, DOMPurify: { sanitize: html => html } };
runInNewContext(await readFile('web/markdown.js', 'utf8'), { window, texmath, URL });
const render = window.renderMarkdown;

test('Markdown renders tables, links, headings and code while escaping raw HTML', () => {
  assert.match(render('# Heading\n\n**Bold** and *italic*'), /<h1>Heading<\/h1>[\s\S]*<strong>Bold<\/strong>/);
  assert.match(render('| One | Two |\n| --- | --- |\n| a | b |'), /<table>/);
  assert.match(render('[Docs](https://example.com)'), /rel="noopener noreferrer"/);
  assert.doesNotMatch(render('[Bad](javascript:alert(1))'), /href=/);
  assert.doesNotMatch(render('<script>alert(1)</script><img src=x onerror=alert(1)>'), /<script>|<img/);
  assert.match(render('```js\nconst x = "<b>";\n```'), /<pre><code class="language-js">[\s\S]*&lt;b&gt;/);
});

test('LaTeX accepts dollar and bracket delimiters, preserves code and prices, and rejects trusted commands', () => {
  for (const math of ['$x^2$', '$$\\frac{1}{2}$$', '\\(x^2\\)', '\\[\\frac{1}{2}\\]']) {
    assert.match(render(math), /class="katex"/);
    assert.match(render(math), /<math/);
  }
  assert.doesNotMatch(render('`$x$`\n\n```tex\n$x$\n```'), /class="katex"/);
  assert.doesNotMatch(render('It costs $20 or $30.'), /class="katex"/);
  assert.doesNotMatch(render('$\\href{javascript:alert(1)}{click}$'), /href="javascript/);
  assert.doesNotMatch(render('$\\includegraphics{https://example.com/track}$'), /<img/);
  assert.doesNotThrow(() => render('Streaming $\\frac{1}'));
  assert.doesNotThrow(() => render('$\\notacommand$'));
});

test('answers embed safe HTTPS or authenticated attachment images while excluding executable and arbitrary local URLs', () => {
  assert.match(render('![Bird](https://example.com/bird.png)'), /<img src="https:\/\/example.com\/bird.png"[^>]+referrerpolicy="no-referrer"/);
  assert.match(render('![Image](/api/files/image?chat=main&id=11111111-1111-1111-1111-111111111111)'), /<img/);
  for (const src of ['/api/setup', '/api/workspace/download?path=USER.md', 'http://example.com/x', 'data:image/svg+xml;base64,AAAA', 'javascript:alert(1)', 'https://user:password@example.com/x']) {
    assert.doesNotMatch(render(`![Bad](${src})`), /<img/);
  }
});
