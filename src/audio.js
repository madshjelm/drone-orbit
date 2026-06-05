const MASTER_RAMP_SECONDS = 0.05;
const REGION_RAMP_SECONDS = 0.08;

// Lightweight algorithmic reverb (parallel damped feedback combs) instead of a
// long convolution impulse — far cheaper on the audio thread, which is the main
// cause of stutter on weaker / mobile devices.
const REVERB_COMB_MS = [31.7, 37.1, 41.1, 43.7, 26.5, 29.3];
const REVERB_FEEDBACK = 0.82;
const REVERB_DAMP_HZ = 2600;
const REVERB_PREDELAY = 0.035;
const REVERB_WET_GAIN = 0.26;
const REVERB_DRY_GAIN = 0.82;

// Procedural placeholder drones (used until real OGG files exist). Kept short and
// generated with yields so building them never blocks the entry screen.
const PROC_DURATION = 8;

// Mobile-friendly mix scheduling.
const MIX_THROTTLE_MS = 50; // ~20 Hz instead of per animation frame
const MIX_GATE = 0.001; // skip gain ramps smaller than this

// Dynamic-voice thresholds (only audible regions get a live source).
const VOICE_ON = 0.012;
const VOICE_OFF = 0.0025;
const VOICE_FADE_SECONDS = 0.35;

export class DroneAudioEngine {
  constructor(regions, zoneState) {
    this.regions = regions;
    this.zoneState = zoneState;
    this.context = null;
    this.regionGains = [];
    this.voices = regions.map(() => ({ source: null, stopAt: 0 }));
    this.buffers = [];
    this.master = null;
    this.eq = {};
    this.reverb = {};
    this.started = false;
    this.preloaded = false;
    this.usingFallback = false;
    this.liteMode = detectLiteMode();
    this.ready = null;
    this._loaded = 0;
    this._lastMixAt = 0;
    this._lastTargets = new Float32Array(regions.length).fill(-1);
    this.streamDest = null;
    this.mediaEl = null;
    this.usingStreamSink = false;
    this._fadeTimer = null;
  }

  // Fetch + decode every buffer ahead of time, without a user gesture. The
  // context is created suspended (no audio output yet); decoding works fine on a
  // suspended context, so a later start() can begin playback instantly.
  async preload(settings, onProgress = () => {}) {
    if (this.preloaded || this.context) {
      return this.ready;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio API is not available in this browser.");
    }

    this.context = new AudioContextClass({ latencyHint: "playback" });
    this.createBus(settings);

    this._loaded = 0;
    // Kick the network fetches off in parallel, but decode / synthesise one at a
    // time with a yield between each so the main thread never stalls (decoding is
    // off-thread, but procedural synthesis runs here).
    this.ready = (async () => {
      const pending = this.regions.map((region) => this.fetchAudio(region));
      for (let index = 0; index < this.regions.length; index += 1) {
        const data = await pending[index];
        this.buffers[index] = await this.decodeOrSynthesize(this.regions[index], data);
        this._loaded += 1;
        onProgress(this._loaded, this.regions.length, this.usingFallback);
        await yieldToMainThread();
      }
    })();
    this.preloaded = true;
    return this.ready;
  }

  async start(settings, onProgress = () => {}) {
    if (this.started) {
      await this.resumePlayback();
      return;
    }

    if (!this.preloaded) {
      await this.preload(settings, onProgress);
    }
    await this.ready;

    await this.resume();
    this.buildVoices();
    await this.setupOutputSink();

    this.started = true;
    this.updateSettings(settings);
  }

