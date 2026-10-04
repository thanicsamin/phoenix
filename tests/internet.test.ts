import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Internet } from '../extensions/internet.ts';
import { destination, publicAddress, startConnector } from '../extensions/internet-client.ts';

const waitFor = async condition => { for (let n = 0; n < 200; n++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Condition timed out'); };
test('connector blocks private addresses and non-web ports on every platform', async () => {
  for (const address of ['127.0.0.1','10.5.0.1','172.16.3.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  await assert.rejects(destination('localhost', 80), /Private/); await assert.rejects(destination('example.com', 22), /HTTP/);
  assert.throws(() => startConnector('ws://example.com/api/internet/socket', 'token'), /HTTPS/);
});

test('real connector carries HTTP and CONNECT, rejects unauthorized clients, and fails closed offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-internet-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let closed = 0; const host = { dataDir: directory, changed() {}, browserClosers: new Map([['main', async () => { closed++; }]]) };
  const internet = new Internet(host); await internet.initialize(); t.after(() => internet.close());
  const server = createServer(); host.port = 0; internet.attach(server); server.listen(0,'127.0.0.1'); await once(server, 'listening'); host.port = server.address().port; t.after(() => { server.closeAllConnections(); server.close(); });
  const target = createServer((req, res) => { let body = ''; req.on('data', bytes => { body += bytes; }); req.on('end', () => res.end(req.method + ' ' + req.url + ' ' + body)); }); target.listen(0,'127.0.0.1'); await once(target,'listening'); t.after(() => { target.closeAllConnections(); target.close(); });
  const client = await internet.pair('http://127.0.0.1:' + host.port);
  const match = /\nstartConnector\((".*?"), (".*?")\);/.exec(client); const url = JSON.parse(match[1]); const token = JSON.parse(match[2]);
  assert.equal(closed, 1);
  if (process.platform !== 'win32') assert.equal((await stat(internet.file)).mode & 0o777, 0o600);
  assert.equal((await readFile(internet.file,'utf8')).includes(token), false);
  assert.equal(JSON.stringify(internet.status()).includes(token), false);
  assert.equal((await once(Object.assign(new WebSocket(url,['phoenix-relay','x'.repeat(43)]), {}), 'unexpected-response'))[1].statusCode, 403);
  const stop = startConnector(url, token, { retry: false, resolveDestination: async () => ({ address: '127.0.0.1', family: 4 }), connectSocket: () => connect(target.address().port, '127.0.0.1') }); t.after(stop); await waitFor(() => internet.status().connected);
  const proxy = new URL(internet.proxy);
  const result = await new Promise((resolve,reject) => { const req = request({ host: proxy.hostname, port: proxy.port, path: 'http://web-fixture.invalid/check?a=1', method: 'POST' }, res => { let body=''; res.on('data',x=>body+=x); res.on('end',()=>resolve(body)); }); req.on('error',reject); req.end('hello'); });
  assert.equal(result, 'POST /check?a=1 hello');
  const tunnel = connect({ host: proxy.hostname, port: proxy.port }); tunnel.on('error',()=>{}); let bytes=''; tunnel.on('data', chunk=>bytes+=chunk); tunnel.write('CONNECT web-fixture.invalid:80 HTTP/1.1\r\nHost: web-fixture.invalid:80\r\n\r\n'); await waitFor(()=>bytes.includes('200 Connection Established')); tunnel.write('GET /tunnel HTTP/1.1\r\nHost: web-fixture.invalid\r\nConnection: close\r\n\r\n'); await waitFor(()=>bytes.includes('GET /tunnel')); tunnel.destroy();
  await internet.toggle(false); assert.equal(internet.status().connected, true); assert.equal(internet.status().enabled, false);
  await assert.rejects(new Promise((resolve,reject)=>internet.open('example.com',80).once('ready',resolve).once('error',reject)), /unavailable/);
  await internet.toggle(true); stop(); await waitFor(()=>!internet.status().connected);
  await assert.rejects(new Promise((resolve,reject)=>internet.open('example.com',443).once('ready',resolve).once('error',reject)), /unavailable/);
  assert.equal(internet.status().enabled, true); await internet.revoke(); assert.equal(internet.status().paired, false); assert.ok(closed >= 4);
});
