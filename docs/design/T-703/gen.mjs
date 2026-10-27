// Генератор макета T-702: SVG → импорт в FigCraft. Токены взяты из src/web/styles/tokens.css (светлая тема).
import { writeFileSync } from 'node:fs';
const T = { surface:'#ffffff', canvas:'#f2f2f2', ink:'#141414', ink3:'#5c5c5c', ink4:'#6b6b6b', film2:'#00000012', film:'#0000000f',
  hair:'#dadada', warn:'#f2a33a', warnInk:'#8f5a00', warnInkOn:'#181320', accent:'#2563eb', ok:'#4ade80' };
const ACC = ['#2f7bf6','#6366f1','#a855f7','#ec4899','#ea580c','#f0b429','#84cc16','#0d9488'];
const INK_ON = (i) => (i===5||i===6) ? '#181320' : '#ffffff';
const F = 'Inter, Arial, sans-serif';
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const txt = (x,y,s,size,w,fill,anchor='start') =>
  `<text x="${x}" y="${y}" font-family="${F}" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const cut = (s,px,cw) => { const n=Math.floor(px/cw); return s.length>n ? s.slice(0,n-1)+'…' : s; };
const plural = (n,a,b,c) => { const m=n%100, d=n%10; return (m>10&&m<20)?c:d===1?a:(d>=2&&d<=4)?b:c; };
const qWord = (n) => `${n} ${plural(n,'вопрос','вопроса','вопросов')}`;
const wWord = (n) => `${n} ${plural(n,'задача','задачи','задач')} в работе`;

const STATES = [
  { id:'Тихий', name:'Rewind', c:0, st:'3 агента · 0 в работе', q:0, w:0 },
  { id:'В работе', name:'Guestbook', c:1, st:'3 агента · 2 в работе', q:0, w:4 },
  { id:'С вопросами', name:'Atlas', c:2, st:'2 агента · 0 в работе', q:2, w:0 },
  { id:'Всё сразу', name:'Rewind', c:0, st:'3 агента · 2 в работе', q:3, w:4 },
  { id:'Длинное название', name:'Платформа мобильных платежей для партнёров', c:4, st:'5 агентов · 3 в работе', q:2, w:5 },
  { id:'Выбранный', name:'Office', c:7, st:'4 агента · 1 в работе', q:1, w:2, cur:true },
  { id:'На паузе', name:'Atlas', c:2, st:'на паузе · 2 в работе', q:0, w:2, p:true },
  { id:'Пауза и вопросы', name:'Guestbook', c:1, st:'на паузе · 3 в работе', q:2, w:3, p:true },
  { id:'Выбранный на паузе', name:'Office', c:7, st:'на паузе · 1 в работе', q:0, w:1, p:true, cur:true },
];
const COLL = [
  { id:'Свёрнутый: тихий', s:STATES[0] },
  { id:'Свёрнутый: сразу', s:STATES[3] },
  { id:'Свёрнутый: выбран.', s:{...STATES[5]} },
  { id:'Свёрнутый: на паузе', s:STATES[6] },
  { id:'Свёрнутый: пауза + ?', s:STATES[7] },
];
const W = 240;
// знак паузы ⏸ — две планки (как player-pause в Rail.tsx)
const pauseGlyph = (cx,cy,h,fill) => { const bw=h*0.28, g=h*0.22; return `<rect x="${cx-g/2-bw}" y="${cy-h/2}" width="${bw}" height="${h}" rx="${bw/3}" fill="${fill}"/><rect x="${cx+g/2}" y="${cy-h/2}" width="${bw}" height="${h}" rx="${bw/3}" fill="${fill}"/>`; };
const pauseBadge = (cx,cy) => `<circle cx="${cx}" cy="${cy}" r="7.5" fill="${T.warn}" stroke="${T.surface}" stroke-width="2"/>` + pauseGlyph(cx,cy,7,T.warnInkOn);

// иконка-аватар: заливка из палитры + первая буква (картинка/эмодзи в макете заменены буквой)
const avatar = (x,y,sz,s) => `<rect x="${x}" y="${y}" width="${sz}" height="${sz}" rx="7" fill="${ACC[s.c]}"/>` +
  txt(x+sz/2, y+sz/2+4.5, s.name[0], sz>=28?13:12.5, 600, INK_ON(s.c), 'middle');
const qBadge = (cx,cy,n) => { const t=n>9?'9+':String(n); const w=Math.max(16,t.length*6+8);
  return `<rect x="${cx-w/2}" y="${cy-8}" width="${w}" height="16" rx="8" fill="${T.warn}" stroke="${T.surface}" stroke-width="2"/>` + txt(cx,cy+3.5,t,10,600,T.warnInkOn,'middle'); };
const wDot = (cx,cy,r=5,fill=T.accent) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${T.surface}" stroke-width="2"/>`;
const nBadge = (cx,cy,n,fill,ink) => { const t=String(n); const w=Math.max(14,t.length*6+6);
  return `<rect x="${cx-w/2}" y="${cy-7}" width="${w}" height="14" rx="7" fill="${fill}" stroke="${T.surface}" stroke-width="2"/>` + txt(cx,cy+3.5,t,9,600,ink,'middle'); };
