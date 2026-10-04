import test from 'node:test';
import assert from 'node:assert/strict';
import {once, EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createAuth} from '../extensions/auth.ts';
import {createWebServer} from '../extensions/web.ts';

test('WebSocket checks origin/auth, pushes updates, switches chats and revokes logged-out sessions', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'phoenix-socket-'));
  const host=new EventEmitter();
  host.auth=await createAuth(directory,{password:'socket-test-password'});
  host.revision=0; host.record=id=>{if(!['main','side'].includes(id))throw new Error('Not found');};
  host.state=async id=>({chatId:id,revision:host.revision,messages:[]});
  const server=createWebServer(host); server.listen(0,'127.0.0.1'); await once(server,'listening'); host.port=server.address().port;
  const origin=`http://127.0.0.1:${host.port}`;
  const url=`ws://127.0.0.1:${host.port}/api/socket`;
  t.after(async()=>{server.closeWebSockets();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const login=await host.auth.login('socket-test-password');
  for(const headers of [{Origin:origin},{Origin:'https://evil.example',Cookie:`phoenix=${login.token}`}]){
    const denied=new WebSocket(url,{headers});
    const [error]=await once(denied,'error'); assert.match(error.message,/403/);
  }
  const socket=new WebSocket(url,{headers:{Origin:origin,Cookie:`phoenix=${login.token}`}});
  let incoming=once(socket,'message'); await once(socket,'open');
  assert.equal(JSON.parse((await incoming)[0]).chatId,'main');
  incoming=once(socket,'message');host.revision++;host.emit('change');
  const update=JSON.parse((await incoming)[0]);
  assert.equal(update.revision,1); assert.equal(update.messages,undefined);
  incoming=once(socket,'message');socket.send(JSON.stringify({chatId:'side'}));
  assert.equal(JSON.parse((await incoming)[0]).chatId,'side');
  const closing=once(socket,'close');host.auth.logout(login.token);host.emit('change');
  assert.equal((await closing)[0],1008);
});

test('changes during a slow state read are delivered; logout revokes the in-flight reply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-socket-race-'));
  const host = new EventEmitter(); host.auth = await createAuth(directory, { password: 'socket-race-password' });
  host.record = () => {}; let revision = 0; let release; let started;
  let nextRead = new Promise(resolve => { started = resolve; });
  host.state = async chatId => {
    const snapshot = { chatId, revision, messages: [] };
    if (started) { const notify = started; started = undefined; await new Promise(resolve => { release = resolve; notify(); }); }
    return snapshot;
  };
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(async () => { release?.(); server.closeWebSockets(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.port}`; const login = await host.auth.login('socket-race-password');
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/socket', { headers: { Origin: origin, Cookie: `phoenix=${login.token}` } });
  const delivered = []; socket.on('message', data => delivered.push(JSON.parse(data)));
  await once(socket, 'open'); await nextRead;
  revision = 1; host.emit('change'); await new Promise(resolve => setTimeout(resolve, 100));
  const update = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Latest state was dropped')), 2000);
    socket.on('message', data => { if (JSON.parse(data).revision === 1) { clearTimeout(timer); resolve(); } });
  });
  release(); await update; assert.deepEqual(delivered.map(state => state.revision), [0, 1]);
  nextRead = new Promise(resolve => { started = resolve; }); revision = 2; host.emit('change'); await nextRead;
  const closing = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
  host.auth.logout(login.token); release();
  assert.equal((await closing)[0], 1008); assert.equal(delivered.some(state => state.revision === 2), false);
});
