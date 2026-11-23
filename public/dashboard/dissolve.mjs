// Adapted from dissolve's web/footer.js, segmented-control.core.ts and kit.ts.
// Copyright (c) 2026 Rayan Selmi. MIT license: ./dissolve-LICENSE.txt
// Keeps the existing dashboard controls, text, and responsive geometry.
const clamp = value => Math.max(0, Math.min(1, value));
const hash = (i, seed) => { const n = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return n - Math.floor(n); };
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const forced = matchMedia('(forced-colors: active)');
const classic = () => document.documentElement.dataset.theme === 'classic';

function bezier(x1, y1, x2, y2) {
  const cx = 3*x1, bx = 3*(x2-x1)-cx, ax = 1-cx-bx;
  const cy = 3*y1, by = 3*(y2-y1)-cy, ay = 1-cy-by;
  const X = t => ((ax*t+bx)*t+cx)*t;
  return x => {
    if (x <= 0 || x >= 1) return clamp(x);
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = X(t)-x, slope = (3*ax*t+2*bx)*t+cx;
      if (Math.abs(error) < 1e-6 || Math.abs(slope) < 1e-6) break;
      t -= error/slope;
    }
    if (t < 0 || t > 1 || Math.abs(X(t)-x) > 1e-4) {
      let low = 0, high = 1;
      for (let i = 0; i < 30; i++) { t = (low+high)/2; if (X(t) < x) low = t; else high = t; }
    }
    return ((ay*t+by)*t+cy)*t;
  };
}
const flow = bezier(.42, 0, .12, 1);
const calm = bezier(.32, .72, 0, 1);
const flights = new Map();
const stopFlights = () => { for (const flight of flights.values()) flight.stop(); };
new MutationObserver(stopFlights).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
reduced.addEventListener('change', stopFlights);
forced.addEventListener('change', stopFlights);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopFlights(); });

