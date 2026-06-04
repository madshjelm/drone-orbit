import { TAU, WEDGE_ANGLE, WEDGE_COUNT, geometry, normalizeAngle, regionFor, regions } from "./config.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export class OrbitRenderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.glowCanvas = document.createElement("canvas");
    this.glowCtx = this.glowCanvas.getContext("2d");
    this.state = state;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.base = 1;
    this.radius = 1;
    this.camera = { x: 0, y: 0 };
    this.cameraTarget = { x: 0, y: 0 };
    this.pointerWorld = { x: 0, y: 0 };
    this.stars = createStars(190);
    this.dust = createStars(42);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth);
    const height = Math.max(1, rect.height || window.innerHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.base = Math.min(width, height);
    this.radius = this.base * 0.43;

    for (const target of [this.canvas, this.glowCanvas]) {
      target.width = Math.round(width * dpr);
      target.height = Math.round(height * dpr);
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.glowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.state.view.minZoom = 1;
    this.state.view.maxZoom = 2.8;

    if (!this.state.view.userChangedZoom) {
      const defaultZoom = width < 620 ? 1.58 : width < 900 ? 1.2 : 1;
      this.setZoom(defaultZoom, false);
    } else {
      this.setZoom(this.state.view.zoom, false);
    }
  }

  setZoom(value, markUser = true) {
    const view = this.state.view;
    view.zoom = clamp(value, view.minZoom, view.maxZoom);
    view.userChangedZoom = markUser || view.userChangedZoom;
  }

  zoomBy(factor) {
    this.setZoom(this.state.view.zoom * factor);
  }

  updateCamera(dt) {
    const view = this.state.view;
    const ship = this.getShipPosition();
    const follow = clamp((view.zoom - 1) / (view.maxZoom - 1), 0, 1);
    this.cameraTarget.x = ship.x * follow * 0.86;
    this.cameraTarget.y = ship.y * follow * 0.86;

    const ease = 1 - Math.exp(-dt / 0.72);
    this.camera.x += (this.cameraTarget.x - this.camera.x) * ease;
    this.camera.y += (this.cameraTarget.y - this.camera.y) * ease;
  }

  pickRegion(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const world = this.screenToWorld(screenX, screenY);
    const r = Math.hypot(world.x, world.y);
    const hole = this.radius * geometry.holeRadiusRatio;
    const divide = this.radius * geometry.divideRadiusRatio;
    const outer = this.radius * geometry.outerRadiusRatio;

    if (r < hole || r > outer) {
      return null;
    }

    const angle = normalizeAngle(Math.atan2(world.x, -world.y));
    const wedgeIndex = Math.round(angle / WEDGE_ANGLE) % WEDGE_COUNT;
    const ring = r >= divide ? "major" : "minor";
    return regionFor(ring, wedgeIndex);
  }

  screenToWorld(x, y) {
    const zoom = this.state.view.zoom;
    return {
      x: (x - this.width / 2) / zoom + this.camera.x,
      y: (y - this.height / 2) / zoom + this.camera.y
    };
  }

  draw(time) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground(ctx, time);
    ctx.restore();

    this.drawGlow(time);
    this.drawWheel(ctx, time);
    this.drawPlanet(ctx, time);
    this.drawShip(ctx, time);
  }

  drawBackground(ctx, time) {
    const drift = reducedMotion ? 0 : time * 0.000012;
    const gradient = ctx.createLinearGradient(0, 0, this.width, this.height);
    gradient.addColorStop(0, "#02030d");
    gradient.addColorStop(0.48, "#071326");
    gradient.addColorStop(1, "#02050c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    const nebula = ctx.createRadialGradient(this.width * 0.28, this.height * 0.18, 0, this.width * 0.28, this.height * 0.18, this.base * 0.62);
    nebula.addColorStop(0, "rgba(45, 122, 152, 0.14)");
    nebula.addColorStop(1, "rgba(45, 122, 152, 0)");
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, this.width, this.height);

    for (let layer = 0; layer < 3; layer += 1) {
      const alpha = [0.72, 0.44, 0.26][layer];
      const size = [1.55, 1.05, 0.72][layer];
      ctx.fillStyle = `rgba(218, 235, 255, ${alpha})`;
      for (const star of this.stars) {
        if (star.layer !== layer) {
          continue;
        }
        const x = wrap(star.x * this.width + drift * this.width * (layer + 1) * 8, -4, this.width + 4);
        const y = wrap(star.y * this.height + drift * this.height * (layer + 1) * 5, -4, this.height + 4);
        ctx.globalAlpha = alpha * star.a;
        ctx.beginPath();
        ctx.arc(x, y, size * star.s, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const mote of this.dust) {
      const x = wrap(mote.x * this.width + drift * this.width * 15, -8, this.width + 8);
      const y = wrap(mote.y * this.height - drift * this.height * 11, -8, this.height + 8);
      ctx.fillStyle = `rgba(143, 232, 255, ${0.08 + mote.a * 0.08})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.2 + mote.s * 1.6, 0, TAU);
      ctx.fill();
    }
  }

  drawGlow(time) {
    const glowCtx = this.glowCtx;
    glowCtx.save();
    glowCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    glowCtx.clearRect(0, 0, this.width, this.height);
    this.applyCamera(glowCtx);
    glowCtx.globalCompositeOperation = "lighter";

    for (const region of regions) {
      const zone = this.state.zoneState[region.index];
      const intensity = zone.weight;
      if (intensity < 0.004) {
        continue;
      }

      const color = colorForRegion(region, 0.42 + intensity * 0.34, 0.2 + intensity * 0.62);
      drawZonePath(glowCtx, this.radius, region.wedgeIndex, region.ring, 0);
      glowCtx.fillStyle = color;
      glowCtx.fill();
    }

    glowCtx.restore();

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.filter = `blur(${Math.max(8, this.base * 0.018)}px)`;
    ctx.globalAlpha = 0.72;
    ctx.drawImage(this.glowCanvas, 0, 0, this.width, this.height);
    ctx.filter = "none";
    ctx.globalAlpha = 0.82;
    ctx.drawImage(this.glowCanvas, 0, 0, this.width, this.height);
    ctx.restore();
  }

  drawWheel(ctx) {
    ctx.save();
    this.applyCamera(ctx);

    for (const region of regions) {
      drawZonePath(ctx, this.radius, region.wedgeIndex, region.ring, 0);
      ctx.fillStyle = colorForRegion(region, region.ring === "major" ? 0.18 : 0.1, region.ring === "major" ? 0.09 : 0.12);
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.base * 0.003);
      ctx.strokeStyle = "rgba(1, 7, 18, 0.78)";
      ctx.stroke();
    }

    this.drawSelectedRing(ctx);
    this.drawLabels(ctx);
    ctx.restore();
  }

  drawSelectedRing(ctx) {
    const selected = this.state.selection.region;
    if (!selected || this.state.phase !== "entry") {
      return;
    }

    drawZonePath(ctx, this.radius, selected.wedgeIndex, selected.ring, this.radius * 0.006);
    ctx.lineWidth = Math.max(2, this.base * 0.004);
    ctx.strokeStyle = "rgba(255, 239, 184, 0.92)";
    ctx.shadowColor = "rgba(255, 210, 118, 0.8)";
    ctx.shadowBlur = Math.max(10, this.base * 0.022);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  drawLabels(ctx) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.82)";
    ctx.shadowBlur = Math.max(3, this.base * 0.006);
    ctx.fillStyle = "rgba(255, 245, 216, 0.92)";

    for (let i = 0; i < WEDGE_COUNT; i += 1) {
      const major = regionFor("major", i);
      const minor = regionFor("minor", i);
      const angle = i * WEDGE_ANGLE;
      const majorR = this.radius * (geometry.divideRadiusRatio + geometry.outerRadiusRatio) * 0.5;
      const minorR = this.radius * (geometry.holeRadiusRatio + geometry.divideRadiusRatio) * 0.5;

      drawLabel(ctx, major.display, angle, majorR, Math.max(18, this.base * 0.052), 820);
      drawLabel(ctx, minor.display, angle, minorR, Math.max(13, this.base * 0.031), 720);
    }

    ctx.restore();
  }

  drawPlanet(ctx, time) {
    ctx.save();
    this.applyCamera(ctx);
    const planetR = this.radius * geometry.planetRadiusRatio;
    const spin = reducedMotion ? 0.4 : time * 0.000045;

    ctx.save();
    ctx.shadowColor = "rgba(72, 169, 255, 0.48)";
    ctx.shadowBlur = planetR * 0.34;
    const ocean = ctx.createRadialGradient(-planetR * 0.28, -planetR * 0.35, planetR * 0.08, 0, 0, planetR);
    ocean.addColorStop(0, "#52d3ff");
    ocean.addColorStop(0.48, "#0d70b4");
    ocean.addColorStop(1, "#053063");
    ctx.fillStyle = ocean;
    ctx.beginPath();
    ctx.arc(0, 0, planetR, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, planetR * 0.96, 0, TAU);
    ctx.clip();
    ctx.fillStyle = "rgba(142, 214, 112, 0.88)";
    drawContinent(ctx, planetR, spin, [
      [-0.72, -0.45],
      [-0.34, -0.6],
      [-0.08, -0.38],
      [-0.18, -0.1],
      [-0.48, -0.04],
      [-0.62, -0.24]
    ]);
    drawContinent(ctx, planetR, spin + 1.4, [
      [0.14, -0.5],
      [0.58, -0.4],
      [0.66, -0.06],
      [0.38, 0.16],
      [0.08, 0.0]
    ]);
    drawContinent(ctx, planetR, spin + 2.3, [
      [-0.18, 0.2],
      [0.16, 0.3],
      [0.2, 0.62],
      [-0.12, 0.72],
      [-0.34, 0.46]
    ]);
    ctx.restore();

    ctx.lineWidth = Math.max(1.5, planetR * 0.035);
    ctx.strokeStyle = "rgba(154, 229, 255, 0.74)";
    ctx.beginPath();
    ctx.arc(0, 0, planetR * 1.04, 0, TAU);
    ctx.stroke();

    const night = ctx.createLinearGradient(-planetR, -planetR, planetR, planetR);
    night.addColorStop(0, "rgba(255, 255, 255, 0.18)");
    night.addColorStop(0.42, "rgba(255, 255, 255, 0)");
    night.addColorStop(1, "rgba(0, 0, 0, 0.36)");
    ctx.fillStyle = night;
    ctx.beginPath();
    ctx.arc(0, 0, planetR, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  drawShip(ctx, time) {
    if (this.state.phase === "entry") {
      return;
    }

    const ship = this.getShipPosition();
    const direction = this.state.motion.instantDirection || this.state.motion.direction;
    const heading = this.state.motion.angle + (direction >= 0 ? Math.PI / 2 : -Math.PI / 2);
    const size = Math.max(14, this.base * 0.024);
    const flicker = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 0.018);
    const halo = this.mixedShipColor();

    ctx.save();
    this.applyCamera(ctx);
    ctx.translate(ship.x, ship.y);
    ctx.rotate(heading);
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = halo;
    ctx.shadowColor = halo;
    ctx.shadowBlur = size * (1.3 + flicker * 0.8);
    ctx.beginPath();
    ctx.ellipse(-size * 0.52, 0, size * 0.32, size * 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    const engine = ctx.createLinearGradient(-size * 1.45, 0, -size * 0.3, 0);
    engine.addColorStop(0, "rgba(108, 228, 255, 0)");
    engine.addColorStop(0.45, `rgba(108, 228, 255, ${0.28 + flicker * 0.32})`);
    engine.addColorStop(1, "rgba(255, 245, 202, 0.85)");
    ctx.fillStyle = engine;
    ctx.beginPath();
    ctx.moveTo(-size * 1.5, 0);
    ctx.lineTo(-size * 0.34, -size * 0.28);
    ctx.lineTo(-size * 0.3, size * 0.28);
    ctx.closePath();
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = size * 0.16;
    ctx.fillStyle = "#f7f2df";
    ctx.strokeStyle = "#081020";
    ctx.lineWidth = Math.max(1.4, size * 0.11);
    ctx.beginPath();
    ctx.moveTo(size * 0.78, 0);
    ctx.lineTo(-size * 0.36, -size * 0.48);
    ctx.quadraticCurveTo(-size * 0.72, 0, -size * 0.36, size * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#f0a94c";
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, -size * 0.44);
    ctx.lineTo(-size * 0.5, -size * 0.86);
    ctx.lineTo(size * 0.08, -size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#5fd4ff";
    ctx.beginPath();
    ctx.arc(size * 0.22, 0, size * 0.2, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  getShipPosition() {
    const motion = this.state.motion;
    const radius = this.getShipRadius();
    return polar(motion.angle, radius);
  }

  getShipRadius() {
    const motion = this.state.motion;
    const planetR = this.radius * geometry.planetRadiusRatio;
    const innerR = this.radius * (geometry.holeRadiusRatio + geometry.divideRadiusRatio) * 0.5;
    const outerR = this.radius * (geometry.divideRadiusRatio + geometry.outerRadiusRatio) * 0.5;
    const orbitR = lerp(innerR, outerR, motion.ringMix);

    if (this.state.phase === "launching") {
      const eased = easeOutCubic(motion.launchProgress);
      return lerp(planetR * 0.7, orbitR, eased);
    }

    return orbitR;
  }

  mixedShipColor() {
    let hueX = 0;
    let hueY = 0;
    let total = 0;
    let light = 0;

    for (const region of regions) {
      const weight = this.state.zoneState[region.index].weight;
      if (weight <= 0) {
        continue;
      }
      const hue = hueForWedge(region.wedgeIndex);
      hueX += Math.cos((hue / 360) * TAU) * weight;
      hueY += Math.sin((hue / 360) * TAU) * weight;
      light += (region.ring === "major" ? 68 : 52) * weight;
      total += weight;
    }

    if (!total) {
      return "rgba(143, 232, 255, 0.72)";
    }

    const hue = normalizeAngle(Math.atan2(hueY, hueX)) / TAU * 360;
    return `hsla(${hue.toFixed(1)}, 84%, ${clamp(light / total, 45, 72).toFixed(1)}%, 0.78)`;
  }

  applyCamera(ctx) {
    const zoom = this.state.view.zoom;
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.camera.x, -this.camera.y);
  }
}

export function colorForRegion(region, lightness = 0.5, alpha = 1) {
  const hue = hueForWedge(region.wedgeIndex);
  const saturation = region.ring === "major" ? 78 : 64;
  const light = (region.ring === "major" ? 44 : 28) + lightness * 34;
  return `hsla(${hue.toFixed(1)}, ${saturation}%, ${clamp(light, 12, 76).toFixed(1)}%, ${alpha})`;
}

function hueForWedge(wedgeIndex) {
  return (wedgeIndex / WEDGE_COUNT) * 360 - 8;
}

function drawZonePath(ctx, radius, wedgeIndex, ring, expand) {
  const center = wedgeIndex * WEDGE_ANGLE;
  const start = center - WEDGE_ANGLE / 2;
  const end = center + WEDGE_ANGLE / 2;
  const inner = radius * (ring === "major" ? geometry.divideRadiusRatio : geometry.holeRadiusRatio) - expand;
  const outer = radius * (ring === "major" ? geometry.outerRadiusRatio : geometry.divideRadiusRatio) + expand;

  ctx.beginPath();
  ctx.arc(0, 0, outer, start - Math.PI / 2, end - Math.PI / 2, false);
  ctx.arc(0, 0, inner, end - Math.PI / 2, start - Math.PI / 2, true);
  ctx.closePath();
}

function drawLabel(ctx, text, angle, radius, size, weight) {
  const point = polar(angle, radius);
  ctx.font = `${weight} ${size}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(text, point.x, point.y);
}

function drawContinent(ctx, radius, spin, points) {
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    const px = Math.sin(x * 1.6 + spin) * radius * 0.72 + x * radius * 0.18;
    const py = y * radius * 0.86;
    if (index === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.closePath();
  ctx.fill();
}

function createStars(count) {
  let seed = 1187;
  const stars = [];
  for (let index = 0; index < count; index += 1) {
    seed = lcg(seed);
    const x = seed / 2147483647;
    seed = lcg(seed);
    const y = seed / 2147483647;
    seed = lcg(seed);
    const s = 0.4 + (seed / 2147483647) * 1.2;
    seed = lcg(seed);
    const a = 0.4 + (seed / 2147483647) * 0.6;
    stars.push({ x, y, s, a, layer: index % 3 });
  }
  return stars;
}

function lcg(seed) {
  return (seed * 48271) % 2147483647;
}

function polar(angle, radius) {
  return {
    x: Math.sin(angle) * radius,
    y: -Math.cos(angle) * radius
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutCubic(t) {
  const p = clamp(t, 0, 1);
  return 1 - (1 - p) ** 3;
}

function wrap(value, min, max) {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
}
