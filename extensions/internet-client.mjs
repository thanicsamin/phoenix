import { connect, BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const privateRanges = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) privateRanges.addSubnet(address, prefix);
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
privateRanges.addSubnet('2001:db8::', 32, 'ipv6'); privateRanges.addSubnet('2002::', 16, 'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !privateRanges.check(address) : family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !privateRanges.check(address, 'ipv6');
}
export async function destination(host, port) {
  if (typeof host !== 'string' || host.length > 253 || ![80,443].includes(port)) throw Error('Only public HTTP/HTTPS destinations are allowed.');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw Error('Private network destinations are blocked.');
  return addresses[0];
}

// One dependency-free client for Windows, macOS and Linux (Node 22+).
// DNS resolves here; TLS remains end-to-end between Phoenix and the website.
export function startConnector(url, token, { resolveDestination = destination, connectSocket = (address, port) => connect({ host: address.address, port, family: address.family }), retry = true } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname))) throw Error('Use HTTPS for a remote Phoenix.');
  let stopped = false; let socket; let reconnect; const streams = new Map();
  const drop = id => { const item = streams.get(id); streams.delete(id); item?.tcp?.destroy(); clearInterval(item?.drain); };
  const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const dial = () => {
    socket = new WebSocket(target, ['phoenix-relay', token]); socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => console.log('Phoenix connected. Keep this window open. Ctrl+C disconnects.'));
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', event => {
      for (const id of streams.keys()) drop(id);
      if (!stopped && retry && event.code !== 1008) reconnect = setTimeout(dial, 3000);
      else if (!stopped) console.log('Connector disconnected. Pair again from Phoenix Settings.');
    });
    socket.addEventListener('message', async event => {
      try {
        if (typeof event.data !== 'string') {
          const bytes = Buffer.from(event.data); if (bytes.length < 4 || bytes.length > 65540) throw Error('Invalid data.');
          const id = bytes.readUInt32BE(); const item = streams.get(id); if (!item) return;
          if (!item.tcp.write(bytes.subarray(4))) send({ type: 'pause', id });
          return;
        }
        const value = JSON.parse(event.data); const { type, id, host, port } = value;
        if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) throw Error('Invalid stream.');
        if (type === 'open') {
          if (streams.has(id) || streams.size >= 32) throw Error('Too many connections.');
          // Reserve before awaiting DNS so concurrent opens also count toward the cap.
          const item = { tcp: undefined, peerPaused: false }; streams.set(id, item);
          try {
            const address = await resolveDestination(host, port);
            if (streams.get(id) !== item || socket.readyState !== WebSocket.OPEN) return;
            const tcp = connectSocket(address, port); item.tcp = tcp;
            tcp.setTimeout(60000, () => drop(id));
            tcp.once('connect', () => send({ type: 'ready', id }));
            tcp.on('data', bytes => {
              for (let offset = 0; offset < bytes.length; offset += 65536) {
                const payload = Buffer.alloc(4 + Math.min(65536, bytes.length - offset)); payload.writeUInt32BE(id); bytes.copy(payload, 4, offset, offset + 65536); socket.send(payload);
              }
              if (socket.bufferedAmount > 1024 * 1024) {
                tcp.pause(); item.drain ||= setInterval(() => {
                  if (socket.bufferedAmount < 131072) { clearInterval(item.drain); item.drain = undefined; if (!item.peerPaused) tcp.resume(); }
                }, 10);
              }
              if (socket.bufferedAmount > 4 * 1024 * 1024) socket.close(1008, 'Buffer limit');
            });
            tcp.on('drain', () => send({ type: 'resume', id }));
            tcp.on('end', () => send({ type: 'end', id }));
            tcp.on('error', () => { send({ type: 'close', id }); drop(id); });
            tcp.on('close', () => { send({ type: 'close', id }); drop(id); });
          } catch { send({ type: 'close', id }); drop(id); }
        } else {
          const item = streams.get(id); if (!item) return;
          if (type === 'close') drop(id);
          else if (type === 'end') item.tcp?.end();
          else if (type === 'pause') { item.peerPaused = true; item.tcp?.pause(); }
          else if (type === 'resume') { item.peerPaused = false; if (!item.drain) item.tcp?.resume(); }
          else throw Error('Invalid message.');
        }
      } catch { socket.close(1008, 'Invalid relay message'); }
    });
  };
  dial();
  return () => { stopped = true; clearTimeout(reconnect); for (const id of streams.keys()) drop(id); socket.close(); };
}
