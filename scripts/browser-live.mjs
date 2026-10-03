import browser from '../extensions/browser.js';
const host = { dataDir: '/data', extensions: {}, cleanups: [], changed() {} }; let tool;
browser({ on() {}, registerTool(value) { tool = value; } }, host, {}, 'live-check');
try {
  for (const [site, url] of [
    ['Amazon', 'https://www.amazon.com/s?k=usb+c+cable'],
    ['Walmart', 'https://www.walmart.com/search?q=usb+c+cable'],
    ['DuckDuckGo', 'https://duckduckgo.com/?q=nix+flakes+documentation'],
    ['Google', 'https://www.google.com/search?q=nix+flakes+documentation'],
  ]) {
    try {
      const result = await tool.execute('live', { action: 'navigate', url });
      const text = result.content[0].text;
      console.log(JSON.stringify({ site, blocked: result.details.blocked, snapshot: text.slice(0, 1800) }));
    } catch (error) { console.log(JSON.stringify({ site, error: error.message })); }
  }
} finally { for (const close of host.cleanups.reverse()) await close(); }
