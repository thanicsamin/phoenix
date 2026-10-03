import test from 'node:test';
import assert from 'node:assert/strict';
import {once, EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createAuth} from '../extensions/auth.js';
import {createWebServer} from '../extensions/web.js';

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
