'use strict';
// Deliberately small grammar: literal argv joined by pipes / sequential operators.
// Never execute the supplied shell text. Rebuild only validated fixed executables.
function tokens(text, allowTilde = false){
 if(typeof text!=='string'||text.length>4096||/[\r\n\0$`]/.test(text))return null;
 const out=[];let value='',quote='',started=false;
 const push=()=>{if(started){out.push({word:value});value='';started=false;}};
 for(let i=0;i<text.length;i++){
  const c=text[i];if(quote){if(c===quote)quote='';else{if(c==='\\'&&quote==='"')return null;value+=c;}started=true;continue;}
  if(c==='"'||c==="'"){quote=c;started=true;continue;}
  if(/\s/.test(c)){push();continue;}
  if(c===';'||c==='|'||c==='&'){push();let op=c;if(text[i+1]===c){op+=c;i++;}if(![';','|','&&'].includes(op))return null;out.push({op});continue;}
  if(/[\\><()*?\[\]{}!]/.test(c)||c==='~'&&(!allowTilde||started||text[i+1]!=='/'))return null;value+=c;started=true;
 }
 if(quote)return null;push();return out;
}
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
function diagnosticExecution(text){
 const parsed=tokens(text);if(!parsed?.length)return null;
 const commands=[[]],operators=[];
 for(const token of parsed){if(token.op){if(!commands.at(-1).length)return null;operators.push(token.op);commands.push([]);}else commands.at(-1).push(token.word);}
 if(!commands.at(-1).length||commands.length>12)return null;
 let hasCurl=false;const rendered=[];
 for(let i=0;i<commands.length;i++){
  const [name,...args]=commands[i];let file,argv=args;
  if(name==='env'){
   if(args.length||operators[i]!=='|'||commands[i+1]?.join(' ')!=='grep -i proxy')return null;file='/usr/bin/env';
  }else if(name==='grep'){
   if(i===0||operators[i-1]!=='|')return null;
   const operands=args.filter(a=>!a.startsWith('-'));if(operands.length!==1||args.filter(a=>a.startsWith('-')).some(a=>!/^-[iEvF]+$/.test(a)))return null;file='/usr/bin/grep';
  }else if(name==='echo'){file='/bin/echo';}
  else if(name==='curl'){
   file='/usr/bin/curl';hasCurl=true;let urls=0;argv=['-q','--max-time','15'];
   for(let j=0;j<args.length;j++){
    const arg=args[j];
    if(['-s','-S','-I','-f','--silent','--show-error','--head','--fail'].includes(arg)){argv.push(arg);continue;}
    if(['--max-time','-o','--output','-w','--write-out'].includes(arg)){
     const value=args[++j];if(value===undefined)return null;
     if(arg==='--max-time'&&!/^(?:[1-9]|[12][0-9]|30)$/.test(value))return null;
     if(['-o','--output'].includes(arg)&&value!=='/dev/null')return null;
     if(['-w','--write-out'].includes(arg)&&!/^%\{http_code\}(?:\\n)?$/.test(value))return null;
     argv.push(arg,value);continue;
    }
    try{const url=new URL(arg);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname==='localhost'||/^[\d[\]:.]+$/.test(url.hostname))return null;}catch{return null;}
    if(++urls>1)return null;argv.push(arg);
   }
   if(urls!==1)return null;
  }else return null;
  rendered.push([file,...argv].map(shellQuote).join(' '));
 }
 if(!hasCurl)return null;
 return {file:'/bin/sh',args:['-c',rendered.map((c,i)=>c+(operators[i]?' '+operators[i]+' ':'')).join('')]};
}
module.exports={diagnosticExecution,tokens,shellQuote};
