'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');
test('models open an in-chat provider form, reuse only matching credentials and never persist entered keys',async()=>{
 const {window,document}=parseHTML(fs.readFileSync('media/chat.html','utf8'));let active;Object.defineProperty(document,'activeElement',{get:()=>active});window.HTMLElement.prototype.focus=function(){active=this;};window.HTMLElement.prototype.getBoundingClientRect=()=>({top:500,left:20,bottom:600,width:680,height:100});window.HTMLElement.prototype.checkValidity=()=>true;window.HTMLElement.prototype.reportValidity=()=>true;
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value||this.firstElementChild?.getAttribute('value')||'';},set(v){this._value=v;}});
 const messages=[],states=[],context=vm.createContext({window,document,Event:window.Event,TextDecoder,crypto:require('node:crypto'),acquireVsCodeApi:()=>({getState:()=>({}),setState:s=>states.push(JSON.stringify(s)),postMessage:m=>messages.push(m)}),requestAnimationFrame:fn=>fn(),getComputedStyle:()=>({top:'9px',height:'6px'}),ResizeObserver:class{observe(){} unobserve(){} disconnect(){}},setInterval(){},setTimeout(){},clearTimeout(){},console});
 for(const file of ['media/icons.js','media/transcript.js','media/chat.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const event=new window.Event('message');event.data={type:'state',session:{id:'draft',title:'New conversation',mode:'manual',timeline:[],messages:[],usage:{input:0,output:0}},provider:{name:'glm',model:'glm-5.3',baseUrl:'https://api.z.ai/api/coding/paas/v4',protocol:'chat',configured:true,connectionId:'legacy'},modelConnections:[{id:'legacy',label:'glm-5.3',provider:'glm',model:'glm-5.3'}],workspace:'test',readonly:false,busy:false};const unconfigured=new window.Event('message');
 unconfigured.data={...event.data,provider:{...event.data.provider,configured:false},modelConnections:[]};
 window.dispatchEvent(unconfigured);
 assert.equal(document.getElementById('model').textContent,'Select model');
 assert.equal(document.getElementById('setup').hidden,false);
 assert(document.getElementById('app').classList.contains('needs-model'));
 document.getElementById('connect-codex').click();
 assert.equal(messages.at(-1).type,'chatgptSignIn');
 assert.equal(document.getElementById('connection-provider').value,'chatgpt');
 document.dispatchEvent(Object.assign(new window.Event('keydown'),{key:'Escape'}));
 document.getElementById('connect').click();
 assert.equal(document.getElementById('connection-provider').value,'glm');
 assert.equal(document.getElementById('connection-key').disabled,false);
 document.dispatchEvent(Object.assign(new window.Event('keydown'),{key:'Escape'}));
 const savedModel=new window.Event('message');
 savedModel.data={...unconfigured.data,modelConnections:event.data.modelConnections};
 window.dispatchEvent(savedModel);
 assert.equal(document.getElementById('setup').hidden,true);
 assert(!document.getElementById('app').classList.contains('needs-model'));
 window.dispatchEvent(unconfigured);

 document.getElementById('model').click();
 assert.doesNotMatch(document.getElementById('popup').textContent,/glm-5\.3/);
 assert.match(document.getElementById('popup').textContent,/Добавить модель/);
 document.dispatchEvent(Object.assign(new window.Event('keydown'),{key:'Escape'}));
 window.dispatchEvent(event);
 assert.equal(document.getElementById('setup').hidden,true);
 assert.equal(document.getElementById('welcome-title').hidden,false);
 document.getElementById('model').click();assert(document.querySelector('.popup-models'));
 assert(parseInt(document.getElementById('popup').style.maxHeight)<=320);assert.equal(document.querySelectorAll('.model-choice-row').length,2);
 const high=document.querySelector('[data-effort="high"]');high.click();assert.equal(messages.at(-1).type,'selectEffort');assert.equal(messages.at(-1).effort,'high');assert.equal(high.getAttribute('aria-checked'),'true');assert.equal(document.getElementById('popup').hidden,false);
 const toggle=document.querySelector('.architecture-toggle');toggle.click();assert.equal(messages.at(-1).profile,'architecture');assert.equal(toggle.getAttribute('aria-checked'),'true');toggle.click();assert.equal(messages.at(-1).profile,'balanced');assert.equal(toggle.getAttribute('aria-checked'),'false');
 document.querySelector('.effort-track').onkeydown({key:'End',preventDefault(){},stopPropagation(){}});assert.equal(messages.at(-1).effort,'max');assert.equal(document.querySelector('[data-effort="max"]').getAttribute('aria-checked'),'true');

 [...document.querySelectorAll('.popup-item')].find(n=>n.textContent.includes('Добавить модель')).click();assert.equal(document.getElementById('popup').hidden,false);assert(document.querySelector('.connection-form'));assert.equal(document.getElementById('connection-reuse').checked,true);
 const provider=document.getElementById('connection-provider');provider.value='custom';provider.onchange();assert.equal(document.getElementById('connection-reuse').checked,false);assert.equal(document.getElementById('connection-key').disabled,false);document.getElementById('connection-model').value='my-model';document.getElementById('connection-base').value='https://api.example.com/v1';document.getElementById('connection-key').value='never-persist-this';document.querySelector('.connection-form').onsubmit({preventDefault(){}});const packet=messages.at(-1);assert.equal(packet.type,'saveModelConnection');assert.equal(packet.profile.apiKey,'never-persist-this');assert(states.every(s=>!s.includes('never-persist-this')));assert.equal(document.getElementById('connection-key').value,'');
 const error=new window.Event('message');error.data={type:'modelConnectionError',requestId:packet.requestId,text:'Check model ID'};window.dispatchEvent(error);assert.equal(document.getElementById('connection-error').textContent,'Check model ID');assert.equal(document.querySelector('.connection-save').disabled,false);
 document.getElementById('connection-key').value='discard-on-close';document.dispatchEvent(Object.assign(new window.Event('keydown'),{key:'Escape'}));assert.equal(document.getElementById('popup').hidden,true);assert(!document.getElementById('connection-key'));
 document.getElementById('settings').click();assert.equal(document.getElementById('popup').hidden,false);assert(document.querySelector('.connection-form'));
 const planProvider=document.getElementById('connection-provider');planProvider.value='chatgpt';planProvider.onchange();assert.equal(document.getElementById('connection-key').required,false);assert.equal(document.getElementById('connection-key').parentElement.hidden,true);assert.equal(document.querySelector('.connection-save').disabled,true);
 document.querySelector('.connection-login').click();const authPacket=messages.at(-1);assert.equal(authPacket.type,'chatgptSignIn');
 const authorized=new window.Event('message');authorized.data={type:'chatgptAuthorized',requestId:authPacket.requestId,account:{id:'account1',email:'user@test'},accounts:[{id:'account1',email:'user@test'}],models:[{id:'account-model',label:'Available model'}]};window.dispatchEvent(authorized);assert.equal(document.querySelector('.connection-save').disabled,false);assert.equal(document.getElementById('connection-plan-model').value,'account-model');document.querySelector('.connection-form').onsubmit({preventDefault(){}});assert.equal(messages.at(-1).profile.accountId,'account1');assert.equal(messages.at(-1).profile.provider,'chatgpt');assert.equal(messages.at(-1).profile.model,'account-model');assert.equal(messages.at(-1).profile.apiKey,'');
 const close=new window.Event('keydown');close.key='Escape';document.dispatchEvent(close);
 for(const [trigger,kind] of [['mode','modes'],['attach','add']]){
   document.getElementById(trigger).click();assert(document.querySelector('.popup-'+kind));
   document.dispatchEvent(close);assert.equal(document.getElementById('popup').hidden,true);
 }
 document.getElementById('model').click();
 [...document.querySelectorAll('.popup-item')].find(row=>row.textContent.includes('Skills and MCP')).click();
 assert.equal(messages.at(-1).type,'integrations');
 const catalog=new window.Event('message');
 catalog.data={type:'integrationsState',servers:[{name:'Fixture',source:'Project',status:'needs approval',toolCount:0}],skills:[]};
 window.dispatchEvent(catalog);
 document.querySelector('.integration-connect').click();
 assert.equal(messages.at(-1).type,'connectIntegration');
 const consent=new window.Event('message');
 consent.data={type:'integrationConsent',name:'Fixture',target:'fixture',local:true,consent:'once'};
 window.dispatchEvent(consent);
 assert.match(document.getElementById('integration-status').textContent,/Fixture/);
 document.querySelector('#integration-status .connection-save').click();
 assert.equal(messages.at(-1).consent,'once');

 const local = new window.Event('message');
 local.data = { ...event.data, contextUsage: { used: 400000, window: 1000000, compactAt: 900000 }, session: {
   ...event.data.session, turnId: 'turn', metrics: [
     { phase: 'generation', actor: 'main', turnId: 'turn', usage: { input_tokens: 1024, input_tokens_details: { cached_tokens: 768 } } },
     { phase: 'tool', actor: 'main', turnId: 'turn' }
   ]
 } };
 window.dispatchEvent(local);
 const contextMeter = document.getElementById('context-usage');
 assert.equal(contextMeter.hidden, false);
 assert.equal(contextMeter.style.getPropertyValue('--context-fill'), '40%');
 assert.match(contextMeter.title, /40%.*до автосжатия/);
 contextMeter.click();
 assert.equal(messages.at(-1).type, 'contextReport');
 const beforeContext = messages.length;
 document.getElementById('prompt').value = '/context';
 document.getElementById('prompt').dispatchEvent(new window.Event('input'));
 document.getElementById('send').click();
 assert.deepEqual(messages.slice(beforeContext).map(message=>message.type),['contextReport'],
   '/context requests the local report without sending a chat message');

 const agentCount = document.querySelector('.agent-tree-count');
 window.dispatchEvent(local);
 assert.equal(document.querySelector('.agent-tree-count'), agentCount, 'streaming keeps the click target');
 const map = document.getElementById('agent-map');
 map.showModal = () => { map.open = true; };
 agentCount.click();
 assert.equal(map.open, true);
 map.open = false;

 const prompt = document.getElementById('prompt');
 prompt.value = 'Draft in progress';
 prompt.focus();
 vm.runInContext('lastPromptEdit = Date.now()', context);
 const waiting = new window.Event('message');
 waiting.data = { ...local.data, busy: true, approval: { id: 'test-approval', kind: 'command', detail: 'Test' } };
 window.dispatchEvent(waiting);
 assert.equal(document.getElementById('approval').hidden, true);
 assert.equal(document.querySelector('.composer').hidden, false);
 vm.runInContext('lastPromptEdit -= approvalTypingPause; updateApproval()', context);
 assert.equal(document.getElementById('approval').hidden, false);
 assert.equal(prompt.value, 'Draft in progress');
 const allow = document.getElementById('allow');
 assert.equal(document.activeElement, allow);
 const enter = () => Object.assign(new window.Event('keydown',{bubbles:true,cancelable:true}),{key:'Enter'});
 allow.dispatchEvent(enter());
 assert.equal(messages.at(-1).type,'approval');
 assert.equal(messages.at(-1).allow,true);
 const deny = document.getElementById('deny');
 deny.focus();
 window.dispatchEvent(waiting);
 assert.equal(document.activeElement,deny);
 deny.dispatchEvent(enter());
 assert.equal(messages.at(-1).allow,false);
 const next = new window.Event('message');
 next.data = {...waiting.data,approval:{...waiting.data.approval,id:'next-approval'}};
 window.dispatchEvent(next);
 assert.equal(document.activeElement,allow);

 const question = new window.Event('message');
 question.data = { ...local.data, busy: true, approval: {
   id:'question',kind:'question',question:'Что выбрать?',options:['Первое','Второе'],why:'Влияет на совместимость',
   optionDetails:['Сохраняет формат','Меняет формат'],recommendation:{choice:0,reason:'Сохраняет старых клиентов'}
 } };
 window.dispatchEvent(question);
 assert.equal(document.getElementById('question-panel').hidden,false);
 assert.equal(document.getElementById('action-approval').hidden,true);
 assert.equal(document.activeElement,document.querySelector('#question-options button'));
 assert.equal(document.getElementById('question-why').textContent,'Влияет на совместимость');
 assert.match(document.querySelector('#question-options button').textContent,/Рекомендую.*Сохраняет формат.*Сохраняет старых клиентов/);
 assert.equal(vm.runInContext("renderEvent({id:'thinking',role:'thinking',status:'running'}).querySelector('.loader-dots').children.length",context),3);
 assert.equal(vm.runInContext("renderEvent({id:'thought',role:'thinking',status:'done',startedAt:100,finishedAt:400}).querySelector('.thinking-label').textContent",context),'Thought for <1s');
 document.querySelectorAll('#question-options button')[1].click();
 assert.equal(messages.at(-1).type,'answerQuestion');
 assert.equal(messages.at(-1).choice,1);

 const completed = new window.Event('message');
 completed.data = {...event.data, approval:null, session:{...event.data.session, id:'follow-up',
   plan:{steps:[{status:'pending',title:'Проверить сценарий в браузере'}]},
   timeline:[{id:'fu-user',role:'user',text:'Проверь изменение'},{id:'fu-reply',role:'assistant',status:'done',text:'План готов.'}]}};
 window.dispatchEvent(completed);
 const followUpInput=document.getElementById('prompt');
 assert.equal(followUpInput.placeholder,'Продолжим. Следующий шаг — Проверить сценарий в браузере');
 assert(followUpInput.classList.contains('has-follow-up'));
 const press=key=>followUpInput.dispatchEvent(Object.assign(new window.Event('keydown',{cancelable:true}),{key}));
 const beforeTab=messages.length;
 press('Enter');
 assert.equal(messages.length,beforeTab);
 press('Tab');
 assert(!followUpInput.classList.contains('has-follow-up'));
 assert.equal(followUpInput.value,'Продолжим. Следующий шаг — Проверить сценарий в браузере');
 assert.equal(messages.length,beforeTab);
 press('Enter');
 assert.equal(messages.at(-1).type,'send');
 assert.equal(messages.at(-1).text,'Продолжим. Следующий шаг — Проверить сценарий в браузере');
 assert.equal(followUpInput.value,'');

 document.dispatchEvent(Object.assign(new window.Event('keydown'),{key:'Escape'}));
 event.data={...event.data,provider:{...event.data.provider,name:'chatgpt',model:'account-model',accountId:'account1',effortLevels:['low','medium','xhigh'],reasoningEffort:'medium'}};
 window.dispatchEvent(event);
 document.getElementById('model').click();
 const catalogRequest=messages.at(-1);
 assert.equal(catalogRequest.type,'chatgptCatalog');
 const codexCatalog=new window.Event('message');
 codexCatalog.data={type:'chatgptCatalog',requestId:catalogRequest.requestId,models:[{id:'account-model',label:'Available model'},{id:'another-model',label:'Another model'}]};
 window.dispatchEvent(codexCatalog);
 assert.equal(document.querySelector('[data-effort="medium"]').getAttribute('aria-checked'),'true');
 document.querySelector('.effort-track').onkeydown({key:'End',preventDefault(){},stopPropagation(){}});
 assert.equal(messages.at(-1).effort,'xhigh');
 assert.equal(messages.at(-1).model,'account-model');
 const picker=document.querySelector('.codex-model-select');
 picker.value='another-model';picker.onchange();
 assert.equal(messages.at(-1).type,'selectChatgptModel');
 assert.equal(messages.at(-1).model,'another-model');

 const dispatchDrag = (type, transfer) => {
   const drag = Object.assign(new window.Event(type,{cancelable:true}),{dataTransfer:transfer});
   document.dispatchEvent(drag);
   assert.equal(drag.defaultPrevented,true);
 };
 const explorer = {
   types:['application/vnd.code.uri-list'],files:[],
   getData:type=>type==='application/vnd.code.uri-list'?'file:///project/a%20b.js\r\nfile:///project/README.md':''
 };
 dispatchDrag('dragover',explorer);
 assert.equal(explorer.dropEffect,'copy');
 assert(document.body.classList.contains('file-drag-over'));
 dispatchDrag('drop',explorer);
 assert.equal(messages.at(-1).type,'attachDroppedFiles');
 assert.deepEqual(Array.from(messages.at(-1).paths),['file:///project/a%20b.js','file:///project/README.md']);
 assert(!document.body.classList.contains('file-drag-over'));
 const attached=new window.Event('message');
 attached.data={type:'attachment',sessionId:'draft',file:{path:'/project/README.md',kind:'file',label:'README.md'}};
 window.dispatchEvent(attached);
 assert.match(document.getElementById('attachments').textContent,/README.md/);
 const dropped = {name:'notes.txt',type:'text/plain',size:2,arrayBuffer:async()=>new Uint8Array([111,107]).buffer};
 dispatchDrag('drop',{types:['Files'],files:[dropped],getData:()=>''});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(document.getElementById('attachments').textContent,/notes.txt/);
 const upload=document.getElementById('send');
 assert.equal(upload.disabled,false);
 upload.click();
 assert.equal(messages.at(-1).type,'send');
 assert.equal(messages.at(-1).attachments.find(item=>item.label==='notes.txt').text,'ok');

 const checkpointState=new window.Event('message');
 checkpointState.data={...event.data,session:{...event.data.session,id:'checkpoint-chat',timeline:[
   {id:'checkpoint-user',role:'user',text:'Branchable message',checkpoint:{timeline:0,messages:0}},
   {id:'ordinary-user',role:'user',text:'Ordinary message'}
 ]}};
 window.dispatchEvent(checkpointState);
 const [branchable,ordinary]=document.querySelectorAll('article.user');
 const contextMenu=document.getElementById('checkpoint-menu');
 assert.equal(contextMenu.hidden,true);
 assert(!branchable.textContent.includes('Ветка отсюда'));
 const rightClick=()=>Object.assign(new window.Event('contextmenu',{cancelable:true,bubbles:true}),{clientX:30,clientY:60});
 const ordinaryClick=rightClick();ordinary.dispatchEvent(ordinaryClick);assert(!ordinaryClick.defaultPrevented);
 const branchClick=rightClick();branchable.dispatchEvent(branchClick);assert(branchClick.defaultPrevented);
 assert.equal(contextMenu.hidden,false);
 assert.deepEqual(Array.from(contextMenu.children,item=>item.textContent),['Ветка отсюда','Ветка с откатом кода']);
 contextMenu.lastElementChild.click();
 assert.equal(contextMenu.hidden,true);
 assert.equal(messages.at(-1).type,'checkpoint');
 assert.equal(messages.at(-1).id,'checkpoint-user');
 assert.equal(messages.at(-1).restoreCode,true);

});

