'use strict';
const zlib=require('node:zlib');
const { createHash } = require('node:crypto');
const https=require('node:https'),dns=require('node:dns/promises'),net=require('node:net');
const {parseHTML}=require('linkedom'),{Readability}=require('@mozilla/readability');const {McpRegistry}=require('./mcp');
function privateAddress(address){const ip=address.toLowerCase().replace(/^\[|\]$/g,'');if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&p[1]>=18&&p[1]<=19);}if(ip.startsWith('::ffff:')){const mapped=ip.slice(7);if(net.isIPv4(mapped))return privateAddress(mapped);const parts=mapped.split(':');if(parts.length===2){const a=parseInt(parts[0],16),b=parseInt(parts[1],16);return privateAddress(`${a>>8}.${a&255}.${b>>8}.${b&255}`);}return true;}return ip==='::'||ip==='::1'||/^(fc|fd|fe[89ab]|ff)/.test(ip);}
async function publicUrl(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('web_fetch accepts public HTTPS URLs without credentials');const host=url.hostname.replace(/^\[|\]$/g,'');const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true});if(!addresses.length||addresses.some(a=>privateAddress(a.address)))throw new Error('web_fetch does not access private, loopback or local network addresses');url.hash='';return {url,addresses};}
async function download(value,signal,redirects=0){if(redirects>4)throw new Error('Too many webpage redirects');const {url,addresses}=await publicUrl(value);signal?.throwIfAborted();const response=await new Promise((resolve,reject)=>{const req=https.get(url,{signal,headers:{'user-agent':'GLM-AI/0.10 (public webpage reader)','accept':'text/html,text/plain,application/json','accept-encoding':'identity'},lookup:(_host,opts,cb)=>opts.all?cb(null,addresses):cb(null,addresses[0].address,addresses[0].family)},res=>{if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();resolve({redirect:new URL(res.headers.location,url).toString()});return;}if(res.statusCode<200||res.statusCode>=300){res.resume();reject(Object.assign(new Error(`Webpage returned HTTP ${res.statusCode}`), {statusCode:res.statusCode}));return;}let bytes=0;const chunks=[];res.on('data',b=>{bytes+=b.length;if(bytes>2*1024*1024)res.destroy(new Error('Webpage exceeds 2 MB'));else chunks.push(b);});res.on('error',reject);res.on('end',()=>{try{let body=Buffer.concat(chunks);const options={maxOutputLength:2*1024*1024};if(res.headers['content-encoding']==='gzip')body=zlib.gunzipSync(body,options);else if(res.headers['content-encoding']==='br')body=zlib.brotliDecompressSync(body,options);resolve({url:url.toString(),type:res.headers['content-type']||'',body:body.toString('utf8')});}catch(e){reject(e);}});});req.setTimeout(15000,()=>req.destroy(new Error('Webpage timed out')));req.on('error',reject);});return response.redirect?download(response.redirect,signal,redirects+1):response;}
function extract(body,url,type='text/html'){if(body.includes('\0')||(type&&!/^(text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml))/i.test(type)))throw new Error('Page is not readable HTML/text; use the corresponding document skill');if(!type.includes('html'))return {title:url,text:body,links:[]};const {document}=parseHTML(body);const title=document.title||url;const links=[...document.querySelectorAll('a[href]')].slice(0,200).flatMap(a=>{try{const target=new URL(a.getAttribute('href'),url);return target.protocol==='https:'?[{title:a.textContent.trim().slice(0,140),url:target.toString()}]:[];}catch{return [];}}).filter(l=>l.title).slice(0,30);for(const el of document.querySelectorAll('script,style,noscript,svg,nav,footer'))el.remove();const fallback=document.body?.textContent||document.documentElement.textContent;let article;try{article=new Readability(document,{charThreshold:100}).parse();}catch{}return {title:article?.title||title,text:(article?.textContent||fallback).replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').trim(),links};}
function unwrap(value){for(let i=0;i<4&&typeof value==='string';i++){try{value=JSON.parse(value);}catch{break;}}return value;}
function resultData(result){if(result.isError)throw new Error('Web provider returned an error: '+(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(' ').slice(0,500));if(result.structuredContent)return unwrap(result.structuredContent);const text=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');const parsed=unwrap(text);return typeof parsed==='string'?{text:parsed}:parsed;}
function readerNotFound(title, text) {
  return /^(?:404(?:\s+not found)?\b|page not found\b|not found\s*$)/i.test(title.trim()) ||
    /^(?:#{1,6}\s*)?404(?:\s+not found)?(?:\s*\n|$)/i.test(text.trimStart());
}
function webPageSlice(page, args) {
  const offset = args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset >= page.text.length) {
    throw Error('Offset is outside the extracted webpage.');
  }
  const minimum = /[\uD800-\uDBFF]/.test(page.text[offset]) && offset + 1 < page.text.length ? 2 : 1;
  const max = Math.min(page.text.length, offset + Math.max(minimum, Math.min(16000, args.limit || 10000)));
  const links = offset === 0 ? page.links.filter(link => link.url.length <= 1024).slice(0, 6) : [];
  const shape = end => ({
    url: page.url, title: page.title, method: page.method, snapshot: page.snapshot,
    offset, endOffset: end, totalChars: page.text.length,
    nextOffset: end < page.text.length ? end : null,
    text: page.text.slice(offset, end), links
  });
  // Keep escaped JSON below the generic tool-output archival threshold.
  let low = offset + minimum, high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(shape(mid)).length <= 11500) low = mid;
    else high = mid - 1;
  }
  if (low > offset + 1 && /[\uD800-\uDBFF]/.test(page.text[low - 1]) && low < page.text.length) low--;
  return shape(low);
}
class WebCoverage {
  constructor() { this.pages = new Map(); }
  record(result) {
    if (!result?.snapshot || !Number.isInteger(result.totalChars) ||
        !Number.isInteger(result.offset) || !Number.isInteger(result.endOffset) ||
        result.offset < 0 || result.endOffset <= result.offset || result.endOffset > result.totalChars) return undefined;
    const existing = this.pages.get(result.url);
    const ranges = existing?.snapshot === result.snapshot ? existing.ranges : [];
    ranges.push([result.offset, result.endOffset]);
    ranges.sort(([a], [b]) => a - b);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (!last || last[1] < range[0]) merged.push(range);
      else last[1] = Math.max(last[1], range[1]);
    }
    const complete = merged.length === 1 && merged[0][0] === 0 && merged[0][1] === result.totalChars;
    this.pages.set(result.url, { url: result.url, title: result.title, snapshot: result.snapshot, ranges: merged, total: result.totalChars, complete });
    return { complete, readChars: merged.reduce((sum, [a, b]) => sum + b - a, 0) };
  }
  incomplete() { return [...this.pages.values()].filter(page => !page.complete); }
}
class WebTools{
 constructor(keyProvider){this.keyProvider=keyProvider;this.pages=new Map();this.registry=null;this.key=null;}
 async mcp(){const key=await this.keyProvider();if(!key)throw new Error('Configure a GLM API key to use Z.ai web search');if(key!==this.key){this.registry?.close();this.key=key;this.registry=new McpRegistry([{name:'zai-web-search',url:'https://api.z.ai/api/mcp/web_search_prime/mcp'},{name:'zai-web-reader',url:'https://api.z.ai/api/mcp/web_reader/mcp'}],async()=>key);}return this.registry;}
 async call(server,matcher,args,signal){const registry=await this.mcp();await registry.connect(server);const entry=[...registry.tools.entries()].find(([,t])=>t.server===server&&matcher.test(t.tool.name));if(!entry)throw new Error('Web provider did not expose the expected tool');return resultData(JSON.parse(await registry.call(entry[0],args,signal)));}
 async search(args,signal){if(typeof args.query!=='string'||!args.query.trim()||args.query.length>2000)throw new Error('Provide a nonempty public search query (max 2000 characters)');const params={search_query:args.query,location:'us',content_size:'medium',...(args.domain?{search_domain_filter:args.domain}:{}),...(args.recency?{search_recency_filter:args.recency}:{})};if(args.domain&&!/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(args.domain))throw new Error('Provide a domain name without scheme or path');const data=await this.call('zai-web-search',/web_?search_?prime/i,params,signal);let results=Array.isArray(data)?data:data.search_result||data.search_results||data.results; if(!results&&data.text){try{const parsed=JSON.parse(data.text);results=parsed.search_result||parsed.search_results||parsed.results;}catch{}}
 if(Array.isArray(results)&&args.domain)results=results.filter(r=>{try{const host=new URL(r.link||r.url).hostname;return host===args.domain||host.endsWith('.'+args.domain);}catch{return false;}});
 return JSON.stringify({provider:'Z.ai Web Search',query:args.query,...(Array.isArray(results)?{results:results.slice(0,10).map(r=>({title:r.title,url:r.link||r.url,excerpt:(r.content||r.snippet||r.summary||'').slice(0,1500),date:r.publish_date||r.published_date}))}:{result:data}),note:'Search excerpts are not full page reads. Use web_fetch on relevant source URLs and cite them.'});}
 async read(args, signal) {
  const {url} = await publicUrl(args.url);
  const key = url.toString();
  let page = this.pages.get(key);
  if (!page || Date.now() - page.at > 300000) {
    try {
      const raw = await download(key, signal);
      page = { ...extract(raw.body, raw.url, raw.type), url: raw.url, method: 'direct HTTPS' };
      if (readerNotFound(page.title, page.text)) throw Object.assign(Error('Webpage returned a not-found document'), {statusCode:404});
      if (page.text.length < 100) throw Error('Page has no useful extractable text');
    } catch (error) {
      signal?.throwIfAborted();
      if ([404, 410].includes(error.statusCode)) throw error;
      const data = await this.call('zai-web-reader', /web_?reader/i, {
        url:key, return_format:'markdown', timeout:20, retain_images:false, with_links_summary:true
      }, signal).catch(() => { throw error; });
      const text = typeof data === 'string' ? data : data?.content || data?.text;
      const title = String(data?.title || key);
      if (typeof text !== 'string' || !text.trim() || readerNotFound(title, text)) throw Error('Web reader did not return a readable source.');
      page = { url:key, title, text, links:[], method:'Z.ai Web Reader' };
    }
    page.title = page.title.slice(0, 200);
    page.snapshot = createHash('sha256').update(page.text).digest('hex').slice(0,24);
    page.at = Date.now();
    for (const alias of new Set([key, page.url])) {
      this.pages.set(alias, page);
      if (this.pages.size > 50) this.pages.delete(this.pages.keys().next().value);
    }
  }
  return JSON.stringify(webPageSlice(page, args));
}
 close(){this.registry?.close();}
}
module.exports={WebTools,WebCoverage,webPageSlice,readerNotFound,privateAddress,publicUrl,download,extract,resultData,unwrap};
