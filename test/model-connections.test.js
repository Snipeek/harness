'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ModelConnections,connections}=require('../src/model-connections'),{SessionStore,hasConversationContent}=require('../src/store');
function context(){const state=new Map(),secrets=new Map();return {state,secretsMap:secrets,globalState:{get:(k,d)=>state.get(k)??d,update:async(k,v)=>state.set(k,v)},secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v),delete:async k=>secrets.delete(k)}};}
const input=(model='model-a')=>({provider:'custom',protocol:'chat',baseUrl:'https://api.example.com/v1',model,apiKey:'private-key'});
test('independent model connections persist metadata without keys and serialize concurrent additions',async()=>{const ctx=context(),store=new ModelConnections(ctx);const [a,b]=await Promise.all([store.save(input()),store.save({...input('model-b'),apiKey:'other-key'})]);assert.equal(store.list().length,2);assert.equal((await store.settings(a.id)).apiKey,'private-key');assert.equal((await store.settings(b.id)).apiKey,'other-key');assert(!JSON.stringify([...ctx.state.values()]).includes('private-key'));assert(!JSON.stringify(store.list()).includes('other-key'));await store.activate(a.id);assert.equal(connections(ctx).activeId,a.id);});
test('credential reuse is bound to provider, endpoint and protocol; failed persistence removes the new secret',async()=>{const ctx=context(),store=new ModelConnections(ctx),source={...input(),apiKey:'source-key'};await store.save({...input(),apiKey:'',reuseKey:true},source);await assert.rejects(store.save({...input(),baseUrl:'https://other.example.com/v1',reuseKey:true},source),/same provider/);await assert.rejects(store.save({...input(),protocol:'responses',reuseKey:true},source),/same provider/);assert.equal(store.list().length,1);const bad=context();bad.globalState.update=async()=>{throw Error('disk error');};await assert.rejects(new ModelConnections(bad).save(input()),/disk error/);assert.equal(bad.secretsMap.size,0);});
test('empty and notice-only drafts are not stored or loaded; real conversations survive regardless of title',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-empty-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new SessionStore(root),draft={id:'aabb-0011',title:'New conversation',messages:[],timeline:[{role:'notice',text:'Configure provider'}]};await store.save(draft);assert.deepEqual(await fs.readdir(root),[]);await fs.writeFile(path.join(root,'aabb-0022.json'),JSON.stringify({...draft,id:'aabb-0022'}));assert.deepEqual(await store.load(),[]);draft.messages.push({role:'user',content:'Hello'});await store.save(draft);assert.equal((await store.load()).length,1);assert(hasConversationContent(draft));draft.messages=[];await store.save(draft);assert.equal((await store.load()).length,0);});
test('changing the model keeps the chat, portable history and provider accounting', async t => {
  const { createHost } = require('../scripts/runtime-host');
  const { providerUsage } = require('../src/sidebar');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-switch-'));
  const h = await createHost({ root, storage: path.join(root, '.storage') });
  t.after(async () => { await h.close(); await fs.rm(root, { recursive: true, force: true }); });
  const ctx = context();
  ctx.secretsMap.set('ai.glm.key', 'legacy-key');
  h.app.context.globalState = ctx.globalState;
  h.app.context.secrets = ctx.secrets;
  const sessionId = h.session.id;
  h.session.messages = [{ role: 'user', content: 'Original conversation' },
    { role: 'assistant', content: 'Prior answer', reasoning_content: 'Legacy reasoning' }];
  h.session.usage = { input: 100, output: 10 };
  h.app.openTab = () => { throw Error('A model switch must not open a tab'); };
  const profile = await h.app.modelConnections.save({ ...input(), protocol: 'responses' });

  h.app.confirmModelRoute = async () => false;
  await h.app.selectModelConnection(h.view, profile.id);
  assert.equal(h.session.modelProfileId, null);
  h.app.confirmModelRoute = async () => true;
  await h.app.selectModelConnection(h.view, profile.id);

  assert.equal(h.session.id, sessionId);
  assert.equal(h.session.modelProfileId, profile.id);
  assert.equal(h.session.messages[1].content, 'Prior answer');
  assert.equal(h.session.messages[1].reasoning_content, undefined);
  const saved = (await h.app.store.load()).find(session => session.id === sessionId);
  assert.equal(saved.modelProfileId, profile.id);

  let payload;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    payload = JSON.parse(request.body);
    const event = { type: 'response.completed', response: {
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continued' }] }],
      usage: { input_tokens: 30, output_tokens: 4 }
    } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  });
  await h.send('Continue');
  assert(payload, h.session.timeline.at(-1)?.text);
  assert.equal(payload.model, profile.model);
  assert(payload.input.some(item => item.role === 'user' && item.content === 'Original conversation'));
  assert.equal(h.session.messages.at(-1).content, 'Continued');
  const other = await h.app.modelConnections.save({ ...input('model-b'), protocol: 'responses' });
  h.app.confirmModelRoute = () => { throw Error('Same endpoint and protocol need no prompt'); };
  await h.app.selectModelConnection(h.view, other.id);
  assert.equal(h.session.id, sessionId);
  assert.equal(h.session.model, 'model-b');
  assert.equal(h.session.messages.at(-1).content, 'Continued');
  const usage = providerUsage([h.session]);
  assert.equal(usage.glm.input, 100);
  assert.equal(usage.custom.input, 30);
});

