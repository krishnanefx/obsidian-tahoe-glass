/*
 * Tahoe Glass — companion plugin for the Tahoe theme.
 *
 * Real glass bends the content behind it at its edges. CSS alone
 * can't do that, but Chromium accepts SVG filters in `backdrop-filter`.
 * For every glass surface this plugin renders a displacement map that
 * matches the element's exact size and corner radii (a rounded-rect
 * distance field with a convex bezel), wraps it in an <feDisplacementMap>
 * filter and hands it to the theme through the `--tahoe-lens` variable.
 *
 * It also drives the pointer-reactive specular highlight (--tahoe-mx,
 * --tahoe-my, --tahoe-glow) and moves the window controls inside the
 * floating sidebar of the Settings window.
 */

import { Plugin, PluginSettingTab, Setting, Platform, Notice, setIcon } from "obsidian";
import { fs, path, os, childProcess, remote, loadNode } from "./node";

const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_SETTINGS = {
  glassLevel: 0.5, // 0 = Clear, 1 = Tinted
  refraction: true,
  strength: 1,
  dispersion: true,
  specular: true, // glare and Fresnel on the rim
  lighterToolbar: true, // a cheaper filter on the toolbar, which sits over scrolling notes and redraws every frame
  batterySaver: "auto", // lighter glass on battery or in Low Power Mode: auto | always | off
  look: 2,
  glow: true,
  windowControls: true,
  settingsHeader: true,
};

// Header-card copy for Obsidian's own settings pages.
const PAGE_DESCRIPTIONS = {
  about: "Your account, app updates, language and the basics of how Obsidian works.",
  appearance: "Choose a theme, accent color and fonts, and decide how Obsidian looks.",
  interface: "Arrange the ribbon, tab bar, status bar and the other parts of the window.",
  editor: "Set how notes look and behave while you write and read them.",
  file: "Choose where new notes and attachments go, and how links are written.",
  hotkeys: "Assign keyboard shortcuts to any command.",
  keychain: "Keep passwords and API keys that plugins can use, outside your notes.",
  plugins: "Turn Obsidian\u2019s built-in features on or off.",
  "community-plugins": "Browse, install and manage plugins made by the Obsidian community.",
};

// Tile colors for plugins the theme doesn't know about.
const TILE_PALETTE = ["#007aff", "#34c759", "#ff9500", "#ff2d55", "#af52de", "#5856d6", "#30b0c7", "#ff3b30", "#00c7be", "#ffb800"];

// Surfaces that get a lens: things that float over content.
const LENS_TARGETS = [
  ".mod-root .workspace-tabs:not(.mod-stacked) > .workspace-tab-header-container > .workspace-tab-header-container-inner",
  ".mod-root .workspace-tab-header-container > :is(.sidebar-toggle-button, .workspace-tab-header-new-tab, .workspace-tab-header-tab-list) > .clickable-icon",
  ".mod-root .view-header-nav-buttons",
  ".mod-root .view-actions",
  ".status-bar",
  ".menu",
  ".suggestion-container",
  ".prompt",
  ".notice",
  ".canvas-controls .canvas-control-group",
  ".canvas-card-menu",
  ".document-search-container",
  ".tahoe-run-button",
].join(", ");

// Surfaces that catch the pointer highlight.
const GLOW_TARGETS = [
  LENS_TARGETS,
  ".modal.mod-settings .vertical-tab-header",
  ".mod-sidedock .search-input-container input",
].join(", ");

const MAX_IDLE_FILTERS = 40;
const MAX_IDLE_MAPS = 24;
// With "Lighter glass on the toolbar", controls this small (toolbar buttons
// and capsules, the status bar) get the bend plus a pre-drawn rim light — 4
// steps instead of ~19. They sit over scrolling notes, so they redraw every frame.
const LITE_SIDE = 64;

class LensHost {
  constructor(plugin, doc) {
    this.plugin = plugin;
    this.doc = doc;
    this.win = doc.defaultView;
    this.filters = new Map(); // key -> { id, node, mapKey, refs, used }
    this.maps = new Map(); // mapKey -> { promise, urls, refs, used }
    this.tracked = new Map(); // element -> { want, has } filter keys
    this.pending = new Set();
    this.counter = 0;
    this.flushTimer = 0;
    this.flushFrame = 0;
    this.scanFrame = 0;
    this.glowEl = null;
    this.glowFrame = 0;
    this.lastPointer = null;
    this.noticeContainer = null;

    this.svg = doc.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.setAttribute("class", "tahoe-glass-defs");
    this.defs = doc.createElementNS(SVG_NS, "defs");
    this.svg.appendChild(this.defs);
    doc.body.appendChild(this.svg);

    this.resizeObserver = new this.win.ResizeObserver((entries) => {
      for (const entry of entries) this.schedule(entry.target);
    });
    this.bodyObserver = new this.win.MutationObserver(() => this.requestScan());
    this.bodyObserver.observe(doc.body, { childList: true });
    this.noticeObserver = new this.win.MutationObserver(() => this.requestScan());

    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    doc.addEventListener("pointermove", this.onPointerMove, { passive: true });
    doc.documentElement.addEventListener("pointerleave", this.onPointerLeave, { passive: true });

    this.requestScan();
  }

  get settings() {
    return this.plugin.settings;
  }

  /* ---------- discovery ---------- */

  // Once a frame, so a menu gets its glass on the frame it appears.
  requestScan() {
    if (this.scanFrame) return;
    this.scanFrame = this.win.requestAnimationFrame(() => {
      this.scanFrame = 0;
      this.scan();
    });
  }

