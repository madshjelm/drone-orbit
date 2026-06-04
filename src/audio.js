const MASTER_RAMP_SECONDS = 0.05;
const REGION_RAMP_SECONDS = 0.08;
const REVERB_SECONDS = 6.2;
const REVERB_DECAY = 4.1;
const REVERB_WET_GAIN = 0.52;
const REVERB_DRY_GAIN = 0.82;

export class DroneAudioEngine {
  constructor(regions, zoneState) {
    this.regions = regions;
    this.zoneState = zoneState;
    this.context = null;
    this.regionGains = [];
    this.sources = [];
    this.master = null;
    this.eq = {};
    this.reverb = {};
    this.started = false;
    this.usingFallback = false;
  }

  async start(settings, onProgress = () => {}) {
    if (this.started) {
      await this.resume();
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio API is not available in this browser.");
    }

    this.context = new AudioContextClass();
    await this.resume();
    this.createBus(settings);

    let loaded = 0;
    const buffers = await Promise.all(
      this.regions.map(async (region) => {
        const buffer = await this.loadBuffer(region);
        loaded += 1;
        onProgress(loaded, this.regions.length, this.usingFallback);
        return buffer;
      })
    );

    const startAt = this.context.currentTime + 0.06;
    buffers.forEach((buffer, index) => {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.eq.low);
      source.start(startAt);
      this.sources[index] = source;
      this.regionGains[index] = gain;
    });

    this.started = true;
    this.updateSettings(settings);
  }

  async resume() {
    if (this.context && this.context.state !== "running") {
      await Promise.race([
        this.context.resume().catch(() => undefined),
        new Promise((resolve) => {
          window.setTimeout(resolve, 800);
        })
      ]);
    }
  }

  createBus(settings) {
    const ctx = this.context;
    this.eq.low = ctx.createBiquadFilter();
    this.eq.mid = ctx.createBiquadFilter();
    this.eq.high = ctx.createBiquadFilter();
    this.reverb.dry = ctx.createGain();
    this.reverb.preDelay = ctx.createDelay(0.18);
    this.reverb.convolver = ctx.createConvolver();
    this.reverb.wet = ctx.createGain();
    this.master = ctx.createGain();

    this.eq.low.type = "lowshelf";
    this.eq.low.frequency.value = 120;
    this.eq.mid.type = "peaking";
    this.eq.mid.frequency.value = 1000;
    this.eq.mid.Q.value = 0.9;
    this.eq.high.type = "highshelf";
    this.eq.high.frequency.value = 4000;
    this.reverb.dry.gain.value = REVERB_DRY_GAIN;
    this.reverb.preDelay.delayTime.value = 0.035;
    this.reverb.convolver.buffer = createReverbImpulse(ctx, REVERB_SECONDS, REVERB_DECAY);
    this.reverb.wet.gain.value = REVERB_WET_GAIN;

    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.reverb.dry);
    this.eq.high.connect(this.reverb.preDelay);
    this.reverb.preDelay.connect(this.reverb.convolver);
    this.reverb.convolver.connect(this.reverb.wet);
    this.reverb.dry.connect(this.master);
    this.reverb.wet.connect(this.master);
    this.master.connect(ctx.destination);
    this.updateSettings(settings);
  }

  updateSettings(settings) {
    if (!this.context || !this.master) {
      return;
    }

    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(settings.volume, now, MASTER_RAMP_SECONDS);
    this.eq.low.gain.setTargetAtTime(settings.eq.bass, now, MASTER_RAMP_SECONDS);
    this.eq.mid.gain.setTargetAtTime(settings.eq.mid, now, MASTER_RAMP_SECONDS);
    this.eq.high.gain.setTargetAtTime(settings.eq.high, now, MASTER_RAMP_SECONDS);
  }

  updateMix() {
    if (!this.started || !this.context) {
      return;
    }

    const now = this.context.currentTime;
    for (let index = 0; index < this.regionGains.length; index += 1) {
      const weight = Math.max(0, Math.min(1, this.zoneState[index].weight));
      const gain = Math.sin(weight * Math.PI * 0.5);
      this.regionGains[index].gain.setTargetAtTime(gain, now, REGION_RAMP_SECONDS);
    }
  }

  async loadBuffer(region) {
    try {
      const response = await fetch(region.audioPath, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const data = await response.arrayBuffer();
      return await this.context.decodeAudioData(data);
    } catch (error) {
      this.usingFallback = true;
      return this.createProceduralDrone(region);
    }
  }

  createProceduralDrone(region) {
    const sampleRate = this.context.sampleRate;
    const duration = 16;
    const frameCount = Math.floor(sampleRate * duration);
    const buffer = this.context.createBuffer(2, frameCount, sampleRate);
    const rootMidi = 48 + region.semitone;
    const root = quantizedFrequencyFromMidi(rootMidi, duration);
    const rootDetuned = quantizedFrequencyFromMidi(rootMidi + 0.045, duration);
    const fifth = quantizedFrequencyFromMidi(rootMidi + 7, duration);
    const octave = quantizedFrequencyFromMidi(rootMidi + 12, duration);
    const upperFifth = quantizedFrequencyFromMidi(rootMidi + 19, duration);
    const airTone = quantizedFrequencyFromMidi(rootMidi + 24, duration);
    const color = region.ring === "major" ? 1 : 0.86;

    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      const panPhase = channel === 0 ? 0 : Math.PI * 0.37;
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const slow = 0.76 + 0.24 * Math.sin((Math.PI * 2 * t) / duration + panPhase);
        const pulse = 0.9 + 0.1 * Math.sin((Math.PI * 4 * t) / duration + panPhase * 1.6);
        const shimmer = 0.55 + 0.45 * Math.sin((Math.PI * 6 * t) / duration + panPhase * 0.8);
        const raw =
          0.28 * Math.sin(Math.PI * 2 * root * t + panPhase) +
          0.2 * Math.sin(Math.PI * 2 * rootDetuned * t + panPhase * 1.2) +
          0.19 * Math.sin(Math.PI * 2 * fifth * t + panPhase * 0.7) +
          0.1 * Math.sin(Math.PI * 2 * octave * t + panPhase * 1.4) +
          0.055 * Math.sin(Math.PI * 2 * upperFifth * t + panPhase * 1.9) * shimmer +
          0.025 * Math.sin(Math.PI * 2 * airTone * t + panPhase * 2.3);
        data[i] = Math.tanh(raw * 1.45) * slow * pulse * color * 0.72;
      }
    }

    return buffer;
  }
}

function quantizedFrequencyFromMidi(midi, duration) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  return Math.max(1, Math.round(frequency * duration) / duration);
}

function createReverbImpulse(ctx, seconds, decay) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 9347;

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    const channelPhase = channel === 0 ? 0 : Math.PI * 0.31;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 48271) % 2147483647;
      const noise = (seed / 2147483647) * 2 - 1;
      const t = i / length;
      const envelope = (1 - t) ** decay;
      const earlyBloom = Math.min(1, i / (ctx.sampleRate * 0.08));
      const modulation =
        0.86 +
        0.1 * Math.sin(Math.PI * 2 * 3.1 * t + channelPhase) +
        0.04 * Math.sin(Math.PI * 2 * 11.7 * t + channelPhase);
      data[i] = noise * envelope * earlyBloom * modulation;
    }
  }

  return impulse;
}
