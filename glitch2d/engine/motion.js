export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const PARAMS = Object.freeze({
  headX: [-1, 1, 0], headY: [-1, 1, 0], headZ: [-1, 1, 0],
  gazeX: [-1, 1, 0], gazeY: [-1, 1, 0], eyeOpen: [0, 1, 1],
  mouthOpen: [0, 1, 0], mouthWide: [-1, 1, 0], smile: [-1, 1, 0],
  brow: [-1, 1, 0], breath: [0, 1, 0], arm: [-1, 1, 0],
});
export const EXPRESSIONS = Object.freeze({
  neutral: { smile: 0, brow: 0, eyeOpen: 1, mouthWide: 0 },
  happy: { smile: 1, brow: .25, eyeOpen: .86, mouthWide: .45 },
  curious: { smile: .1, brow: .85, eyeOpen: 1, mouthWide: -.25 },
  sleepy: { smile: -.2, brow: -.25, eyeOpen: .5, mouthWide: -.1 },
  shy: { smile: .55, brow: -.5, eyeOpen: .88, mouthWide: -.15 },
});

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function mouthFromRms(value, gain = 4.2) {
  return clamp((value - .012) * gain, 0, 1);
}

export class Spring {
  value = 0;
  velocity = 0;
  step(target, dt) {
    // Bounded substeps also handle a tab returning from the background.
    let left = clamp(dt, 0, .12);
    while (left > 0) {
      const h = Math.min(left, 1 / 120);
      this.velocity += ((target - this.value) * 48 - this.velocity * 8.5) * h;
      this.value += this.velocity * h;
      left -= h;
    }
    return this.value;
  }
}

export class Motion {
  constructor(random = Math.random) {
    this.random = random;
    this.values = Object.fromEntries(Object.entries(PARAMS).map(([id, spec]) => [id, spec[2]]));
    this.target = { ...this.values };
    this.idle = true;
    this.follow = true;
    this.pointer = { x: 0, y: 0 };
    this.audio = 0;
    this.speaking = false;
    this.time = 0;
    this.nextBlink = 2.5;
    this.blinkTime = -1;
    this.waveTime = -1;
    this.hair = new Spring();
  }
  setParameters(values) {
    for (const [id, value] of Object.entries(values)) {
      if (!Object.hasOwn(PARAMS, id) || !Number.isFinite(value)) continue;
      this.target[id] = clamp(value, PARAMS[id][0], PARAMS[id][1]);
    }
  }
  setExpression(name) {
    if (!Object.hasOwn(EXPRESSIONS, name)) throw new RangeError(`Unknown expression: ${name}`);
    this.setParameters(EXPRESSIONS[name]);
  }
  reset() {
    this.setParameters(Object.fromEntries(Object.entries(PARAMS).map(([id, spec]) => [id, spec[2]])));
    this.pointer = { x: 0, y: 0 };
    this.blinkTime = this.waveTime = -1;
  }
  blink() { this.blinkTime = 0; }
  wave() { this.waveTime = 0; }
  step(dt) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .05);
    this.time += dt;
    const t = this.time;
    const target = { ...this.target };
    if (this.idle) {
      target.headZ += Math.sin(t * .67) * .12;
      target.headY += Math.sin(t * .91) * .07;
      target.breath = (Math.sin(t * 1.8) + 1) * .5;
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkTime < 0) this.blink();
    }
    if (this.follow) {
      target.gazeX = clamp(target.gazeX + this.pointer.x * .7, -1, 1);
      target.gazeY = clamp(target.gazeY + this.pointer.y * .55, -1, 1);
      target.headX += this.pointer.x * .22;
      target.headY += this.pointer.y * .1;
    }
    if (this.speaking) target.mouthOpen = this.audio;
    if (this.waveTime >= 0) {
      this.waveTime += dt;
      target.arm = Math.sin(this.waveTime * 8) * Math.sin(Math.min(1, this.waveTime / 1.65) * Math.PI) * .75;
      target.headY += Math.sin(Math.min(1, this.waveTime / 1.65) * Math.PI) * .3;
      if (this.waveTime >= 1.65) this.waveTime = -1;
    }
    for (const key of Object.keys(PARAMS)) {
      const speed = key === 'mouthOpen' ? (target[key] > this.values[key] ? 25 : 17) : 12;
      this.values[key] = lerp(this.values[key], clamp(target[key], PARAMS[key][0], PARAMS[key][1]), 1 - Math.exp(-speed * dt));
    }
    const pose = { ...this.values };
    if (this.blinkTime >= 0) {
      this.blinkTime += dt;
      // Fast closure, a brief hold, then a slower reopening. Geometric aperture.
      const b = this.blinkTime;
      const aperture = b < .075 ? 1 - b / .075 : b < .11 ? 0 : clamp((b - .11) / .14, 0, 1);
      pose.eyeOpen *= aperture;
      if (b >= .25) {
        this.blinkTime = -1;
        this.nextBlink = 2.7 + this.random() * 3.2;
      }
    }
    pose.hair = this.hair.step(-pose.headZ * .7 + (this.idle ? Math.sin(t * 1.25) * .14 : 0), dt);
    return pose;
  }
}
