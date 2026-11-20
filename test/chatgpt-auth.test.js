'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {ChatGPTAuth,verifyIdentity,authFor}=require('../src/chatgpt-auth');
function context(){const state=new Map(),secrets=new Map();return {state,secretsMap:secrets,globalState:{get:(k,d)=>state.get(k)??d,update:async(k,v)=>state.set(k,v)},secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v)}};}
const tokens={access_token:'private-access',refresh_token:'private-refresh',id_token:'private-id',scope:'openid chatgpt.tokens.use.direct',expires_in:3600,token_type:'Bearer'};
test('browser OAuth uses PKCE, validates callback and stores only public account metadata',async()=>{
 const ctx=context();let authorize,exchange;
 const auth=new ChatGPTAuth(ctx,{fetch:async(url,options)=>{assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');exchange=new URLSearchParams(options.body);return Response.json(tokens);},verify:async(token,client,nonce)=>{assert.equal(token,tokens.id_token);assert.equal(client,'oaiapp_test');assert.equal(nonce,authorize.searchParams.get('nonce'));return {sub:'user1',email:'user@example.test'};}});
 const account=await auth.signIn(async url=>{authorize=new URL(url);assert.equal(authorize.searchParams.get('client_id'),'dynamic_agent_client');assert.match(authorize.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);assert.equal(authorize.searchParams.get('resource'),'https://api.openai.com/v1');const callback=new URL(authorize.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:authorize.searchParams.get('state'),code:'single-code',client_id:'oaiapp_test'});const result=await fetch(callback);assert.equal(result.status,200);return true;});
 assert.equal(account.email,'user@example.test');assert.equal(exchange.get('redirect_uri'),authorize.searchParams.get('redirect_uri'));assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),authorize.searchParams.get('code_challenge'));assert(!JSON.stringify([...ctx.state]).includes('private-'));assert.equal((await auth.record(account.id)).refresh_token,tokens.refresh_token);assert.equal(auth.pending,null);
});
test('wrong state and declined consent never exchange credentials; cancelled attempts terminate',async()=>{
 const ctx=context();let calls=0;const auth=new ChatGPTAuth(ctx,{fetch:async()=>{calls++;throw Error('must not exchange');}});
 for(const bad of ['state','denied'])await assert.rejects(auth.signIn(async url=>{const a=new URL(url),callback=new URL(a.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:bad==='state'?'wrong':a.searchParams.get('state'),error:'access_denied'});assert.equal((await fetch(callback)).status,400);return true;}));
 assert.equal(calls,0);assert.equal(ctx.secretsMap.size,0);
 await assert.rejects(auth.signIn(async()=>{auth.cancel('other');assert(auth.pending);auth.cancel('owner');return true;},undefined,'owner'),/отменён/);
});
test('refresh is serialized, rotates credentials and catalog preserves only visible account models',async()=>{
 const ctx=context(),id=randomUUID();ctx.secretsMap.set('ai.chatgpt.'+id,JSON.stringify({...tokens,id,client_id:'issued',expires_at:0}));let refreshes=0;
 const auth=new ChatGPTAuth(ctx,{fetch:async(url,options)=>{if(url.endsWith('/models')){assert.equal(options.headers.authorization,'Bearer renewed');return Response.json({models:[{slug:'model-1',display_name:'Model 1',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'xhigh'}],default_reasoning_level:'xhigh'},{slug:'hidden',visibility:'hide'}]});}refreshes++;assert.equal(new URLSearchParams(options.body).get('client_id'),'issued');return Response.json({...tokens,access_token:'renewed',refresh_token:'rotated'});}});
 assert.deepEqual(await Promise.all([auth.accessToken(id),auth.accessToken(id)]),['renewed','renewed']);assert.equal(refreshes,1);assert.equal((await auth.record(id)).refresh_token,'rotated');const expected=[{id:'model-1',label:'Model 1',effort:{levels:['low','xhigh'],defaultEffort:'xhigh'}}];assert.deepEqual(await auth.models(id),expected);assert.deepEqual(new ChatGPTAuth(ctx).cachedModels(id),expected);
});
test('ID token verification enforces signatures, audience, nonce, expiry and issuer',async()=>{
 const {generateKeyPair,SignJWT,exportJWK,createLocalJWKSet}=await import('jose');const {privateKey,publicKey}=await generateKeyPair('RS256');const key=await exportJWK(publicKey);key.kid='test';const jwks=createLocalJWKSet({keys:[key]});
 const sign=(issuer='https://auth.openai.com',expiry='2m')=>new SignJWT({nonce:'expected'}).setProtectedHeader({alg:'RS256',kid:'test'}).setSubject('subject').setIssuer(issuer).setAudience('client').setExpirationTime(expiry).sign(privateKey);
 const token=await sign();assert.equal((await verifyIdentity(token,'client','expected',jwks)).sub,'subject');await assert.rejects(verifyIdentity(token,'wrong','expected',jwks));await assert.rejects(verifyIdentity(token,'client','wrong',jwks));await assert.rejects(verifyIdentity(await sign('wrong'),'client','expected',jwks));await assert.rejects(verifyIdentity(await sign(undefined,'-1m'),'client','expected',jwks));
});
test('ChatGPT connection validates account catalog and binds conversations to the account',async()=>{
 const {ModelConnections,sameRoute}=require('../src/model-connections');const ctx=context(),id=randomUUID();ctx.state.set('ai.chatgpt.accounts',[{id,email:'x@test'}]);ctx.secretsMap.set('ai.chatgpt.'+id,JSON.stringify({...tokens,expires_at:Date.now()+3600000}));const auth=authFor(ctx);auth.models=async()=>[{id:'allowed',label:'Allowed'}];const store=new ModelConnections(ctx);
 await assert.rejects(store.save({provider:'chatgpt',model:'unavailable',accountId:id}),/доступную/);const profile=await store.save({provider:'chatgpt',model:'allowed',accountId:id,baseUrl:'https://evil.test'});assert.equal(profile.baseUrl,'https://api.openai.com/v1');assert.equal((await store.settings(profile.id)).apiKey,tokens.access_token);assert(!JSON.stringify(store.list()).includes(tokens.access_token));assert.equal(sameRoute(profile,{...profile,accountId:randomUUID()}),false);
});
