import assert from 'node:assert/strict';
const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085'; let cookie; let csrf;
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: base, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  if (path === '/api/login') { cookie = response.headers.get('set-cookie').split(';')[0]; csrf = result.csrf; }
  return result;
}
async function wait(chatId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = await api(`/api/state?chat=${chatId}`);
    if (!state.busy) { if (state.error) throw new Error(state.error); return state; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Live model check timed out.');
}
await api('/api/login', { password: process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password' });
const main = await api('/api/state'); assert.equal(main.configured, true);
const existing = main.chats.find(chat => chat.title === 'Diagnostics'); const chat = existing || await api('/api/new', { title: 'Diagnostics' });
await api('/api/model', { chatId: chat.id, model: { provider: 'opencode-go', id: 'space-bunny-free' }, thinking: 'off' });
const upload = await fetch(base + '/api/files?chat=' + chat.id + '&name=diagnostic.txt', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: 'Diagnostic token: PHOENIX_FILE_ROUNDTRIP_4921.\n' });
assert.equal(upload.status, 201); const file = await upload.json();
await api('/api/prompt', { chatId: chat.id, attachments: [file.id], message: 'Read the attached file using your file tools. Create checks/attachment-result.md containing exactly its diagnostic token, then use attach_file to share that Markdown file. Keep the reply brief. Do not change agent code or memory.' });
let state = await wait(chat.id); const attachment = state.messages.flatMap(message => message.attachments || []).find(item => item.name === 'attachment-result.md');
assert.ok(attachment, JSON.stringify(state.messages.slice(-3)));
const downloaded = await fetch(`${base}/api/files/download?chat=${chat.id}&id=${attachment.id}`, { headers: { Cookie: cookie } }); assert.match(await downloaded.text(), /PHOENIX_FILE_ROUNDTRIP_4921/);
console.log('Live Space Bunny: uploaded text was read, an artifact was created, and its authenticated download matched.');
await api('/api/prompt', { chatId: chat.id, message: 'Use bash to sleep for 8 seconds, then create checks/steering-result.txt containing ORIGINAL. Use attach_file to share it. This is a steering test; do not modify the agent.' });
const deadline = Date.now() + 45000;
while (Date.now() < deadline) { state = await api(`/api/state?chat=${chat.id}`); if (state.steerable) break; await new Promise(resolve => setTimeout(resolve, 300)); }
assert.equal(state.steerable, true);
await api('/api/steer', { chatId: chat.id, message: 'Correction: the final steering-result.txt must contain STEERED_4921 instead of ORIGINAL. Use attach_file only after correcting it.' });
state = await wait(chat.id);
const steering = await api('/api/workspace/file?path=checks/steering-result.txt'); assert.match(steering.text, /STEERED_4921/);
console.log('Live Space Bunny: steering changed the running task output without cancellation.');
await api('/api/prompt', { chatId: chat.id, message: 'Use browser navigate to https://www.amazon.com/s?k=usb+c+cable and report whether actual USB-C cable search results are visible. Then navigate to https://www.walmart.com/search?q=usb+c+cable and report whether results or a human-verification page are visible. Do not click, solve challenges, buy, or log in. Keep the reply to one line per site.' });
state = await wait(chat.id); console.log('Live Space Bunny browser report:', state.messages.filter(item => item.role === 'assistant' && item.text).at(-1)?.text);
console.log('Live checks completed in Diagnostics chat.');