  scan() {
    if (!this.settings.refraction) return;

    const notices = this.doc.querySelector(".notice-container");
    if (notices && notices !== this.noticeContainer) {
      this.noticeObserver.disconnect();
      this.noticeObserver.observe(notices, { childList: true });
      this.noticeContainer = notices;
    }

    const found = new Set(this.doc.querySelectorAll(LENS_TARGETS));
    for (const el of found) {
      if (!this.tracked.has(el)) {
        this.tracked.set(el, { want: null, has: null });
        this.resizeObserver.observe(el);
        this.pending.add(el);
      }
    }
    for (const el of [...this.tracked.keys()]) {
      if (!found.has(el)) this.untrack(el);
    }
    if (this.pending.size) this.flush();
  }

  untrack(el) {
    const state = this.tracked.get(el);
    this.tracked.delete(el);
    this.pending.delete(el);
    this.resizeObserver.unobserve(el);
    el.style.removeProperty("--tahoe-lens");
    if (state) this.release(state.has);
  }

  // New surfaces get glass on the next frame; resizes of ones that have it
  // wait for size animations (tabs opening, menus growing) to settle.
  schedule(el) {
    this.pending.add(el);
    const state = this.tracked.get(el);
    if (!state || !state.has) {
      if (!this.flushFrame)
        this.flushFrame = this.win.requestAnimationFrame(() => {
          this.flushFrame = 0;
          this.flush();
        });
      return;
    }
    if (this.flushTimer) this.win.clearTimeout(this.flushTimer);
    this.flushTimer = this.win.setTimeout(() => this.flush(), 70);
  }

  flush() {
    this.win.clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    const els = [...this.pending];
    this.pending.clear();
    for (const el of els) {
      if (el.isConnected && this.tracked.has(el)) this.apply(el);
    }
  }

  /* ---------- lenses ---------- */

  // Everything a lens depends on. Maps are drawn for sizes rounded up to 8px
  // and stretched to fit, so a menu a few pixels taller, or the tab bar while
  // the window resizes, reuses one instead of drawing a new one.
  lensSpec(w, h, radii) {
    const q = (n) => (n > LITE_SIDE ? Math.ceil(n / 8) * 8 : n);
    const mw = q(w);
    const mh = q(h);
    // The edge band and how far in it looks, after Liquid Glass Studio's
    // demo: a 20px band that sees content from 3.5× as far in. Strength
    // deepens the bend and widens the band. Small controls are edge almost
    // all the way across and may see right through to their far side — the
    // inverted look of a glass rod. (The reach also stays under 120px, the
    // most an 8-bit displacement map holds without visible steps.)
    // feDisplacementMap moves by scale × (value − 0.5), so the reach at the
    // rim is scale / 2.
    const side = Math.min(mw, mh);
    const strength = this.settings.strength;
    const bezel = Math.round(Math.max(6, Math.min(side * 0.45, 20 * (0.75 + 0.25 * strength))));
    const reach = Math.min(bezel * 3.5 * strength, side * 0.85, 120);
    const scale = Math.round(2 * reach * 10) / 10;
    const dark = this.doc.body.classList.contains("theme-dark");
    const tier = this.plugin.saving || (this.settings.lighterToolbar && Math.min(w, h) <= LITE_SIDE) ? "lite" : "full";
    const mapRadii = radii.map((r) => Math.round(r * 2) / 2);
    const mapKey = `${tier}|${mw}x${mh}|${mapRadii.join(",")}|${bezel}|${dark ? "d" : "l"}`;
    return { tier, mw, mh, radii: mapRadii, bezel, scale, dark, mapKey };
  }

  apply(el) {
    const state = this.tracked.get(el);
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);

    if (w < 12 || h < 12 || w * h > 1600 * 1200) {
      if (state.has) {
        el.style.removeProperty("--tahoe-lens");
        this.release(state.has);
      }
      state.want = state.has = null;
      return;
    }

    const cs = this.win.getComputedStyle(el);
    const radius = (value) => {
      const n = parseFloat(value) || 0;
      const px = value.trim().endsWith("%") ? (Math.min(w, h) * n) / 100 : n;
      return Math.min(px, w / 2, h / 2);
    };
    const radii = [
      radius(cs.borderTopLeftRadius),
      radius(cs.borderTopRightRadius),
      radius(cs.borderBottomRightRadius),
      radius(cs.borderBottomLeftRadius),
    ];
    const spec = this.lensSpec(w, h, radii);
    const key = `${w}x${h}|${spec.mapKey}|${spec.scale}|${this.settings.dispersion ? 1 : 0}|${this.settings.specular ? 1 : 0}`;
    if (key === state.want && (state.has === key || state.loading)) return;
    state.want = key;

