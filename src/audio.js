const MASTER_RAMP_SECONDS = 0.05;
const REGION_RAMP_SECONDS = 0.08;

export class DroneAudioEngine {
  constructor(regions, zoneState) {
    this.regions = regions;
    this.zoneState = zoneState;
    this.context = null;
    this.regionGains = [];
    this.sources = [];
    this.master = null;
    this.eq = {};
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
    this.master = ctx.createGain();

    this.eq.low.type = "lowshelf";
    this.eq.low.frequency.value = 120;
    this.eq.mid.type = "peaking";
    this.eq.mid.frequency.value = 1000;
    this.eq.mid.Q.value = 0.9;
    this.eq.high.type = "highshelf";
    this.eq.high.frequency.value = 4000;

    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.master);
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
    const duration = 12;
    const frameCount = Math.floor(sampleRate * duration);
    const buffer = this.context.createBuffer(2, frameCount, sampleRate);
    const root = quantizedFrequency(region.semitone, region.ring === "major" ? 36 : 24, duration);
    const fifth = quantizedFrequency((region.semitone + 7) % 12, region.ring === "major" ? 43 : 31, duration);
    const octave = quantizedFrequency(region.semitone, region.ring === "major" ? 48 : 36, duration);
    const color = region.ring === "major" ? 1 : 0.76;

    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      const panPhase = channel === 0 ? 0 : Math.PI * 0.37;
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const slow = 0.82 + 0.18 * Math.sin((Math.PI * 2 * t) / duration + panPhase);
        const air = 0.015 * Math.sin((Math.PI * 2 * 7 * t) / duration + panPhase);
        data[i] =
          (0.18 * Math.sin(Math.PI * 2 * root * t + panPhase) +
            0.12 * Math.sin(Math.PI * 2 * fifth * t + panPhase * 0.7) +
            0.035 * Math.sin(Math.PI * 2 * octave * t + panPhase * 1.4) +
            air) *
          slow *
          color;
      }
    }

    return buffer;
  }
}

function quantizedFrequency(semitone, baseMidi, duration) {
  const midi = baseMidi + semitone;
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  return Math.max(1, Math.round(frequency * duration) / duration);
}
