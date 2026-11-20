'use strict';
const {randomUUID}=require('node:crypto'),{endpoint}=require('./providers');
const {validContextWindow}=require('./request-context');
const STATE='ai.modelConnections';
function connections(context){const value=context.globalState.get(STATE,{profiles:[],activeId:null});return {profiles:Array.isArray(value?.profiles)?value.profiles:[],activeId:value?.activeId||null};}
function publicConnection(p){return {id:p.id,label:p.label,provider:p.provider,model:p.model,baseUrl:p.baseUrl,protocol:p.protocol,contextWindow:p.contextWindow,...(p.accountId?{accountId:p.accountId}: {})};}
function baseURL(value){endpoint(value,'validate');return new URL(value).toString().replace(/\/+$/,'');}
function sameRoute(a,b){return a.provider===b.provider&&(a.accountId||null)===(b.accountId||null)&&a.protocol===b.protocol&&baseURL(a.baseUrl)===baseURL(b.baseUrl);}
class ModelConnections{
 constructor(context){this.context=context;this.queue=Promise.resolve();}
 list(){return connections(this.context).profiles.map(publicConnection);}
 async settings(id){const p=connections(this.context).profiles.find(p=>p.id===id);if(!p)throw Error('Model connection not found');if(p.provider==='chatgpt'){const auth=require('./chatgpt-auth').authFor(this.context);const record=await auth.record(p.accountId);return {...publicConnection(p),apiKey:record.access_token,getApiKey:()=>auth.accessToken(p.accountId)};}return {...publicConnection(p),apiKey:await this.context.secrets.get('ai.modelConnection.'+p.id)||''};}
 async activate(id){const value=connections(this.context);if(id!==null&&!value.profiles.some(p=>p.id===id))throw Error('Model connection not found');await this.context.globalState.update(STATE,{...value,activeId:id});}
 save(input,reuseSource){
  const operation=this.queue.catch(()=>{}).then(async()=>{
   if(!['glm','openai','custom','chatgpt'].includes(input.provider))throw Error('Choose a provider');
   const model=String(input.model||'').trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/.test(model))throw Error('Enter a valid model ID');
   const protocol=['openai','chatgpt'].includes(input.provider)?'responses':input.provider==='glm'?'chat':input.protocol;if(!['chat','responses'].includes(protocol))throw Error('Choose an API protocol');
   const profile={id:randomUUID(),label:String(input.label||model).trim().slice(0,80)||model,provider:input.provider,model,protocol,baseUrl:baseURL(['openai','chatgpt'].includes(input.provider)?'https://api.openai.com/v1':String(input.baseUrl||'').trim())};
   if(input.contextWindow!==undefined){
     if(!validContextWindow(input.contextWindow))throw Error('Context window must be an integer from 8192 to 10000000');
     profile.contextWindow=input.contextWindow;
   }
   if(input.provider==='chatgpt'){const auth=require('./chatgpt-auth').authFor(this.context);if(!auth.accounts().some(a=>a.id===input.accountId))throw Error('Войдите в ChatGPT');const models=await auth.models(input.accountId);if(!models.some(m=>m.id===model))throw Error('Выберите доступную модель подписки');profile.accountId=input.accountId;const state=connections(this.context);if(state.profiles.length>=100)throw Error('Model connection limit reached');await this.context.globalState.update(STATE,{profiles:[...state.profiles,profile],activeId:profile.id});return publicConnection(profile);}
   let apiKey=String(input.apiKey||'').trim();if(input.reuseKey){if(!reuseSource?.apiKey||!sameRoute(profile,reuseSource))throw Error('Existing key can only be reused for the same provider, endpoint and protocol');apiKey=reuseSource.apiKey;}
   if(!apiKey||apiKey.length>8192)throw Error('Enter an API key');
   const state=connections(this.context);if(state.profiles.length>=100)throw Error('Model connection limit reached');
   const secret='ai.modelConnection.'+profile.id;await this.context.secrets.store(secret,apiKey);
   try{await this.context.globalState.update(STATE,{profiles:[...state.profiles,profile],activeId:profile.id});}catch(e){await this.context.secrets.delete?.(secret);throw e;}
   return publicConnection(profile);
  });this.queue=operation;return operation;
 }
}
module.exports={ModelConnections,connections,publicConnection,sameRoute};
