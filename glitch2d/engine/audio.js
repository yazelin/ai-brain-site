import { mouthFromRms, rms } from './motion.js';

export class VoicePlayer {
  constructor(motion, onState = () => {}) {
    this.motion = motion; this.onState = onState;
    this.element = new Audio(); this.element.preload = 'auto';
    this.element.crossOrigin = 'anonymous'; this.sequence = 0;
    this.element.addEventListener('ended', () => this.stop());
    this.element.addEventListener('error', () => this.stop('error'));
  }
  async play(url) {
    this.stop();
    const sequence = ++this.sequence;
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 1024;
      this.source = this.context.createMediaElementSource(this.element);
      this.source.connect(this.analyser); this.analyser.connect(this.context.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
    }
    await this.context.resume();
    if (sequence !== this.sequence) return;
    this.element.src = String(url);
    this.motion.speaking = true; this.motion.audio = 0;
    try {
      await this.element.play();
      if (sequence === this.sequence) this.onState('playing');
    } catch (error) {
      if (sequence === this.sequence) this.stop('error');
      throw error;
    }
  }
  update() {
    if (!this.motion.speaking || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    this.motion.audio = mouthFromRms(rms(this.samples));
    return this.motion.audio;
  }
  stop(state = 'stopped') {
    this.sequence++;
    this.element.pause(); this.motion.speaking = false; this.motion.audio = 0;
    this.motion.setParameters({ mouthOpen: 0 });
    this.onState(state);
  }
  dispose() { this.stop(); this.context?.close(); }
}