  // Persistent per-region gain nodes. The buffer sources themselves are created
  // lazily in updateMix() so only audible regions ever run.
  buildVoices() {
    const ctx = this.context;
    for (let index = 0; index < this.regions.length; index += 1) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.eq.low);
      this.regionGains[index] = gain;
      this.voices[index] = { source: null, stopAt: 0 };
      this._lastTargets[index] = -1;
    }
  }

  // Route master through a MediaStream + hidden <audio> element so mobile
  // browsers surface OS media controls and keep playing in the background. Falls
  // back to the direct destination if that path is unavailable (e.g. iOS quirks).
  async setupOutputSink() {
    const ctx = this.context;
    try {
      if (typeof ctx.createMediaStreamDestination !== "function") {
        throw new Error("MediaStream destination unsupported");
      }
      this.mediaEl = document.getElementById("mediaSink");
      if (!this.mediaEl) {
        throw new Error("Media element missing");
      }
      this.streamDest = ctx.createMediaStreamDestination();
      this.master.connect(this.streamDest);
      this.mediaEl.srcObject = this.streamDest.stream;
      this.mediaEl.loop = true;
      await this.mediaEl.play();
      this.usingStreamSink = true;
    } catch (error) {
      this.usingStreamSink = false;
      if (this.streamDest) {
        try {
          this.master.disconnect(this.streamDest);
        } catch (disconnectError) {
          /* ignore */
        }
        this.streamDest = null;
      }
      this.master.connect(ctx.destination);
    }
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

  async resumePlayback() {
    await this.resume();
    if (this.usingStreamSink && this.mediaEl) {
      try {
        await this.mediaEl.play();
      } catch (error) {
        /* ignore */
      }
    }
  }

  async suspend() {
    if (this.context && this.context.state === "running") {
      await this.context.suspend().catch(() => undefined);
    }
    if (this.mediaEl) {
      try {
        this.mediaEl.pause();
      } catch (error) {
        /* ignore */
      }
    }
  }

  // Gently fade the master out over `seconds`, then suspend. Master gain is
  // restored afterwards (while silent) so a later resume isn't muted.
  fadeOutAndPause(seconds = 12) {
    if (!this.context || !this.master) {
      return;
    }
    const now = this.context.currentTime;
    const volume = this.master.gain.value;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(volume, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + seconds);
    window.clearTimeout(this._fadeTimer);
    this._fadeTimer = window.setTimeout(async () => {
      await this.suspend();
      if (this.master) {
        this.master.gain.value = volume;
      }
    }, seconds * 1000 + 60);
  }

  cancelFade() {
    if (this._fadeTimer) {
      window.clearTimeout(this._fadeTimer);
      this._fadeTimer = null;
    }
    if (this.context && this.master) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
    }
  }

  createBus(settings) {
    const ctx = this.context;
    this.eq.low = ctx.createBiquadFilter();
    this.eq.mid = ctx.createBiquadFilter();
    this.eq.high = ctx.createBiquadFilter();
    this.reverb.dry = ctx.createGain();
    this.reverb.preDelay = ctx.createDelay(0.18);
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
    this.reverb.preDelay.delayTime.value = REVERB_PREDELAY;
    this.reverb.wet.gain.value = REVERB_WET_GAIN;

    // Parallel damped feedback combs form a cheap, smooth reverb. Fewer lines on
    // mobile. (No ConvolverNode — that was the heaviest audio-thread node.)
    const combCount = this.liteMode ? 3 : REVERB_COMB_MS.length;
    this.reverb.combs = [];
    for (let i = 0; i < combCount; i += 1) {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = REVERB_COMB_MS[i] / 1000;
      const damp = ctx.createBiquadFilter();
      damp.type = "lowpass";
      damp.frequency.value = REVERB_DAMP_HZ;
      const feedback = ctx.createGain();
      feedback.gain.value = REVERB_FEEDBACK;
      this.reverb.preDelay.connect(delay);
      delay.connect(damp);
      damp.connect(feedback);
      feedback.connect(delay);
      delay.connect(this.reverb.wet);
      this.reverb.combs.push({ delay, damp, feedback });
    }

    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.reverb.dry);
    this.eq.high.connect(this.reverb.preDelay);
    this.reverb.dry.connect(this.master);
    this.reverb.wet.connect(this.master);
    // The master sink (MediaStream or destination) is chosen by setupOutputSink().
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

    const wall = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (wall - this._lastMixAt < MIX_THROTTLE_MS) {
      return;
    }
    this._lastMixAt = wall;

    const ctx = this.context;
    const now = ctx.currentTime;
    for (let index = 0; index < this.regions.length; index += 1) {
      const weight = Math.max(0, Math.min(1, this.zoneState[index].weight));
      const gain = Math.sin(weight * Math.PI * 0.5);
      const voice = this.voices[index];
      let target;

      if (gain > VOICE_ON) {
        if (!voice.source) {
          this.spawnVoice(index, now);
        } else if (voice.stopAt) {
          voice.stopAt = 0; // becoming audible again before the fade finished
        }
        target = gain;
      } else if (gain < VOICE_OFF) {
        if (voice.source && !voice.stopAt) {
          voice.stopAt = now + VOICE_FADE_SECONDS;
        }
        target = 0;
      } else {
        target = voice.source ? (voice.stopAt ? 0 : gain) : 0;
      }

      if (Math.abs(target - this._lastTargets[index]) >= MIX_GATE) {
        this._lastTargets[index] = target;
        this.regionGains[index].gain.setTargetAtTime(target, now, REGION_RAMP_SECONDS);
      }

      if (voice.source && voice.stopAt && now >= voice.stopAt) {
        try {
          voice.source.stop();
        } catch (error) {
          /* ignore */
        }
        try {
          voice.source.disconnect();
        } catch (error) {
          /* ignore */
        }
        voice.source = null;
        voice.stopAt = 0;
      }
    }
  }

  spawnVoice(index, now) {
    const buffer = this.buffers[index];
    if (!buffer) {
      return;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.regionGains[index]);
    const offset = buffer.duration > 0 ? Math.random() * buffer.duration : 0;
    source.start(now, offset);

    const gainParam = this.regionGains[index].gain;
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(0, now); // ramp up from silence to avoid clicks

    this.voices[index].source = source;
    this.voices[index].stopAt = 0;
    this._lastTargets[index] = -1;
  }

  async fetchAudio(region) {
    try {
      const response = await fetch(region.audioPath, { cache: "force-cache" });
      if (!response.ok) {
        return null;
      }
      return await response.arrayBuffer();
    } catch (error) {
      return null;
    }
  }

  async decodeOrSynthesize(region, data) {
    if (data) {
      try {
        return await this.context.decodeAudioData(data);
      } catch (error) {
        /* fall back to a synthesised placeholder */
      }
    }
    this.usingFallback = true;
    return this.createProceduralDrone(region);
  }

  // Render a placeholder drone with an OfflineAudioContext so the synthesis runs
  // off the main thread (a per-sample JS loop here was the cause of the choppy
  // intro when OGG files are missing). Falls back to the sync loop if needed.
  async createProceduralDrone(region) {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) {
      return this.createProceduralDroneSync(region);
    }

    const sampleRate = this.context.sampleRate;
    const duration = PROC_DURATION;
    const frames = Math.max(1, Math.floor(sampleRate * duration));
    const oac = new OfflineCtx(2, frames, sampleRate);
    const rootMidi = 48 + region.semitone;
    const color = region.ring === "major" ? 1 : 0.86;

    const sum = oac.createGain();
    sum.gain.value = 1;
    const partials = [
      { semi: 0, amp: 0.28 },
      { semi: 0.045, amp: 0.2 },
      { semi: 7, amp: 0.19 },
      { semi: 12, amp: 0.1 },
      { semi: 19, amp: 0.055 },
      { semi: 24, amp: 0.025 }
    ];
    for (const partial of partials) {
      const osc = oac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = quantizedFrequencyFromMidi(rootMidi + partial.semi, duration);
      const gain = oac.createGain();
      gain.gain.value = partial.amp;
      osc.connect(gain);
      gain.connect(sum);
      osc.start(0);
      osc.stop(duration);
    }

    // tanh saturation, then a slow amplitude "breath" driven by an LFO.
    const shaper = oac.createWaveShaper();
    shaper.curve = makeTanhCurve(1.45);

    const breath = oac.createGain();
    breath.gain.value = 0.78;
    const lfo = oac.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 1 / duration;
    const lfoGain = oac.createGain();
    lfoGain.gain.value = 0.22;
    lfo.connect(lfoGain);
    lfoGain.connect(breath.gain);
    lfo.start(0);
    lfo.stop(duration);

    const out = oac.createGain();
    out.gain.value = color * 0.72;

    sum.connect(shaper);
    shaper.connect(breath);
    breath.connect(out);
    out.connect(oac.destination);

    return oac.startRendering();
  }

  createProceduralDroneSync(region) {
    const sampleRate = this.context.sampleRate;
    const duration = PROC_DURATION;
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

function detectLiteMode() {
  try {
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const lowCores = (navigator.hardwareConcurrency || 8) <= 4;
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
    return Boolean((coarse && lowCores) || mobileUA);
  } catch (error) {
    return false;
  }
}

function quantizedFrequencyFromMidi(midi, duration) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  return Math.max(1, Math.round(frequency * duration) / duration);
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function makeTanhCurve(drive) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive);
  }
  return curve;
}