const bg = (x,y,h,s) => s.p ? `<rect x="${x}" y="${y}" width="${W}" height="${h}" rx="12" fill="${T.warn}" fill-opacity="${s.cur?.22:.12}" stroke="${T.warn}" stroke-opacity=".6"/>` : s.cur ? `<rect x="${x}" y="${y}" width="${W}" height="${h}" rx="12" fill="${T.film2}" stroke="${T.hair}"/>` : '';
const pill = (x,cy,label,fill,ink,w) => `<rect x="${x}" y="${cy-9}" width="${w}" height="18" rx="9" fill="${fill}"/>` + txt(x+w/2,cy+4,label,11,600,ink,'middle');

// ----- A: как сейчас -----
function rowA(x,y,s){ const h=40, dot = s.w>0 ? T.ok : T.ink4;
  const mark = s.p ? pauseGlyph(x+W-14,y+20,9,T.warnInk) : `<circle cx="${x+W-14}" cy="${y+20}" r="3.5" fill="${dot}"/>`;
  const nameC = cut(s.name, 160, 7.8);
  return { h, svg: bg(x,y,h,s) + avatar(x+8,y+8,24,s) + txt(x+40,y+18,nameC,13,500,T.ink) +
    txt(x+40,y+32,cut(s.st,160,5.7),11,s.p?600:400,s.p?T.warnInk:s.cur?T.ink4:T.ink3) +
    (s.q>0?qBadge(x+8+24+8-8,y+8-6+8,s.q):'') + (s.w>0?wDot(x+31,y+30,5):'') +
    mark };
}
// ----- B: метрики второй строкой -----
function rowB(x,y,s){ const h=48; let line2='', cx=x+44;
  const cy=y+33;
  if (s.p){ const tail = s.q>0 ? `· ${s.w}` : `· ${s.w} в работе`;
    line2 += pauseGlyph(cx+3,cy-1,9,T.warnInk) + txt(cx+12,cy+3,'На паузе',11,600,T.warnInk) + (s.w>0?txt(cx+12+8*5.9+2,cy+3,tail,11,400,T.ink3):''); cx += 12 + 8*5.9 + (s.w>0?tail.length*5.5+8:8);
    if (s.q>0){ const l=qWord(s.q); line2 += `<rect x="${cx-1}" y="${cy-8}" width="${l.length*5.6+22}" height="16" rx="8" fill="${T.warn}" fill-opacity=".22"/><text x="${cx+5}" y="${cy+3.5}" font-family="${F}" font-size="10" font-weight="700" fill="${T.warnInk}">?</text>` + txt(cx+14,cy+3.5,l,11,600,T.warnInk); } }
  else if (s.q===0 && s.w===0) line2 = `<circle cx="${cx+3}" cy="${cy-1}" r="3" fill="${T.ink4}"/>` + txt(cx+12,cy+3,'Простаивает',11,400,s.cur?T.ink4:T.ink3);
  else { if (s.w>0){ const l=wWord(s.w); line2 += `<circle cx="${cx+3}" cy="${cy-1}" r="3.5" fill="${T.accent}"/><circle cx="${cx+3}" cy="${cy-1}" r="6" fill="none" stroke="${T.accent}" stroke-opacity=".35"/>` + txt(cx+14,cy+3,l,11,500,T.accent); cx += 14 + l.length*5.7 + 10; }
    if (s.q>0){ const l=qWord(s.q); line2 += `<rect x="${cx-1}" y="${cy-8}" width="${l.length*5.6+22}" height="16" rx="8" fill="${T.warn}" fill-opacity=".22"/><text x="${cx+5}" y="${cy+3.5}" font-family="${F}" font-size="10" font-weight="700" fill="${T.warnInk}">?</text>` + txt(cx+14,cy+3.5,l,11,600,T.warnInk); } }
  return { h, svg: bg(x,y,h,s) + avatar(x+8,y+10,28,s) + txt(x+44,y+20,cut(s.name,188,7.8),13,500,T.ink) + line2 };
}
// ----- C: кольцо вокруг иконки + капсулы справа -----
function rowC(x,y,s){ const h=40; const icx=x+24, icy=y+20;
  const ring = s.p ? `<circle cx="${icx}" cy="${icy}" r="16" fill="none" stroke="${T.warn}" stroke-width="2" stroke-dasharray="3 3"/>` : s.w>0 ? `<circle cx="${icx}" cy="${icy}" r="16" fill="none" stroke="${T.accent}" stroke-width="2"/><path d="M ${icx} ${icy-16} A 16 16 0 0 1 ${icx+16} ${icy}" fill="none" stroke="${T.accent}" stroke-width="3" stroke-linecap="round"/>` : '';
  let right=''; let rx=x+W-8; const caps=[];
  if (s.p) caps.push({l:String(s.w),pause:true,w:s.w>9?40:34});
  else if (s.w>0) caps.push({l:String(s.w),fill:T.accent,ink:'#ffffff',w:24});
  if (s.q>0) caps.push({l:'? '+(s.q>9?'9+':s.q),fill:T.warn,ink:T.warnInkOn,w:s.q>9?34:30});
  for (const c of caps){ rx-=c.w;
    if (c.pause) right += `<rect x="${rx+.5}" y="${y+11.5}" width="${c.w-1}" height="17" rx="8.5" fill="${T.warn}" fill-opacity=".18" stroke="${T.warn}"/>` + pauseGlyph(rx+11,y+20,8,T.warnInk) + txt(rx+19,y+24,c.l,11,600,T.warnInk);
    else right += pill(rx,y+20,c.l,c.fill,c.ink,c.w); rx-=4; }
  const avail = (rx+4) - (x+48) - 4;
  return { h, svg: bg(x,y,h,s) + ring + avatar(x+12,y+8,24,s) + txt(x+48,y+24.5,cut(s.name,avail,7.8),13,500,T.ink) + right };
}
// ----- D: точка на иконке + столбец счётчиков справа -----
function rowD(x,y,s){ const h=44; const colW = (s.q>0||s.w>0||s.p) ? 78 : 0;
  let right=''; const rx=x+W-8;
  const lines=[]; if (s.q>0) lines.push({t:qWord(s.q),f:T.warnInk,w:600});
  if (s.p) lines.push({t: s.w>0 ? `${s.w} в работе` : 'на паузе', f:T.ink3, w:400, pause:true});
  else if (s.w>0) lines.push({t:`${s.w} в работе`,f:T.accent,w:500});
  lines.forEach((l,i)=>{ const yy = lines.length===1 ? y+26 : y+19+i*13; right += txt(rx,yy,l.t,11,l.w,l.f,'end'); if (l.pause) right += pauseGlyph(rx-l.t.length*5.5-9,yy-3.5,8,T.warnInk); });
  return { h, svg: bg(x,y,h,s) + avatar(x+8,y+8,28,s) + (s.p?pauseBadge(x+8+28-2,y+8+28-2):s.w>0?wDot(x+8+28-2,y+8+28-2,5,T.ok):'') +
    txt(x+44,y+26,cut(s.name,W-44-8-colW-(colW?6:0),7.8),13,500,T.ink) + right };
}
// свёрнутый рейл: строка 52×40
function collapsed(variant,x,y,s){ const w=52,h=40; const ix=x+14, iy=y+8, ic=ix+12, icy=iy+12;
  const bgr = s.p ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${T.warn}" fill-opacity="${s.cur?.22:.12}" stroke="${T.warn}" stroke-opacity=".6"/>` : s.cur ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${T.film2}" stroke="${T.hair}"/>` : '';
  let g = bgr;
  if (variant==='C' && s.p) g += `<circle cx="${ic}" cy="${icy}" r="16" fill="none" stroke="${T.warn}" stroke-width="2" stroke-dasharray="3 3"/>`;
  else if (variant==='C' && s.w>0) g += `<circle cx="${ic}" cy="${icy}" r="16" fill="none" stroke="${T.accent}" stroke-width="2"/>`;
  g += avatar(ix,iy,24,s);
  if (s.q>0) g += qBadge(ix+24+2,iy-2,s.q);
  if (s.p) g += variant==='A' ? pauseBadge(ix+22,iy+3) : pauseBadge(ix+22,iy+27);
  else if (s.w>0){ if (variant==='A') g += wDot(ix+22,iy+27,5); else if (variant==='D') g += wDot(ix+22,iy+27,5,T.ok) + ''; else g += nBadge(ix+22,iy+27,s.w,T.accent,'#fff'); }
  if (variant==='D' && s.w>0) g += '';
  return g;
}

const VARS = [
  { key:'A', title:'A · Как сейчас (для сравнения)', fn:rowA },
  { key:'B', title:'B · Метрики второй строкой (счётчики текстом, нули скрыты)', fn:rowB },
  { key:'C', title:'C · Кольцо работы вокруг иконки + капсулы-счётчики справа', fn:rowC },
  { key:'D', title:'D · Точка «работает» на иконке + столбец цифр справа', fn:rowD },
];
const X0=40, CW=268, GAP=16;
const colX = (i)=> X0 + i*CW;
const collX0 = X0 + STATES.length*CW + 24;
const collX = (i)=> collX0 + i*(52+32+46);
const totalW = collX(COLL.length) + 20;
let y = 40, out = '';
out += txt(X0,y+8,'T-703 · Строка офиса в левом рейле — варианты',22,700,T.ink);
out += txt(X0,y+30,'Рейл 264 px (строка 240 px), свёрнутый 70 px (строка 52 px). Светлая тема, токены из tokens.css. Иконка-эмодзи/картинка показана цветной плиткой с буквой.',12,400,T.ink3);
y += 66;
// заголовки колонок
STATES.forEach((s,i)=>{ out += txt(colX(i)+6,y,s.id,12,600,T.ink3); });
COLL.forEach((c,i)=>{ out += txt(collX(i),y,c.id.replace('Свёрнутый: ','Узкий · '),12,600,T.ink3); });
y += 14;
let blocks='';
for (const v of VARS){
  let b=''; const by=y;
  b += txt(X0,y+16,v.title,15,700,T.ink); y+=30;
  let rowH=0;
  STATES.forEach((s,i)=>{ const r=v.fn(colX(i)+6,y+6,s); rowH=Math.max(rowH,r.h);
    b = b + `<g id="${v.key} · ${s.id}"><rect x="${colX(i)}" y="${y}" width="252" height="${r.h+12}" rx="14" fill="${T.surface}" stroke="${T.hair}"/>` + r.svg + `</g>`; });
  COLL.forEach((c,i)=>{ b += `<g id="${v.key} · ${c.id}"><rect x="${collX(i)-12}" y="${y}" width="76" height="${rowH+12}" rx="14" fill="${T.surface}" stroke="${T.hair}"/>` + collapsed(v.key,collX(i),y+6,c.s) + `</g>`; });
  y += rowH+12+44;
  blocks += `<g id="Вариант ${v.key}">${b}</g>`;
}
const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}"><rect width="${totalW}" height="${H}" fill="${T.canvas}"/>${out}${blocks}</svg>`;
writeFileSync(new URL('./rail-office-rows.svg', import.meta.url), svg);
console.log(totalW, H);
