'use strict';

const block = (id,type,text='') => ({id,type,text});
const title = block('title','headline','How public transit shapes a city');
const body = block('body','body','A connected network makes more jobs reachable without a car.');
const image = {...block('photo','media','A tram approaches an accessible platform.'),src:'/tram.jpg'};
const stat = block('stat','metric','42% · trips made without a car');
const quote = block('quote','quote','A street is a place people cross and a place people stay.');
const items = Array.from({length:11},(_,i)=>block('p'+i,'body','Point '+(i+1)+' · '+ 'One idea with supporting evidence. '.repeat(i%3+3)));
const check = (body,expected=true) => ['(()=>{'+body+'})()',expected];
const data = JSON.stringify({title,body,image,stat,quote,items});
const helpers = `
const {title,body,image,stat,quote,items}=${data};
const slide=(blocks,opts={})=>api.compose(blocks,opts);
const placed=result=>result.pages.flatMap(page=>page.blocks);
const coherent=(result,input)=>{
 if(!Array.isArray(result.pages)||!result.pages.length||result.pages.some(page=>!Array.isArray(page.blocks)||!page.blocks.length))return false;
 const flattened=placed(result);
 if(flattened.length!==input.length||new Set(flattened.map(x=>x.id)).size!==input.length)return false;
 const source=new Map(input.map(x=>[x.id,x]));
 for(const p of result.pages)for(const [i,a] of p.blocks.entries()){
  const box=a.box,b=source.get(a.id);
  if(!b||b.type!==a.type||b.text!==a.text||b.src!==a.src||!box)return false;
  const {x,y,w,h}=box;
  if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||w<=0||h<=0||x+w>1000.00001||y+h>1000.00001)return false;
  for(const other of p.blocks.slice(i+1)){
   const o=other.box;
   if(Math.min(x+w,o.x+o.w)-Math.max(x,o.x)>0.001&&Math.min(y+h,o.y+o.h)-Math.max(y,o.y)>0.001)return false;
  }
 }
 return true;
};
const signature=result=>JSON.stringify(result.pages.map(page=>page.blocks.map(({type,box})=>[type,box])));
`;
const acceptance = code => check(helpers+code);
const smoke = (name, code) => [...acceptance(code),name];
const contract = `
Common contract. Export compose(blocks, options={}) from main.js. A block is {id,type,text} and a media block also has src. Input IDs are unique. Return {pages:[{blocks:[{id,type,text,src?,box:{x,y,w,h}}]}]}. Each input appears exactly once with original type, text and media src. box coordinates are normalized to a 1000 × 1000 grid, independent of physical aspect; positive dimensions, inside bounds, no overlaps. Input stays unchanged and a repeated call with identical inputs returns the identical output. You may edit main.js, layout.js, paginate.js and tokens.js only. Keep the supplied test, add no dependencies, run node test.js. Your output code is the deliverable. Explain how you derived the available variations in your final answer.
`;
const tasks = [{
 id:'composable-slide-language',
 kind:'module',
 automaticAcceptance:true,
 allowedFiles:['main.js','layout.js','paginate.js','tokens.js'],
 files: {
  'main.js': 'function compose(blocks){return {pages:[{blocks:blocks.map(b=>({...b,box:{x:0,y:0,w:1000,h:1000}}))}]};}\nmodule.exports={compose};\n',
  'layout.js':'// Reusable composition rules can live here.\n',
  'paginate.js':'// Pagination can live here.\n',
  'tokens.js':'// Presentation tokens can live here.\n',
  'test.js':'// Protected public check entry point.\n'
 },
 stages: [
  {
   prompt:`Design a unified slide language with no existing component library. The team has four starting examples: a one-line statement should feel intentional rather than empty; a short explanation paired with a photo should feel like one idea; three equally important numbers should read as a group; a heading plus two short paragraphs should read in sequence. Infer a reusable grammar instead of selecting four templates by example ID. Support headline, body, media and metric, including previously unseen permutations, optional roles, and uneven counts. Start with landscape (16:9). Each presentation of one to six short blocks should fit one page. Use one consistent margin system and clear title hierarchy. If there are at least three metrics with no media, show them as aligned, equally sized peers. With a media/body pair, give both roles substantial space without overlap. The headline should appear above the body or supporting data. `+contract,
   publicChecks:[
    smoke('Base layout preserves all roles', `const x=[title,body,image,stat]; return coherent(slide(x),x)&&slide(x).pages.length===1;`),
    smoke('Metric peers align', `const x=[title,stat,{...stat,id:'s2'},{...stat,id:'s3'}];const boxes=placed(slide(x)).filter(b=>b.type==='metric').map(b=>b.box);return boxes.length===3&&boxes.every(b=>b.w===boxes[0].w&&b.h===boxes[0].h&&(b.x===boxes[0].x||b.y===boxes[0].y));`)
   ],
   checks:[
    acceptance(`return [[title],[title,body,image],[title,stat,{...stat,id:'s2'},{...stat,id:'s3'}],[title,body,{...body,id:'b2'}],[title,image,stat,body],[body,image],[title,stat,body]].every(blocks=>{const r=slide(blocks);return r.pages.length===1&&coherent(r,blocks)&&placed(r).every(x=>x.box.x>=24&&x.box.y>=24&&x.box.x+x.box.w<=976&&x.box.y+x.box.h<=976);});`),
    acceptance(`const [a,b,c]=placed(slide([title,stat,{...stat,id:'s2'},{...stat,id:'s3'}])).filter(x=>x.type==='metric').map(x=>x.box);return ((a.y===b.y&&b.y===c.y)||(a.x===b.x&&b.x===c.x))&&a.w===b.w&&b.w===c.w&&a.h===b.h&&b.h===c.h&&a.w>=100;`),
    acceptance(`const r=placed(slide([title,image,body]));const t=r.find(x=>x.type==='headline').box,m=r.find(x=>x.type==='media').box,b=r.find(x=>x.type==='body').box;return t.y<b.y&&m.w*m.h>=90000&&b.w*b.h>=45000;`),
    acceptance(`const input=[title,stat,body,image];const original=JSON.stringify(input);return new Set([[title,body,{...body,id:'b2'}],[title,image,body],[title,stat,body],[stat,{...stat,id:'s2'},{...stat,id:'s3'}]].map(x=>JSON.stringify(placed(slide(x)).map(b=>b.box)))).size>=3&&JSON.stringify(slide(input))===JSON.stringify(slide(input))&&JSON.stringify(input)===original;`)
   ]
  },
  {
   prompt:`A portrait (9:16) format is now required, as well as landscape. Use options.aspect equal to '9:16' or '16:9', default landscape. For slide with media/body in portrait, stack rather than squeeze them into columns: their horizontal boxes must overlap substantially, and each must be at least 65% of the canvas width. Add long-content pagination: at most six blocks per page, keep body text blocks in input-relative reading order, and never use shrinking to drop content. Whenever metrics overflow onto further pages, preserve peer alignment whenever three or more metrics share a page in landscape. Add support for quote as a full content role, inside the same grammar. Preserve all previous landscape behaviors. `+contract,
   publicChecks:[
    smoke('Portrait retains mixed roles including quotes', `const x=[title,quote,image,{...body,id:'details'},stat];return ['9:16','16:9'].every(aspect=>coherent(slide(x,{aspect}),x));`),
    smoke('Overflow keeps every block in reading order', `const x=[...items.slice(0,7),quote];return ['9:16','16:9'].every(aspect=>{const r=slide(x,{aspect});return coherent(r,x)&&r.pages.every(p=>p.blocks.length<=6)&&placed(r).filter(b=>b.type==='body').map(b=>b.id).join()===items.slice(0,7).map(b=>b.id).join();});`)
   ],
   checks:[
    acceptance(`const x=[title,image,body];const r=slide(x,{aspect:'9:16'});const [m,b]=['media','body'].map(type=>placed(r).find(v=>v.type===type).box);return coherent(r,x)&&r.pages.length===1&&m.w>=650&&b.w>=650&&Math.min(m.x+m.w,b.x+b.w)-Math.max(m.x,b.x)>=500&&signature(r)!==signature(slide(x));`),
    acceptance(`const x=[title,...items,image,stat,quote];return ['16:9','9:16'].every(aspect=>{const r=slide(x,{aspect});return coherent(r,x)&&r.pages.length>=3&&r.pages.every(p=>p.blocks.length<=6)&&JSON.stringify(placed(r).filter(b=>b.type==='body').map(b=>b.id))===JSON.stringify(items.map(b=>b.id));});`),
    acceptance(`return ['16:9','9:16'].every(aspect=>[[quote],[title,quote,stat],[body,quote,image],[title,body,quote,stat,image]].every(x=>coherent(slide(x,{aspect}),x)));`),
    acceptance(`const x=[title,...Array.from({length:11},(_,i)=>({...stat,id:'metric'+i})),body];return slide(x).pages.every(page=>{const metrics=page.blocks.filter(b=>b.type==='metric').map(b=>b.box);return metrics.length<3||metrics.every(b=>b.w===metrics[0].w&&b.h===metrics[0].h&&metrics.some(c=>c!==b&&(c.x===b.x||c.y===b.y)));});`)
   ]
  },
  {
   prompt:`Separate style and emphasis from composition. options.theme can be 'paper', 'ink' or 'forest'; default paper. Return a palette object on the result: {background,foreground,accent}, each a six-digit #RRGGBB, with WCAG relative-luminance contrast >=4.5 for foreground on background and >=3 for accent on background. The three palettes must be genuinely distinct and must not change page boundaries or geometry. options.emphasis may be 'balanced' (default), 'image' or 'data'. The same slide can switch emphasis without duplicated content: in a landscape mix containing a headline, photo, metrics and body, image emphasis must increase the total media area by at least 15% vs data emphasis, and vice versa for the total metric area. For taller portrait layouts or missing roles use a graceful fallback while retaining the selected theme. Maintain every prior capability. `+contract,
   publicChecks:[
    smoke('Themes change palette while geometry remains stable', `const x=[title,body,stat,quote];const a=slide(x,{theme:'paper'}),b=slide(x,{theme:'ink'}),c=slide(x,{theme:'forest'});return [a,b,c].every(r=>coherent(r,x)&&/^#[0-9a-f]{6}$/i.test(r.palette?.background))&&new Set([a,b,c].map(r=>r.palette.background)).size===3&&new Set([a,b,c].map(signature)).size===1;`),
    smoke('Image and data emphasis reallocate space', `const x=[title,body,image,stat];const a=slide(x,{emphasis:'image'}),b=slide(x,{emphasis:'data'});const area=(r,t)=>{const {box}=placed(r).find(x=>x.type===t);return box.w*box.h;};return coherent(a,x)&&coherent(b,x)&&area(a,'media')>area(b,'media')&&area(b,'metric')>area(a,'metric');`)
   ],
   checks:[
    acceptance(`const x=[title,image,stat,{...stat,id:'s2'},body,quote];const themes=['paper','ink','forest'];const results=themes.map(theme=>slide(x,{theme}));const lum=c=>{const n=c.slice(1).match(/../g).map(h=>parseInt(h,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return n[0]*.2126+n[1]*.7152+n[2]*.0722;};const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};return new Set(results.map(r=>signature(r))).size===1&&new Set(results.map(r=>r.palette.background)).size===3&&results.every(({palette:p})=>[p.background,p.foreground,p.accent].every(c=>/^#[0-9a-f]{6}$/i.test(c))&&contrast(p.foreground,p.background)>=4.5&&contrast(p.accent,p.background)>=3);`),
    acceptance(`const x=[title,image,stat,{...stat,id:'s2'},body];const byRole=(r,t)=>placed(r).filter(b=>b.type===t).reduce((n,b)=>n+b.box.w*b.box.h,0);const a=slide(x,{emphasis:'image'}),b=slide(x,{emphasis:'data'});return coherent(a,x)&&coherent(b,x)&&byRole(a,'media')>=1.15*byRole(b,'media')&&byRole(b,'metric')>=1.15*byRole(a,'metric');`),
    acceptance(`const cases=[[title],[title,body,image],[stat,quote,body],[title,stat,image,body,quote],[title,...items],[title,image,stat,{...stat,id:'s2'},body]];for(const x of cases)for(const aspect of ['16:9','9:16'])for(const emphasis of ['balanced','image','data']){const configs=['paper','ink','forest'].map(theme=>({theme,aspect,emphasis}));const r=configs.map(o=>slide(x,o));if(!r.every(v=>coherent(v,x)&&v.pages.every(p=>p.blocks.length<=6))||new Set(r.map(signature)).size!==1||new Set(r.map(x=>x.palette.background)).size!==3)return false;}return true;`),
    acceptance(`const x=[title,image,stat,body,quote];const a=slide(x,{theme:'forest',aspect:'9:16',emphasis:'image'});placed(a)[0].box.w=-1;a.palette.background='oops';const b=slide(x,{theme:'forest',aspect:'9:16',emphasis:'image'});return coherent(b,x)&&b.palette.background!=='oops';`)
   ]
  }
 ]
}];
module.exports = { tasks };
