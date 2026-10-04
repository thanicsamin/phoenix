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
  const message = (error: unknown) => { errorText.textContent = error instanceof Error ? error.message : 'Could not connect Plaid.'; };
  const render = (status: PlaidStatus) => {
    settings.hidden = false;
    get('plaid-status').textContent = `${status.environment === 'sandbox' ? 'Sandbox · test banks' : 'Production · real banks'}${status.configured ? ` · ${status.items.length} connected` : ' · Not configured'}`;
    form.hidden = status.managedByEnvironment; clientId.disabled = environment.disabled = status.items.length > 0;
    if (!status.items.length) environment.value = status.environment;
    clientId.value = status.clientId || ''; clientId.required = !status.items.length;
    connect.hidden = !status.configured; connect.disabled = busy || !!pendingSave;
    const items = get('plaid-items'); items.replaceChildren();
    for (const item of status.items) {
      const row = document.createElement('div'); row.className = 'plaid-item';
      const name = document.createElement('span'); name.textContent = item.name; row.append(name);
      for (const action of ['Reconnect', 'Disconnect']) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action; button.disabled = busy;
        button.addEventListener('click', async () => {
          if (busy) return;
          if (action === 'Disconnect') {
            if (!confirm(`Disconnect ${item.name} from Phoenix?`)) return;
            busy = true; button.disabled = true; errorText.textContent = '';
            try { render(await api('/api/plaid/disconnect', { itemId: item.id })); }
            catch (error) { message(error); } finally { busy = false; await refresh(); }
          } else await open(item.id);
        }); row.append(button);
      }
      items.append(row);
    }
  };
  const refresh = async () => {
    try { render(await api('/api/plaid/status')); }
    catch (error) { settings.hidden = true; message(error); }
  };
  const clearPending = () => { try { sessionStorage.removeItem('phoenix-plaid-link'); } catch { /* Storage can be disabled. */ } };
  const finish = async () => {
    if (!pendingSave) return;
    retry.disabled = true;
    try {
      const status = await api('/api/plaid/complete', pendingSave);
      pendingSave = undefined; retry.hidden = true; errorText.textContent = ''; render(status);
    } catch (error) { message(error); retry.hidden = false; }
    finally { retry.disabled = false; }
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
        handler?.destroy(); handler = undefined; busy = false;
        if (!dialog.open) dialog.showModal(); settings.open = true; await finish(); await refresh();
      },
      onExit: error => {
        if (generation !== controllerGeneration) return;
        clearPending(); handler?.destroy(); handler = undefined; busy = false;
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
    const generation = controllerGeneration; busy = true; connect.disabled = true; errorText.textContent = '';
    try {
      await load(); if (generation !== controllerGeneration) return;
      const link = await api('/api/plaid/link', itemId ? { itemId } : {}); if (generation !== controllerGeneration) return;
      try { sessionStorage.setItem('phoenix-plaid-link', JSON.stringify(link)); } catch { /* Popup linking still works without storage. */ }
      await start(link);
    } catch (error) { busy = false; clearPending(); message(error); await refresh(); }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; errorText.textContent = ''; const button = form.querySelector<HTMLButtonElement>('button')!; button.disabled = true;
    try {
      // The client ID is retained in this form only; secrets are always cleared.
      render(await api('/api/plaid/configure', { clientId: clientId.value, secret: secret.value, environment: environment.value }));
    } catch (error) { message(error); } finally { secret.value = ''; busy = false; button.disabled = false; await refresh(); }
  });
  connect.addEventListener('click', () => { open().catch(message); });
  retry.addEventListener('click', () => { finish().then(refresh).catch(message); });
  const resume = async () => {
    if (!new URL(location.href).searchParams.has('oauth_state_id')) return;
    const receivedRedirectUri = location.href; history.replaceState(null, '', location.pathname);
    settings.open = true; if (!dialog.open) dialog.showModal();
    let link: PlaidLink | undefined;
    try { link = JSON.parse(sessionStorage.getItem('phoenix-plaid-link') || 'null'); } catch { /* Invalid/missing state is handled below. */ }
    if (!link || typeof link.token !== 'string' || link.token.length > 300 || !Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now()) {
      clearPending(); message(Error('This bank sign-in expired. Connect again.')); return;
    }
    busy = true;
    try { await start(link, receivedRedirectUri); } catch (error) { busy = false; message(error); }
  };
  return { refresh, resume, reset: () => { controllerGeneration++; busy = false; handler?.destroy(); handler = undefined; pendingSave = undefined; retry.hidden = true; secret.value = clientId.value = ''; clearPending(); get('plaid-items').replaceChildren(); } };
};