export function moveSegment(track, previous, next) {
  const old = flights.get(track);
  const oldPoints = reduced.matches ? null : old?.points;
  const ghostOpacity = old?.pillOpacity ?? 1;
  const slidingFrom = reduced.matches ? old?.pill.getBoundingClientRect() : null;
  old?.stop();
  if (!classic() || forced.matches || !previous || previous === next) return;
  const box = track.getBoundingClientRect();
  if (!box.width) return;
  const from = slidingFrom ?? previous.getBoundingClientRect(), to = next.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.className = 'segment-flight';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pad = 12, dpr = Math.min(devicePixelRatio || 1, 3);
  canvas.width = Math.ceil((box.width+pad*2)*dpr);
  canvas.height = Math.ceil((box.height+pad*2)*dpr);
  const pill = document.createElement('span'), ghost = document.createElement('span');
  for (const [element, rect] of [[ghost,from],[pill,to]]) {
    element.className = 'segment-flight-pill';
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {left:`${rect.x-box.x}px`, top:`${rect.y-box.y}px`, width:`${rect.width}px`, height:`${rect.height}px`});
  }
  track.append(ghost,pill,canvas);
  ctx.setTransform(dpr,0,0,dpr,pad*dpr,pad*dpr);
  const ink = getComputedStyle(canvas).color;
  let pitch = Math.max(4,to.height*.14), points;
  // The source uses at most 180 overlapping round grains inside a capsule.
  do {
    points = [];
    const cols = Math.max(2,Math.round(Math.max(from.width,to.width)/pitch));
    const rows = Math.max(2,Math.round(to.height/pitch));
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
      const u=(x+.5)/cols, v=(y+.5)/rows;
      const edge=Math.max(0,Math.abs(u-.5)*to.width-(to.width-to.height)/2);
      if (Math.hypot(edge,(v-.5)*to.height) > to.height/2-Math.min(to.width/cols,to.height/rows)*.3) continue;
      const k=points.length;
      points.push({u,v,tx:to.x-box.x+u*to.width,ty:to.y-box.y+v*to.height,
        sx:from.x-box.x+u*from.width,sy:from.y-box.y+v*from.height,
        sr:Math.max(from.width/cols,from.height/rows)*1.22/2,
        tr:Math.max(to.width/cols,to.height/rows)*1.22/2,
        arc:(v-.5)*1.6+(hash(k,3)-.5)*.7, seed:hash(k,4), scatter:(hash(k,5)-.5)*8, run:290*(.85+.3*hash(k,9)), sa:1});
    }
    pitch *= 1.15;
  } while(points.length > 180);
  points.forEach((p,i) => {
    const prior = oldPoints?.[Math.floor(i/points.length*oldPoints.length)];
    if (prior) { p.sx=prior.x; p.sy=prior.y; p.sr=prior.radius; p.sa=prior.alpha; }
  });
  const direction = to.x >= from.x ? 1 : -1;
  const reach = Math.min(1,Math.hypot(to.x-from.x,to.y-from.y)/to.width);
  const arc = Math.min(7,3+to.width*.03)*(.55+.45*reach);
  const start = performance.now();
  let frame;
  const initialWidth = track.clientWidth, initialHeight = track.clientHeight;
  const resize = new ResizeObserver(() => {
    if (track.clientWidth !== initialWidth || track.clientHeight !== initialHeight) stop();
  });
  const flight = {points, pill, pillOpacity:0, stop};
  function stop() {
    cancelAnimationFrame(frame); resize.disconnect();
    canvas.remove(); ghost.remove(); pill.remove(); flights.delete(track);
  }
  flights.set(track,flight);
  resize.observe(track);
  function draw(now) {
    const since = now-start;
    ctx.clearRect(-pad,-pad,box.width+pad*2,box.height+pad*2);
    if (reduced.matches) {
      const k=calm(clamp(since/260));
      Object.assign(pill.style,{left:`${from.x-box.x+(to.x-from.x)*k}px`,top:`${from.y-box.y+(to.y-from.y)*k}px`,width:`${from.width+(to.width-from.width)*k}px`});
      pill.style.opacity='1'; ghost.style.opacity='0';
    } else {
      ctx.fillStyle=ink;
      const fade=clamp((since-340)/80);
      for (const p of points) {
        const lead=direction>0?p.u:1-p.u, delay=(1-lead)*110*.6+p.seed*110*.4;
        const e=flow(clamp((since-delay)/p.run)), bump=Math.sin(Math.PI*e);
        p.x=p.sx+(p.tx-p.sx)*e+p.scatter*bump;
        p.y=p.sy+(p.ty-p.sy)*e+p.arc*arc*bump;
        p.alpha=(p.sa+(1-p.sa)*clamp(since/60))*(1-fade);
        p.radius=(p.sr+(p.tr-p.sr)*e)*(1-.55*bump);
        if (p.alpha <= .003) continue;
        ctx.globalAlpha=p.alpha;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.radius,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=1;
      ghost.style.opacity=String(ghostOpacity*(1-clamp(since/90)));
      flight.pillOpacity=clamp((since-280)/100);
      pill.style.opacity=String(flight.pillOpacity);
    }
    if (since < (reduced.matches?260:420)) frame=requestAnimationFrame(draw); else flight.stop();
  }
  draw(start);
}

