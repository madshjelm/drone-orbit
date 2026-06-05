const MASTER_RAMP_SECONDS = 0.05;
const REGION_RAMP_SECONDS = 0.08;

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
    this.started = false;
    this.preloaded = false;
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
    // Fetch in parallel, decode one at a time with a yield between each. Regions
    // without an audio file simply stay null (silent) — no placeholder audio.
    this.ready = (async () => {
      const pending = this.regions.map((region) => this.fetchAudio(region));
      for (let index = 0; index < this.regions.length; index += 1) {
        const data = await pending[index];
        this.buffers[index] = await this.decodeBuffer(data);
        this._loaded += 1;
        onProgress(this._loaded, this.regions.length);
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
    this.master = ctx.createGain();

    this.eq.low.type = "lowshelf";
    this.eq.low.frequency.value = 120;
    this.eq.mid.type = "peaking";
    this.eq.mid.frequency.value = 1000;
    this.eq.mid.Q.value = 0.9;
    this.eq.high.type = "highshelf";
    this.eq.high.frequency.value = 4000;

    // Dry, clean signal path: sources -> region gains -> EQ -> master. No reverb
    // (the loops carry their own space); keeps the mix stable and light.
    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.master);
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
      // Regions without an audio file are silent — nothing to schedule.
      if (!this.buffers[index]) {
        continue;
      }
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
      const response = await fetch(region.audioPath);
      if (!response.ok) {
        return null;
      }
      return await response.arrayBuffer();
    } catch (error) {
      return null;
    }
  }

  async decodeBuffer(data) {
    if (!data) {
      return null;
    }
    try {
      return await this.context.decodeAudioData(data);
    } catch (error) {
      return null;
    }
  }
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
