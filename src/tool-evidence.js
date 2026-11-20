'use strict';

const searchTools = new Set(['search_files','search_batch']);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const keyOf = value => JSON.stringify(value, (_, item) =>
  item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
const resultRows = (name,result) => name==='search_batch' ? result?.results : result ? [result] : null;
const complete = rows => rows?.length && rows.every(row=>Array.isArray(row?.matches) &&
  !row.error && !row.truncated && !row.scopeTruncated && row.nextOffset==null);

class SearchEvidence {
  constructor(){this.results=new Map();this.generation=0;}
  clear(){this.results.clear();this.generation++;}
  async run(name,args,scope,execute){
    const queries=name==='search_batch'?args?.queries:[args];
    if(!searchTools.has(name)||!Array.isArray(queries)||queries.some(q=>!q||q.directory))return execute();
    const key=keyOf([scope,name,args]);
    if(this.results.has(key))return JSON.stringify({...parse(this.results.get(key)),reusedSearch:true});
    const generation=this.generation;
    const result=await execute();
    if(generation===this.generation && result.length<=12000 && complete(resultRows(name,parse(result)))){
      if(this.results.size>=32)this.results.delete(this.results.keys().next().value);
      this.results.set(key,result);
    }
    return result;
  }
}

const short=(value,limit)=>typeof value==='string'?value.slice(0,limit):undefined;

function searchIndex(history,through){
  const calls=new Map(), hits=new Map();
  for(let i=0;i<through;i++){
    const m=history[i];
    for(const call of m.tool_calls||[])if(searchTools.has(call.function?.name))calls.set(call.id,call.function);
    if(m.role!=='tool')continue;
    const call=calls.get(m.tool_call_id);
    if(!call)continue;
    const args=parse(call.arguments), result=parse(m.content);
    const rows=resultRows(call.name,result);
    const queries=call.name==='search_batch'?args?.queries:[args];
    if(!Array.isArray(rows)||!Array.isArray(queries))continue;
    rows.forEach((row,index)=>{
      const q=queries[index];
      if(!q?.query||!Array.isArray(row?.matches)||row.error)return;
      const scope={query:short(q.query,180),directory:short(q.directory,180),path:short(q.path,180),glob:short(q.glob,120),regex:q.regex,case_sensitive:q.case_sensitive,offset:q.offset,limit:q.limit,context:q.context};
      hits.set(keyOf(q),{...scope,complete:complete([row])===true,
        matches:row.matches.slice(0,2).map(s=>String(s).slice(0,180)),count:row.matches.length});
      if(hits.size>8)hits.delete(hits.keys().next().value);
    });
  }
  return [...hits.values()];
}

module.exports={SearchEvidence,searchIndex};
