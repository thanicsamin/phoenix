window.initBrowserControl = ({ api, chat, csrf, refresh }) => {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#browser-dialog'); const screen = $('#browser-screen');
  let socket; let currentChat; let drawing = false; let composing = false; let touch; let controlled = false; let ready = false; let autoTake = false;
  function send(data) { if ((controlled || data.type === 'take') && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  function mode(value) {
    controlled = value;
    $('#browser-status').textContent = controlled ? 'You’re in control' : 'Watching · Agent in control';
    $('#return-browser').textContent = controlled ? 'Return to agent' : 'Take control';
    $('#return-browser').disabled = !ready;
    for (const input of document.querySelectorAll('#browser-address input, #browser-address button, .browser-input input, #browser-tab, #browser-enter')) input.disabled = !controlled;
    screen.setAttribute('aria-label', controlled ? 'Website view. Click to focus a field, then type. Use Tab to move between fields.' : 'Live website view. Take control to interact.');
  }
  function clearView() {
    screen.getContext('2d').clearRect(0, 0, screen.width, screen.height);
    $('#browser-keyboard').value = ''; $('#browser-url').value = '';
  }
  function disconnect() { const previous = socket; socket = undefined; previous?.close(); clearView(); }
  function connect() {
    disconnect();
    ready = false; mode(controlled);
    $('#browser-status').textContent = 'Preparing…'; $('#browser-reconnect').hidden = true;
    $('#return-browser').disabled = true;
    const url = new URL('/api/browser/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url); connection.binaryType = 'blob'; socket = connection;
    connection.addEventListener('open', () => {
      const view = $('#browser-view');
      connection.send(JSON.stringify({ type: 'start', chatId: currentChat, csrf: csrf(), width: Math.max(320, Math.min(1280, Math.floor(view.clientWidth))), height: Math.max(320, Math.min(900, Math.floor(view.clientHeight))) }));
    });
    connection.addEventListener('message', async event => {
      if (connection !== socket || !dialog.open) return;
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready') {
            if (screen.width !== message.width || screen.height !== message.height) { screen.width = message.width; screen.height = message.height; }
            $('#browser-url').placeholder = message.origin === 'null' ? 'https://…' : message.origin;
            ready = true; mode(message.controlled);
            if (autoTake && !controlled) { autoTake = false; $('#return-browser').click(); }
          } else if (message.type === 'control') { mode(message.controlled); }
          else if (message.type === 'error') { $('#browser-status').textContent = message.error; $('#return-browser').disabled = false; }
        } catch { /* Ignore malformed status messages. */ }
      } else if (!drawing) {
        drawing = true;
        try {
          const image = await createImageBitmap(event.data);
          if (connection === socket && dialog.open) screen.getContext('2d').drawImage(image, 0, 0, screen.width, screen.height);
          image.close();
        } catch { /* A dropped frame doesn't interrupt keyboard input. */ }
        finally { drawing = false; }
      }
    });
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      socket = undefined; clearView();
      ready = false; $('#browser-status').textContent = controlled ? 'Disconnected · Agent stays paused' : 'Disconnected'; $('#browser-reconnect').hidden = false; $('#return-browser').disabled = !controlled;
      refresh().catch(() => {});
    });
    connection.addEventListener('error', () => { $('#browser-status').textContent = 'Could not connect'; });
  }
  window.openBrowser = (take = false) => { currentChat = chat(); autoTake = take; dialog.showModal(); connect(); };
  $('#browser').addEventListener('click', () => window.openBrowser());
  $('#browser-reconnect').addEventListener('click', connect);
  $('#close-browser').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', disconnect);
  window.addEventListener('pagehide', disconnect);
  $('#return-browser').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      if (controlled) { await api('/api/browser/release', { chatId: currentChat }); mode(false); await refresh(); }
      else { $('#browser-status').textContent = 'Taking control…'; send({ type: 'take' }); }
    }
    catch (error) { $('#browser-status').textContent = error.message; }
    finally { $('#return-browser').disabled = !ready && !controlled; }
  });
  $('#browser-address').addEventListener('submit', event => {
    event.preventDefault(); const input = $('#browser-url');
    if (input.value) send({ type: 'navigate', url: input.value }); input.value = ''; screen.focus();
  });
  $('#browser-back').addEventListener('click', () => send({ type: 'back' }));
  $('#browser-reload').addEventListener('click', () => send({ type: 'reload' }));
  $('#browser-tab').addEventListener('click', () => send({ type: 'key', key: 'Tab' }));
  $('#browser-enter').addEventListener('click', () => send({ type: 'key', key: 'Enter' }));
  function point(event) {
    const bounds = screen.getBoundingClientRect();
    return { x: Math.max(0, Math.min(screen.width - 1, (event.clientX - bounds.left) * screen.width / bounds.width)), y: Math.max(0, Math.min(screen.height - 1, (event.clientY - bounds.top) * screen.height / bounds.height)) };
  }
  screen.addEventListener('pointerdown', event => {
    if (!controlled) return;
    event.preventDefault(); screen.focus(); screen.setPointerCapture(event.pointerId);
    touch = { ...point(event), startY: event.clientY, lastY: event.clientY, moved: false, id: event.pointerId };
  });
  screen.addEventListener('pointermove', event => {
    if (!touch || touch.id !== event.pointerId) return;
    if (Math.abs(event.clientY - touch.startY) > 8) touch.moved = true;
    if (touch.moved && event.pointerType === 'touch') { send({ type: 'scroll', y: Math.max(-2000, Math.min(2000, (touch.lastY - event.clientY) * screen.height / screen.clientHeight)) }); touch.lastY = event.clientY; }
  });
  screen.addEventListener('pointerup', event => { if (touch?.id === event.pointerId && !touch.moved) send({ type: 'click', x: touch.x, y: touch.y }); touch = undefined; });
  screen.addEventListener('pointercancel', () => { touch = undefined; });
  screen.addEventListener('wheel', event => { event.preventDefault(); send({ type: 'scroll', y: Math.max(-2000, Math.min(2000, event.deltaY)) }); }, { passive: false });
  const keys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  function key(event, direct = false) {
    if (!controlled) return;
    if (event.isComposing || composing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    if (keys.has(event.key) || (event.ctrlKey || event.metaKey || event.altKey) && /^[A-Za-z]$/.test(event.key)) {
      event.preventDefault();
      send({ type: 'key', key: `${event.ctrlKey || event.metaKey ? 'Control+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.key}` });
    } else if (direct && event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
  }
  screen.addEventListener('keydown', event => key(event, true));
  screen.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain').slice(0, 4096); send({ type: 'text', text }); });
  const keyboard = $('#browser-keyboard');
  keyboard.addEventListener('keydown', event => key(event));
  keyboard.addEventListener('compositionstart', () => { composing = true; });
  const type = () => { if (!composing && keyboard.value) { send({ type: 'text', text: keyboard.value.slice(0, 4096) }); keyboard.value = ''; } };
  keyboard.addEventListener('compositionend', () => { composing = false; type(); });
  keyboard.addEventListener('input', type);
  keyboard.addEventListener('beforeinput', event => {
    if (event.inputType === 'deleteContentBackward') { event.preventDefault(); send({ type: 'key', key: 'Backspace' }); }
  });
};
