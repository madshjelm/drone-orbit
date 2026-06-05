import { TAU, WEDGE_ANGLE, WEDGE_COUNT, geometry, normalizeAngle, regionFor, regions } from "./config.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const liteMode = detectLiteMode();

// Equirectangular Earth texture resolution. Generated once at startup; this is
// plenty for the small on-screen sphere.
const EARTH_TEX_W = 384;
const EARTH_TEX_H = 192;
const CLOUD_TEX_W = 256;
const CLOUD_TEX_H = 128;
// Cap on the per-frame sphere render resolution to keep the cost predictable.
const PLANET_MAX_PX = 190;

// Normalised sun direction in view space (upper-left, tilted toward the viewer).
const SUN = normalize3(-0.55, -0.42, 0.72);

export class OrbitRenderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    // The zone bloom is rendered into a small offscreen buffer and upscaled —
    // the upscale itself supplies the blur, cheaply.
    this.glowCanvas = document.createElement("canvas");
    this.glowCtx = this.glowCanvas.getContext("2d");
    this.glowScale = 0.25;
    // Static deep-space backdrop (gradient + nebula + both star layers) baked
    // once per resize and blitted in a single pass each frame.
    this.skyCanvas = document.createElement("canvas");
    this.skyCtx = this.skyCanvas.getContext("2d");
    this.planetCanvas = document.createElement("canvas");
    this.planetCtx = this.planetCanvas.getContext("2d");
    this.state = state;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.base = 1;
    this.radius = 1;
    this.camera = { x: 0, y: 0 };
    this.cameraTarget = { x: 0, y: 0 };
    this.pointerWorld = { x: 0, y: 0 };

    // Procedural planet textures (built once, independent of viewport size).
    this.earthTex = buildEarthTexture();
    this.cloudTex = buildCloudTexture();
    this.planetImage = null;
    this.planetPx = 0;
    this.lastPlanetRender = -1;
    this.planetFrozen = false;

    this.twinkles = [];
    this.meteor = null;
    this.meteorTimer = 4 + Math.random() * 6;
    this.lastTime = null;

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

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    // Glow buffer: small, fixed target on the long edge regardless of DPI.
    this.glowScale = clamp(360 / (Math.max(width, height) * dpr), 0.08, 0.5);
    this.glowCanvas.width = Math.max(1, Math.round(width * dpr * this.glowScale));
    this.glowCanvas.height = Math.max(1, Math.round(height * dpr * this.glowScale));

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.state.view.minZoom = 1;
    this.state.view.maxZoom = 2.8;

    this.buildSky();
    this.buildTwinkles();
    this.buildPlanetBuffer();

    if (!this.state.view.userChangedZoom) {
      const defaultZoom = width < 620 ? 1.58 : width < 900 ? 1.2 : 1;
      this.setZoom(defaultZoom, false);
    } else {
      this.setZoom(this.state.view.zoom, false);
    }
  }

  // ---- Offscreen layer construction -------------------------------------

  buildSky() {
    const dpr = this.dpr;
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    this.skyCanvas.width = w;
    this.skyCanvas.height = h;
    const ctx = this.skyCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.width;
    const H = this.height;
    ctx.clearRect(0, 0, W, H);

    // Deep-space vertical gradient.
    const sky = ctx.createLinearGradient(0, 0, W * 0.35, H);
    sky.addColorStop(0, "#03040f");
    sky.addColorStop(0.5, "#060b1d");
    sky.addColorStop(1, "#020308");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Soft nebula clouds — a few large, very low-alpha radial blooms.
    const nebulae = [
      { x: 0.26, y: 0.2, r: 0.7, color: [60, 96, 168], a: 0.16 },
      { x: 0.8, y: 0.74, r: 0.62, color: [120, 60, 132], a: 0.12 },
      { x: 0.62, y: 0.12, r: 0.42, color: [40, 130, 150], a: 0.1 },
      { x: 0.12, y: 0.82, r: 0.5, color: [38, 70, 130], a: 0.1 }
    ];
    ctx.globalCompositeOperation = "lighter";
    for (const n of nebulae) {
      const cx = n.x * W;
      const cy = n.y * H;
      const rad = n.r * Math.max(W, H);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${n.color[0]}, ${n.color[1]}, ${n.color[2]}, ${n.a})`);
      g.addColorStop(0.5, `rgba(${n.color[0]}, ${n.color[1]}, ${n.color[2]}, ${n.a * 0.35})`);
      g.addColorStop(1, `rgba(${n.color[0]}, ${n.color[1]}, ${n.color[2]}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // A faint dusty band evoking a distant galactic plane.
    ctx.save();
    ctx.translate(W * 0.5, H * 0.5);
    ctx.rotate(-0.5);
    const band = ctx.createLinearGradient(0, -H * 0.28, 0, H * 0.28);
    band.addColorStop(0, "rgba(90, 110, 170, 0)");
    band.addColorStop(0.5, "rgba(120, 130, 190, 0.07)");
    band.addColorStop(1, "rgba(90, 110, 170, 0)");
    ctx.fillStyle = band;
    ctx.fillRect(-W, -H * 0.28, W * 2, H * 0.56);
    ctx.restore();

    // Two star layers, baked straight into the sky so the whole backdrop costs
    // a single blit per frame.
    const area = W * H;
    this.paintStars(ctx, Math.round(area / 1500), {
      minSize: 0.35,
      maxSize: 0.95,
      minAlpha: 0.25,
      maxAlpha: 0.7,
      glowChance: 0.03,
      seed: 4051
    });
    this.paintStars(ctx, Math.round(area / 5200), {
      minSize: 0.7,
      maxSize: 1.7,
      minAlpha: 0.5,
      maxAlpha: 1,
      glowChance: 0.2,
      seed: 9173
    });

    ctx.globalCompositeOperation = "source-over";
  }

  paintStars(ctx, count, opts) {
    const W = this.width;
    const H = this.height;
    const rng = mulberry32(opts.seed);
    for (let i = 0; i < count; i += 1) {
      const x = rng() * W;
      const y = rng() * H;
      const size = opts.minSize + rng() * (opts.maxSize - opts.minSize);
      const alpha = opts.minAlpha + rng() * (opts.maxAlpha - opts.minAlpha);
      const tint = pickStarTint(rng());

      if (rng() < opts.glowChance) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 6);
        glow.addColorStop(0, `rgba(${tint}, ${alpha * 0.5})`);
        glow.addColorStop(1, `rgba(${tint}, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, size * 6, 0, TAU);
        ctx.fill();
      }

      ctx.fillStyle = `rgba(${tint}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
  }

  buildTwinkles() {
    // A handful of bright twinkling beacons, drawn live for a sense of life.
    const area = this.width * this.height;
    const rng = mulberry32(90210);
    const count = Math.max(14, Math.round(area / 36000));
    this.twinkles = [];
    for (let i = 0; i < count; i += 1) {
      this.twinkles.push({
        x: rng() * this.width,
        y: rng() * this.height,
        size: 0.8 + rng() * 1.5,
        base: 0.35 + rng() * 0.4,
        amp: 0.25 + rng() * 0.45,
        speed: 0.6 + rng() * 1.8,
        phase: rng() * TAU,
        tint: pickStarTint(rng()),
        spike: rng() > 0.45
      });
    }
  }

  buildPlanetBuffer() {
    const planetR = this.radius * geometry.planetRadiusRatio;
    const cap = liteMode ? 150 : PLANET_MAX_PX;
    const px = Math.max(32, Math.min(cap, Math.round(planetR * 2 * this.dpr)));
    if (px === this.planetPx && this.planetImage) {
      return;
    }
    this.planetPx = px;
    this.planetCanvas.width = px;
    this.planetCanvas.height = px;
    this.planetImage = this.planetCtx.createImageData(px, px);
    this.lastPlanetRender = -1;
    this.planetFrozen = false;
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
    const dt = this.lastTime == null ? 0 : Math.min(0.05, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(ctx, time, dt);
    ctx.restore();

    this.drawGlow(time);
    this.drawWheel(ctx, time);
    this.drawPlanet(ctx, time);
    this.drawShip(ctx, time);
  }

  drawBackground(ctx, time, dt) {
    // The full backdrop (gradient + nebula + stars) is a single static blit.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.skyCanvas, 0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = true;

    this.drawTwinkles(ctx, time);
    this.drawMeteor(ctx, time, dt);
  }

  drawTwinkles(ctx, time) {
    const t = reducedMotion ? 0 : time * 0.001;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const star of this.twinkles) {
      const a = clamp(star.base + star.amp * Math.sin(t * star.speed + star.phase), 0, 1);
      if (a <= 0.02) {
        continue;
      }
      const x = star.x;
      const y = star.y;
      ctx.fillStyle = `rgba(${star.tint}, ${a})`;
      ctx.beginPath();
      ctx.arc(x, y, star.size, 0, TAU);
      ctx.fill();

      if (star.spike && a > 0.5) {
        const len = star.size * (3 + a * 3);
        ctx.strokeStyle = `rgba(${star.tint}, ${(a - 0.5) * 0.6})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - len, y);
        ctx.lineTo(x + len, y);
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y + len);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawMeteor(ctx, time, dt) {
    if (reducedMotion) {
      return;
    }

    if (!this.meteor) {
      this.meteorTimer -= dt;
      if (this.meteorTimer <= 0) {
        this.spawnMeteor();
      }
      return;
    }

    const m = this.meteor;
    m.life += dt;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    const fade = m.life < 0.2 ? m.life / 0.2 : clamp(1 - (m.life - 0.2) / m.duration, 0, 1);

    if (m.life > m.duration + 0.2 || m.x < -120 || m.x > this.width + 120 || m.y > this.height + 120) {
      this.meteor = null;
      this.meteorTimer = 5 + Math.random() * 9;
      return;
    }

    const speed = Math.hypot(m.vx, m.vy) || 1;
    const tailX = m.x - (m.vx / speed) * m.length;
    const tailY = m.y - (m.vy / speed) * m.length;
    const grad = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
    grad.addColorStop(0, `rgba(214, 236, 255, ${0.85 * fade})`);
    grad.addColorStop(1, "rgba(214, 236, 255, 0)");

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    ctx.fillStyle = `rgba(240, 248, 255, ${fade})`;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 1.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  spawnMeteor() {
    const angle = Math.PI * (0.18 + Math.random() * 0.24); // shallow downward streak
    const speed = 380 + Math.random() * 320;
    this.meteor = {
      x: Math.random() * this.width * 0.8,
      y: -20 - Math.random() * this.height * 0.15,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      length: 90 + Math.random() * 120,
      life: 0,
      duration: 0.7 + Math.random() * 0.6
    };
  }

  drawGlow(time) {
    const s = this.dpr * this.glowScale;
    const zoom = this.state.view.zoom;
    const glowCtx = this.glowCtx;
    glowCtx.setTransform(s, 0, 0, s, 0, 0);
    glowCtx.clearRect(0, 0, this.width, this.height);
    glowCtx.save();
    this.applyCamera(glowCtx);
    glowCtx.globalCompositeOperation = "lighter";

    // Track the screen-space bounding box of the lit zones so the upscale blit
    // only touches the pixels it needs to (typically a few wedges, not the disc).
    let active = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const expand = (wx, wy) => {
      const px = this.width / 2 + (wx - this.camera.x) * zoom;
      const py = this.height / 2 + (wy - this.camera.y) * zoom;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    };

    for (const region of regions) {
      const zone = this.state.zoneState[region.index];
      const intensity = zone.weight;
      if (intensity < 0.004) {
        continue;
      }
      active = true;
      const color = colorForRegion(region, 0.42 + intensity * 0.34, 0.2 + intensity * 0.62);
      drawZonePath(glowCtx, this.radius, region.wedgeIndex, region.ring, 0);
      glowCtx.fillStyle = color;
      glowCtx.fill();

      const center = region.wedgeIndex * WEDGE_ANGLE;
      const inner = this.radius * (region.ring === "major" ? geometry.divideRadiusRatio : geometry.holeRadiusRatio);
      const outer = this.radius * (region.ring === "major" ? geometry.outerRadiusRatio : geometry.divideRadiusRatio);
      for (const a of [center - WEDGE_ANGLE / 2, center, center + WEDGE_ANGLE / 2]) {
        const sa = Math.sin(a);
        const ca = -Math.cos(a);
        expand(sa * inner, ca * inner);
        expand(sa * outer, ca * outer);
      }
    }

    glowCtx.restore();

    if (!active) {
      return;
    }

    const margin = this.radius * 0.05 * zoom;
    const dx = clamp(minX - margin, 0, this.width);
    const dy = clamp(minY - margin, 0, this.height);
    const dw = clamp(maxX + margin, 0, this.width) - dx;
    const dh = clamp(maxY + margin, 0, this.height) - dy;
    if (dw <= 0 || dh <= 0) {
      return;
    }
    const factor = this.dpr * this.glowScale; // glow buffer px per CSS px

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.glowCanvas, dx * factor, dy * factor, dw * factor, dh * factor, dx, dy, dw, dh);
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
    const planetR = this.radius * geometry.planetRadiusRatio;
    this.renderEarth(time);

    ctx.save();
    this.applyCamera(ctx);

    // Atmospheric halo bleeding beyond the disc.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(0, 0, planetR * 0.82, 0, 0, planetR * 1.65);
    halo.addColorStop(0, "rgba(96, 168, 255, 0.32)");
    halo.addColorStop(0.5, "rgba(70, 132, 230, 0.12)");
    halo.addColorStop(1, "rgba(70, 132, 230, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, planetR * 1.65, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The rendered sphere.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.planetCanvas, -planetR, -planetR, planetR * 2, planetR * 2);

    ctx.restore();
  }

  // Renders the lit, rotating sphere into the planet buffer.
  renderEarth(time) {
    if (!this.planetImage) {
      return;
    }
    // Hold the globe still until launch (and for reduced motion) so the intro
    // costs almost nothing while audio preloads. Once flying, rotate but cap the
    // per-pixel pass to ~20-30 Hz since the sphere turns slowly.
    const frozen = reducedMotion || this.state.phase === "entry";
    if (frozen) {
      if (this.planetFrozen) {
        return;
      }
      this.planetFrozen = true;
    } else {
      this.planetFrozen = false;
      const rate = liteMode ? 50 : 33;
      if (this.lastPlanetRender >= 0 && time - this.lastPlanetRender < rate) {
        return;
      }
      this.lastPlanetRender = time;
    }

    const spin = frozen ? 0.6 : time * 0.00006;
    const px = this.planetPx;
    const data = this.planetImage.data;
    const earth = this.earthTex;
    const cloud = this.cloudTex;
    const ew = earth.w;
    const eh = earth.h;
    const cw = cloud.w;
    const ch = cloud.h;
    const ed = earth.data;
    const cd = cloud.data;

    const R = px / 2;
    const invR = 1 / R;
    const cosSpin = Math.cos(spin);
    const sinSpin = Math.sin(spin);
    const tilt = 0.41; // ~23.5° axial tilt
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const cloudShift = reducedMotion ? 0 : (time * 0.0000115) % 1;

    let idx = 0;
    for (let py = 0; py < px; py += 1) {
      const ny = (py + 0.5) * invR - 1;
      const ny2 = ny * ny;
      for (let pxi = 0; pxi < px; pxi += 1, idx += 4) {
        const nx = (pxi + 0.5) * invR - 1;
        const d2 = nx * nx + ny2;
        if (d2 > 1) {
          data[idx + 3] = 0;
          continue;
        }
        const nz = Math.sqrt(1 - d2);

        // View-space normal -> texture-space by undoing spin (Y) then tilt (X).
        const x1 = nx * cosSpin - nz * sinSpin;
        const z1 = nx * sinSpin + nz * cosSpin;
        const y2 = ny * cosT + z1 * sinT;
        const z2 = -ny * sinT + z1 * cosT;

        const lat = Math.asin(clamp(y2, -1, 1));
        const lon = Math.atan2(x1, z2);
        let u = lon * (0.5 / Math.PI) + 0.5;
        const v = 0.5 - lat / Math.PI;

        let tx = (u * ew) | 0;
        if (tx >= ew) tx -= ew;
        let ty = (v * eh) | 0;
        if (ty >= eh) ty = eh - 1;
        const ei = (ty * ew + tx) * 4;
        let r = ed[ei];
        let g = ed[ei + 1];
        let b = ed[ei + 2];
        const specMask = ed[ei + 3] / 255;

        // Lighting.
        const ndl = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
        const lum = ndl > 0 ? ndl : 0;
        const shade = 0.07 + 0.93 * lum;
        r *= shade;
        g *= shade;
        b *= shade;

        // Cloud layer (lit by the same terminator).
        let cu = u + cloudShift;
        if (cu >= 1) cu -= 1;
        let ctx2 = (cu * cw) | 0;
        if (ctx2 >= cw) ctx2 -= cw;
        let cty = (v * ch) | 0;
        if (cty >= ch) cty = ch - 1;
        const cAmount = (cd[cty * cw + ctx2] / 255) * 0.85;
        if (cAmount > 0.003) {
          const cl = 255 * shade;
          r += (cl - r) * cAmount;
          g += (cl - g) * cAmount;
          b += (cl - b) * cAmount;
        }

        // Ocean sun-glint specular (suppressed under clouds).
        if (specMask > 0.2 && lum > 0) {
          const hx = SUN[0];
          const hy = SUN[1];
          const hz = SUN[2] + 1;
          const hl = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
          let sdot = (nx * hx + ny * hy + nz * hz) * hl;
          if (sdot > 0) {
            sdot *= sdot;
            sdot *= sdot;
            sdot *= sdot; // ^8
            const spec = sdot * sdot * specMask * (1 - cAmount) * 220;
            r += spec;
            g += spec;
            b += spec;
          }
        }

        // Atmospheric rim (Fresnel) — stronger on the lit limb.
        const rim = 1 - nz;
        const fres = rim * rim * rim;
        const rimLight = fres * (0.35 + 0.65 * lum);
        r += 90 * rimLight;
        g += 150 * rimLight;
        b += 255 * rimLight;

        // Feathered edge for a smooth silhouette.
        const edge = (1 - Math.sqrt(d2)) * R;
        const alpha = edge >= 1 ? 255 : edge <= 0 ? 0 : (edge * 255) | 0;

        data[idx] = r > 255 ? 255 : r;
        data[idx + 1] = g > 255 ? 255 : g;
        data[idx + 2] = b > 255 ? 255 : b;
        data[idx + 3] = alpha;
      }
    }

    this.planetCtx.putImageData(this.planetImage, 0, 0);
  }

  drawShip(ctx, time) {
    if (this.state.phase === "entry") {
      return;
    }

    const ship = this.getShipPosition();
    const direction = this.state.motion.instantDirection || this.state.motion.direction;
    // Nose points along the velocity (tangent), not toward the centre.
    const heading = this.state.motion.angle + (direction >= 0 ? 0 : Math.PI);
    const size = Math.max(15, this.base * 0.025);
    const flicker = reducedMotion ? 0.6 : 0.55 + 0.45 * Math.sin(time * 0.02);
    const halo = this.mixedShipColor();

    ctx.save();
    this.applyCamera(ctx);
    ctx.translate(ship.x, ship.y);
    ctx.rotate(heading);

    // --- Engine exhaust (additive, points astern at -x) ---
    ctx.globalCompositeOperation = "lighter";
    const plumeLen = size * (1.7 + flicker * 0.7);
    const plume = ctx.createLinearGradient(-size * 0.62, 0, -plumeLen, 0);
    plume.addColorStop(0, "rgba(255, 247, 214, 0.95)");
    plume.addColorStop(0.35, `rgba(120, 226, 255, ${0.45 + flicker * 0.3})`);
    plume.addColorStop(1, "rgba(96, 150, 255, 0)");
    ctx.fillStyle = plume;
    ctx.beginPath();
    ctx.moveTo(-size * 0.6, -size * 0.2);
    ctx.quadraticCurveTo(-plumeLen, 0, -size * 0.6, size * 0.2);
    ctx.closePath();
    ctx.fill();

    // Soft engine core glow — a radial gradient rather than a costly shadowBlur.
    const haloFade = halo.slice(0, halo.lastIndexOf(",")) + ", 0)";
    const coreR = size * (1.1 + flicker * 0.6);
    const core = ctx.createRadialGradient(-size * 0.58, 0, 0, -size * 0.58, 0, coreR);
    core.addColorStop(0, halo);
    core.addColorStop(0.5, haloFade);
    core.addColorStop(1, haloFade);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(-size * 0.58, 0, coreR, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    // --- Swept wings ---
    const wing = ctx.createLinearGradient(0, -size, 0, size);
    wing.addColorStop(0, "#aeb9cc");
    wing.addColorStop(0.5, "#6b7585");
    wing.addColorStop(1, "#3c4452");
    ctx.fillStyle = wing;
    ctx.strokeStyle = "rgba(8, 12, 24, 0.85)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(size * 0.12, sign * size * 0.16);
      ctx.lineTo(-size * 0.32, sign * size * 0.86);
      ctx.lineTo(-size * 0.52, sign * size * 0.82);
      ctx.lineTo(-size * 0.34, sign * size * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // --- Fuselage ---
    const hull = ctx.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
    hull.addColorStop(0, "#f2f5fb");
    hull.addColorStop(0.45, "#c4ccd9");
    hull.addColorStop(0.55, "#9aa4b4");
    hull.addColorStop(1, "#59616f");
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(size * 1.02, 0);
    ctx.quadraticCurveTo(size * 0.45, -size * 0.36, -size * 0.32, -size * 0.34);
    ctx.quadraticCurveTo(-size * 0.72, -size * 0.18, -size * 0.78, 0);
    ctx.quadraticCurveTo(-size * 0.72, size * 0.18, -size * 0.32, size * 0.34);
    ctx.quadraticCurveTo(size * 0.45, size * 0.36, size * 1.02, 0);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, size * 0.06);
    ctx.strokeStyle = "rgba(8, 12, 24, 0.9)";
    ctx.stroke();

    // Nose accent stripe.
    ctx.fillStyle = "rgba(245, 193, 90, 0.9)";
    ctx.beginPath();
    ctx.moveTo(size * 1.02, 0);
    ctx.quadraticCurveTo(size * 0.5, -size * 0.18, size * 0.2, -size * 0.12);
    ctx.quadraticCurveTo(size * 0.5, 0, size * 0.2, size * 0.12);
    ctx.quadraticCurveTo(size * 0.5, size * 0.18, size * 1.02, 0);
    ctx.closePath();
    ctx.fill();

    // Top hull highlight.
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    ctx.beginPath();
    ctx.moveTo(size * 0.7, -size * 0.06);
    ctx.quadraticCurveTo(size * 0.1, -size * 0.26, -size * 0.3, -size * 0.2);
    ctx.quadraticCurveTo(size * 0.1, -size * 0.12, size * 0.7, -size * 0.06);
    ctx.closePath();
    ctx.fill();

    // --- Cockpit canopy ---
    const glass = ctx.createRadialGradient(size * 0.34, -size * 0.05, 0, size * 0.28, 0, size * 0.3);
    glass.addColorStop(0, "#dffbff");
    glass.addColorStop(0.5, "#5fd4ff");
    glass.addColorStop(1, "#1b5e9b");
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.ellipse(size * 0.28, 0, size * 0.26, size * 0.18, 0, 0, TAU);
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.04);
    ctx.strokeStyle = "rgba(8, 12, 24, 0.8)";
    ctx.stroke();

    // Canopy glint.
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(size * 0.36, -size * 0.06, size * 0.07, size * 0.04, -0.5, 0, TAU);
    ctx.fill();

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

// ---- Procedural planet textures -----------------------------------------

function buildEarthTexture() {
  const w = EARTH_TEX_W;
  const h = EARTH_TEX_H;
  const data = new Uint8ClampedArray(w * h * 4);
  const seaLevel = 0.5;

  for (let y = 0; y < h; y += 1) {
    const v = y / h;
    const lat = (0.5 - v) * Math.PI; // +pi/2 north .. -pi/2 south
    const poleFade = smoothstep(0.86, 1.02, Math.abs(lat) / (Math.PI / 2));
    for (let x = 0; x < w; x += 1) {
      const u = x / w;
      // Domain warp for more organic coastlines.
      const wx = u + 0.06 * fbm(u * 1.3 + 11.2, v * 1.3, 4, 4, 21);
      const wy = v + 0.06 * fbm(u * 1.3, v * 1.3 + 4.7, 4, 4, 37);
      const elevation = fbm(wx, wy, 6, 5, 7);

      const i = (y * w + x) * 4;
      let r;
      let g;
      let b;
      let spec;

      if (elevation < seaLevel) {
        // Ocean: deep navy to coastal teal.
        const depth = (seaLevel - elevation) / seaLevel; // 0 coast .. 1 deep
        r = mix(28, 8, depth);
        g = mix(104, 38, depth);
        b = mix(150, 78, depth);
        spec = 235;
      } else {
        const land = (elevation - seaLevel) / (1 - seaLevel); // 0 coast .. 1 peak
        const moisture = fbm(wx * 2.1 + 3.3, wy * 2.1 + 9.1, 4, 6, 53);
        // Blend between arid (sandy) and lush (green) biomes.
        let lr = mix(150, 70, moisture);
        let lg = mix(132, 120, moisture);
        let lb = mix(86, 58, moisture);
        // Lowland green -> highland brown -> rock.
        if (land > 0.45) {
          const t = (land - 0.45) / 0.55;
          lr = mix(lr, 120, t);
          lg = mix(lg, 96, t);
          lb = mix(lb, 78, t);
        }
        if (land > 0.78) {
          const t = (land - 0.78) / 0.22;
          lr = mix(lr, 226, t);
          lg = mix(lg, 226, t);
          lb = mix(lb, 230, t);
        }
        r = lr;
        g = lg;
        b = lb;
        spec = 20;
      }

      // Polar ice caps.
      if (poleFade > 0) {
        r = mix(r, 234, poleFade);
        g = mix(g, 240, poleFade);
        b = mix(b, 248, poleFade);
        spec = mix(spec, 90, poleFade);
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = spec;
    }
  }

  return { w, h, data };
}

function buildCloudTexture() {
  const w = CLOUD_TEX_W;
  const h = CLOUD_TEX_H;
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) {
    const v = y / h;
    // Thin out clouds toward the poles.
    const band = 0.55 + 0.45 * Math.sin(v * Math.PI);
    for (let x = 0; x < w; x += 1) {
      const u = x / w;
      let n = fbm(u + 5.1, v + 2.4, 5, 4, 91);
      n = (n - 0.46) / 0.54;
      n = clamp(n, 0, 1);
      n = n * n * band;
      data[y * w + x] = Math.round(clamp(n, 0, 1) * 255);
    }
  }
  return { w, h, data };
}

// Tileable (in x) value-noise FBM. basePeriod = lattice cells across u in [0,1).
function fbm(u, v, octaves, basePeriod, seed) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let period = basePeriod;
  let freq = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise(u * period, v * (period / 2), period, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    period *= 2;
    freq *= 2;
  }
  return sum / norm;
}

function valueNoise(x, y, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const X0 = wrapInt(x0, period);
  const X1 = wrapInt(x0 + 1, period);
  const Y0 = y0;
  const Y1 = y0 + 1;
  const v00 = hash2(X0, Y0, seed);
  const v10 = hash2(X1, Y0, seed);
  const v01 = hash2(X0, Y1, seed);
  const v11 = hash2(X1, Y1, seed);
  const sx = smootherstep(fx);
  const sy = smootherstep(fy);
  return lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
}

function wrapInt(value, period) {
  const p = Math.max(1, Math.round(period));
  return ((value % p) + p) % p;
}

function hash2(ix, iy, seed) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}

function pickStarTint(t) {
  if (t < 0.6) {
    return "232, 240, 255"; // white-blue (most stars)
  }
  if (t < 0.82) {
    return "186, 208, 255"; // blue
  }
  if (t < 0.94) {
    return "255, 236, 206"; // warm white
  }
  return "255, 206, 168"; // amber
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// Phones / low-power devices get a lighter planet render (matches the audio
// engine's own detection so both ease off together).
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

function polar(angle, radius) {
  return {
    x: Math.sin(angle) * radius,
    y: -Math.cos(angle) * radius
  };
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mix(a, b, t) {
  return a + (b - a) * t;
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
