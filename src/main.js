import { DroneAudioEngine } from "./audio.js";
import { OrbitRenderer } from "./renderer.js";
import { WEDGE_ANGLE, WEDGE_COUNT, normalizeAngle, regionFor, regionIndex, regions, ringDisplay } from "./config.js";

const canvas = document.querySelector("#orbitCanvas");
const entryScreen = document.querySelector("#entryScreen");
const launchButton = document.querySelector("#launchButton");
const selectedKeyText = document.querySelector("#selectedKeyText");
const loadStatus = document.querySelector("#loadStatus");
const loadMeter = document.querySelector("#loadMeter");
const loadBar = document.querySelector("#loadBar");
const panel = document.querySelector("#settingsPanel");
const panelToggle = document.querySelector("#panelToggle");
const panelClose = document.querySelector("#panelClose");
const currentKey = document.querySelector("#currentKey");
const directionReadout = document.querySelector("#directionReadout");
const orbitReadout = document.querySelector("#orbitReadout");
const speedReadout = document.querySelector("#speedReadout");
const speedControl = document.querySelector("#speedControl");
const zoomControl = document.querySelector("#zoomControl");
const directionToggle = document.querySelector("#directionToggle");
const orbitToggle = document.querySelector("#orbitToggle");
const volumeControl = document.querySelector("#volumeControl");
const bassControl = document.querySelector("#bassControl");
const midControl = document.querySelector("#midControl");
const highControl = document.querySelector("#highControl");

const state = {
  phase: "entry",
  settings: {
    speedValue: Number(speedControl.value) / 1000,
    volume: Number(volumeControl.value) / 100,
    eq: {
      bass: Number(bassControl.value),
      mid: Number(midControl.value),
      high: Number(highControl.value)
    }
  },
  view: {
    zoom: 1,
    minZoom: 1,
    maxZoom: 2.8,
    userChangedZoom: false
  },
  motion: {
    angle: 0,
    direction: 1,
    instantDirection: 1,
    ringMix: 1,
    targetRingMix: 1,
    launchProgress: 0,
    launchStart: 0,
    launchDuration: 2400,
    transfer: null,
    uturn: null
  },
  selection: {
    region: null
  },
  zoneState: regions.map((region) => ({
    region,
    weight: 0,
    weightTarget: 0
  }))
};

const renderer = new OrbitRenderer(canvas, state);
const audio = new DroneAudioEngine(regions, state.zoneState);
const pointers = new Map();
let pinchStart = null;
let lastFrame = performance.now();

wireControls();
requestAnimationFrame(tick);

function wireControls() {
  window.addEventListener("resize", () => renderer.resize());
  window.addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 80));

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  launchButton.addEventListener("click", launch);
  panelToggle.addEventListener("click", () => setPanelOpen(!panel.classList.contains("is-open")));
  panelClose.addEventListener("click", () => setPanelOpen(false));

  speedControl.addEventListener("input", () => {
    state.settings.speedValue = Number(speedControl.value) / 1000;
    updateHud();
  });

  zoomControl.addEventListener("input", () => {
    renderer.setZoom(Number(zoomControl.value) / 100);
  });

  directionToggle.addEventListener("click", startUTurn);
  orbitToggle.addEventListener("click", startOrbitTransfer);

  for (const control of [volumeControl, bassControl, midControl, highControl]) {
    control.addEventListener("input", () => {
      state.settings.volume = Number(volumeControl.value) / 100;
      state.settings.eq.bass = Number(bassControl.value);
      state.settings.eq.mid = Number(midControl.value);
      state.settings.eq.high = Number(highControl.value);
      audio.updateSettings(state.settings);
    });
  }

  updateHud();
}

function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 2) {
    const points = [...pointers.values()];
    pinchStart = {
      distance: distance(points[0], points[1]),
      zoom: state.view.zoom
    };
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) {
    return;
  }

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2 && pinchStart) {
    const points = [...pointers.values()];
    const nextDistance = distance(points[0], points[1]);
    renderer.setZoom(pinchStart.zoom * (nextDistance / Math.max(1, pinchStart.distance)));
    syncZoomControl();
  }
}

