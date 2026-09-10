import { fitView } from './geometry.js';

// Color-difference matting is performed at load time. The generated source atlas
// is kept intact, including its chroma backing, so art can always be replaced.
export function removeChroma(data, key = [18, 240, 14]) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const spill = Math.max(0, g - Math.max(r, b));
    if (spill < 12) continue;
    let a = Math.max(0, Math.min(1, 1 - spill / (key[1] - Math.max(key[0], key[2]))));
    if (a < .085) a = 0;
    if (a > .94) continue;
    data[i + 3] = Math.round(data[i + 3] * a);
    if (a > 0) {
      data[i] = Math.min(255, Math.max(0, Math.round((r - key[0] * (1 - a)) / a)));
      data[i + 1] = Math.min(255, Math.max(0, Math.round((g - key[1] * (1 - a)) / a)));
      data[i + 2] = Math.min(255, Math.max(0, Math.round((b - key[2] * (1 - a)) / a)));
    } else data[i] = data[i + 1] = data[i + 2] = 0;
  }
  return data;
}

export function prepareTexture(image, spec, makeCanvas) {
  if (!spec.chroma && !spec.crop && !spec.clearRects?.length && !spec.clearPolygons?.length) return image;
  const [x, y, width, height] = spec.crop || [0, 0, image.width, image.height];
  const surface = makeCanvas(width, height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  if (spec.chroma) {
    const pixels = context.getImageData(0, 0, width, height);
    removeChroma(pixels.data, spec.chroma);
    context.putImageData(pixels, 0, 0);
  }
  // Atlas-space exclusions remove neighboring islands, never the selected art.
  for (const [rx, ry, rw, rh] of spec.clearRects || []) context.clearRect(rx - x, ry - y, rw, rh);
  // Hidden attachment openings can be masked without repainting the source.
  for (const polygon of spec.clearPolygons || []) {
    context.save(); context.globalCompositeOperation = 'destination-out'; context.beginPath();
    polygon.forEach(([px, py], i) => { if (i) context.lineTo(px - x, py - y); else context.moveTo(px - x, py - y); });
    context.closePath(); context.fill(); context.restore();
  }
  return surface;
}

export async function loadTextures(rig, baseURL) {
  const sources = new Map();
  const entries = await Promise.all(Object.entries(rig.textures).map(async ([id, spec]) => {
    if (!sources.has(spec.src)) sources.set(spec.src, (async () => {
      const image = new Image(); image.src = new URL(spec.src, baseURL).href;
      await image.decode(); return image;
    })());
    const image = await sources.get(spec.src);
    return [id, prepareTexture(image, spec, (w, h) => {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; return canvas;
    })];
  }));
  return Object.fromEntries(entries);
}

function clipCoordinates(clip, x, y) {
  if (!clip) return [0, 0];
  const [a, b] = clip.axisX, [c, d] = clip.axisY;
  const determinant = a * d - b * c;
  x -= clip.center[0]; y -= clip.center[1];
  return [(d * x - c * y) / determinant, (-b * x + a * y) / determinant];
}

const VERTEX = `
attribute vec2 a_position;
attribute vec2 a_uv;
attribute vec2 a_clip;
uniform vec2 u_resolution;
varying vec2 v_uv;
varying vec2 v_clip;
void main() {
  gl_Position = vec4(a_position / u_resolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_uv = a_uv; v_clip = a_clip;
}`;
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform float u_clipped;
varying vec2 v_uv;
varying vec2 v_clip;
void main() {
  float mask = u_clipped > 0.5 ? 1.0 - smoothstep(0.92, 1.0, dot(v_clip, v_clip)) : 1.0;
  vec4 color = texture2D(u_texture, v_uv);
  float alpha = color.a * u_opacity * mask;
  gl_FragColor = vec4(color.rgb * alpha, alpha);
}`;

export class WebGLRenderer {
  constructor(canvas, textures) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) throw new Error('WebGL unavailable');
    this.canvas = canvas; this.gl = gl; this.kind = 'WebGL';
    const shader = (type, source) => {
      const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
      return value;
    };
    const program = gl.createProgram();
    const vertex = shader(gl.VERTEX_SHADER, VERTEX), fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    this.program = program;
    this.attributes = ['a_position', 'a_uv', 'a_clip'].map(name => gl.getAttribLocation(program, name));
    this.uniforms = Object.fromEntries(['u_resolution', 'u_opacity', 'u_clipped', 'u_texture'].map(name => [name, gl.getUniformLocation(program, name)]));
    this.buffer = gl.createBuffer(); this.indexBuffer = gl.createBuffer();
    this.textures = {};
    for (const [id, image] of Object.entries(textures)) {
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures[id] = { texture, width: image.width, height: image.height };
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  render(scene, rig, { explode = 0, framing = 'full' } = {}) {
    const gl = this.gl, canvas = this.canvas;
    const view = fitView(canvas.width, canvas.height, rig, explode, framing);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.u_resolution, canvas.width, canvas.height);
    gl.uniform1i(this.uniforms.u_texture, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    for (let n = 0; n < this.attributes.length; n++) {
      gl.enableVertexAttribArray(this.attributes[n]);
      gl.vertexAttribPointer(this.attributes[n], 2, gl.FLOAT, false, 24, n * 8);
    }
    for (const item of scene) {
      if (item.opacity < .001) continue;
      const texture = this.textures[item.part.texture];
      const data = new Float32Array(item.positions.length * 3);
      for (let i = 0; i < item.positions.length / 2; i++) {
        const x = item.positions[i * 2], y = item.positions[i * 2 + 1];
        data.set([x * view.scale + view.x, y * view.scale + view.y,
          item.texcoords[i * 2] / texture.width, item.texcoords[i * 2 + 1] / texture.height,
          ...clipCoordinates(item.clip, x, y)], i * 6);
      }
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(item.indices), gl.DYNAMIC_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      gl.uniform1f(this.uniforms.u_opacity, item.opacity);
      gl.uniform1f(this.uniforms.u_clipped, item.clip ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, item.indices.length, gl.UNSIGNED_SHORT, 0);
    }
  }
  dispose() {
    const gl = this.gl;
    for (const value of Object.values(this.textures)) gl.deleteTexture(value.texture);
    gl.deleteBuffer(this.buffer); gl.deleteBuffer(this.indexBuffer); gl.deleteProgram(this.program);
  }
}

// A dependency-free Canvas fallback and deterministic offline reference renderer.
export class CanvasRenderer {
  constructor(canvas, textures) {
    this.canvas = canvas; this.context = canvas.getContext('2d'); this.textures = textures; this.kind = 'Canvas 2D';
  }
  render(scene, rig, { explode = 0, framing = 'full' } = {}) {
    const ctx = this.context, canvas = this.canvas;
    const view = fitView(canvas.width, canvas.height, rig, explode, framing);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
    for (const item of scene) {
      if (item.opacity < .001) continue;
      ctx.save(); ctx.globalAlpha = item.opacity;
      if (item.clip) {
        const { center, axisX, axisY } = item.clip;
        ctx.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = i / 48 * Math.PI * 2;
          const x = center[0] + axisX[0] * Math.cos(a) + axisY[0] * Math.sin(a);
          const y = center[1] + axisX[1] * Math.cos(a) + axisY[1] * Math.sin(a);
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.clip();
      }
      for (let i = 0; i < item.indices.length; i += 3) {
        const ids = item.indices.slice(i, i + 3);
        const src = ids.map(n => item.texcoords.slice(n * 2, n * 2 + 2));
        const dst = ids.map(n => item.positions.slice(n * 2, n * 2 + 2));
        const [s0, s1, s2] = src, [d0, d1, d2] = dst;
        const su = s1[0] - s0[0], sv = s1[1] - s0[1], tu = s2[0] - s0[0], tv = s2[1] - s0[1];
        const determinant = su * tv - sv * tu;
        if (Math.abs(determinant) < 1e-8) continue;
        const dx = d1[0] - d0[0], dy = d1[1] - d0[1], ex = d2[0] - d0[0], ey = d2[1] - d0[1];
        const a = (dx * tv - ex * sv) / determinant, b = (dy * tv - ey * sv) / determinant;
        const c = (ex * su - dx * tu) / determinant, d = (ey * su - dy * tu) / determinant;
        ctx.save(); ctx.beginPath();
        // Slightly overlap triangle clips to avoid subpixel cracks in Canvas.
        const mx = (d0[0] + d1[0] + d2[0]) / 3, my = (d0[1] + d1[1] + d2[1]) / 3;
        dst.forEach(([x, y], j) => {
          const length = Math.hypot(x - mx, y - my) || 1;
          const ex = x + (x - mx) / length * 1.2 / view.scale;
          const ey = y + (y - my) / length * 1.2 / view.scale;
          if (!j) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
        });
        ctx.closePath(); ctx.clip();
        ctx.transform(a, b, c, d, d0[0] - a * s0[0] - c * s0[1], d0[1] - b * s0[0] - d * s0[1]);
        ctx.drawImage(this.textures[item.part.texture], 0, 0); ctx.restore();
      }
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  dispose() {}
}

export function drawMesh(canvas, scene, rig, { explode = 0, selected = '', framing = 'full' } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const view = fitView(canvas.width, canvas.height, rig, explode, framing);
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);
  for (const item of scene) {
    if (item.opacity < .1 || (selected && item.part.id !== selected)) continue;
    ctx.strokeStyle = selected ? '#ffcc97' : '#45cbbc88'; ctx.lineWidth = .7 / view.scale;
    ctx.beginPath();
    for (let i = 0; i < item.indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const index = item.indices[i + j] * 2;
        if (!j) ctx.moveTo(item.positions[index], item.positions[index + 1]);
        else ctx.lineTo(item.positions[index], item.positions[index + 1]);
      }
      ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.restore();
}
