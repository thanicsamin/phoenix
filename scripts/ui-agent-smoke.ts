const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085';
const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password' }) });
if (!login.ok) throw new Error('Preview login failed.');
const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrf } = await login.json();
const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
async function api(path, body) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
const chats = (await api('/api/state')).chats; const chat = chats.find(item => item.title === 'Interface QA') || await api('/api/new', { title: 'Interface QA' });
const statePath = '/api/state?chat=' + chat.id; const before = await api(statePath);
if (before.model.id !== 'space-bunny-free') throw new Error('This test uses only Space Bunny Free.');
const baseline = (await api('/api/ui/generations')).generations.find(item => item.current).id;
await api('/api/prompt', { chatId: chat.id, message: `Test your live UI publishing workflow. This is an authorized TEMPORARY UI experiment. Change ONLY the composer placeholder in /data/workspace/phoenix/web/index.html from Message… to Try a thought…; call reload_ui (do NOT reload_agent). Use browser navigate to its returned local URL to inspect the real UI without asking for any password. Resize to width 390 height 844, inspect snapshot and screenshot. Check the composer is visible, and open Chats then Files, open AGENTS.md, preview it. Do not alter instructions or secrets. Then call rollback_ui with generation ${baseline}, navigate again, and confirm Message… is restored. Finish with a brief report of whether auto-login, mobile controls, file preview, UI publish and rollback worked. Do not make any other edits.` });
let last = ''; const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const state = await api(statePath); const progress = state.tool || (state.busy ? 'Thinking' : 'Complete');
  if (progress !== last) { console.log(progress); last = progress; }
  if (!state.busy && state.messages.length > before.messages.length) { console.log(state.messages.filter(item => item.role === 'assistant').at(-1)?.text || state.error || 'Done'); break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
