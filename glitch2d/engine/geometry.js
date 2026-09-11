import { clamp } from './motion.js';

export const identity = () => [1, 0, 0, 1, 0, 0];
export function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export const point = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
export function around([x, y], angle = 0, sx = 1, sy = 1, tx = 0, ty = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c*sx, s*sx, -s*sy, c*sy, x-c*sx*x+s*sy*y+tx, y-s*sx*x-c*sy*y+ty];
}


function nodeTransform(node, pose) {
  let angle = node.restAngle || 0, sx = 1, sy = 1, tx = 0, ty = 0;
  if (node.drive === 'body') {
    angle += pose.headZ * .006;
    sy = 1 + pose.breath * .003;
    ty = -pose.breath * .5;
  }
  if (node.drive === 'waist') {
    // Live2D's guide puts it as: the tilt of the body should be transformed
    // into an arc rather than translating sideways, and the feet must not
    // leave the ground. Pivoting at the waist is that arc — the torso, arms
    // and head turn as one piece and the legs stay planted. Shearing the torso
    // instead was tried and read as the hips and the neck twisting.
    angle += (pose.lean || 0) * .027;
  }
  if (node.drive === 'head') {
    // headZ is the idle and cursor-follow drive and stays subtle on purpose.
    // tilt is the gesture drive, an order of magnitude larger, and is zero
    // unless something is deliberately moving the head.
    angle += pose.headZ * .075 + (pose.tilt || 0) * .13;
    sx = 1 - Math.abs(pose.headX) * .012;
    tx = pose.headX * 8 + (pose.tilt || 0) * 14;
    ty = pose.headY * 4;
  }
  if (node.drive === 'arm') angle += pose.arm * .07 * (node.side || 1);
  tx += node.offset?.[0] || 0; ty += node.offset?.[1] || 0;
  return around(node.pivot, angle, sx, sy, tx, ty);
}

// One affine face plane keeps skin, eyes, lips and eye apertures registered.
// The small shear suggests a turn without letting features slide independently.
export function facePoint(rig, pose, x, y) {
  const { center: [cx, cy] = [500, 410], yaw = 10, shear = .025 } = rig.facePlane || {};
  return [cx + (x - cx) * (1 - Math.abs(pose.headX) * .035) + pose.headX * (yaw - (y - cy) * shear),
    y + pose.headY * 2];
}

export function nodeMatrices(rig, pose) {
  const matrices = { root: identity() };
  const visiting = new Set();
  const byId = new Map(rig.nodes.map(node => [node.id, node]));
  function resolve(id) {
    if (matrices[id]) return matrices[id];
    if (visiting.has(id)) throw new Error(`Rig node cycle: ${id}`);
    const node = byId.get(id);
    if (!node) throw new Error(`Missing rig node: ${id}`);
    visiting.add(id);
    matrices[id] = multiply(resolve(node.parent || 'root'), nodeTransform(node, pose));
    visiting.delete(id);
    return matrices[id];
  }
  for (const node of rig.nodes) resolve(node.id);
  return matrices;
}