export function mountParticleTitle(title) {
  const canvas=document.createElement('canvas');
  canvas.className='title-particles'; canvas.setAttribute('aria-hidden','true');
  const ctx=canvas.getContext('2d');
  if (!ctx) return;
  const text=title.textContent;
  const sample=document.createElement('canvas');
  const source=sample.getContext('2d',{willReadFrequently:true});
  if (!source) return;
  const pad=36;
  let width=0,height=0,gap=3,dots=[],ink='',frame=0,last=0,visible=false,mx=-1e4,my=-1e4;
  function active() { return classic() && !forced.matches && !document.hidden && visible; }
  function paint() {
    ctx.clearRect(-pad,-pad,width+pad*2,height+pad*2);
    ctx.fillStyle=ink; ctx.beginPath();
    for (const d of dots) { ctx.moveTo(d.x+gap*.34,d.y); ctx.arc(d.x,d.y,gap*.34,0,Math.PI*2); }
    ctx.fill();
  }
  function step(now) {
    frame=0;
    if (!active()) return;
    const dt=Math.min(2,(now-(last||now-16.67))/16.67); last=now;
    const radius=Math.max(26,gap*12), r2=radius*radius;
    let moving=false;
    for (const d of dots) {
      d.vx+=(d.tx-d.x)*.045*dt; d.vy+=(d.ty-d.y)*.045*dt;
      const dx=d.x-mx,dy=d.y-my,q=dx*dx+dy*dy;
      if (q<r2 && q>.01) {
        const force=(1-q/r2)*2.4*dt/Math.sqrt(q);
        d.vx+=dx*force; d.vy+=dy*force;
      }
      d.vx*=Math.pow(.84,dt); d.vy*=Math.pow(.84,dt);
      d.x+=d.vx*dt; d.y+=d.vy*dt;
      if (Math.abs(d.x-d.tx)+Math.abs(d.y-d.ty)+Math.abs(d.vx)+Math.abs(d.vy)>.06) moving=true;
    }
    paint();
    if (moving) frame=requestAnimationFrame(step);
  }
  function start() {
    if (!frame && active() && !reduced.matches) {last=0;frame=requestAnimationFrame(step);}
  }
  function layout() {
    cancelAnimationFrame(frame); frame=0;
    canvas.remove(); title.removeAttribute('data-particles');
    if (!classic() || forced.matches) return;
    const style=getComputedStyle(title),rect=title.getBoundingClientRect();
    width=rect.width; height=rect.height;
    if (!width || !height) return;
    const size=parseFloat(style.fontSize);
    gap=Math.max(3,size*.047);
    sample.width=Math.ceil(width); sample.height=Math.ceil(height);
    source.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    source.letterSpacing=style.letterSpacing;
    source.textBaseline='alphabetic';
    const metrics=source.measureText(text);
    const ascent=metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
    const descent=metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
    source.fillText(text,0,(height-ascent-descent)/2+ascent);
    const pixels=source.getImageData(0,0,sample.width,sample.height).data;
    dots=[];
    for(let y=gap/2;y<height;y+=gap) for(let x=gap/2;x<width;x+=gap) {
      if(pixels[(Math.floor(y)*sample.width+Math.floor(x))*4+3]>140) dots.push({x,y,tx:x,ty:y,vx:0,vy:0});
    }
    if (!dots.length) return;
    ink=style.color;
    const dpr=Math.min(devicePixelRatio||1,3);
    canvas.width=Math.ceil((width+pad*2)*dpr);canvas.height=Math.ceil((height+pad*2)*dpr);
    ctx.setTransform(dpr,0,0,dpr,pad*dpr,pad*dpr);
    title.append(canvas);title.dataset.particles='';paint();
  }
  title.addEventListener('pointermove',event=>{
    if (reduced.matches || !active()) return;
    const rect=title.getBoundingClientRect();mx=event.clientX-rect.x;my=event.clientY-rect.y;start();
  });
  title.addEventListener('pointerleave',()=>{mx=my=-1e4;start();});
  title.addEventListener('click',()=>{
    if (reduced.matches || !active()) return;
    mx=my=-1e4;
    for(const d of dots){const a=Math.random()*Math.PI*2,s=3+Math.random()*7;d.vx+=Math.cos(a)*s;d.vy+=Math.sin(a)*s;}
    start();
  });
  new ResizeObserver(()=>{const r=title.getBoundingClientRect();if(r.width!==width||r.height!==height)layout();}).observe(title);
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(visible)start();else{cancelAnimationFrame(frame);frame=0;}}).observe(title);
  new MutationObserver(layout).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',layout);
  reduced.addEventListener('change',layout); forced.addEventListener('change',layout);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else start();});
  document.fonts.ready.then(layout);
}