    const attach = (filter, filterKey) => {
      if (this.tracked.get(el) !== state || state.want !== key || state.has === filterKey) return; // superseded
      filter.refs++;
      filter.used = Date.now();
      el.style.setProperty("--tahoe-lens", `url(#${filter.id})`);
      this.release(state.has);
      state.has = filterKey;
    };
    const filterFor = (filterKey, urls, quick) => {
      let filter = this.filters.get(filterKey);
      if (!filter) {
        filter = this.buildFilter(w, h, spec, urls, quick);
        this.filters.set(filterKey, filter);
      }
      return filter;
    };
    // The full effect makes a full-size copy of the surface for each of its
    // ~19 steps, which is too much to redo every frame while a big menu or
    // the palette springs open. So while it's moving it gets the bend and a
    // pre-drawn rim, and the full effect once it settles.
    const moving = () => spec.tier === "full" && el.getAnimations().some((a) => a.playState === "running" && a.animationName);
    const ready = this.filters.get(key);
    if (ready && !moving()) return attach(ready, key);
    state.loading = true;
    this.loadMaps(spec).then((urls) => {
      state.loading = false;
      if (this.destroyed) return;
      if (moving()) {
        attach(filterFor(`${key}|quick`, urls, true), `${key}|quick`);
        el.addEventListener("animationend", () => this.tracked.get(el) === state && this.apply(el), { once: true });
      } else {
        attach(filterFor(key, urls, false), key);
      }
      this.collect();
    });
  }

  loadMaps(spec) {
    let entry = this.maps.get(spec.mapKey);
    if (!entry) {
      entry = { refs: 0, used: Date.now(), urls: null };
      entry.promise = this.plugin.mapMaker.make(spec).then((urls) => (entry.urls = urls));
      this.maps.set(spec.mapKey, entry);
    }
    entry.used = Date.now();
    return entry.promise;
  }

  release(key) {
    if (!key) return;
    const filter = this.filters.get(key);
    if (filter) {
      filter.refs = Math.max(0, filter.refs - 1);
      filter.used = Date.now();
    }
  }

  // Keep a small pool of idle filters and maps, so menus and popovers that
  // reopen at the same size don't draw theirs again.
  collect() {
    const idle = [...this.filters.entries()].filter(([, f]) => f.refs === 0).sort((a, b) => a[1].used - b[1].used);
    while (idle.length > MAX_IDLE_FILTERS) {
      const [key, filter] = idle.shift();
      filter.node.remove();
      this.filters.delete(key);
    }
    const inUse = new Set([...this.filters.values()].map((f) => f.mapKey));
    const idleMaps = [...this.maps.entries()].filter(([k, m]) => m.urls && !inUse.has(k)).sort((a, b) => a[1].used - b[1].used);
    while (idleMaps.length > MAX_IDLE_MAPS) {
      const [k, m] = idleMaps.shift();
      this.plugin.mapMaker.free(m.urls);
      this.maps.delete(k);
    }
  }

  buildFilter(w, h, spec, urls, quick = false) {
    const id = `tahoe-lens-${++this.counter}`;
    const el = (tag, attrs, children = []) => {
      const node = this.doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      for (const child of children) node.appendChild(child);
      return node;
    };
    const add = (tag, attrs, children) => filter.appendChild(el(tag, attrs, children));
    const image = (href, result) => add("feImage", { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: "none", result });
    const scale = spec.scale;

    const filter = el("filter", {
      id,
      x: 0,
      y: 0,
      width: w,
      height: h,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    image(urls.displacement, "map");

    if (quick) {
      // While moving: the bend, with glare and Fresnel from the light map laid on as white.
      add("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: "bent" });
      if (this.settings.specular) {
        image(urls.light, "light");
        add("feColorMatrix", { in: "light", type: "matrix", values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.75 1.4 0 0 0", result: "rim" });
        add("feMerge", {}, ["bent", "rim"].map((n) => el("feMergeNode", { in: n })));
      }
    } else if (spec.tier === "lite") {
      // Small controls: the bend, and the rim light drawn into the map ahead of time.
      add("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: "bent" });
      if (this.settings.specular) {
        image(urls.light, "light");
        add("feMerge", {}, ["bent", "light"].map((n) => el("feMergeNode", { in: n })));
      }
    } else {
      if (!this.settings.dispersion) {
        add("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: "bent" });
      } else {
        // Dispersion: red bends a little further than green, blue a little
        // less (Liquid Glass Studio's indices, 0.98 / 1 / 1.02 at gain 7).
        const channels = [
          ["r", 1.14, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
          ["g", 1, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
          ["b", 0.86, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
        ];
        for (const [c, k, matrix] of channels) {
          add("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale: Math.round(scale * k * 10) / 10, xChannelSelector: "R", yChannelSelector: "G", result: `d${c}` });
          add("feColorMatrix", { in: `d${c}`, type: "matrix", values: matrix, result: `c${c}` });
        }
        add("feComposite", { in: "cr", in2: "cg", operator: "arithmetic", k2: 1, k3: 1, result: "rg" });
        add("feComposite", { in: "rg", in2: "cb", operator: "arithmetic", k2: 1, k3: 1, result: "bent" });
      }

      // The light map carries glare (red), Fresnel (green) and the edge band (blue).
      image(urls.light, "light");

      // The folded band squeezes a lot of content into a few pixels; a touch of
      // blur there keeps it smooth (feDisplacementMap doesn't interpolate),
      // while the middle stays sharp.
      add("feGaussianBlur", { in: "bent", stdDeviation: 1.1, edgeMode: "duplicate", result: "bentSoft" });
      add("feColorMatrix", { in: "light", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", result: "bandMask" });
      add("feComposite", { in: "bentSoft", in2: "bandMask", operator: "in", result: "softBand" });
      const layers = ["bent", "softBand"];

      // Glare brightens the content's own color (it picks up what's behind the
      // glass); Fresnel is a thin white edge all the way round.
      if (this.settings.specular) {
        add("feColorMatrix", { in: "light", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0", result: "glareMask" });
        add("feColorMatrix", { in: "light", type: "matrix", values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 1 0 0 0", result: "fresnel" });
        add("feComponentTransfer", { in: "bent", result: "bright" }, ["R", "G", "B"].map((c) => el(`feFunc${c}`, { type: "linear", slope: 0.5, intercept: 0.62 })));
        add("feColorMatrix", { in: "bright", type: "saturate", values: 1.9, result: "hot" });
        add("feComposite", { in: "hot", in2: "glareMask", operator: "in", result: "glare" });
        layers.push("fresnel", "glare");
      }
      add("feMerge", {}, layers.map((n) => el("feMergeNode", { in: n })));
    }

    this.defs.appendChild(filter);
    return { id, node: filter, mapKey: spec.mapKey, refs: 0, used: Date.now() };
  }

  /* ---------- pointer highlight ---------- */

  onPointerMove(evt) {
    if (!this.settings.glow || this.plugin.saving) return;
    const target = evt.target && evt.target.closest ? evt.target.closest(GLOW_TARGETS) : null;
    if (target !== this.glowEl) {
      if (this.glowEl) this.glowEl.setCssProps({ "--tahoe-glow": "0" });
      this.glowEl = target;
    }
    if (!target) return;
    this.lastPointer = evt;
    if (!this.glowFrame) {
      this.glowFrame = this.win.requestAnimationFrame(() => {
        this.glowFrame = 0;
        const el = this.glowEl;
        const p = this.lastPointer;
        if (!el || !p) return;
        const r = el.getBoundingClientRect();
        el.setCssProps({ "--tahoe-mx": `${(p.clientX - r.left).toFixed(1)}px`, "--tahoe-my": `${(p.clientY - r.top).toFixed(1)}px`, "--tahoe-glow": "1" });
      });
    }
  }

  onPointerLeave() {
    if (this.glowEl) this.glowEl.setCssProps({ "--tahoe-glow": "0" });
    this.glowEl = null;
  }

  /* ---------- lifecycle ---------- */

  rebuild() {
    for (const el of [...this.tracked.keys()]) this.untrack(el);
    this.clearCaches();
    this.requestScan();
  }

  clearCaches() {
    for (const filter of this.filters.values()) filter.node.remove();
    this.filters.clear();
    for (const m of this.maps.values()) if (m.urls) this.plugin.mapMaker.free(m.urls);
    this.maps.clear();
  }

  destroy() {
    this.destroyed = true;
    this.win.clearTimeout(this.flushTimer);
    for (const frame of [this.flushFrame, this.scanFrame, this.glowFrame]) if (frame) this.win.cancelAnimationFrame(frame);
    this.bodyObserver.disconnect();
    this.noticeObserver.disconnect();
    this.resizeObserver.disconnect();
    this.doc.removeEventListener("pointermove", this.onPointerMove);
    this.doc.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
    for (const el of [...this.tracked.keys()]) this.untrack(el);
    this.clearCaches();
    for (const el of this.doc.querySelectorAll("[style*='--tahoe-']")) {
      el.style.removeProperty("--tahoe-mx");
      el.style.removeProperty("--tahoe-my");
      el.style.removeProperty("--tahoe-glow");
    }
    this.svg.remove();
  }
}

/*
 * The bend across the edge band, from Liquid Glass Studio
 * (github.com/iyinchao/liquid-glass-studio, MIT): at u (0 rim … 1 inner
 * edge of the band) the surface meets the eye at θi = asin((1 − u)²), the
 * ray refracts into glass of index 1.4, and the content it lands on is
 * shifted inward by tan(θi − θt). Strongest at the rim, it pulls content
 * from far inside and folds it back on itself in a narrow band — the
 * squeezed, mirrored edge of real Liquid Glass. Scaled to 1 at the rim.
 *
 * These functions are also sent to a worker as source text, so they only
 * use each other and plain JavaScript.
 */
function edgeBend(u) {
  const n = 1.4;
  const x = Math.min(Math.max(1 - u, 0), 1);
  const thetaI = Math.asin(x * x);
  const thetaT = Math.asin(Math.sin(thetaI) / n);
  return Math.tan(thetaI - thetaT);
}

// How much light the rim catches, d px in from the edge: bright on the
// outermost pixel or two, gone by about 6px (Studio's range 30, hardness 20).
function rimLight(d) {
  return Math.min(1, Math.pow(Math.max(0, 1.2 - d * 0.185), 5));
}

// Signed distance to a rounded rectangle centered on 0,0 (negative inside).
function roundedRectSdf(hw, hh, radii) {
  const rtl = radii[0];
  const rtr = radii[1];
  const rbr = radii[2];
  const rbl = radii[3];
  return (px, py) => {
    const r = px < 0 ? (py < 0 ? rtl : rbl) : py < 0 ? rtr : rbr;
    const qx = Math.abs(px) - (hw - r);
    const qy = Math.abs(py) - (hh - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

/*
 * The two maps for a rounded rectangle, as RGBA pixels:
 * - displacement: R/G encode where each pixel samples the content behind
 *   (128 = straight through); inside the edge band it points inward along
 *   the surface normal by edgeBend();
 * - light, for full surfaces: red = glare, strongest where the edge faces
 *   the light (top left) with a slightly weaker lobe opposite; green =
 *   Fresnel, the same thin rim all the way round; blue = the edge band,
 *   fading inward. For lite surfaces: glare and Fresnel together, as white
 *   with alpha, ready to lay on top.
 */
function computeGlassMaps(w, h, radii, bezel, dark, tier) {
  const hw = w / 2;
  const hh = h / 2;
  const sdf = roundedRectSdf(hw, hh, radii);
  const band = bezel + Math.max(radii[0], radii[1], radii[2], radii[3]);
  const d = new Uint8ClampedArray(w * h * 4);
  const l = new Uint8ClampedArray(w * h * 4);
  const lite = tier === "lite";
  const rimAt = edgeBend(0);
  const lx = -Math.SQRT1_2;
  const ly = -Math.SQRT1_2; // light from the top left (Studio's glare angle −45°)
  const glareStrength = dark ? 0.9 : 0.85;
  const fresnelStrength = dark ? 0.16 : 0.12;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 128;
      let g = 128;
      let glare = 0;
      let fresnel = 0;
      let soft = 0;
      if (x < band || y < band || x >= w - band || y >= h - band) {
        const px = x + 0.5 - hw;
        const py = y + 0.5 - hh;
        const dist = -sdf(px, py);
        if (dist > 0 && dist < bezel) {
          const gx = sdf(px + 0.5, py) - sdf(px - 0.5, py);
          const gy = sdf(px, py + 0.5) - sdf(px, py - 0.5);
          const len = Math.hypot(gx, gy) || 1;
          const nx = gx / len;
          const ny = gy / len; // outward normal
          const m = edgeBend(dist / bezel) / rimAt;
          r = Math.round(128 - nx * m * 127);
          g = Math.round(128 - ny * m * 127);
          soft = Math.pow(1 - dist / bezel, 0.6);
          const rim = rimLight(dist);
          if (rim > 0) {
            const facing = nx * lx + ny * ly;
            const lobe = Math.min(1, Math.pow((facing >= 0 ? 1.08 : 0.86) * facing * facing, 1.1));
            glare = lobe * rim * glareStrength;
            fresnel = rim * fresnelStrength;
          }
        }
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = 128;
      d[i + 3] = 255;
      if (lite) {
        l[i] = l[i + 1] = l[i + 2] = 255;
        l[i + 3] = Math.round(Math.min(1, fresnel * 1.4 + glare * 0.7) * 255);
      } else {
        l[i] = Math.round(glare * 255);
        l[i + 1] = Math.round(fresnel * 255);
        l[i + 2] = Math.round(soft * 255);
        l[i + 3] = 255;
      }
    }
  }
  return { displacement: d, light: l };
}

// The worker: draws maps off the main thread and returns them as PNG blobs.
const WORKER_SOURCE = `${edgeBend}\n${rimLight}\n${roundedRectSdf}\n${computeGlassMaps}
self.onmessage = async (e) => {
  const { id, w, h, radii, bezel, dark, tier } = e.data;
  try {
    const maps = computeGlassMaps(w, h, radii, bezel, dark, tier);
    const out = {};
    for (const name of ["displacement", "light"]) {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").putImageData(new ImageData(maps[name], w, h), 0, 0);
      out[name] = await canvas.convertToBlob({ type: "image/png" });
    }
    self.postMessage({ id, out });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};`;

/*
 * Draws maps for every window. Uses a worker when it can (so opening a menu
 * never waits on pixel loops or PNG encoding), and the main thread if not.
 */
class MapMaker {
  constructor() {
    this.jobs = new Map();
    this.next = 0;
    try {
      this.source = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      this.worker = new Worker(this.source);
      this.worker.onmessage = (e) => this.done(e.data);
      this.worker.onerror = () => this.fallBack();
    } catch {
      this.worker = null;
    }
  }

  make(spec) {
    const job = { w: spec.mw, h: spec.mh, radii: spec.radii, bezel: spec.bezel, dark: spec.dark, tier: spec.tier };
    if (!this.worker) return Promise.resolve(this.makeHere(job));
    return new Promise((resolve) => {
      const id = ++this.next;
      this.jobs.set(id, { job, resolve });
      this.worker.postMessage(Object.assign({ id }, job));
    });
  }

  done({ id, out, error }) {
    const pending = this.jobs.get(id);
    if (!pending) return;
    this.jobs.delete(id);
    if (error) return pending.resolve(this.makeHere(pending.job));
    const urls = { displacement: URL.createObjectURL(out.displacement), light: URL.createObjectURL(out.light) };
    // Decode them before the filter uses them, so the first frame doesn't have to.
    Promise.all(
      Object.values(urls).map((src) => {
        const img = new Image();
        img.src = src;
        return img.decode().catch(() => {});
      })
    ).then(() => pending.resolve(urls));
  }

  fallBack() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const [id, pending] of this.jobs) {
      this.jobs.delete(id);
      pending.resolve(this.makeHere(pending.job));
    }
  }

  makeHere({ w, h, radii, bezel, dark, tier }) {
    const maps = computeGlassMaps(w, h, radii, bezel, dark, tier);
    const urls = {};
    for (const name of ["displacement", "light"]) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").putImageData(new ImageData(maps[name], w, h), 0, 0);
      urls[name] = canvas.toDataURL("image/png");
    }
    return urls;
  }

  free(urls) {
    for (const url of Object.values(urls || {})) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  destroy() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    if (this.source) URL.revokeObjectURL(this.source);
    this.jobs.clear();
  }
}

export default class TahoeGlassPlugin extends Plugin {
  async onload() {
    await loadNode();
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // The Liquid Glass Studio look turns dispersion on; earlier installs saved it off by default.
    if ((saved.look || 1) < 2) {
      this.settings.dispersion = true;
      this.settings.look = 2;
      await this.saveData(this.settings);
    }
    this.hosts = new Map();
    this.mapMaker = new MapMaker();
    this.originalButtonPositions = new Map();

    this.addSettingTab(new TahoeGlassSettingTab(this.app, this));
    this.addCommand({
      id: "record-slow-moments",
      name: "Record slow moments for 2 minutes (to find lag)",
      icon: "gauge",
      callback: () => this.recordSlowMoments(2),
    });

    this.app.workspace.onLayoutReady(() => {
      this.addHost(document);
      this.applyBodyClasses();

      const rescan = () => this.hosts.forEach((host) => host.requestScan());
      this.registerEvent(this.app.workspace.on("layout-change", rescan));
      this.registerEvent(this.app.workspace.on("active-leaf-change", rescan));
      this.registerEvent(this.app.workspace.on("css-change", () => this.hosts.forEach((host) => host.rebuild())));
      this.registerEvent(this.app.workspace.on("window-open", (_ww, win) => this.addHost(win.document)));
      this.registerEvent(this.app.workspace.on("window-close", (_ww, win) => this.removeHost(win.document)));

      this.patchSettings();
      this.watchPower();
    });
  }

  /* Finding lag ------------------------------------------------------------------ */

  // For a few minutes, note every frame that took over 50 ms, with whose code
  // ran in it (Obsidian's, a plugin's, or the browser laying out and drawing),
  // and every click or key press that took over 50 ms to show on screen. The
  // report goes to ~/Library/Caches/tahoe-glass/slow-moments.json; nothing is
  // written to the vault. Costs nothing measurable while it runs.
  recordSlowMoments(minutes) {
    if (this.recording) return void new Notice("Already recording slow moments.");
    const frames = [];
    const events = [];
    const owner = (url) => {
      const m = /plugin:([\w-]+)/.exec(url || "");
      return m ? m[1] : url ? "obsidian" : "browser";
    };
    const where = (el) => {
      if (!el || !el.closest) return "";
      if (el.closest(".math, .cm-math")) return "maths";
      if (el.closest(".HyperMD-codeblock, .cm-embed-block pre, .tahoe-run-output")) return "code block";
      const line = el.closest(".cm-line");
      if (line) return `note text (${[...line.classList].filter((c) => c !== "cm-line").slice(0, 2).join(" ") || "paragraph"})`;
      const pane = el.closest(".workspace-leaf-content");
      return pane ? `${pane.getAttribute("data-type") || "pane"}` : el.tagName.toLowerCase();
    };
    const observers = [];
    try {
      const loaf = new PerformanceObserver((list) => {
        for (const f of list.getEntries()) {
          const end = f.startTime + f.duration;
          frames.push({
            at: Math.round(f.startTime),
            ms: Math.round(f.duration),
            layoutAndDraw: Math.round(f.renderStart ? end - f.renderStart : 0),
            scripts: (f.scripts || []).map((s) => ({ owner: owner(s.sourceURL), fn: s.sourceFunctionName || "", invoker: s.invoker || "", ms: Math.round(s.duration), forcedLayout: Math.round(s.forcedStyleAndLayoutDuration || 0) })),
          });
        }
      });
      loaf.observe({ type: "long-animation-frame" });
      observers.push(loaf);
    } catch {
      // no long-animation-frame timing in this version: clicks and keys only
    }
    try {
      const ev = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!/^(pointerdown|mousedown|click|keydown|keypress|input)$/.test(e.name)) continue;
          events.push({ at: Math.round(e.startTime), what: e.name, ms: Math.round(e.duration), handling: Math.round(e.processingEnd - e.processingStart), where: where(e.target) });
        }
      });
      ev.observe({ type: "event", durationThreshold: 48 });
      observers.push(ev);
    } catch {
      // no event timing in this version: frames only
    }
    this.recording = { frames, events, observers, started: Date.now() };
    this.recordTimer = window.setTimeout(() => this.finishRecording(), minutes * 60000);
    new Notice(`Recording slow moments for ${minutes} minutes. Use Obsidian as usual, and do whatever feels slow.`, 7000);
  }

  finishRecording(quiet = false) {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    window.clearTimeout(this.recordTimer);
    r.observers.forEach((o) => o.disconnect());
    const time = {};
    for (const f of r.frames) {
      let scripted = 0;
      for (const s of f.scripts) {
        time[s.owner] = (time[s.owner] || 0) + s.ms;
        scripted += s.ms;
      }
      time["layout and drawing"] = (time["layout and drawing"] || 0) + f.layoutAndDraw;
      const rest = f.ms - scripted - f.layoutAndDraw;
      if (rest > 0) time["other (unattributed)"] = (time["other (unattributed)"] || 0) + rest;
    }
    const report = {
      recorded: new Date(r.started).toISOString(),
      seconds: Math.round((Date.now() - r.started) / 1000),
      slowFrames: r.frames.length,
      timeInSlowFrames: Object.fromEntries(Object.entries(time).sort((a, b) => b[1] - a[1])),
      slowestFrames: [...r.frames].sort((a, b) => b.ms - a.ms).slice(0, 15).map((f) => Object.assign({}, f, { scripts: f.scripts.sort((a, b) => b.ms - a.ms).slice(0, 4) })),
      slowInput: [...r.events].sort((a, b) => b.ms - a.ms).slice(0, 25),
    };
    if (Platform.isDesktopApp) {
      try {
        const dir = path.join(os.homedir(), "Library", "Caches", "tahoe-glass");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "slow-moments.json"), JSON.stringify(report, null, 1));
      } catch (e) {
        console.warn("Tahoe Glass: couldn't save the report", e);
      }
    }
    console.debug("Tahoe Glass: slow moments", report);
    if (quiet) return;
    const top = Object.entries(report.timeInSlowFrames).slice(0, 3).map(([k, v]) => `${k} ${v} ms`).join(", ");
    new Notice(report.slowFrames ? `${report.slowFrames} slow frames and ${r.events.length} slow clicks or keys in ${report.seconds} s. Most time: ${top}. Saved the report.` : `No slow moments in ${report.seconds} s.`, 10000);
  }

  /* Battery saver --------------------------------------------------------------- */

  // On battery or in Low Power Mode, every surface gets the light version of the
  // glass (the bend and a pre-drawn rim, no dispersion or glare) and the pointer
  // highlight rests.
  get saving() {
    const mode = this.settings.batterySaver || "auto";
    if (mode === "always") return true;
    if (mode === "off") return false;
    return !!(this.power && (this.power.battery || this.power.lowPower));
  }

  watchPower() {
    this.power = { battery: false, lowPower: false };
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const update = () => {
          this.power.battery = !b.charging;
          this.powerChanged();
        };
        b.addEventListener("chargingchange", update);
        this.register(() => b.removeEventListener("chargingchange", update));
        update();
      });
    }
    const poll = () => {
      if (!Platform.isMacOS) return;
      try {
        childProcess.execFile("/usr/bin/pmset", ["-g"], { timeout: 3000 }, (error, out) => {
          const m = /(?:lowpowermode|powermode)\s+(\d)/.exec(out || "");
          this.power.lowPower = !!(m && m[1] === "1");
          this.powerChanged();
        });
      } catch {
        // no pmset: battery only
      }
    };
    poll();
    this.registerInterval(window.setInterval(poll, 60000));
  }

  powerChanged() {
    const saving = this.saving;
    if (saving === this.wasSaving) return;
    this.wasSaving = saving;
    this.hosts.forEach((_host, doc) => doc.body.classList.toggle("tahoe-battery-saver", saving));
    this.hosts.forEach((host) => host.rebuild());
  }

  onunload() {
    this.finishRecording(true);
    if (this.heroObserver) this.heroObserver.disconnect();
    const settingsDoc = this.settingsDocument();
    [document, settingsDoc].forEach((doc) => {
      if (doc && doc.body) doc.body.style.removeProperty("--tahoe-glass-level");
    });
    this.removeSettingsDecorations();
    this.hosts.forEach((host) => host.destroy());
    this.hosts.clear();
    this.mapMaker.destroy();
    document.body.classList.remove("tahoe-glass", "tahoe-refraction");
    this.teardownWindowControls();
  }

  addHost(doc) {
    if (!doc || this.hosts.has(doc)) return;
    this.hosts.set(doc, new LensHost(this, doc));
    this.applyGlassLevel(doc);
  }

  // Glass level: one CSS variable the theme derives every tint and blur from,
  // set on body, where it outranks the theme's own value.
  applyGlassLevel(doc) {
    if (!doc || !doc.body) return;
    const level = Math.min(1, Math.max(0, Number(this.settings.glassLevel)));
    doc.body.setCssProps({ "--tahoe-glass-level": String(Number.isFinite(level) ? level : 0.5) });
  }

  applyGlassLevelEverywhere() {
    this.hosts.forEach((_host, doc) => this.applyGlassLevel(doc));
    const settingsDoc = this.settingsDocument();
    if (settingsDoc) this.applyGlassLevel(settingsDoc);
  }

  removeHost(doc) {
    const host = this.hosts.get(doc);
    if (host) host.destroy();
    this.hosts.delete(doc);
    if (doc && doc.body) doc.body.style.removeProperty("--tahoe-glass-level");
  }

  applyBodyClasses() {
    document.body.classList.add("tahoe-glass");
    document.body.classList.toggle("tahoe-refraction", this.settings.refraction);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClasses();
    this.applyGlassLevelEverywhere();
    this.hosts.forEach((host) => host.rebuild());
  }

  /* Settings header card ------------------------------------------------------- */

  patchSettings() {
    const st = this.app.setting;
    if (!st || typeof st.openTab !== "function") return;
    const original = st.openTab;
    const decorate = () => this.decorateSettings();
    st.openTab = function (...args) {
      const result = original.apply(this, args);
      decorate();
      return result;
    };
    this.register(() => {
      if (st.openTab !== original) delete st.openTab;
    });
    if (st.activeTab) this.decorateSettings();
  }

  settingsDocument() {
    const st = this.app.setting;
    const el = st && st.activeTab && st.activeTab.containerEl;
    return el ? el.ownerDocument : null;
  }

  decorateSettings() {
    const st = this.app.setting;
    const tab = st && st.activeTab;
    if (this.heroObserver) this.heroObserver.disconnect();
    if (!tab || !tab.containerEl) return;
    const doc = tab.containerEl.ownerDocument;
    const win = doc.defaultView;

    this.applyGlassLevel(doc);
    this.tintCommunityTiles(doc);
    this.placeWindowControls(doc);
    if (!this.settings.settingsHeader) return;

    const content = tab.containerEl;
    const ensure = () => {
      if (content.firstElementChild && content.firstElementChild.classList.contains("tahoe-settings-hero")) return;
      content.querySelectorAll(":scope > .tahoe-settings-hero").forEach((h) => h.remove());
      content.prepend(this.buildHero(doc, win, tab));
    };
    ensure();
    // Pages re-render themselves (toggles, async lists); keep the card on top.
    this.heroObserver = new win.MutationObserver(() => ensure());
    this.heroObserver.observe(content, { childList: true });
  }

  buildHero(doc, win, tab) {
    const hero = doc.createElement("div");
    hero.className = "tahoe-settings-hero";
    hero.setAttribute("data-setting-id", tab.id);
    const nav = doc.querySelector(`.vertical-tab-nav-item[data-setting-id="${win.CSS.escape(tab.id)}"]`);
    const tint = nav ? win.getComputedStyle(nav).getPropertyValue("--tahoe-tile").trim() : "";
    if (tint) hero.style.setProperty("--tahoe-tile", tint);

    const icon = hero.appendChild(doc.createElement("div"));
    icon.className = "tahoe-settings-hero-icon";
    const navSvg = nav && nav.querySelector(".vertical-tab-nav-item-icon svg");
    if (tab.icon) setIcon(icon, tab.icon);
    else if (navSvg) icon.appendChild(navSvg.cloneNode(true));
    else setIcon(icon, "puzzle");

    const title = hero.appendChild(doc.createElement("div"));
    title.className = "tahoe-settings-hero-title";
    title.textContent = tab.name || "";

    const description = this.describeTab(tab);
    if (description) {
      const desc = hero.appendChild(doc.createElement("div"));
      desc.className = "tahoe-settings-hero-desc";
      desc.textContent = description;
    }
    return hero;
  }

  describeTab(tab) {
    if (PAGE_DESCRIPTIONS[tab.id]) return PAGE_DESCRIPTIONS[tab.id];
    const core = this.app.internalPlugins && this.app.internalPlugins.getPluginById && this.app.internalPlugins.getPluginById(tab.id);
    if (core && core.instance && core.instance.description) return core.instance.description;
    const manifest = this.app.plugins && this.app.plugins.manifests && this.app.plugins.manifests[tab.id];
    return manifest ? manifest.description : "";
  }

  tintCommunityTiles(doc) {
    doc.querySelectorAll('[data-section="community-plugins"] .vertical-tab-nav-item[data-setting-id]').forEach((item) => {
      if (item.style.getPropertyValue("--tahoe-tile")) return;
      // The theme already has a color for this one (Tahoe's own plugins and others).
      if (doc.defaultView.getComputedStyle(item).getPropertyValue("--tahoe-tile").trim()) return;
      const id = item.getAttribute("data-setting-id");
      let hash = 0;
      for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      item.style.setProperty("--tahoe-tile", TILE_PALETTE[hash % TILE_PALETTE.length]);
    });
  }

  removeSettingsDecorations() {
    const doc = this.settingsDocument();
    if (!doc) return;
    doc.querySelectorAll(".tahoe-settings-hero").forEach((h) => h.remove());
    doc.querySelectorAll('.vertical-tab-nav-item[style*="--tahoe-tile"]').forEach((i) => i.style.removeProperty("--tahoe-tile"));
  }

  /* Window controls: sit the traffic lights inside the Settings window's sidebar. */

  // The Settings window is a popout of this window: its BrowserWindow is the
  // one with the same place and size on screen.
  placeWindowControls(doc) {
    if (!Platform.isMacOS || !remote || !this.settings.windowControls) return;
    if (doc === document || !doc.body.classList.contains("is-popout-modal")) return;
    const win = doc.defaultView;
    const place = () => {
      if (win.closed) return;
      const bw = remote.BrowserWindow.getAllWindows().find((b) => {
        if (b.isDestroyed()) return false;
        const r = b.getBounds();
        return r.x === win.screenX && r.y === win.screenY && r.width === win.outerWidth && r.height === win.outerHeight;
      });
      if (!bw || !bw.setWindowButtonPosition) return;
      if (!this.originalButtonPositions.has(bw.id)) this.originalButtonPositions.set(bw.id, bw.getWindowButtonPosition());
      bw.setWindowButtonPosition({ x: 20, y: 20 });
    };
    // Right away, and again once the window has settled into place.
    place();
    window.setTimeout(place, 150);
    window.setTimeout(place, 600);
  }

  teardownWindowControls() {
    if (!remote || this.originalButtonPositions.size === 0) return;
    for (const bw of remote.BrowserWindow.getAllWindows()) {
      const original = this.originalButtonPositions.get(bw.id);
      if (original && !bw.isDestroyed()) bw.setWindowButtonPosition(original);
    }
    this.originalButtonPositions.clear();
  }
}

class TahoeGlassSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "sparkles";
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const level = new Setting(containerEl)
      .setName("Glass level")
      .setDesc("Clear lets more of the content through; Tinted is more opaque and easier to read.")
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(s.glassLevel)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.glassLevel = v;
            await this.plugin.saveSettings();
          })
      );
    // "Clear ——●—— Tinted"
    level.settingEl.addClass("tahoe-glass-level-setting");
    const clear = createSpan({ cls: "tahoe-glass-level-end", text: "Clear" });
    level.controlEl.prepend(clear);
    level.controlEl.createSpan({ cls: "tahoe-glass-level-end", text: "Tinted" });

    new Setting(containerEl)
      .setName("Refraction")
      .setDesc("Bend the content behind toolbar capsules, menus and the command palette at their edges.")
      .addToggle((t) =>
        t.setValue(s.refraction).onChange(async (v) => {
          s.refraction = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Strength")
      .setDesc("How far light bends at the rim.")
      .addSlider((sl) =>
        sl
          .setLimits(0.25, 2, 0.05)
          .setValue(s.strength)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.strength = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chromatic dispersion")
      .setDesc("Split colors slightly at the rim, like a real lens. Uses a little more GPU.")
      .addToggle((t) =>
        t.setValue(s.dispersion).onChange(async (v) => {
          s.dispersion = v;
          await this.plugin.saveSettings();
        })
      );

    const power = this.plugin.power || {};
    const now = this.plugin.saving ? `Now on: ${power.lowPower ? "low power mode" : power.battery ? "on battery" : "always"}.` : "Now off.";
    new Setting(containerEl)
      .setName("Battery saver")
      .setDesc(`Lighter glass everywhere (the bend without dispersion or glare) and no pointer highlight. ${now}`)
      .addDropdown((d) =>
        d
          .addOption("auto", "On battery or in low power mode")
          .addOption("always", "Always")
          .addOption("off", "Off")
          .setValue(s.batterySaver || "auto")
          .onChange(async (v) => {
            s.batterySaver = v;
            await this.plugin.saveSettings();
            this.plugin.powerChanged();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Lighter glass on the toolbar")
      .setDesc("Toolbar buttons and capsules use a simpler version of the effect (no dispersion or colored glare), which is cheaper while notes scroll underneath.")
      .addToggle((t) =>
        t.setValue(s.lighterToolbar).onChange(async (v) => {
          s.lighterToolbar = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Rim light")
      .setDesc("Glare where the edge faces the light (and softer opposite), and a thin bright Fresnel edge all the way round.")
      .addToggle((t) =>
        t.setValue(s.specular).onChange(async (v) => {
          s.specular = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Pointer highlight")
      .setDesc("A soft specular glow that follows the pointer across glass.")
      .addToggle((t) =>
        t.setValue(s.glow).onChange(async (v) => {
          s.glow = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Header cards on settings pages")
      .setDesc("Show a centered icon, title and description at the top of each settings page.")
      .addToggle((t) =>
        t.setValue(s.settingsHeader).onChange(async (v) => {
          s.settingsHeader = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.decorateSettings();
          else this.plugin.removeSettingsDecorations();
        })
      );

    if (Platform.isMacOS) {
      new Setting(containerEl)
        .setName("Window controls in the settings sidebar")
        .setDesc("Move the window buttons inside the sidebar of the settings window.")
        .addToggle((t) =>
          t.setValue(s.windowControls).onChange(async (v) => {
            s.windowControls = v;
            await this.plugin.saveSettings();
            this.plugin.teardownWindowControls();
            const doc = this.plugin.settingsDocument();
            if (v && doc) this.plugin.placeWindowControls(doc);
          })
        );
    }
  }
}
