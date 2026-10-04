import type { API } from './globals.d.ts';
import type { PlaidStatus, PlaidLink } from '../src/contracts.ts';

window.initPlaid = ({ api }: { api: API }) => {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const settings = get<HTMLDetailsElement>('plaid-settings');
  const form = get<HTMLFormElement>('plaid-form');
  const connect = get<HTMLButtonElement>('plaid-connect');
  const retry = get<HTMLButtonElement>('plaid-retry');
  const errorText = get<HTMLElement>('plaid-error');
  const dialog = get<HTMLDialogElement>('settings-dialog');
  const secret = get<HTMLInputElement>('plaid-secret');
  const clientId = get<HTMLInputElement>('plaid-client-id');
  const environment = get<HTMLSelectElement>('plaid-environment');
  let handler: ReturnType<NonNullable<typeof window.Plaid>['create']> | undefined;
  let sdk: Promise<void> | undefined;
  let busy = false;
  let pendingSave: { token: string; publicToken?: string; name: string } | undefined;
  let controllerGeneration = 0;
  let status: PlaidStatus | undefined;
  let credentialsEdited = false;
  form.addEventListener('input', () => { credentialsEdited = true; });
  const message = (error: unknown) => { errorText.textContent = error instanceof Error ? error.message : 'Could not connect Plaid.'; };
  const controls = () => {
    const locked = busy || !!pendingSave;
    connect.disabled = locked;
    form.querySelector<HTMLButtonElement>('button')!.disabled = locked;
    clientId.disabled = environment.disabled = locked || !!status?.items.length;
    secret.disabled = locked;
    for (const button of get('plaid-items').querySelectorAll<HTMLButtonElement>('button')) button.disabled = locked;
    retry.disabled = busy;
  };
  const render = (next: PlaidStatus) => {
    status = next;
    settings.hidden = false;
    get('plaid-status').textContent = `${status.environment === 'sandbox' ? 'Sandbox · test banks' : 'Production · real banks'}${status.configured ? ` · ${status.items.length} connected` : ' · Not configured'}`;
    form.hidden = status.managedByEnvironment;
    if (!credentialsEdited) { environment.value = status.environment; clientId.value = status.clientId || ''; }
    clientId.required = !status.items.length;
    connect.hidden = !status.configured;
    const items = get('plaid-items'); items.replaceChildren();
    for (const item of status.items) {
      const row = document.createElement('div'); row.className = 'plaid-item';
      const name = document.createElement('span'); name.textContent = item.name; row.append(name);
      for (const action of ['Reconnect', 'Disconnect']) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action;
        button.addEventListener('click', async () => {
          if (busy || pendingSave) return;
          const generation = controllerGeneration;
          if (action === 'Disconnect') {
            if (!confirm(`Disconnect ${item.name} from Phoenix?`)) return;
            busy = true; controls(); errorText.textContent = '';
            try { const next = await api('/api/plaid/disconnect', { itemId: item.id }); if (generation === controllerGeneration) render(next); }
            catch (error) { if (generation === controllerGeneration) message(error); }
            finally { if (generation === controllerGeneration) { busy = false; controls(); } }
          } else await open(item.id);
        }); row.append(button);
      }
      items.append(row);
    }
    controls();
  };
  const refresh = async () => {
    const generation = controllerGeneration;
    try { const next = await api('/api/plaid/status'); if (generation === controllerGeneration) render(next); }
    catch (error) { if (generation === controllerGeneration) { settings.hidden = !status; message(error); } }
  };
  const clearPending = () => { try { sessionStorage.removeItem('phoenix-plaid-link'); } catch { /* Storage can be disabled. */ } };
  const finish = async () => {
    if (!pendingSave || busy) return;
    const generation = controllerGeneration; busy = true; controls();
    try {
      const status = await api('/api/plaid/complete', pendingSave);
      if (generation !== controllerGeneration) return;
      pendingSave = undefined; retry.hidden = true; errorText.textContent = ''; render(status);
    } catch (error) {
      if (generation !== controllerGeneration) return;
      // Expired or invalid flows need a new sign-in; network failures can retry.
      if (error instanceof Error && 'status' in error && error.status === 400) pendingSave = undefined;
      message(error); retry.hidden = !pendingSave;
    } finally { if (generation === controllerGeneration) { busy = false; controls(); } }
  };
  const load = () => {
    if (window.Plaid) return Promise.resolve();
    sdk ||= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      script.nonce = document.querySelector<HTMLMetaElement>('meta[name="plaid-nonce"]')?.content || '';
      const timer = setTimeout(() => { script.remove(); sdk = undefined; reject(Error('Plaid took too long to load. Try again.')); }, 15000);
      script.onload = () => { clearTimeout(timer); if (window.Plaid) resolve(); else { sdk = undefined; reject(Error('Plaid could not load.')); } };
      script.onerror = () => { clearTimeout(timer); script.remove(); sdk = undefined; reject(Error('Plaid could not load. Check your connection.')); };
      document.head.append(script);
    }); return sdk;
  };
  const start = async (link: PlaidLink, receivedRedirectUri?: string) => {
    const generation = controllerGeneration; await load(); if (generation !== controllerGeneration) return;
    handler?.destroy();
    handler = window.Plaid!.create({ token: link.token, ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: async (publicToken, metadata) => {
        if (generation !== controllerGeneration) return;
        clearPending(); pendingSave = { token: link.token, ...(!link.itemId && publicToken ? { publicToken } : {}), name: metadata.institution?.name || 'Connected bank' };
        handler?.destroy(); handler = undefined; busy = false; controls();
        if (!dialog.open) dialog.showModal(); settings.open = true; await finish();
      },
      onExit: error => {
        if (generation !== controllerGeneration) return;
        clearPending(); handler?.destroy(); handler = undefined; busy = false; controls();
        if (!dialog.open) dialog.showModal(); settings.open = true;
        if (error) errorText.textContent = 'Bank sign-in did not finish. Try again.';
        refresh().catch(() => {});
      },
    });
    // A native modal makes elements outside it inert. Close it before opening
    // Plaid's iframe, then restore Settings on success or cancellation.
    dialog.close(); handler.open();
  };
  const open = async (itemId?: string) => {
    if (busy || pendingSave) return;
    const generation = controllerGeneration; busy = true; controls(); errorText.textContent = '';
    try {
      await load(); if (generation !== controllerGeneration) return;
      const link = await api('/api/plaid/link', itemId ? { itemId } : {}); if (generation !== controllerGeneration) return;
      try { sessionStorage.setItem('phoenix-plaid-link', JSON.stringify(link)); } catch { /* Popup linking still works without storage. */ }
      await start(link);
    } catch (error) { if (generation === controllerGeneration) { busy = false; controls(); clearPending(); message(error); } }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || pendingSave) return;
    const generation = controllerGeneration; busy = true; controls(); errorText.textContent = '';
    try {
      // The client ID is retained in this form only; secrets are always cleared.
      const next = await api('/api/plaid/configure', { clientId: clientId.value, secret: secret.value, environment: environment.value });
      if (generation === controllerGeneration) { credentialsEdited = false; render(next); }
    } catch (error) { if (generation === controllerGeneration) message(error); }
    finally { if (generation === controllerGeneration) { secret.value = ''; busy = false; controls(); } }
  });
  connect.addEventListener('click', () => { open().catch(message); });
  retry.addEventListener('click', () => { finish().catch(message); });
  const resume = async () => {
    if (!new URL(location.href).searchParams.has('oauth_state_id')) return;
    const receivedRedirectUri = location.href; history.replaceState(null, '', location.pathname);
    settings.open = true; if (!dialog.open) dialog.showModal();
    let link: PlaidLink | undefined;
    try { link = JSON.parse(sessionStorage.getItem('phoenix-plaid-link') || 'null'); } catch { /* Invalid/missing state is handled below. */ }
    if (!link || typeof link.token !== 'string' || link.token.length > 300 || !Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now()) {
      clearPending(); message(Error('This bank sign-in expired. Connect again.')); return;
    }
    const generation = controllerGeneration; busy = true; controls();
    try { await start(link, receivedRedirectUri); } catch (error) { if (generation === controllerGeneration) { busy = false; controls(); message(error); } }
  };
  return { refresh, resume, active: () => busy || !!pendingSave, reset: () => { controllerGeneration++; busy = false; handler?.destroy(); handler = undefined; pendingSave = undefined; status = undefined; credentialsEdited = false; retry.hidden = true; secret.value = clientId.value = ''; errorText.textContent = ''; clearPending(); get('plaid-items').replaceChildren(); settings.hidden = true; controls(); } };
};
