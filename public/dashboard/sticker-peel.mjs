/**
 * sticker-peel.mjs — WebGL2 "sticker peel" renderer.
 *
 * A trimmed port of the ReactBits <StickerPeel /> cylindrical mesh shader
 * (https://github.com/DavidHDev/react-bits, MIT + Commons Clause, see
 * sticker-peel-LICENSE.txt next to this file). The port keeps the physical
 * part only — a rolled cylinder of paper rendered as a displaced mesh, a matte
 * paper backside with lighting, and the artwork's own alpha silhouette — and
 * drops the React lifecycle, spring physics, pointer tracking, shadow passes
 * and the gloss/holo foil finishes.
 *
 * API
 *   const renderer = createPeelRenderer(canvas);
 *   if (renderer) {
 *     renderer.setImage(decodedImage);        // -> boolean, uploads texture once
 *     renderer.draw({ peel, direction, lightX, lightY });
 *     renderer.clear();                       // blank the canvas mid-drag
 *     renderer.destroy();
 *   }
 *
 *   peel       0..0.45  0 = perfectly flat, 0.45 = deepest approved peel
 *   direction  radians  local-space angle toward the grabbed edge
 *                       (0 = +x/right, PI/2 = +y/down); that side curls inward
 *   lightX/Y   optional normalized 0..1 canvas coordinates of the highlight
 *
 * Canvas contract: the element is ONE logical 512x512 square whose artwork sits
 * at the same position/size as the source <img>. CSS scales the element to the
 * sticker button; nothing here reads display size or applies rotation/scale —
 * the coordinator's transform (`rotate(...) scale(...)`) is applied outside.
 *
 * Returns null when WebGL2 is unavailable or the shaders fail to compile, so
 * callers can keep the static <img>. `renderer.onLost` / `renderer.onRestored`
 * are assignable callbacks; after a restore the caller should call setImage()
 * again (the last image is re-uploaded automatically, this is only a hint).
 */

const SIZE = 512; // logical square, matches the source PNG/WebP canvas
const GRID = 64; // mesh cells per axis (65x65 vertices, ample at 170px display)
const MASK = 96; // alpha probe resolution for bounds + hull
const MAX_PEEL = 0.45;
const BACK = [0.906, 0.894, 0.871]; // warm unprinted paper
const DEFAULT_LIGHT = [0.34, 0.24];
const DRAW_DEFAULTS = Object.freeze({ peel: 0, direction: 0 });

