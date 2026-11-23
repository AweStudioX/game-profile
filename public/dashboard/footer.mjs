(() => {
  const collage = document.querySelector('[data-footer-collage]');
  if (!collage) return;
  const stickers = [...collage.querySelectorAll('.footer-sticker')];
  if (!stickers.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fineHover = window.matchMedia('(hover: hover) and (pointer: fine)');

  const PEEL = .2;
  const GRAB_PEEL = .32;
  const DRAG_THRESHOLD = 4;
  const KEY_STEP = 12;
  const HOVER_RAMP = 180;
  const HOVER_TRACK = 140;
  const SETTLE = 240;

  const clamp01 = value => Math.max(0, Math.min(1, value));
  const imageOf = sticker => sticker.querySelector('img');
  const offsets = new Map();
  let geom = new WeakMap();

  // Vary the middle of the path, never delay a sticker's start or finish.
  const revealItems = stickers.map((sticker, index) => {
    const phase = clamp01((parseFloat(getComputedStyle(sticker).getPropertyValue('--d')) || 0) / 240);
    sticker.style.setProperty('--reveal-travel', `${32 + phase * 24}px`);
    sticker.style.setProperty('--reveal-twist', `${(index % 2 ? -1 : 1) * (2 + phase * 2)}deg`);
    return { sticker, curve: (phase - .5) * .64, value: -1 };
  });

  // Native transform/opacity animations follow compositor scrolling without
  // waiting for scroll events or per-frame JavaScript style writes.
  const revealTimeline = typeof ViewTimeline === 'function'
    ? new ViewTimeline({ subject: collage, axis: 'block', inset: '0px' })
    : null;
  let revealAnimations = [];
  function buildNativeReveal() {
    for (const animation of revealAnimations) animation.cancel();
    revealAnimations = [];
    if (reduced.matches) return;
    const distance = Math.min(320, window.innerHeight * .4, collage.clientHeight);
    const edge = distance / (window.innerHeight + collage.clientHeight);
    for (const { sticker, curve } of revealItems) {
      const style = getComputedStyle(sticker);
      const rotation = parseFloat(style.getPropertyValue('--r')) || 0;
      const scale = parseFloat(style.getPropertyValue('--s')) || 1;
      const travel = parseFloat(style.getPropertyValue('--reveal-travel'));
      const twist = parseFloat(style.getPropertyValue('--reveal-twist'));
      const hidden = {
        opacity: 0,
        transform: `translate(-50%, calc(-50% + ${travel}px)) rotate(${rotation - twist}deg) scale(${.94 * scale})`,
      };
      const visible = {
        opacity: 1,
        transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
      };
      // Linear time with quadratic spatial variation, matching the fallback.
      const easing = c => `cubic-bezier(${1 / 3}, ${(1 + c) / 3}, ${2 / 3}, ${(2 + c) / 3})`;
      revealAnimations.push(sticker.animate([
        { ...hidden, offset: 0, easing: easing(curve) },
        { ...visible, offset: edge },
        { ...visible, offset: 1 - edge, easing: easing(-curve) },
        { ...hidden, offset: 1 },
      ], { timeline: revealTimeline, duration: 'auto', fill: 'both' }));
    }
  }

  // Scroll distance controls both translation and opacity; no timed exit.
  let scrollRevealFrame = 0;
  let lastRevealProgress = -1;
  function updateReveal() {
    scrollRevealFrame = 0;
    const rect = collage.getBoundingClientRect();
    const distance = Math.min(320, window.innerHeight * .4, collage.clientHeight);
    const progress = reduced.matches ? 1 : clamp01(Math.min(window.innerHeight - rect.top, rect.bottom) / distance);
    if (progress === lastRevealProgress) return;
    lastRevealProgress = progress;
    for (const item of revealItems) {
      const value = progress + item.curve * progress * (1 - progress);
      if (value === item.value) continue;
      item.value = value;
      item.sticker.style.setProperty('--float', String(value));
    }
    collage.classList.toggle('is-visible', progress > 0);
  }
  function scheduleReveal() {
    if (!scrollRevealFrame) scrollRevealFrame = requestAnimationFrame(updateReveal);
  }
  const reveal = () => {
    for (const sticker of stickers) sticker.classList.add('is-loaded');
    if (revealTimeline) buildNativeReveal();
    else updateReveal();
  };
  const settled = () => Promise.all(stickers.map(sticker => {
    const image = imageOf(sticker);
    if (!image || image.complete) return Promise.resolve();
    return new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    });
  }));
  collage.classList.add('is-armed');
  if (revealTimeline) {
    buildNativeReveal();
    new ResizeObserver(buildNativeReveal).observe(collage);
    new IntersectionObserver(([entry]) => {
      collage.classList.toggle('is-visible', entry.isIntersecting);
    }).observe(collage);
    window.addEventListener('resize', buildNativeReveal);
    reduced.addEventListener('change', buildNativeReveal);
  } else {
    updateReveal();
    window.addEventListener('scroll', scheduleReveal, { passive: true });
    window.addEventListener('resize', scheduleReveal);
    reduced.addEventListener('change', scheduleReveal);
  }
  settled().then(reveal);

  // Shared renderer: one canvas, one WebGL context, lazily loaded on first hover.
  let canvas = null;
  let renderer = null;
  let rendererPromise = null;
  let lifecycle = 0;
  let activation = 0;
  let pendingWrapper = null;
  let hoverPoint = null;

  let state = inactiveState();
  let anim = null;
  let rafId = 0;

  let drag = null;
  let suppressClick = false;
  let suppressUntil = 0;
  let lastPointerUpAt = -Infinity;

  function inactiveState() {
    return { wrapper: null, active: false, peel: 0, direction: Math.PI, lightX: .5, lightY: .5 };
  }

  function makeCanvas() {
    const element = document.createElement('canvas');
    element.width = 512;
    element.height = 512;
    element.className = 'footer-peel-canvas';
    element.setAttribute('aria-hidden', 'true');
    // The parent stylesheet owns the canvas box; these keep the shared canvas
    // correct even if it is inspected or mounted before that rule applies.
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none';
    return element;
  }

  function ensureRenderer() {
    if (renderer) return Promise.resolve(renderer);
    if (rendererPromise) return rendererPromise;
    const epoch = lifecycle;
    rendererPromise = (async () => {
      let module = null;
      try { module = await import('./sticker-peel.mjs'); } catch { module = null; }
      if (epoch !== lifecycle) return null;
      if (!module) { rendererPromise = null; return null; }
      const create = module.createPeelRenderer;
      if (typeof create !== 'function') return null;
      canvas ??= makeCanvas();
      let created = null;
      try { created = create(canvas); } catch { created = null; }
      if (epoch !== lifecycle) {
        try { created?.destroy?.(); } catch {}
        return null;
      }
      renderer = created || null;
      if (!renderer) canvas = null;
      else renderer.onLost = () => { if (state.active) finalizeNow(); };
      return renderer;
    })();
    return rendererPromise;
  }

  async function decodeImage(image) {
    if (!image.complete) {
      await new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }
    if (image.decode) { try { await image.decode(); } catch {} }
    return image.naturalWidth > 0;
  }

  function geometryOf(wrapper) {
    const cached = geom.get(wrapper);
    if (cached) return cached;
    const styles = getComputedStyle(wrapper);
    const rotation = (parseFloat(styles.getPropertyValue('--r')) || 0) * Math.PI / 180;
    const parsedScale = parseFloat(styles.getPropertyValue('--s'));
    const scale = parsedScale > 0 ? parsedScale : 1;
    let halfW = wrapper.offsetWidth / 2;
    let halfH = wrapper.offsetHeight / 2;
    if (!halfW || !halfH) {
      const rect = wrapper.getBoundingClientRect();
      halfW = rect.width / (2 * scale) || 1;
      halfH = rect.height / (2 * scale) || 1;
    }
    const result = { rotation, scale, halfW, halfH };
    geom.set(wrapper, result);
    return result;
  }

  // Local coordinates ignore the wrapper's rotate/scale so the peel direction
  // always points at the edge nearest the pointer, not at a viewport quadrant.
  function targetFrom(wrapper, point) {
    const geometry = geometryOf(wrapper);
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const vx = point.x - (rect.left + rect.width / 2);
    const vy = point.y - (rect.top + rect.height / 2);
    const cos = Math.cos(geometry.rotation);
    const sin = Math.sin(geometry.rotation);
    const lx = (cos * vx + sin * vy) / geometry.scale;
    const ly = (-sin * vx + cos * vy) / geometry.scale;
    const direction = Math.atan2(ly, lx);
    return {
      direction,
      lightX: clamp01((lx + geometry.halfW) / (2 * geometry.halfW)),
      lightY: clamp01((ly + geometry.halfH) / (2 * geometry.halfH)),
    };
  }

  function mountCanvas(wrapper) {
    if (!canvas) return;
    canvas.style.display = 'block';
    wrapper.appendChild(canvas);
  }

  function hideCanvas() {
    if (!canvas) return;
    canvas.style.display = 'none';
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function drawOnce() {
    if (!state.active || !renderer) return false;
    try {
      renderer.draw({
        peel: state.peel,
        direction: state.direction,
        lightX: state.lightX,
        lightY: state.lightY,
      });
      return true;
    } catch {
      return false;
    }
  }

  function finalizeNow() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    anim = null;
    if (state.wrapper) state.wrapper.classList.remove('is-peeling');
    state = inactiveState();
    pendingWrapper = null;
    hideCanvas();
  }

  async function activate(wrapper, point, grabbed = false) {
    const allowed = () => !reduced.matches && (grabbed
      ? drag?.wrapper === wrapper
      : fineHover.matches && !drag);
    if (!allowed()) return;
    if (state.active && state.wrapper === wrapper) {
      updatePreview(wrapper, point);
      return;
    }
    if (state.active) finalizeNow();
    const image = imageOf(wrapper);
    if (!image) return;
    const token = ++activation;
    pendingWrapper = wrapper;
    const activeRenderer = await ensureRenderer();
    if (token !== activation || !activeRenderer) {
      if (pendingWrapper === wrapper) pendingWrapper = null;
      return;
    }
    if (!allowed()) {
      if (pendingWrapper === wrapper) pendingWrapper = null;
      return;
    }
    if (!await decodeImage(image)) {
      if (pendingWrapper === wrapper) pendingWrapper = null;
      return;
    }
    if (token !== activation || !allowed()) {
      if (pendingWrapper === wrapper) pendingWrapper = null;
      return;
    }
    mountCanvas(wrapper);
    let ok = false;
    try { ok = !!activeRenderer.setImage(image); } catch { ok = false; }
    if (!ok || token !== activation) {
      hideCanvas();
      if (pendingWrapper === wrapper) pendingWrapper = null;
      return;
    }
    state = inactiveState();
    state.wrapper = wrapper;
    state.active = true;
    pendingWrapper = null;
    const previewPoint = grabbed ? { x: drag.lastX, y: drag.lastY } : hoverPoint || point;
    if (previewPoint) {
      const target = targetFrom(wrapper, previewPoint);
      if (target) Object.assign(state, target);
    }
    // Only hide the flat image once the canvas has accepted and drawn it.
    if (!drawOnce()) {
      state = inactiveState();
      hideCanvas();
      return;
    }
    wrapper.classList.add('is-peeling');
    rampTo(grabbed ? GRAB_PEEL : PEEL, HOVER_RAMP);
  }

  function updatePreview(wrapper, point) {
    if (!state.active || state.wrapper !== wrapper) return;
    const target = targetFrom(wrapper, point);
    if (!target) return;
    state.direction = target.direction;
    state.lightX = target.lightX;
    state.lightY = target.lightY;
    const amount = drag?.wrapper === wrapper ? GRAB_PEEL : PEEL;
    if (anim && anim.to === amount) { drawOnce(); return; }
    if (Math.abs(state.peel - amount) < .001) { drawOnce(); return; }
    rampTo(amount, HOVER_TRACK);
  }

  function rampTo(target, duration) {
    if (!state.active || !renderer) return;
    if (Math.abs(state.peel - target) < .001 && !anim) {
      state.peel = target;
      drawOnce();
      if (target === 0) finalizeNow();
      return;
    }
    anim = { from: state.peel, to: target, start: performance.now(), duration };
    if (!rafId) rafId = requestAnimationFrame(step);
  }

  function step(now) {
    rafId = 0;
    if (!anim || !state.active) return;
    const t = anim.duration <= 0 ? 1 : Math.min(1, (now - anim.start) / anim.duration);
    const eased = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    state.peel = anim.from + (anim.to - anim.from) * eased;
    drawOnce();
    if (t < 1) { rafId = requestAnimationFrame(step); return; }
    const done = anim.to;
    anim = null;
    if (done === 0) finalizeNow();
  }

  function settleDown() {
    if (!state.active) return;
    if (drag && drag.wrapper === state.wrapper) return;
    if (reduced.matches) { finalizeNow(); return; }
    rampTo(0, SETTLE);
  }

  function setOffset(wrapper, x, y) {
    const px = Math.round(x * 100) / 100;
    const py = Math.round(y * 100) / 100;
    offsets.set(wrapper, { x: px, y: py });
    wrapper.style.setProperty('--drag-x', `${px}px`);
    wrapper.style.setProperty('--drag-y', `${py}px`);
    wrapper.classList.toggle('is-displaced', px !== 0 || py !== 0);
  }

  function measureBounds(wrapper, x, y) {
    const board = collage.getBoundingClientRect();
    const rect = wrapper.getBoundingClientRect();
    return {
      minX: x + (board.left - rect.left),
      maxX: x + (board.right - rect.right),
      minY: y + (board.top - rect.top),
      maxY: y + (board.bottom - rect.bottom),
    };
  }

  function clampRange(value, min, max) {
    if (min > max) return (min + max) / 2;
    return Math.min(max, Math.max(min, value));
  }

  function onPointerEnter(event) {
    if (!fineHover.matches || reduced.matches) return;
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    hoverPoint = { x: event.clientX, y: event.clientY };
    activate(event.currentTarget, hoverPoint);
  }

  function onPointerMove(event) {
    if (drag && drag.id === event.pointerId) { dragMove(event); return; }
    if (!fineHover.matches || reduced.matches) return;
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const wrapper = event.currentTarget;
    hoverPoint = { x: event.clientX, y: event.clientY };
    if (state.active && state.wrapper === wrapper) { updatePreview(wrapper, hoverPoint); return; }
    if (drag || pendingWrapper === wrapper) return;
    activate(wrapper, hoverPoint);
  }

  function onPointerLeave(event) {
    const wrapper = event.currentTarget;
    if (drag && drag.wrapper === wrapper) return;
    if (pendingWrapper === wrapper && !(state.active && state.wrapper === wrapper)) {
      pendingWrapper = null;
      activation++;
      hideCanvas();
      return;
    }
    if (state.active && state.wrapper === wrapper) settleDown();
  }

  function dragMove(event) {
    const current = drag;
    if (!current) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.moved = true;
      current.wrapper.classList.add('is-dragging');
      current.bounds = measureBounds(current.wrapper, current.baseX, current.baseY);
    }
    const x = clampRange(current.baseX + dx, current.bounds.minX, current.bounds.maxX);
    const y = clampRange(current.baseY + dy, current.bounds.minY, current.bounds.maxY);
    setOffset(current.wrapper, x, y);
    if (state.active && state.wrapper === current.wrapper) {
      updatePreview(current.wrapper, { x: event.clientX, y: event.clientY });
    }
  }

  function onPointerDown(event) {
    if (drag || event.isPrimary === false) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const wrapper = event.currentTarget;
    try { wrapper.setPointerCapture(event.pointerId); } catch {}
    suppressClick = false;
    suppressUntil = 0;
    const offset = offsets.get(wrapper) || { x: 0, y: 0 };
    drag = {
      wrapper,
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
      moved: false,
      bounds: null,
    };
    activate(wrapper, { x: event.clientX, y: event.clientY }, true);
  }

  function finishDrag() {
    const current = drag;
    drag = null;
    current.wrapper.classList.remove('is-dragging');
    return current;
  }

  function abortDrag() {
    if (!drag) return;
    const current = finishDrag();
    setOffset(current.wrapper, current.baseX, current.baseY);
    try { current.wrapper.releasePointerCapture(current.id); } catch {}
    settleDown();
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const current = finishDrag();
    lastPointerUpAt = performance.now();
    if (current.moved) {
      suppressClick = true;
      suppressUntil = lastPointerUpAt + 700;
    }
    try { current.wrapper.releasePointerCapture(event.pointerId); } catch {}
    settleDown();
  }

  function onPointerCancel(event) {
    if (drag && event.pointerId === drag.id) abortDrag();
  }

  function onLostCapture(event) {
    if (drag && event.pointerId === drag.id) abortDrag();
  }

  function nudge(wrapper, dx, dy) {
    const offset = offsets.get(wrapper) || { x: 0, y: 0 };
    const bounds = measureBounds(wrapper, offset.x, offset.y);
    setOffset(
      wrapper,
      clampRange(offset.x + dx, bounds.minX, bounds.maxX),
      clampRange(offset.y + dy, bounds.minY, bounds.maxY),
    );
  }

  function resetPosition(wrapper) {
    setOffset(wrapper, 0, 0);
    if (state.active && state.wrapper === wrapper) settleDown();
  }

  function onKeyDown(event) {
    const wrapper = event.currentTarget;
    if (event.target !== wrapper) return;
    if (event.key === 'Enter') { resetPosition(wrapper); return; }
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -KEY_STEP;
    else if (event.key === 'ArrowRight') dx = KEY_STEP;
    else if (event.key === 'ArrowUp') dy = -KEY_STEP;
    else if (event.key === 'ArrowDown') dy = KEY_STEP;
    else return;
    event.preventDefault();
    nudge(wrapper, dx, dy);
  }

  function onClick(event) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // A pointer click is only rejected while a preceding drag is still cooling
    // down; keyboard activation (detail 0) must always reset the sticker.
    if (event.detail > 0 && performance.now() < suppressUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Keyboard or assistive activation (no pointer detail) resets the sticker.
    if (event.detail === 0 && performance.now() - lastPointerUpAt > 700) {
      resetPosition(event.currentTarget);
    }
  }

  function onResize() {
    geom = new WeakMap();
    if (drag) abortDrag();
    finalizeNow();
    for (const wrapper of stickers) {
      const offset = offsets.get(wrapper);
      if (!offset || (!offset.x && !offset.y)) continue;
      const bounds = measureBounds(wrapper, offset.x, offset.y);
      setOffset(
        wrapper,
        clampRange(offset.x, bounds.minX, bounds.maxX),
        clampRange(offset.y, bounds.minY, bounds.maxY),
      );
    }
  }

  function onReducedChange() {
    geom = new WeakMap();
    if (reduced.matches) finalizeNow();
  }

  function onHoverMediaChange() {
    if (!fineHover.matches) finalizeNow();
  }

  function teardown() {
    lifecycle++;
    activation++;
    pendingWrapper = null;
    hoverPoint = null;
    drag = null;
    suppressClick = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    anim = null;
    for (const wrapper of stickers) wrapper.classList.remove('is-peeling', 'is-dragging');
    state = inactiveState();
    hideCanvas();
    if (renderer) { try { renderer.destroy(); } catch {} renderer = null; }
    rendererPromise = null;
    if (canvas) { canvas.remove(); canvas = null; }
  }

  function onPageShow(event) {
    if (!event.persisted) return;
    geom = new WeakMap();
    reveal();
  }

  for (const wrapper of stickers) {
    wrapper.addEventListener('pointerenter', onPointerEnter);
    wrapper.addEventListener('pointermove', onPointerMove);
    wrapper.addEventListener('pointerleave', onPointerLeave);
    wrapper.addEventListener('pointerdown', onPointerDown);
    wrapper.addEventListener('pointerup', onPointerUp);
    wrapper.addEventListener('pointercancel', onPointerCancel);
    wrapper.addEventListener('lostpointercapture', onLostCapture);
    wrapper.addEventListener('keydown', onKeyDown);
    wrapper.addEventListener('click', onClick);
    wrapper.addEventListener('dragstart', event => event.preventDefault());
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) abortDrag();
  });
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', teardown);
  window.addEventListener('pageshow', onPageShow);
  reduced.addEventListener('change', onReducedChange);
  fineHover.addEventListener('change', onHoverMediaChange);
})();