function onPointerUp(event) {
  const startPoint = pointers.get(event.pointerId);
  pointers.delete(event.pointerId);
  pinchStart = null;

  if (state.phase === "entry" && startPoint) {
    const move = Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y);
    if (move < 8) {
      const region = renderer.pickRegion(event.clientX, event.clientY);
      if (region) {
        selectRegion(region);
      }
    }
  }
}

function onWheel(event) {
  event.preventDefault();
  renderer.zoomBy(event.deltaY < 0 ? 1.08 : 0.925);
  syncZoomControl();
}

function selectRegion(region) {
  state.selection.region = region;
  selectedKeyText.textContent = `Launch key: ${region.label}`;
  launchButton.disabled = false;
  launchButton.textContent = `Launch from ${region.display}`;
  setEntryHighlight(region);
}

async function launch() {
  const region = state.selection.region;
  if (!region) {
    return;
  }

  launchButton.disabled = true;
  launchButton.textContent = "Loading drones";
  loadMeter.hidden = false;
  loadStatus.textContent = "Preparing audio buffers.";
  state.motion.angle = region.wedgeIndex * WEDGE_ANGLE;
  state.motion.ringMix = region.ring === "major" ? 1 : 0;
  state.motion.targetRingMix = state.motion.ringMix;
  state.motion.launchProgress = 0;
  updateWeightTargets();
  updateZoneWeights(1);

  try {
    await audio.start(state.settings, (loaded, total, fallback) => {
      loadBar.style.width = `${Math.round((loaded / total) * 100)}%`;
      loadStatus.textContent = fallback
        ? `Loaded ${loaded}/${total}; using preview drones where OGG files are missing.`
        : `Loaded ${loaded}/${total}`;
    });
  } catch (error) {
    loadStatus.textContent = error.message;
    launchButton.textContent = "Launch";
    launchButton.disabled = false;
    return;
  }

  state.phase = "launching";
  state.motion.launchStart = performance.now();
  entryScreen.classList.add("is-hidden");
  directionToggle.disabled = false;
  orbitToggle.disabled = false;
  updateToggleText();
}

function startUTurn() {
  const motion = state.motion;
  if (state.phase !== "orbiting" || motion.uturn) {
    return;
  }

  motion.uturn = {
    elapsed: 0,
    duration: 1700,
    from: motion.direction
  };
  directionToggle.disabled = true;
}

function startOrbitTransfer() {
  const motion = state.motion;
  if (state.phase !== "orbiting" || motion.transfer) {
    return;
  }

  const target = motion.ringMix >= 0.5 ? 0 : 1;
  motion.transfer = {
    elapsed: 0,
    duration: 2600,
    from: motion.ringMix,
    to: target
  };
  motion.targetRingMix = target;
  orbitToggle.disabled = true;
}

