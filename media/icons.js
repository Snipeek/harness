'use strict';
// Standard action glyphs drawn on a consistent 24px grid; no font-dependent symbols.
window.aiIcon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'20',height:'20',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
  const paths = {
    spinner:['M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9'], back:['M20 12H4m7-7-7 7 7 7'], plus:['M12 5v14M5 12h14'],
    send:['M12 19V5m-5.5 5.5L12 5l5.5 5.5'], stop:['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z'],
    slash:['M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z','m9 16 6-8'],
    chevron:['m10 7 5 5-5 5'], down:['m7 10 5 5 5-5'],
    manual:[
      'M8 11V6a1.5 1.5 0 0 1 3 0v5',
      'M11 9V4.5a1.5 1.5 0 0 1 3 0V11',
      'M14 8V6a1.5 1.5 0 0 1 3 0v6',
      'M17 10a1.5 1.5 0 0 1 3 0v4.5a6.5 6.5 0 0 1-12 3.4L5 13a1.5 1.5 0 0 1 2.5-1.6L10 14'
    ],
    edit:['m8 7-5 5 5 5m8-10 5 5-5 5M14 5l-4 14'],
    plan:['M7 4h11a2 2 0 0 1 2 2v11h2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 0-4 0v2',
      'M8 20a2 2 0 0 0 2-2v-1h10M10 9h6m-6 4h4'],
    check:['m5 12 4 4L19 6'], copy:['M8 8h12v13H8Z','M16 8V3H3v14h5'], bookmark:['M6 3h12v18l-6-4-6 4Z'],
    refresh:['M23 4v6h-6','M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
    settings:['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z','M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
    eye:['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z','M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
    agents:['M9 4h6v6H9ZM2 17h6v5H2Zm14 0h6v5h-6ZM12 10v4H5v3m7-3h7v3'],
    file:['M5 2h9l5 5v15H5Z','M14 2v6h5'], selection:['M4 4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5m0-6V4'],
    close:['m7 7 10 10M7 17 17 7'], search:['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0','m15 15 6 6'], filter:['M3 4h18l-7 8v7l-4 2v-9Z'], bolt:['m13 2-9 12h7l-1 8L21 9h-8Z'],
    archive:['M4 7v14h16V7M2 3h20v4H2Zm7 9h6'], pencil:['m16 3 5 5-12 12-6 1 1-6Z','m14 5 5 5'], more:['M5 12h.01M12 12h.01M19 12h.01']
  };
  for(const d of paths[name === 'auto' ? 'bolt' : name] || paths.more){const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',d);svg.append(p);}
  if(name==='stop')svg.setAttribute('fill','currentColor');return svg;
};
