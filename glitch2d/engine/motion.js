export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const PARAMS = Object.freeze({
  headX: [-1, 1, 0], headY: [-1, 1, 0], headZ: [-1, 1, 0],
  gazeX: [-1, 1, 0], gazeY: [-1, 1, 0], eyeOpen: [0, 1, 1],
  mouthOpen: [0, 1, 0], mouthWide: [-1, 1, 0], smile: [-1, 1, 0],
  brow: [-1, 1, 0], breath: [0, 1, 0], arm: [-1, 1, 0],
});
// Micro-expressions for the character page, where the face fills the viewport.
export const EXPRESSIONS = Object.freeze({
  neutral: { smile: 0, brow: 0, eyeOpen: 1, mouthWide: 0 },
  happy: { smile: 1, brow: .25, eyeOpen: .86, mouthWide: .45 },
  curious: { smile: .1, brow: .85, eyeOpen: 1, mouthWide: -.25 },
  sleepy: { smile: -.2, brow: -.25, eyeOpen: .5, mouthWide: -.1 },
  shy: { smile: .55, brow: -.5, eyeOpen: .88, mouthWide: -.15 },
});

/* Emotes for a desk pet roughly 220 pixels tall. Deliberately not the
   micro-expressions above: happy up there bends the lip by three pixels and
   lifts the brow by two, which at pet size is indistinguishable from neutral.

   Four things move the face, and all four are used:
     eyeOpen   aperture; under .16 the drawn closed lids take over
     mouthOpen over .12 swaps in the open mouth, and sets how wide it opens
     mouthWide horizontal shape of the mouth, positive smiles, negative pouts
     brow/gaze/head  brow height and tilt, gaze, head angle
   smile only shows on a closed mouth, where it bends the lip line. */
export const EMOTES = Object.freeze({
  // Narrowed eyes over a wide open mouth: laughing.
  happy: { smile: 1, brow: .55, eyeOpen: .3, mouthWide: 1, mouthOpen: .8, gazeY: .25, headY: -.2 },
  // Eyes drifting up and away, head cocked, mouth pursed small: thinking.
  thinking: { smile: 0, brow: .9, eyeOpen: .95, mouthWide: -1, mouthOpen: .22, gazeX: -1, gazeY: -.85, headX: -.35, headZ: .55 },
  // Eyes shut, mouth shut, head hanging.
  sleep: { smile: -.2, brow: -.3, eyeOpen: 0, mouthWide: -.2, mouthOpen: 0, headY: .6, headZ: -.3 },
  // Eyes shut, mouth at full stretch, paired with the caller's shake and colour shift.
  error: { smile: -1, brow: -1, eyeOpen: 0, mouthWide: 1, mouthOpen: 1 },
});
// Emotes the caller should render with its own glitch treatment.
export const GLITCHED_EMOTES = Object.freeze(['error']);
// Drawn eye art that replaces the whole eye for an emote. Parameters can
// narrow an eye but cannot bend it into a smile or fill it with a spiral, so
// these two swap in their own art through the eyes slot.
export const EMOTE_EYES = Object.freeze({ happy: 'smile', error: 'spiral' });
// A full reset, so switching emotes never carries the previous one's leftovers.
export const NEUTRAL_POSE = Object.freeze({
  smile: 0, brow: 0, eyeOpen: 1, mouthWide: 0, mouthOpen: 0,
  gazeX: 0, gazeY: 0, headX: 0, headY: 0, headZ: 0,
});

// .7 per unit of headZ was the original idle feel; headZ turns the head by
// .075 radians per unit, so this is that same feel expressed in radians.
const HEAD_SWAY = .7 / .075;

const ease = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/* One wave, as a pure function of seconds since it started.

   The shoulder leads and the elbow follows 0.12s behind, so the arm unfolds
   instead of flipping up in one piece. While the hand is up the forearm swings
   around the elbow and the wrist trails it by most of a beat. Everything else
   is coupled to the same curve: the figure sways over its shoes, the head tips
   toward the raised hand, the free arm counter-swings, and the face warms up.
   Hair needs no term here, it already follows headZ through its spring. */
// The joints of one wave, as a pure function of seconds since it started.
// Overlapping action: the shoulder goes first, the elbow follows a beat later,
// and the wrist trails both. Nothing arrives at the same time.
const joints = u => ({
  raise: ease(u / .40) * (1 - ease((u - 2.10) / .48)),
  fold: ease((u - .13) / .48) * (1 - ease((u - 2.22) / .46)),
});

export const WAVE_DURATION = 2.9;

/* One wave.

   Three things keep it from reading as a machine. The joints are offset from
   each other, shoulder to elbow to wrist, so the arm unrolls instead of
   turning as one piece. The body, head and free arm run on the same curve
   delayed by 0.15s, so they are still settling after the hand has arrived and
   still returning after it has left. And the arm overshoots a little on
   arrival and rocks back, the follow-through that a limb with mass has.

   Hair needs no term here. It already trails headZ through its own spring,
   which is the same idea one layer further out. */