test('nested Markdown renders bold code, multiple backticks, and literal code content',()=>{
 const {document}=parseHTML('<html></html>');
 const source=fs.readFileSync('media/chat.js','utf8');
 const context=vm.createContext({document,window:{aiIcon:()=>document.createElement('span')}});
 const fragment=source.slice(source.indexOf('const node ='),source.indexOf('const toolNames'));
 vm.runInContext(fragment,context);
 context.sample='**`ServiceFeedbackBugButton.module.css`** · **``a`b``** · `**literal**` · **`a*b` done**';
 const body=vm.runInContext('markdown(sample)',context);
 assert.deepEqual([...body.querySelectorAll('strong code')].map(n=>n.textContent),['ServiceFeedbackBugButton.module.css','a`b','a*b']);
 assert.equal(body.querySelector('p > code').textContent,'**literal**');

 const render=lines=>{
   context.sample=lines.join('\r\n');
   return vm.runInContext('markdown(sample)',context);
 };
 const fenced=render(['- Example', '', '  ```ts', '  const x = "<tag>";', '    x;', '', '  ```', '- Next item',
   '~~~python', 'def f():', '    return True', '~~~', '', '````text', '```', '````']);
 const ts=fenced.querySelector('li pre');
 assert.equal(ts.getAttribute('aria-label'),'ts');
 assert.equal(ts.textContent,'const x = "<tag>";\n  x;\n');
 assert.equal(ts.querySelector('.diff-syntax-keyword').textContent,'const');
 assert.equal(fenced.querySelectorAll('ul').length,1);
 assert.equal(fenced.querySelectorAll('li').length,2);
 assert.equal(fenced.querySelector('pre[aria-label="python"] .diff-syntax-keyword').textContent,'def');
 assert.equal(fenced.querySelector('pre[aria-label="text"]').textContent,'```');
 const streaming=render(['  ```json', '  {"ok": true}']);
 assert.equal(streaming.querySelector('pre').textContent,'{"ok": true}');

});