export function deformPoint(part, x, y, pose, rig, explode = 0) {
  const [rx, ry, w, h] = part.rect;
  const cx = rx + w / 2, cy = ry + h / 2;
  const type = part.type || 'sprite';
  if (part.attachment) {
    // Extend only the hidden root under the skirt. Fractions follow editor resizing.
    const { depth, extend } = part.attachment;
    y -= clamp(1 - (y - ry) / (h * depth), 0, 1) * h * extend;
  }
  if (part.hand) {
    // Refine the hand around its fixed wrist without shortening the sleeve.
    const anchor = [rx + w * part.hand.anchor[0], ry + h * part.hand.anchor[1]];
    const delta = [x - anchor[0], y - anchor[1]];
    const distance = delta[0] * part.hand.axis[0] + delta[1] * part.hand.axis[1];
    let blend = clamp(distance / (h * part.hand.transition), 0, 1);
    blend = blend * blend * (3 - 2 * blend);
    const angle = part.hand.angle + (pose.handAngle || 0) * (part.hand.wave || 0);
    const adjusted = point(around(anchor, angle, part.hand.scale, part.hand.scale), x, y);
    x += (adjusted[0] - x) * blend; y += (adjusted[1] - y) * blend;
  }
  if (part.bend && (pose.armRaise || pose.armFold || pose.armTuck)) {
    // ponytail: throwaway spike — two-bone bend over the existing joints, no
    // reweighting UI, no per-vertex weights stored. Child (elbow) first, then
    // the parent (shoulder), which is the order a deformer chain resolves in.
    const at = ([u, v]) => [rx + w * u, ry + h * v];
    const shoulder = at(part.joints.shoulder), elbow = at(part.joints.elbow);
    const axis = [elbow[0] - shoulder[0], elbow[1] - shoulder[1]];
    const span = axis[0] * axis[0] + axis[1] * axis[1];
    // s counts bone lengths from the shoulder: <1 upper arm, >1 forearm and hand.
    const s = ((x - shoulder[0]) * axis[0] + (y - shoulder[1]) * axis[1]) / span;
    const ramp = (a, b) => { const t = clamp((s - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    // Two drivers so the elbow can lag the shoulder and then swing on its own.
    const fold = pose.armFold ?? pose.armRaise, raise = pose.armRaise ?? pose.armFold;
    const fore = around(elbow, part.bend.elbow * fold * ramp(1 - part.bend.blend, 1 + part.bend.blend));
    [x, y] = point(fore, x, y);
    // Tuck pulls the upper arm toward vertical while the forearm sweeps past
    // horizontal, which keeps the hand inside the view on the way up and down.
    const swing = part.bend.shoulder * raise + (part.bend.tuck || 0) * (pose.armTuck || 0);
    const upper = around(shoulder, swing * ramp(-part.bend.blend, part.bend.blend));
    [x, y] = point(upper, x, y);
  }
  if (part.neck && Math.abs(x - part.neck.center) < 80 && y < part.neck.bottom) {
    const weight = clamp((part.neck.bottom - y) / (part.neck.bottom - part.neck.top), 0, 1);
    x = part.neck.center + (x - part.neck.center) * (1 - weight * part.neck.pinch);
    y -= weight * (part.neck.extend || 0);
    if (part.neck.follow) {
      const head = rig.nodes.find(node => node.drive === 'head');
      if (head) {
        const moved = point(nodeTransform(head, pose), ...facePoint(rig, pose, x, y));
        const rest = point(nodeTransform(head, { headX: 0, headY: 0, headZ: 0 }), x, y);
        const blend = weight * part.neck.follow * clamp((80 - Math.abs(x - part.neck.center)) / 25, 0, 1);
        x += (moved[0] - rest[0]) * blend; y += (moved[1] - rest[1]) * blend;
      }
    }
  }
  if (part.neck?.rest) {
    // Keep the small neck independent from the roomy hoodie scale. Blend into
    // the hidden hood lining and upper chest; the outer clothing stays fixed.
    const { top, bottom, inner, outer, pinch, drop, shrink = 0 } = part.neck.rest;
    let vertical = clamp((bottom - y) / (bottom - top), 0, 1);
    let horizontal = clamp((outer - Math.abs(x - part.neck.center)) / (outer - inner), 0, 1);
    vertical *= vertical * (3 - 2 * vertical);
    horizontal *= horizontal * (3 - 2 * horizontal);
    const weight = vertical * horizontal;
    x = part.neck.center + (x - part.neck.center) * (1 - pinch * weight);
    // Shrink pulls the neck column and its choker back toward head scale, which
    // also lowers the band and uncovers more throat.
    y = bottom - (bottom - y) * (1 - shrink * weight) + drop * weight;
  }
  if (part.jaw) {
    // Rounder chin: widen the lower face and let it fall a little further.
    const { top, bottom, widen = 0, drop = 0 } = part.jaw;
    let weight = clamp((y - top) / (bottom - top), 0, 1);
    weight *= weight * (3 - 2 * weight);
    x = cx + (x - cx) * (1 + widen * weight);
    y += drop * weight;
  }
  if (part.sway) {
    // Rooted at the top, free at the bottom: hair, and anything else that hangs.
    const weight = clamp((y - ry) / h, 0, 1);
    x += pose.hair * part.sway * weight * weight;
  }
  if (type === 'eye' || type === 'lash') {
    const apertureY = part.apertureY ?? cy;
    y = apertureY + (y - apertureY) * Math.max(.025, pose.eyeOpen);
  }
  if (type === 'iris') {
    x += pose.gazeX * (part.travel?.[0] ?? 9);
    y += pose.gazeY * (part.travel?.[1] ?? 5);
  }
  if (type === 'brow') {
    y -= pose.brow * 9;
    y += (x - cx) / w * pose.brow * 9 * (part.side || 1);
  }
  if (type === 'mouth') {
    y = cy + (y - cy) * (.15 + .85 * pose.mouthOpen);
    x = cx + (x - cx) * (1 + pose.mouthWide * .18);
  }
  if (type === 'lip') {
    y -= pose.smile * 3 * Math.pow((x - cx) / (w / 2), 2);
  }
  if (part.face) [x, y] = facePoint(rig, pose, x, y);
  const shift = part.explode || [0, 0];
  return [x + shift[0] * explode, y + shift[1] * explode];
}

export function partOpacity(part, pose) {
  if (part.visible === false) return 0;
  // A slot holds interchangeable art. Exactly one variant in a slot is visible,
  // picked by pose.slots; a slot nobody has chosen shows its 'default' variant.
  if (part.slot && (pose.slots?.[part.slot] ?? 'default') !== part.variant) return 0;
  if (part.type === 'mouth') return clamp(pose.mouthOpen / .12, 0, 1);
  if (part.type === 'lip') return 1 - clamp(pose.mouthOpen / .12, 0, 1);
  if (part.type === 'closed-eye') return 1 - clamp(pose.eyeOpen / .16, 0, 1);
  if (part.type === 'eye' || part.type === 'iris' || part.type === 'lash') return clamp(pose.eyeOpen / .09, 0, 1);
  if (part.type === 'blush') return clamp(pose.smile, 0, 1) * .4;
  return part.opacity ?? 1;
}

export function buildScene(rig, pose, { explode = 0, hidden = new Set() } = {}) {
  const matrices = nodeMatrices(rig, pose);
  const displayPose = { ...pose, eyeOpen: pose.eyeOpen + (1 - pose.eyeOpen) * explode, mouthOpen: pose.mouthOpen + (1 - pose.mouthOpen) * explode };
  return rig.parts.filter(part => !hidden.has(part.id)).map(part => {
    const baseOpacity = partOpacity(part, pose);
    const opacity = part.visible === false ? 0 : baseOpacity + (1 - baseOpacity) * explode;
    const parentMatrix = matrices[part.node || 'root'];
    if (!parentMatrix) throw new Error(`Missing node for ${part.id}`);
    const matrix = part.adjustment ? multiply(parentMatrix, part.adjustment) : parentMatrix;
    const [x, y, w, h] = part.rect;
    const [u, v, uw, vh] = part.uv;
    const columns = part.mesh?.[0] || 4, rows = part.mesh?.[1] || 6;
    const positions = [], texcoords = [], indices = [];
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) {
      const a = i / columns, b = j / rows;
      const local = deformPoint(part, x + w * a, y + h * b, displayPose, rig, explode);
      positions.push(...point(matrix, ...local));
      texcoords.push(u + uw * a, v + vh * b);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i, b = a + columns + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
    // Eye aperture shares the exact head/face transforms with the iris.
    let clip = null;
    if (part.clip) {
      const [ex, ey, ew, eh] = part.clip;
      const shift = part.explode || [0, 0];
      const project = (x, y) => {
        if (part.face) [x, y] = facePoint(rig, displayPose, x, y);
        return point(matrix, x + shift[0] * explode, y + shift[1] * explode);
      };
      const cx = ex + ew / 2, cy = ey + eh / 2;
      const center = project(cx, cy), edgeX = project(cx + ew / 2, cy);
      const edgeY = project(cx, cy + eh / 2 * Math.max(.01, displayPose.eyeOpen));
      clip = { center, axisX: edgeX.map((n, i) => n - center[i]), axisY: edgeY.map((n, i) => n - center[i]) };
    }
    return { part, positions, texcoords, indices, opacity, clip };
  });
}

export function fitView(width, height, rig, explode = 0, framing = 'full') {
  const [rx, ry, rw, rh] = rig.views?.[framing] || [0, 0, ...rig.size];
  const scale = Math.min(width / rw, height / rh) * (1 - explode * .22);
  return { scale, x: (width - rw * scale) / 2 - rx * scale, y: (height - rh * scale) / 2 - ry * scale };
}

export function editPartRect(part, index, value, lockAspect = true) {
  if (!Number.isFinite(value) || index < 0 || index > 3 || !Number.isInteger(index)) return;
  if (index > 1 && value <= 0) return;
  const before = [...part.rect];
  part.rect[index] = value;
  if (lockAspect && index > 1) {
    const other = index === 2 ? 3 : 2;
    part.rect[other] = before[other] * value / before[index];
  }
  if (part.lockAspect !== undefined && index > 1) part.lockAspect = lockAspect && Math.abs(part.rect[2] / part.rect[3] - part.uv[2] / part.uv[3]) < 1e-8;
  if (part.apertureY !== undefined) part.apertureY = part.rect[1] + (part.apertureY - before[1]) * part.rect[3] / before[3];
  if (part.clip) {
    const [x, y, w, h] = before, [nx, ny, nw, nh] = part.rect;
    part.clip = [nx + (part.clip[0] - x) * nw / w, ny + (part.clip[1] - y) * nh / h,
      part.clip[2] * nw / w, part.clip[3] * nh / h];
  }
}
