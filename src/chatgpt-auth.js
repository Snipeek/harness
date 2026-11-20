'use strict';
const http=require('node:http');
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
const ISSUER='https://auth.openai.com',RESOURCE='https://api.openai.com/v1';
const instances=new WeakMap();
function authFor(context){if(!instances.has(context))instances.set(context,new ChatGPTAuth(context));return instances.get(context);}
function publicAccount(record){return {id:record.id,email:record.email||'ChatGPT',subject:record.subject};}
const reasoningLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function modelEffort(model, metadata) {
 const supported = metadata?.supported_reasoning_levels;
 const levels = Array.isArray(supported)
   ? reasoningLevels.filter(level => supported.some(item => item?.effort === level))
   : /^gpt-6\.(?:1-(?:sol|terra)|2-(?:sol|astra))$/.test(model)
     ? reasoningLevels.slice(2) : [];
 return { levels, defaultEffort: levels.includes(metadata?.default_reasoning_level)
   ? metadata.default_reasoning_level : levels.includes('low') ? 'low' : levels[0] };
}
class ChatGPTAuth{
 constructor(context,{fetch:fetcher=globalThis.fetch,verify}={}){this.context=context;this.fetch=fetcher;this.verify=verify||verifyIdentity;this.refreshes=new Map();this.modelCatalogs=new Map();}
 accounts(){return this.context.globalState.get('ai.chatgpt.accounts',[]);}
 async record(id){if(!/^[0-9a-f-]{36}$/i.test(id||''))throw Error('Неверный аккаунт ChatGPT');const raw=await this.context.secrets.get('ai.chatgpt.'+id);if(!raw)throw Error('Войдите в ChatGPT заново');return JSON.parse(raw);}
 async tokenRequest(body){const response=await this.fetch(ISSUER+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,resource:RESOURCE}),redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`ChatGPT: авторизация не удалась (HTTP ${response.status}). Войдите заново.`);return response.json();}
 validateTokens(tokens){if(typeof tokens.access_token!=='string'||!tokens.access_token||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.token_type?.toLowerCase()!=='bearer')throw Error('ChatGPT вернул неполную авторизацию');if(!String(tokens.scope||'').split(' ').includes('chatgpt.tokens.use.direct'))throw Error('Не разрешено использование подписки. Включите доступ для приложения в ChatGPT и войдите заново.');}
 async signIn(...args){if(this.signingIn)throw Error('Вход уже открыт в браузере');this.signingIn=true;try{return await this.startSignIn(...args);}finally{this.signingIn=false;}}
 async startSignIn(openExternal,accountId,requestId){
  if(this.pending)throw Error('Вход уже открыт в браузере');
  const previous=accountId?await this.record(accountId):null;
  let host=this.context.globalState.get('ai.chatgpt.host');if(!host){host='urn:uuid:'+randomUUID();await this.context.globalState.update('ai.chatgpt.host',host);}
  const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const server=http.createServer();let timer,settled=false;
  let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);server.close();this.pending=null;error?reject(error):resolve(value);};
  this.pending={requestId,cancel:()=>finish(Error('Вход отменён'))};
  // Register the promise consumer before opening the browser or handling any callback.
  result.catch(()=>{});
  try{
   await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
   const redirect='http://127.0.0.1:'+server.address().port+'/auth/callback';
   server.on('request',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'");
    let url;try{url=new URL(req.url,redirect);}catch{res.writeHead(400);res.end();return;}if(req.method!=='GET'||url.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
    if(settled){res.writeHead(410);res.end('Sign-in expired.');return;}
    // One attempt accepts exactly one callback, including failures.
    settled=true;clearTimeout(timer);server.close();
    try{
     if(url.searchParams.get('state')!==state)throw Error('Не удалось проверить вход. Повторите авторизацию.');
     if(url.searchParams.has('error'))throw Error('Вход или доступ к подписке отклонён');
     const client=url.searchParams.get('client_id')||previous?.client_id;
     if(!client||client==='dynamic_agent_client'||(previous&&client!==previous.client_id)||!url.searchParams.get('code'))throw Error('Регистрация ChatGPT не завершена');
     const tokens=await this.tokenRequest({grant_type:'authorization_code',client_id:client,code:url.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect});
     this.validateTokens(tokens);
     const identity=await this.verify(tokens.id_token,client,nonce);
     if(previous&&identity.sub!==previous.subject)throw Error('Выполнен вход в другой аккаунт. Добавьте его отдельным подключением.');
     const id=previous?.id||randomUUID(),record={...tokens,id,client_id:client,subject:identity.sub,email:identity.email,expires_at:Date.now()+tokens.expires_in*1000};
     if(!tokens.refresh_token)throw Error('ChatGPT не предоставил обновление авторизации. Повторите вход.');
     await this.context.secrets.store('ai.chatgpt.'+id,JSON.stringify(record));
     const account=publicAccount(record),accounts=this.accounts().filter(a=>a.id!==id);try{await this.context.globalState.update('ai.chatgpt.accounts',[...accounts,account]);}catch(error){if(previous)await this.context.secrets.store('ai.chatgpt.'+id,JSON.stringify(previous));else await this.context.secrets.delete?.('ai.chatgpt.'+id);throw error;}
     res.end('Вход выполнен. Вернитесь в VS Code и выберите модель.');this.pending=null;resolve(account);
    }catch(error){res.writeHead(400);res.end('Вход не завершён. Подробности в VS Code.');this.pending=null;reject(error);}
   });
   timer=setTimeout(()=>finish(Error('Время входа истекло. Повторите вход.')),5*60*1000);timer.unref?.();
   const url=new URL(ISSUER+'/api/accounts/authorize');url.search=new URLSearchParams({client_id:previous?.client_id||'dynamic_agent_client',...(!previous?{agent_name_hint:'GLM Token Usage AI'}:{id_token_hint:previous.id_token}),ext_agent_host_id:host,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
   if(await openExternal(url.toString())===false)finish(Error('Не удалось открыть браузер'));
  }catch(error){finish(error);}
  return result;
 }
 cancel(requestId){if(!requestId||this.pending?.requestId===requestId)this.pending?.cancel();}
 async accessToken(id){
  if(this.refreshes.has(id))return this.refreshes.get(id);
  const operation=this.withRefreshLock(id,async()=>{
   const record=await this.record(id);if(record.expires_at>Date.now()+60000)return record.access_token;
   const tokens=await this.tokenRequest({grant_type:'refresh_token',client_id:record.client_id,refresh_token:record.refresh_token});
   // Refresh may omit scope when retaining the existing grant.
   tokens.scope??=record.scope;this.validateTokens(tokens);
   const next={...record,...tokens,refresh_token:tokens.refresh_token||record.refresh_token,expires_at:Date.now()+tokens.expires_in*1000};
   await this.context.secrets.store('ai.chatgpt.'+id,JSON.stringify(next));return next.access_token;
  }).finally(()=>this.refreshes.delete(id));this.refreshes.set(id,operation);return operation;
 }
 async withRefreshLock(id,operation){
  const directory=this.context.globalStorageUri?.fsPath;if(!directory)return operation();
  await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'chatgpt-refresh-'+id+'.lock');let lock;
  for(let i=0;i<200;i++){
   try{lock=await fs.open(file,'wx',0o600);break;}catch(error){if(error.code!=='EEXIST')throw error;try{if(Date.now()-(await fs.stat(file)).mtimeMs>60000)await fs.rm(file);}catch{}await new Promise(r=>setTimeout(r,200));}
  }
  if(!lock)throw Error('Авторизация обновляется в другом окне. Повторите запрос.');
  try{return await operation();}finally{await lock.close();await fs.rm(file,{force:true});}
 }
 cachedModels(id){return this.modelCatalogs.get(id)||this.context.globalState.get('ai.chatgpt.models.'+id,[]);}
 async models(id){const token=await this.accessToken(id);const res=await this.fetch(RESOURCE+'/models',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error(`Не удалось загрузить модели подписки (HTTP ${res.status}). Проверьте доступ в ChatGPT.`);const body=await res.json();const models=(body.models||[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,label:m.display_name||m.slug,effort:modelEffort(m.slug,m)}));if(!models.length)throw Error('В аккаунте нет доступных моделей для этого подключения');this.modelCatalogs.set(id,models);await this.context.globalState.update('ai.chatgpt.models.'+id,models);return models;}
}
async function verifyIdentity(token,client,nonce,keySet){
 const {createRemoteJWKSet,jwtVerify}=await import('jose');
 const {payload}=await jwtVerify(token,keySet||createRemoteJWKSet(new URL(ISSUER+'/.well-known/jwks.json')),{issuer:ISSUER,audience:client,algorithms:['RS256'],requiredClaims:['exp','sub','nonce'],clockTolerance:5});
 if(payload.nonce!==nonce||typeof payload.sub!=='string'||!payload.sub)throw Error('Не удалось проверить аккаунт ChatGPT');return payload;
}
module.exports={ChatGPTAuth,authFor,verifyIdentity,modelEffort,reasoningLevels};