const VERTEX = `#version 300 es
in vec2 aGrid;
uniform vec2 uCanvas;
uniform vec2 uMesh;
uniform vec2 uOffset;
uniform vec4 uUvRect;
uniform vec2 uDir;
uniform float uFold;
uniform float uRadius;

out vec2 vUv;
out vec3 vNormal;
out vec3 vPos;

const float PI = 3.14159265358979;

void main() {
  vec2 local = (aGrid - 0.5) * uMesh;
  float s = dot(local, uDir);
  float d = uFold - s;
  vec3 normal = vec3(0.0, 0.0, 1.0);
  float h = 0.0;
  vec2 p = local;
  if (d > 0.0) {
    float theta = d / uRadius;
    float along = uFold + d - PI * uRadius;
    h = 2.0 * uRadius;
    normal = vec3(0.0, 0.0, -1.0);
    if (theta < PI) {
      along = uFold - uRadius * sin(theta);
      h = uRadius * (1.0 - cos(theta));
      normal = vec3(uDir * sin(theta), cos(theta));
    }
    p += (along - s) * uDir;
  }
  vec2 world = p + uOffset;
  vUv = mix(uUvRect.xy, uUvRect.zw, aGrid);
  vNormal = normal;
  vPos = vec3(world, h);
  gl_Position = vec4(
    world.x / uCanvas.x * 2.0 - 1.0,
    1.0 - world.y / uCanvas.y * 2.0,
    clamp(-h * 0.004, -1.0, 1.0),
    1.0
  );
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uImage;
uniform vec3 uBack;
uniform vec3 uLight;
uniform float uShine;

in vec2 vUv;
in vec3 vNormal;
in vec3 vPos;

out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec4 art = texture(uImage, vUv); // premultiplied
  if (art.a < 0.004) discard;

  vec3 nf = normalize(vNormal);
  bool front = nf.z >= 0.0;
  vec3 n = front ? nf : -nf;
  vec3 L = normalize(uLight - vPos);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float ndl = max(dot(n, L), 0.0);
  float ndh = max(dot(n, H), 0.0);
  float bend = clamp(1.0 - n.z, 0.0, 1.0);

  if (front) {
    // Flat areas stay pixel-identical to the source art; only curvature dims
    // and the fold line catches a little sheen.
    float shade = 1.0 - 0.16 * bend;
    vec3 albedo = art.rgb / max(art.a, 0.05);
    vec3 color = albedo * shade + vec3(pow(ndh, 42.0) * 0.10 * bend * uShine);
    outColor = vec4(min(color * art.a, vec3(art.a)), art.a);
  } else {
    // Unprinted paper back: matte, slightly grained, cloud top lit by the key.
    float grain = hash(floor(vUv * 640.0)) * 0.05 - 0.025;
    vec3 paper = uBack * (0.64 + 0.30 * ndl);
    vec3 color = paper + vec3(grain) + vec3(pow(ndh, 20.0) * 0.07 * uShine);
    outColor = vec4(min(color * art.a, vec3(art.a)), art.a);
  }
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function link(gl, vs, fs) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vs);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, 'aGrid');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Andrew monotone chain over [x, y] pairs; returns the hull in input order. */
function convexHull(points) {
  if (points.length < 3) return points;
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function createPeelRenderer(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;

  // One logical square, backed at device resolution (capped at 2x).
  try {
    const dpr = Math.min(2, (canvas.ownerDocument && canvas.ownerDocument.defaultView
      ? canvas.ownerDocument.defaultView.devicePixelRatio
      : 1) || 1);
    const backing = Math.round(SIZE * dpr);
    if (canvas.width !== backing) canvas.width = backing;
    if (canvas.height !== backing) canvas.height = backing;
    if (canvas.width !== backing || canvas.height !== backing) return null;
  } catch (error) {
    return null;
  }

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power'
    });
  } catch (error) {
    gl = null;
  }
  if (!gl) return null;

  const count = GRID * GRID * 6;
  const uniforms = {
    canvas: null, mesh: null, offset: null, uvRect: null, dir: null,
    fold: null, radius: null, image: null, back: null, light: null, shine: null
  };
  let program = null;
  let vao = null;
  let gridBuffer = null;
  let indexBuffer = null;
  let texture = null;

  // Artwork-local layout, filled by setImage().
  let meshW = SIZE;
  let meshH = SIZE;
  let offX = SIZE / 2;
  let offY = SIZE / 2;
  let uvRect = new Float32Array([0, 0, 1, 1]);
  let hullX = null;
  let hullY = null;
  let hullCount = 0;
  let ready = false;
  let lost = false;
  let lastImage = null;
  let scratch = null;
  let scratchCtx = null;

  const renderer = {
    onLost: null,
    onRestored: null,
    setImage,
    draw,
    clear,
    destroy
  };

  function initGL() {
    const linked = link(gl, VERTEX, FRAGMENT);
    if (!linked) return false;
    gl.useProgram(linked);
    uniforms.image = gl.getUniformLocation(linked, 'uImage');
    uniforms.canvas = gl.getUniformLocation(linked, 'uCanvas');
    uniforms.mesh = gl.getUniformLocation(linked, 'uMesh');
    uniforms.offset = gl.getUniformLocation(linked, 'uOffset');
    uniforms.uvRect = gl.getUniformLocation(linked, 'uUvRect');
    uniforms.dir = gl.getUniformLocation(linked, 'uDir');
    uniforms.fold = gl.getUniformLocation(linked, 'uFold');
    uniforms.radius = gl.getUniformLocation(linked, 'uRadius');
    uniforms.back = gl.getUniformLocation(linked, 'uBack');
    uniforms.light = gl.getUniformLocation(linked, 'uLight');
    uniforms.shine = gl.getUniformLocation(linked, 'uShine');

    const vertices = new Float32Array((GRID + 1) * (GRID + 1) * 2);
    for (let y = 0; y <= GRID; y++) {
      for (let x = 0; x <= GRID; x++) {
        const i = (y * (GRID + 1) + x) * 2;
        vertices[i] = x / GRID;
        vertices[i + 1] = y / GRID;
      }
    }
    const indices = new Uint16Array(count);
    let cursor = 0;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const a = y * (GRID + 1) + x;
        const b = a + 1;
        const c = a + GRID + 1;
        const d = c + 1;
        indices[cursor++] = a;
        indices[cursor++] = b;
        indices[cursor++] = d;
        indices[cursor++] = a;
        indices[cursor++] = d;
        indices[cursor++] = c;
      }
    }

    vao = gl.createVertexArray();
    if (!vao) return false;
    gl.bindVertexArray(vao);
    gridBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    program = linked;
    return true;
  }

  /**
   * Alpha silhouette of the artwork: opaque bounding box (mesh + uv sub-rect)
   * plus a convex hull of boundary pixels used for the fold extents, so narrow
   * stickers (PS5, cartridge) curl from their real edge instead of the square.
   */
  function measure(image, iw, ih) {
    meshW = SIZE;
    meshH = SIZE;
    offX = SIZE / 2;
    offY = SIZE / 2;
    uvRect[0] = 0;
    uvRect[1] = 0;
    uvRect[2] = 1;
    uvRect[3] = 1;
    hullX = null;
    hullY = null;
    hullCount = 0;

    try {
      const doc = canvas.ownerDocument || document;
      if (!scratch) scratch = doc.createElement('canvas');
      if (!scratchCtx) {
        scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
      }
      if (!scratchCtx) return;
      const mw = Math.max(8, Math.min(MASK, Math.round((iw / ih) * MASK)));
      const mh = Math.max(8, Math.min(MASK, Math.round((ih / iw) * MASK)));
      scratch.width = mw;
      scratch.height = mh;
      scratchCtx.clearRect(0, 0, mw, mh);
      scratchCtx.drawImage(image, 0, 0, mw, mh);
      const pixels = scratchCtx.getImageData(0, 0, mw, mh).data;

      let minX = mw;
      let minY = mh;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < mh; y++) {
        const row = y * mw;
        for (let x = 0; x < mw; x++) {
          if (pixels[(row + x) * 4 + 3] > 12) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) {
        // Fully transparent upload: fall back to the full square.
        uvRect[0] = 0;
        uvRect[1] = 0;
        uvRect[2] = 1;
        uvRect[3] = 1;
        return;
      }

      const cellX = SIZE / mw;
      const cellY = SIZE / mh;
      const x0 = minX * cellX;
      const x1 = (maxX + 1) * cellX;
      const y0 = minY * cellY;
      const y1 = (maxY + 1) * cellY;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      meshW = Math.min(SIZE, x1 - x0);
      meshH = Math.min(SIZE, y1 - y0);
      offX = cx;
      offY = cy;
      uvRect[0] = x0 / SIZE;
      uvRect[1] = y0 / SIZE;
      uvRect[2] = x1 / SIZE;
      uvRect[3] = y1 / SIZE;

      // Boundary samples only: the hull of an opaque silhouette is tiny.
      const points = [];
      const alpha = (x, y) => pixels[((y * mw) + x) * 4 + 3];
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          if (alpha(x, y) <= 127) continue;
          const edge =
            x === 0 || y === 0 || x === mw - 1 || y === mh - 1 ||
            alpha(x - 1, y) <= 127 || alpha(x + 1, y) <= 127 ||
            alpha(x, y - 1) <= 127 || alpha(x, y + 1) <= 127;
          if (edge) {
            points.push([(x + 0.5) * cellX - cx, (y + 0.5) * cellY - cy]);
          }
        }
      }
      const hull = points.length >= 3
        ? convexHull(points)
        : [
            [x0 - cx, y0 - cy],
            [x1 - cx, y0 - cy],
            [x1 - cx, y1 - cy],
            [x0 - cx, y1 - cy]
          ];
      hullX = new Float32Array(hull.length);
      hullY = new Float32Array(hull.length);
      for (let i = 0; i < hull.length; i++) {
        hullX[i] = hull[i][0];
        hullY[i] = hull[i][1];
      }
      hullCount = hull.length;
    } catch (error) {
      // Tainted canvas or a hostile decoder: keep the full-square fallback
      // already assigned above; the peel still works, just on the full box.
      hullX = null;
      hullY = null;
      hullCount = 0;
    }
  }

  function setImage(image) {
    if (!image || lost) return false;
    const iw = image.naturalWidth || image.width || 0;
    const ih = image.naturalHeight || image.height || 0;
    if (!iw || !ih) return false;
    if (!program && !initGL()) return false;

    try {
      gl.useProgram(program);
      if (!texture) {
        texture = gl.createTexture();
        if (!texture) return false;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (let drain = 0; drain < 8 && gl.getError() !== gl.NO_ERROR; drain++) {
        // drop errors left over from earlier frames before judging this upload
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (gl.getError() !== gl.NO_ERROR) return false;
    } catch (error) {
      return false;
    }

    lastImage = image;
    measure(image, iw, ih);
    ready = true;
    return true;
  }

  // Per-frame scratch: extents are written here so draw() stays allocation-free.
  let extentLo = 0;
  let extentHi = 0;

  function extents(nx, ny) {
    if (!hullCount) {
      const half = (Math.abs(nx) * meshW + Math.abs(ny) * meshH) / 2;
      extentLo = -half;
      extentHi = half;
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < hullCount; i++) {
      const value = hullX[i] * nx + hullY[i] * ny;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    extentLo = min;
    extentHi = max;
  }

  function clear() {
    if (!gl || lost) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function draw(params) {
    if (!gl || lost) return;
    const p = params || DRAW_DEFAULTS;
    clear();
    if (!ready || !program || !vao) return;

    let peel = Number(p.peel);
    if (!(peel > 0)) peel = 0;
    else if (peel > MAX_PEEL) peel = MAX_PEEL;
    let angle = Number(p.direction);
    if (!isFinite(angle)) angle = 0;

    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    // The shader folds where dot(local, uDir) < uFold, so point uDir at the
    // grabbed edge's opposite: the sheet then rolls from that edge inward.
    const ux = -nx;
    const uy = -ny;
    extents(ux, uy);
    const span = extentHi - extentLo;
    const radius = span > 4 ? Math.max(7, Math.min(34, span * 0.075)) : 1;

    let lightX = p.lightX == null ? DEFAULT_LIGHT[0] : Number(p.lightX);
    if (!isFinite(lightX)) lightX = DEFAULT_LIGHT[0];
    else lightX = lightX < 0 ? 0 : lightX > 1 ? 1 : lightX;
    let lightY = p.lightY == null ? DEFAULT_LIGHT[1] : Number(p.lightY);
    if (!isFinite(lightY)) lightY = DEFAULT_LIGHT[1];
    else lightY = lightY < 0 ? 0 : lightY > 1 ? 1 : lightY;

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.image, 0);
    gl.uniform2f(uniforms.canvas, SIZE, SIZE);
    gl.uniform2f(uniforms.mesh, meshW, meshH);
    gl.uniform2f(uniforms.offset, offX, offY);
    gl.uniform4f(uniforms.uvRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    gl.uniform2f(uniforms.dir, ux, uy);
    gl.uniform1f(uniforms.fold, extentLo + peel * span);
    gl.uniform1f(uniforms.radius, radius);
    gl.uniform3f(uniforms.back, BACK[0], BACK[1], BACK[2]);
    gl.uniform3f(uniforms.light, lightX * SIZE, lightY * SIZE, 300);
    gl.uniform1f(uniforms.shine, 0.55);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  function contextLost(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    lost = true;
    ready = false;
    program = null;
    vao = null;
    gridBuffer = null;
    indexBuffer = null;
    texture = null;
    if (typeof renderer.onLost === 'function') {
      try {
        renderer.onLost();
      } catch (error) {
        /* a listener must not break the fallback */
      }
    }
  }

  function contextRestored() {
    lost = false;
    if (!initGL()) {
      if (typeof renderer.onLost === 'function') renderer.onLost();
      return;
    }
    if (lastImage) {
      const image = lastImage;
      lastImage = null;
      setImage(image);
    }
    if (typeof renderer.onRestored === 'function') {
      try {
        renderer.onRestored(ready);
      } catch (error) {
        /* ignore */
      }
    }
  }

  function destroy() {
    if (gl) {
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      if (texture) gl.deleteTexture(texture);
      if (gridBuffer) gl.deleteBuffer(gridBuffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
    }
    texture = null;
    gridBuffer = null;
    indexBuffer = null;
    vao = null;
    program = null;
    ready = false;
    lost = true;
    lastImage = null;
    scratch = null;
    scratchCtx = null;
    hullX = null;
    hullY = null;
    hullCount = 0;
    gl = null;
  }

  if (!initGL()) {
    destroy();
    return null;
  }

  canvas.addEventListener('webglcontextlost', contextLost, false);
  canvas.addEventListener('webglcontextrestored', contextRestored, false);

  clear();

  return renderer;
}

export default createPeelRenderer;
