'use strict';
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const Ajv = require('ajv');
class McpRegistry {
 constructor(configs=[],secret=async()=>undefined){this.configs=configs;this.secret=secret;this.clients=new Map();this.connecting=new Map();this.tools=new Map();this.loaded=new Map();this.closed=false;this.ajv=new Ajv({strict:false,allErrors:true});this.ajv.addFormat('int32',{type:'number',validate:n=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647});}
 async connect(name){if(this.closed)throw Error('MCP registry is closed');if(this.clients.has(name))return this.clients.get(name);if(this.connecting.has(name))return this.connecting.get(name);const pending=this.connectOnce(name);this.connecting.set(name,pending);try{return await pending;}finally{this.connecting.delete(name);}}
 async connectOnce(name){const cfg=this.configs.find(c=>c.name===name);if(!cfg)throw new Error('Unknown MCP server');if(cfg.requiresApproval&&!cfg.approved)throw new Error('Connection needs approval in AI: Skills and MCP');
 const client=new Client({name:'glm-ai',version:'0.15.5'},{capabilities:{}});
 let transport;
 if(typeof cfg.transport==='function')transport=await cfg.transport();
 else if(cfg.url){const url=new URL(cfg.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&(cfg.allowHttp||['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('MCP requires HTTPS or localhost');if(url.username||url.password)throw new Error('Store MCP credentials in SecretStorage');const token=await this.secret(name);const headers={...(cfg.headers||{}),...(token?{Authorization:`Bearer ${token}`}:{})};const options={requestInit:{headers},...(cfg.type==='sse'?{eventSourceInit:{fetch:(input,init)=>fetch(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),...headers},redirect:'error'})}}:{})};transport=cfg.type==='sse'?new SSEClientTransport(url,options):new StreamableHTTPClientTransport(url,options);}
 else{if(typeof cfg.command!=='string'||!Array.isArray(cfg.args||[]))throw new Error('MCP requires command and argument array');transport=new StdioClientTransport({command:cfg.command,args:cfg.args||[],env:cfg.env,cwd:cfg.cwd,stderr:'pipe'});transport.stderr?.resume();}
 try{await client.connect(transport,{timeout:15000});}catch(e){await client.close().catch(()=>{});throw new Error(`MCP ${name}: connection failed (${e.code||e.name||'error'})`);}if(this.closed){await client.close();throw Error('MCP registry is closed');}this.clients.set(name,client);client.onclose=()=>{if(this.clients.get(name)===client){this.clients.delete(name);for(const [key,t] of this.tools)if(t.server===name)this.tools.delete(key);}};client.setNotificationHandler(ToolListChangedNotificationSchema,()=>this.refresh(name).catch(()=>{}));try{await this.refresh(name);}catch(e){this.clients.delete(name);await client.close().catch(()=>{});throw e;}return client;}
 async refresh(name){const client=this.clients.get(name),fresh=[];let cursor;const cursors=new Set();for(let page=0;page<64;page++){const list=await client.listTools(cursor?{cursor}:{},{timeout:15000});fresh.push(...list.tools);cursor=list.nextCursor;if(!cursor)break;if(cursors.has(cursor)||page===63)throw new Error('MCP pagination did not converge');cursors.add(cursor);}
 if(this.clients.get(name)!==client) return;
 for(const [key,t]of this.tools)if(t.server===name)this.tools.delete(key);
 const local=this.configs.some(cfg=>cfg.name===name&&typeof cfg.transport==='function');
 for(const t of fresh){const key='mcp_'+(local?t.name:createHash('sha256').update(name+'\0'+t.name).digest('hex').slice(0,24));this.tools.set(key,{server:name,local,tool:t,definition:{type:'function',function:{name:key,description:`[${name}/${t.name}] ${(t.description||'').slice(0,3000)}`,parameters:t.inputSchema}},validate:this.ajv.compile(t.inputSchema)});}}
 async resources(server,cursor){const client=await this.connect(server);if(!client.getServerCapabilities()?.resources)return JSON.stringify({resources:[],unsupported:true});return JSON.stringify(await client.listResources(cursor?{cursor}:{}));}
 async readResource(server,uri,signal){const client=await this.connect(server);if(typeof uri!=='string')throw new Error('Resource URI required');return JSON.stringify(await client.readResource({uri},{signal,timeout:30000}));}
 async search(query,owner,onlyServer){
   if(typeof query!=='string'||!query.trim())throw Error('Search query required');
   const exact=query.trim().toLowerCase();
   const known=[...this.tools.entries()].find(([key,t])=>key===exact);
   const target=onlyServer||known?.[1].server||this.configs.find(cfg=>
     exact===cfg.name.toLowerCase()||exact.startsWith(cfg.name.toLowerCase()+'/'))?.name;
   const configs=this.configs.filter(cfg=>target?cfg.name===target:!cfg.ready||cfg.ready());
   const errors=[],pending=new Set();
   const included=new Set(configs.map(cfg=>cfg.name)), words=exact.split(/\s+/);
   const rank=()=>[...this.tools.entries()].filter(([,t])=>included.has(t.server)).map(([key,t])=>{
     const exactName=key===exact||t.tool.name.toLowerCase()===exact||
       (t.server+'/'+t.tool.name).toLowerCase()===exact;
     const searchable=(t.server+' '+t.tool.name+' '+(t.tool.description||'')).toLowerCase();
     return {key,t,exactName,score:exactName?100:onlyServer||exact===t.server.toLowerCase()?1:
       words.reduce((score,word)=>score+Number(searchable.includes(word)),0)};
   }).filter(item=>item.score).sort((a,b)=>b.score-a.score);
   const work=configs.map(async cfg=>{
     if(this.clients.has(cfg.name)&&!cfg.ready)return;
     pending.add(cfg.name);
     try{
       if(this.clients.has(cfg.name))await this.refresh(cfg.name);
       else await this.connect(cfg.name);
     }catch(error){errors.push({server:cfg.name,error:error.message});}
     finally{pending.delete(cfg.name);}
   });
   if(target)await Promise.all(work);
   else if(pending.size && !rank().length){
     let timer;
     await Promise.race([Promise.all(work),new Promise(resolve=>{timer=setTimeout(resolve,350);})]);
     clearTimeout(timer);
   }
   let ranked=rank();
   if(ranked.some(item=>item.exactName))ranked=ranked.filter(item=>item.exactName);
   ranked=ranked.slice(0,onlyServer?20:5);
   const loaded=this.loaded.get(owner)||new Set();
   let externalCount=[...loaded].filter(key=>this.tools.has(key)&&!this.tools.get(key).local).length;
   for(const item of ranked){
     if(loaded.has(item.key)||(!item.t.local&&externalCount>=20))continue;
     loaded.add(item.key);
     if(!item.t.local)externalCount++;
   }
   this.loaded.set(owner,loaded);
   return JSON.stringify({tools:ranked.filter(item=>loaded.has(item.key)).map(({key,t})=>({
     name:key,server:t.server,originalName:t.tool.name,description:t.tool.description
   })),errors,pending:[...pending],...(pending.size?{
     partial:true, hint:'Some catalogs are still connecting. Continue with ready tools or query the required server by exact name.'
   }:{})});
 }
 taskSupported(name){
   const entry=this.tools.get(name);
   return Boolean(entry && !entry.local && ['required','optional'].includes(entry.tool.execution?.taskSupport) &&
     this.clients.get(entry.server)?.getServerCapabilities()?.tasks?.requests?.tools?.call);
 }
 async runTask(name,args,signal,onCreated){
   const entry=this.tools.get(name),client=entry&&this.clients.get(entry.server);
   if(!client||!this.taskSupported(name))throw Error('MCP task is no longer available.');
   if(!entry.validate(args))throw Error('Invalid MCP arguments: '+this.ajv.errorsText(entry.validate.errors));
   let taskId;
   const options={task:{ttl:300000,pollInterval:1000},signal,timeout:60000};
   try{
     for await(const message of client.experimental.tasks.callToolStream({name:entry.tool.name,arguments:args},undefined,options)){
       if(message.type==='taskCreated'){taskId=message.task.taskId;onCreated?.(taskId);}
       if(message.type==='result')return message.result;
       if(message.type==='error')throw message.error;
     }
     throw Error('MCP task ended without a result.');
   }finally{
     if(taskId&&signal.aborted)client.experimental.tasks.cancelTask(taskId,{timeout:3000}).catch(()=>{});
   }
 }
 selected(owner){return [...(this.loaded.get(owner)||[])].sort().map(key=>this.tools.get(key)?.definition).filter(Boolean);}
 async call(name,args,signal,owner){const t=this.tools.get(name);if(!t)throw new Error('MCP tool is no longer available. Search tools again');if(!t.validate(args))throw new Error('Invalid MCP arguments: '+this.ajv.errorsText(t.validate.errors));const result=await this.clients.get(t.server).callTool({name:t.tool.name,arguments:args,...(t.local?{_meta:{harnessConversation:owner}}:{})},undefined,{signal,timeout:60000});return JSON.stringify(result);}
 catalog(){return this.configs.map(c=>({name:c.name,source:c.source||'AI settings',transport:c.type||(c.url?'http':'stdio'),status:c.ready&&!c.ready()?'unavailable':c.requiresApproval&&!c.approved?'needs approval':this.clients.has(c.name)?'connected':'configured'}));}
 close(){this.closed=true;for(const c of this.clients.values())c.close().catch(()=>{});this.clients.clear();}
}
module.exports={McpRegistry};
