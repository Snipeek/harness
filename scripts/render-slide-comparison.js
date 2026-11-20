'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluateModules } = require('./quality-grader');

const blocks = [
  { id:'title', type:'headline', text:'Улица, где можно остаться' },
  { id:'tram', type:'media', text:'Трамвайная остановка', src:'/fixture-tram.jpg' },
  { id:'story', type:'body', text:'Частые остановки и короткие пересадки расширяют доступ к работе.' },
  { id:'share', type:'metric', text:'42% поездок без автомобиля' },
  { id:'time', type:'metric', text:'12 мин до пересадки' },
  { id:'quote', type:'quote', text:'«Улица — место, где можно встретиться». ' }
];
const cases = [
  { label:'16:9 · акцент на изображении', options:{aspect:'16:9',theme:'paper',emphasis:'image'} },
  { label:'16:9 · акцент на данных', options:{aspect:'16:9',theme:'ink',emphasis:'data'} },
  { label:'9:16 · сбалансированный акцент', options:{aspect:'9:16',theme:'forest',emphasis:'balanced'} },
];
const text = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const colors = palette => {
  const defaults = {background:'#f4f1e9',foreground:'#232323',accent:'#35503d'};
  return Object.entries(defaults).map(([name,fallback])=>
    '--'+name+':'+(/^#[\da-f]{6}$/i.test(palette?.[name])?palette[name]:fallback)).join(';');
};

function sample(files, sampleCase) {
  try {
    const { options, label } = sampleCase;
    const plan = evaluateModules(files, 'JSON.stringify(api.compose('+JSON.stringify(blocks)+','+JSON.stringify(options)+'))');
    const {pages,palette}=JSON.parse(plan);
    if(!Array.isArray(pages)||!pages.length)throw Error('Пустая раскладка');
    const format=options.aspect==='9:16'?'portrait':'landscape';
    const slides=pages.map(page=>'<div class="slide '+format+'" style="'+colors(palette)+'">'+page.blocks.map(block=>{
      const box=block.box||{};
      if(!['x','y','w','h'].every(key=>Number.isFinite(box[key])))throw Error('Отсутствует геометрия блока '+block.id);
      const style=['left','top','width','height'].map((key,i)=>key+':'+box[['x','y','w','h'][i]]/10+'%').join(';');
      const type=['headline','body','metric','media','quote'].includes(block.type)?block.type:'body';
      return '<div class="block '+type+'" style="'+style+'">'+text(block.text)+'</div>';
    }).join('')+'</div>').join('');
    const fallback=['background','foreground','accent'].some(key=>!/^#[\da-f]{6}$/i.test(palette?.[key]));
    return '<section><h3>'+text(label)+'</h3>'+slides+
      (fallback?'<small>Часть цветов взята из палитры визуализатора.</small>':'')+'</section>';
  }catch(error){
    return '<section><h3>'+text(sampleCase.label)+'</h3><p>Раскладка не построена. '+text(error.message)+'</p></section>';
  }
}

function comparison(directories, destination) {
  const samples = directories.flatMap(([label,directory])=>['glm','chatgpt'].map(provider=>{
    const root=path.join(directory,'composable-slide-language-0-'+provider,'workspace');
    const files=Object.fromEntries(fs.readdirSync(root).filter(name=>/\.(js|json)$/.test(name))
      .map(name=>[name,fs.readFileSync(path.join(root,name),'utf8')]));
    return '<article><h2>'+text(label)+' · '+(provider==='glm'?'GLM 5.3':'GPT‑6.1 Sol')+'</h2>'+
      cases.map(item=>sample(files,item)).join('')+'</article>';
  }));
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Раскладка слайдов в сравнении</title>
  <style>
    *{box-sizing:border-box}body{background:#f2f2ef;color:#252625;font:16px/1.45 system-ui,sans-serif;margin:0}
    main{max-width:1680px;margin:auto;padding:28px}h1{font-size:clamp(26px,3vw,44px);margin:0 0 8px}
    p{margin:0 0 24px;max-width:72ch}h2{font-size:19px;margin:0 0 18px}h3{font-size:14px;margin:0 0 8px}
    .comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,285px),1fr));gap:16px}
    article{background:white;border:1px solid #dddcd5;border-radius:12px;padding:14px}section{margin:0 0 24px}
    .slide{position:relative;width:100%;overflow:hidden;background:var(--background);color:var(--foreground);border:1px solid #2223;border-radius:5px;container-type:inline-size;margin-bottom:8px}
    .landscape{aspect-ratio:16/9}.portrait{aspect-ratio:9/16;width:62%;margin-inline:auto}
    .block{position:absolute;padding:1.15cqw;overflow:hidden;display:flex;align-items:center;line-height:1.15;font-size:3.4cqw;overflow-wrap:anywhere}
    .headline{font-weight:760;font-size:5.5cqw}.metric{font-weight:700;border-top:2px solid var(--accent)}
    .quote{font-style:italic;border-left:2px solid var(--accent)}.media{background:var(--accent);color:var(--background);font-weight:650;justify-content:center;text-align:center}
  </style></head><body><main><h1>Раскладка слайдов в сравнении</h1><p>Один и тот же набор блоков в четырёх реализациях. Типографика и заглушка изображения общие. Модель определяет расположение блоков, разбиение по слайдам и палитру.</p><div class="comparison">${samples.join('')}</div></main></body></html>`;
  fs.writeFileSync(destination,html);
}

if(require.main===module){
  const [baseline,candidate,destination]=process.argv.slice(2);
  if(!baseline||!candidate||!destination)throw Error('Usage: node scripts/render-slide-comparison.js BASELINE CANDIDATE DESTINATION');
  comparison([['До',baseline],['После',candidate]],destination);
}
module.exports={ comparison };
