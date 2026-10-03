import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import browser from '../extensions/browser.js';
const server=createServer((_request,response)=>response.end(`<html><body><h1>Browser ready</h1><p id="detection"></p><script>document.querySelector('#detection').textContent='webdriver='+navigator.webdriver+'; headed='+!navigator.userAgent.includes('HeadlessChrome');</script><label>Name<input id="name"></label><button id="confirm" onclick="document.querySelector('h1').textContent='Confirmed'">Confirm</button></body></html>`));
server.listen(0,'127.0.0.1'); await once(server,'listening');
const host={dataDir:'/data',extensions:{},cleanups:[],changed(){}};
let tool;
browser({on(){},registerTool(value){tool=value;}},host,{},'browser-smoke');
try {
 const snapshot=await tool.execute('smoke',{action:'navigate',url:`http://127.0.0.1:${server.address().port}`});
 assert.match(snapshot.content[0].text,/Browser ready/);
 assert.match(snapshot.content[0].text,/webdriver=false; headed=true/);
 await tool.execute('smoke',{action:'fill',selector:'#name',value:'Phoenix'});
 const clicked=await tool.execute('smoke',{action:'click',selector:'#confirm'});
 assert.match(clicked.content[0].text,/Confirmed/);
 const screenshot=await tool.execute('smoke',{action:'screenshot'});
 assert.equal(screenshot.content[0].mimeType,'image/png');
 assert.ok(screenshot.content[0].data.length>1000);
 console.log('Container Chromium: navigation, input, click, snapshot and screenshot passed.');
} finally {
 for (const cleanup of host.cleanups.reverse()) await cleanup();
 server.closeAllConnections(); server.close();
}