function tick(now) {
  const dt = Math.min(0.08, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;

  updateMotion(dt, now);
  updateWeightTargets();
  updateZoneWeights(dt);
  renderer.updateCamera(dt);
  audio.updateMix();
  updateHud();
  renderer.draw(now);
  requestAnimationFrame(tick);
}

function updateMotion(dt, now) {
  const motion = state.motion;

  if (state.phase === "launching") {
    motion.launchProgress = Math.min(1, (now - motion.launchStart) / motion.launchDuration);
    if (motion.launchProgress >= 1) {
      state.phase = "orbiting";
    }
    return;
  }

  if (state.phase !== "orbiting") {
    return;
  }

  const baseSpeed = speedRadiansPerSecond(state.settings.speedValue);
  let signedSpeed = baseSpeed * motion.direction;
  motion.instantDirection = motion.direction;

  if (motion.uturn) {
    motion.uturn.elapsed += dt * 1000;
    const p = Math.min(1, motion.uturn.elapsed / motion.uturn.duration);
    const multiplier = Math.cos(Math.PI * p);
    signedSpeed = baseSpeed * motion.uturn.from * multiplier;
    motion.instantDirection = Math.sign(signedSpeed || motion.uturn.from);
    if (p >= 1) {
      motion.direction = -motion.uturn.from;
      motion.instantDirection = motion.direction;
      motion.uturn = null;
      directionToggle.disabled = false;
      updateToggleText();
    }
  }

  if (motion.transfer) {
    motion.transfer.elapsed += dt * 1000;
    const p = Math.min(1, motion.transfer.elapsed / motion.transfer.duration);
    motion.ringMix = lerp(motion.transfer.from, motion.transfer.to, easeInOut(p));
    if (p >= 1) {
      motion.ringMix = motion.transfer.to;
      motion.transfer = null;
      orbitToggle.disabled = false;
      updateToggleText();
    }
  }

  motion.angle = normalizeAngle(motion.angle + signedSpeed * dt);
}

function updateWeightTargets() {
  for (const zone of state.zoneState) {
    zone.weightTarget = 0;
  }

  if (state.phase === "entry") {
    if (state.selection.region) {
      state.zoneState[state.selection.region.index].weightTarget = 1;
    }
    return;
  }

  const motion = state.motion;
  const angular = angularBlend(motion.angle);
  const majorMix = motion.ringMix;
  const minorMix = 1 - majorMix;
  const launchGain = state.phase === "launching" ? easeOutCubic(motion.launchProgress) : 1;

  for (const part of angular) {
    if (majorMix > 0.001) {
      state.zoneState[regionIndex("major", part.wedge)].weightTarget += part.weight * majorMix * launchGain;
    }
    if (minorMix > 0.001) {
      state.zoneState[regionIndex("minor", part.wedge)].weightTarget += part.weight * minorMix * launchGain;
    }
  }

  let total = 0;
  for (const zone of state.zoneState) {
    total += zone.weightTarget;
  }
  if (total > 0) {
    for (const zone of state.zoneState) {
      zone.weightTarget /= total;
    }
  }
}

function updateZoneWeights(dt) {
  const factor = 1 - Math.exp(-dt / 0.12);
  for (const zone of state.zoneState) {
    zone.weight += (zone.weightTarget - zone.weight) * factor;
    if (zone.weight < 0.0001) {
      zone.weight = 0;
    }
  }
}

function setEntryHighlight(region) {
  for (const zone of state.zoneState) {
    zone.weightTarget = zone.region.index === region.index ? 1 : 0;
  }
}

function angularBlend(angle) {
  const position = normalizeAngle(angle) / WEDGE_ANGLE;
  const left = Math.floor(position);
  const frac = position - left;
  const right = (left + 1) % WEDGE_COUNT;

  return [
    { wedge: left, weight: 1 - frac },
    { wedge: right, weight: frac }
  ];
}

function updateHud() {
  const dominant = dominantRegion();
  if (dominant) {
    currentKey.textContent = `Now orbiting: ${dominant.label}`;
  }

  directionReadout.textContent = state.motion.direction > 0 ? "CW" : "CCW";
  orbitReadout.textContent = state.motion.ringMix >= 0.5 ? "Major" : "Minor";
  speedReadout.textContent = secondsPerKeyLabel(state.settings.speedValue);
  syncZoomControl();
}

function dominantRegion() {
  if (state.phase === "entry" && state.selection.region) {
    return state.selection.region;
  }

  if (state.phase === "entry") {
    return regionFor("major", 0);
  }

  let best = state.zoneState[0];
  for (const zone of state.zoneState) {
    if (zone.weight > best.weight) {
      best = zone;
    }
  }
  return best.region;
}

function updateToggleText() {
  directionToggle.textContent = state.motion.direction > 0 ? "CW" : "CCW";
  directionToggle.setAttribute("aria-pressed", state.motion.direction > 0 ? "true" : "false");
  const activeRing = state.motion.ringMix >= 0.5 ? "major" : "minor";
  orbitToggle.textContent = ringDisplay(activeRing);
  orbitToggle.setAttribute("aria-pressed", activeRing === "major" ? "true" : "false");
}

function setPanelOpen(open) {
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncZoomControl() {
  zoomControl.value = String(Math.round(state.view.zoom * 100));
}

function speedRadiansPerSecond(value) {
  const min = WEDGE_ANGLE / 300;
  const max = WEDGE_ANGLE / 3;
  return min * (max / min) ** value;
}

function secondsPerKeyLabel(value) {
  const seconds = WEDGE_ANGLE / speedRadiansPerSecond(value);
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)}m/key`;
  }
  return `${Math.round(seconds)}s/key`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function easeOutCubic(t) {
  return 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;
}
