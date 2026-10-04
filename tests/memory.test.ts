import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import memory from '../extensions/memory.ts';

test('shared memory persists across chats and includes owner facts in subsequent prompts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'phoenix-memory-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const host={workspace:directory,extensions:{}};const tools=[];const hooks=[];
  const pi={on:(_event,handler)=>hooks.push(handler),registerTool:tool=>tools.push(tool)};
  memory(pi,host);memory(pi,host);
  assert.equal((await tools[0].execute('read',{})).content[0].text,'(empty)');
  await Promise.all([tools[0].execute('first',{text:'I prefer brief replies.'}),tools[1].execute('second',{text:'I prefer tea.'})]);
  assert.equal((await tools[0].execute('read',{})).content[0].text,'I prefer tea.');
  const prompt=await hooks[1]({systemPrompt:'Base prompt'});
  assert.match(prompt.systemPrompt,/Base prompt/);assert.match(prompt.systemPrompt,/I prefer tea/);
  assert.match(prompt.systemPrompt,/Never store secrets/);
});