export function waveFrame(t) {
  const { raise, fold } = joints(t);
  // Follow-through: a small damped rock as the arm reaches the top.
  const settle = t > .40 && t < 1.1 ? Math.sin((t - .40) * 13) * Math.exp(-(t - .40) * 4.5) * .09 : 0;
  const held = ease((t - .66) / .20) * (1 - ease((t - 1.95) / .28));
  const beat = (t - .66) * 9.2;
  const swing = Math.sin(beat) * held;
  // The body is late to start and late to stop, which is what reads as soft.
  const body = joints(t - .15).raise;
  const bodySway = Math.sin(beat - 1.3) * held;
  return {
    armRaise: raise + settle,
    armFold: fold + swing * .17 + settle * .5,
    handAngle: Math.sin(beat - 1.0) * held,
    // Strategic stillness, which the Live2D motion guide puts as keeping the
    // parts that have no reason to move stationary while the others move. The
    // body's share is one small arc over the shoes and nothing else: bending
    // the torso instead shears a drawing that is one sheet from collar to hip,
    // which reads as the hips and the neck twisting. The amount is deliberately
    // near the edge of noticeable, because a greeting that sways is worse than
    // one that is still.
    lean: -.62 * body,
    arm: 0,
    // The head keeps square to the shoulders. Turning it against them puts a
    // twist in the neck, and the neck is a short column with a choker on it,
    // so the twist is the first thing the eye catches.
    tilt: 0,
    headZ: 0,
    headY: 0,
    headX: 0,
    smile: raise,
    brow: .28 * body,
    eyeOpen: 1 - .15 * body,
  };
}

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
    this.slots = {};
    this.hair = new Spring();
  }
  setParameters(values) {
    for (const [id, value] of Object.entries(values)) {
      if (!Object.hasOwn(PARAMS, id) || !Number.isFinite(value)) continue;
      this.target[id] = clamp(value, PARAMS[id][0], PARAMS[id][1]);
    }
  }
  /* Which variant is showing in each art slot. Unknown slots are ignored so a
     caller cannot invent one, and 'default' clears a slot back to the base art. */
  setSlots(values) {
    const known = new Set(this.rigSlots || []);
    for (const [slot, variant] of Object.entries(values)) {
      if (known.size && !known.has(slot)) continue;
      if (variant === 'default' || variant == null) delete this.slots[slot];
      else this.slots[slot] = String(variant);
    }
  }
  setExpression(name) {
    if (!Object.hasOwn(EXPRESSIONS, name)) throw new RangeError(`Unknown expression: ${name}`);
    this.setParameters(EXPRESSIONS[name]);
  }
  reset() {
    this.setParameters(Object.fromEntries(Object.entries(PARAMS).map(([id, spec]) => [id, spec[2]])));
    this.pointer = { x: 0, y: 0 };
    this.slots = {};
    this.blinkTime = this.waveTime = -1;
  }
  blink() { this.blinkTime = 0; }
  /* Ignored while one is already running. Restarting mid-wave snapped the arm
     back to hanging and began again, which reads as the hand falling off. A
     second click still lands elsewhere, it just does not interrupt this. */
  wave() { if (this.waveTime < 0) this.waveTime = 0; }
  get waving() { return this.waveTime >= 0; }
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
    let wave = null;
    if (this.waveTime >= 0) {
      this.waveTime += dt;
      wave = waveFrame(this.waveTime);
      // These ride the spring with everything else, so the face eases in.
      for (const key of ['arm', 'headX', 'headY', 'headZ', 'smile', 'brow']) target[key] += wave[key];
      target.eyeOpen = Math.min(target.eyeOpen, wave.eyeOpen);
      if (this.waveTime >= WAVE_DURATION) this.waveTime = -1;
    }
    for (const key of Object.keys(PARAMS)) {
      const speed = key === 'mouthOpen' ? (target[key] > this.values[key] ? 25 : 17) : 12;
      this.values[key] = lerp(this.values[key], clamp(target[key], PARAMS[key][0], PARAMS[key][1]), 1 - Math.exp(-speed * dt));
    }
    // Which hand is on. The sleeve's own hand is cut out of its texture, so a
    // hand part is always drawn and exactly one of them is visible. The side
    // view is drawn hanging and the palm is drawn raised, so the swap happens
    // once the forearm is up far enough for the palm to read as a greeting.
    // Live2D swaps hands the same way rather than trying to turn one.
    const HAND_SWAP = .55;
    // The bend drivers are already smooth in time; running them through the
    // spring would only damp the swing, so they go straight onto the pose.
    const pose = { ...this.values, armRaise: 0, armFold: 0, handAngle: 0, lean: 0, tilt: 0, slots: {} };
    if (wave) Object.assign(pose, { armRaise: wave.armRaise, armFold: wave.armFold, handAngle: wave.handAngle, lean: wave.lean, tilt: wave.tilt });
    pose.slots = { ...this.slots, leftHand: pose.armFold > HAND_SWAP ? 'open' : 'default' };
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
    // The hair trails the head's actual rotation, not the parameters that cause
    // it. Driving it from raw parameters let the two drift apart, and the hair
    // swung hard while the head had barely tipped. HEAD_SWAY converts radians
    // back to the scale the idle sway was tuned on, so idle is unchanged.
    const headAngle = pose.headZ * .075 + (pose.tilt || 0) * .13;
    const headShift = pose.headX * 8 + (pose.tilt || 0) * 14;
    pose.hair = this.hair.step(-headAngle * HEAD_SWAY - headShift * .014 + (this.idle ? Math.sin(t * 1.25) * .14 : 0), dt);
    return pose;
  }
}