test('a chat with Codex images continues on text-only GLM and retains images for Codex', async t => {
  const {createHost}=require('../scripts/runtime-host');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-vision-switch-'));
  const h=await createHost({root,storage:path.join(root,'.storage')});
  t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
  const ctx=context();
  const accountId='2c813d88-bcd0-40ec-b7db-c92a35299964';
  const codex={id:'codex',provider:'chatgpt',model:'gpt-6.1-sol',protocol:'responses',
    baseUrl:'https://api.openai.com/v1',accountId};
  ctx.state.set('ai.modelConnections',{activeId:codex.id,profiles:[codex]});
  ctx.secretsMap.set('ai.chatgpt.'+accountId,JSON.stringify({access_token:'mock-access',expires_at:Date.now()+3600000}));
  ctx.secretsMap.set('ai.glm.key','mock-glm');
  h.app.context.globalState=ctx.globalState;
  h.app.context.secrets=ctx.secrets;
  h.app.confirmModelRoute=async()=>true;
  h.session.modelProfileId=codex.id;
  const url='data:image/png;base64,c2NyZWVuc2hvdA==';
  h.session.messages=[
    {role:'user',content:[{type:'text',text:'Inspect this screenshot'},{type:'image_url',image_url:{url}}]},
    {role:'assistant',content:'The save button is visible.',_responseItems:[]},
  ];
  const requests=[];
  t.mock.method(globalThis,'fetch',async (_url,opts)=>{
    const body=JSON.parse(opts.body);
    requests.push(body);
    if(body.messages?.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type!=='text'))){
      return new Response(JSON.stringify({error:{message:"messages.content.type is invalid, allowed values: ['text']"}}),{status:400});
    }
    const event=body.messages
      ? {choices:[{delta:{content:'Continued in GLM'},finish_reason:'stop'}]}
      : {type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Continued in Codex'}]}]}};
    return new Response('data: '+JSON.stringify(event)+'\n\n');
  });

  await h.app.receive(h.view,{type:'mode',mode:'plan'});
  await h.app.receive(h.view,{type:'selectProfile',profile:'architecture'});
  await h.app.selectModelConnection(h.view,'legacy');
  await h.app.receive(h.view,{type:'selectEffort',effort:'high'});
  const glmChat=h.app.newSession();
  assert.equal(glmChat.modelProfileId,null);
  assert.equal(glmChat.mode,'plan');
  assert.equal(glmChat.workProfile,'architecture');
  assert.equal((await h.app.sessionSettings(glmChat)).reasoningEffort,'high');
  await h.send('Continue in GLM');
  assert.equal(h.session.messages.at(-1).content,'Continued in GLM');
  assert(requests[0].messages.some(message=>typeof message.content==='string'&&message.content.includes('Inspect this screenshot')));
  assert(requests[0].messages.some(message=>message.content==='The save button is visible.'));
  assert(!JSON.stringify(requests[0]).includes(url));
  assert.equal(h.session.messages[0].content[1].image_url.url,url);

  await h.app.selectModelConnection(h.view,codex.id);
  const codexSettings=await h.app.sessionSettings(h.session);
  const effort=codexSettings.effortLevels.at(-1);
  await h.app.receive(h.view,{type:'selectEffort',model:codex.model,effort});
  const codexChat=h.app.newSession();
  assert.equal(codexChat.modelProfileId,codex.id);
  assert.equal((await h.app.sessionSettings(codexChat)).reasoningEffort,effort);
  assert.equal((await h.app.sessionSettings(glmChat)).provider,'glm');
  await h.send('Continue in Codex');
  assert.equal(h.session.messages.at(-1).content,'Continued in Codex');
  assert(requests[1].input.some(item=>Array.isArray(item.content)&&item.content.some(part=>part.type==='input_image'&&part.image_url===url)));

  const otherView={postMessage(){}};
  h.app.views.set(otherView,{sessionId:codexChat.id});
  await h.app.selectModelConnection(otherView,'legacy');
  assert.equal((await h.app.sessionSettings(h.app.newSession())).provider,'glm');
  assert.equal((await h.app.sessionSettings(h.session)).provider,'chatgpt');
});
