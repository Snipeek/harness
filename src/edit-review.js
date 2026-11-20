'use strict';

// Match lines within a bounded matrix. Large replacements can still be reviewed as one block.
function editHunks(before, after) {
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const old = lines(before), next = lines(after);
  let start = 0, end = old.length, endNext = next.length;
  while (start < end && start < endNext && old[start] === next[start]) start++;
  while (end > start && endNext > start && old[end - 1] === next[endNext - 1]) { end--; endNext--; }
  const hunk = (a,b,c,d) => ({start:a,end:b,before:old.slice(a,b).join(''),after:next.slice(c,d).join('')});
  if ((end-start+1)*(endNext-start+1)>250000) return [hunk(start,end,start,endNext)];
  const width=endNext-start+1, height=end-start+1;
  const table=new Uint32Array(width*height);
  for(let a=height-2;a>=0;a--) for(let b=width-2;b>=0;b--) {
    const at=a*width+b;
    table[at]=old[start+a]===next[start+b]?1+table[at+width+1]:Math.max(table[at+1],table[at+width]);
  }
  const result=[];
  let a=start,b=start, oldStart=a,nextStart=b;
  const flush=()=>{if(oldStart!==a||nextStart!==b)result.push(hunk(oldStart,a,nextStart,b));};
  while(a<end||b<endNext) {
    if(a<end&&b<endNext&&old[a]===next[b]){flush();oldStart=++a;nextStart=++b;}
    else if(b===endNext||(a<end&&table[(a-start+1)*width+b-start]>=table[(a-start)*width+b-start+1]))a++;
    else b++;
  }
  flush();
  return result;
}

function applyHunks(before, hunks, selected) {
  const lines=before.match(/[^\n]*\n|[^\n]+$/g)||[];
  const accepted=new Set(selected);
  for(let i=hunks.length-1;i>=0;i--) {
    const hunk=hunks[i];
    if(accepted.has(i))lines.splice(hunk.start,hunk.end-hunk.start,hunk.after);
  }
  return lines.join('');
}

module.exports={editHunks,applyHunks};
