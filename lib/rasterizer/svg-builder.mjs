/**
 * svg-builder.mjs — Convert a Figma node tree to an SVG string.
 *
 * Architecture: dispatcher pattern — each Figma node type maps to a render
 * function that returns the node's content in its own coordinates; renderNode
 * places it (transform) and applies the node's effects, blend mode and opacity.
 * Unknown types emit a magenta placeholder rect so renders never crash, and
 * every source property the builder does not draw is reported (see
 * frameToSvgWithReport).
 *
 * Parameter naming — two entry points, one shared engine:
 *
 *   slideToSvg(deck, slideNode)  — Slides entry point (.deck files)
 *     "deck" = a parsed .deck file. Expects SLIDE nodes, 1920×1080 viewport.
 *
 *   frameToSvg(fig, node)        — Design entry point (.fig files)
 *     "fig" = a parsed .fig file. Uses the node's own size as viewport.
 *
 *   Internal render functions all accept "deck" for historical reasons,
 *   but they are format-agnostic — they work on any Figma node tree
 *   regardless of whether it came from a .deck or .fig file.
 *   Both formats share the same binary codec (canvas.fig inside a ZIP).
 *
 * Paint model (docs/rasterizer/paint-model.md): every geometry — a vector's
 * fill regions, a rectangle, an ellipse, a text run — is drawn once per
 * visible paint, bottom to top, with the paint's opacity and blend mode.
 * Linear and radial gradients are SVG gradients mapped through the inverse of
 * the paint transform; angular, diamond and image paints are drawn in paint
 * space and clipped by the geometry. Strokes are Figma's own outline
 * (strokeGeometry, always centred on the path at twice the weight for INSIDE
 * and OUTSIDE), clipped to the fill geometry for INSIDE and cut out of it for
 * OUTSIDE.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVectorNetworkBlob } from 'openfig-core';
import { hashToHex } from '../core/image-helpers.mjs';
import { nid } from '../core/node-helpers.mjs';

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

// Per-slide ID counter — reset at the start of each slideToSvg call so IDs are unique within each SVG doc
let _svgIdSeq = 0;

// Source properties the current render does not draw: `nodeId property=value (why)`.
let _unsupported = new Set();
function unsupported(node, text) {
  _unsupported.add(`${node?.guid ? nid(node) : '?'} ${text}`);
}

// Outline mode: a VECTOR/OUTLINE mask draws its geometry opaque, whatever its paints.
let _outlineMode = 0;

// Crisp clips: clip and outline-mask geometry without antialiasing, for a
// rasterizer that supersamples — the coverage of a shape clipped by an equal
// clip is then its own, not squared (see frameToSvgWithReport options).
let _crispClips = false;

// Pixel grid: Figma draws a text baseline on a whole device pixel. `_pixelScale`
// is the export scale (0: no snapping); `_ctm` the node-to-export matrix
// [a, b, c, d, e, f] of the node being drawn.
let _pixelScale = 0;
let _ctm = [1, 0, 0, 1, 0, 0];
function multiply(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
function nodeMatrix(node) {
  const t = node.transform ?? {};
  return [t.m00 ?? 1, t.m10 ?? 0, t.m01 ?? 0, t.m11 ?? 1, t.m02 ?? 0, t.m12 ?? 0];
}
/**
 * A glyph baseline as Figma draws it: the baseline's distance from the top of
 * its line is a whole export pixel (the text box itself keeps its position).
 * Axis-aligned text only.
 */
function snapBaseline(lineY, y) {
  if (!_pixelScale || Math.abs(_ctm[1]) > 1e-9 || Math.abs(_ctm[2]) > 1e-9 || Math.abs(_ctm[3]) < 1e-9) return y;
  const k = Math.abs(_ctm[3]) * _pixelScale;
  return lineY + Math.round((y - lineY) * k) / k;
}
function crisp() { return _crispClips ? ' shape-rendering="crispEdges"' : ''; }

// ── Variables ─────────────────────────────────────────────────────────────────
//
// A paint colour bound to a variable (`colorVar`) is drawn with the variable's
// value in the mode active where the node sits: the nearest explicit
// `variableModeBySetMap` up the drawn tree (an instance's own over its
// component's), else the set's default mode. The file does not name a set's
// default: it is the mode whose values the file's own cached colours carry on
// nodes outside every explicit mode (their caches follow the default). The
// colour stored beside a binding is only a cache — an override copied from
// elsewhere keeps a stale one — and is used when the mode cannot be known.

let _modes = [];
const _variables = new WeakMap();

function setOf(variable) {
  return variable.variableSetID?.assetRef?.key ?? (variable.variableSetID?.guid ? `${variable.variableSetID.guid.sessionID}:${variable.variableSetID.guid.localID}` : null);
}

const sameColor = (a, b) => a && b && ['r', 'g', 'b', 'a'].every(k => Math.abs((a[k] ?? 1) - (b[k] ?? 1)) < 0.003);

function variablesOf(deck) {
  let index = _variables.get(deck);
  if (!index) {
    const byId = new Map();
    for (const node of deck.nodeMap?.values?.() ?? []) {
      if (node.type !== 'VARIABLE') continue;
      if (node.key) byId.set(`key:${node.key}`, node);
      if (node.guid) byId.set(`id:${nid(node)}`, node);
    }
    // Votes for each set's default mode from cached colours outside every explicit mode.
    const votes = new Map();
    const explicit = new Map();
    const underMode = (node) => {
      const id = node.guid ? nid(node) : null;
      if (id && explicit.has(id)) return explicit.get(id);
      const parent = node.parentIndex?.guid ? deck.getNode?.(`${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`) : null;
      const result = modeMap(node).size > 0 || (parent ? underMode(parent) : false);
      if (id) explicit.set(id, result);
      return result;
    };
    const vote = (holder, paint) => {
      const variable = byId.get(aliasTarget(holder?.colorVar?.value?.alias));
      if (!variable || !holder.color) return;
      // A solid paint caches the variable's alpha as its opacity.
      const cached = paint ? { ...holder.color, a: (holder.color.a ?? 1) * (holder.opacity ?? 1) } : holder.color;
      const matches = (variable.variableDataValues?.entries ?? []).filter(e => sameColor(e.variableData?.value?.colorValue, cached));
      if (matches.length !== 1) return;
      const set = setOf(variable), mode = `${matches[0].modeID?.sessionID}:${matches[0].modeID?.localID}`;
      if (!votes.has(set)) votes.set(set, new Map());
      votes.get(set).set(mode, (votes.get(set).get(mode) ?? 0) + 1);
    };
    for (const node of deck.nodeMap?.values?.() ?? []) {
      if (node.type === 'VARIABLE' || underMode(node)) continue;
      for (const paint of [...(node.fillPaints ?? []), ...(node.strokePaints ?? [])]) { vote(paint, paint.type === 'SOLID'); for (const stop of paint.stops ?? []) vote(stop, false); }
    }
    const defaults = new Map([...votes].map(([set, modes]) => [set, [...modes].sort((a, b) => b[1] - a[1])[0][0]]));
    index = { byId, defaults };
    _variables.set(deck, index);
  }
  return index;
}

function modeMap(node) {
  const entries = node?.variableModeBySetMap?.entries ?? [];
  const map = new Map();
  for (const e of entries) {
    const set = e.variableSetID?.assetRef?.key ?? (e.variableSetID?.guid ? `${e.variableSetID.guid.sessionID}:${e.variableSetID.guid.localID}` : null);
    if (set && e.variableModeID) map.set(set, `${e.variableModeID.sessionID}:${e.variableModeID.localID}`);
  }
  return map;
}

function withModes(map, fn) {
  if (!map.size) return fn();
  _modes.push(map);
  try { return fn(); } finally { _modes.pop(); }
}

function aliasTarget(alias) {
  if (alias?.assetRef?.key) return `key:${alias.assetRef.key}`;
  if (alias?.guid) return `id:${alias.guid.sessionID}:${alias.guid.localID}`;
  return null;
}

/** The colour a `colorVar` binding resolves to where the node is drawn, or null when it cannot be resolved. */
function variableColor(deck, node, binding) {
  let target = aliasTarget(binding?.value?.alias);
  for (let depth = 0; target && depth < 16; depth++) {
    const { byId, defaults } = variablesOf(deck);
    const variable = byId.get(target);
    if (!variable) { unsupported(node, `colorVar ${target.slice(4)}: variable not in the source (cached colour drawn)`); return null; }
    const set = setOf(variable);
    let mode = null;
    for (let i = _modes.length - 1; i >= 0 && mode === null; i--) mode = _modes[i].get(set) ?? null;
    mode ??= defaults.get(set) ?? null;
    if (mode === null) return null;
    const entries = variable.variableDataValues?.entries ?? [];
    const entry = entries.find(e => `${e.modeID?.sessionID}:${e.modeID?.localID}` === mode);
    if (!entry) return null;
    const value = entry?.variableData?.value;
    if (value?.colorValue) return value.colorValue;
    target = aliasTarget(value?.alias);
  }
  return null;
}

/** A paint (or gradient stop, or effect) with its variable-bound colour resolved for the current mode. */
function resolvedColor(deck, node, holder) {
  if (!holder?.colorVar) return holder?.color;
  return variableColor(deck, node, holder.colorVar) ?? holder.color;
}

function resolvePaint(deck, node, paint) {
  if (!paint) return paint;
  const bound = paint.colorVar ? variableColor(deck, node, paint.colorVar) : null;
  const stops = paint.stops?.map(s => ({ ...s, color: resolvedColor(deck, node, s) ?? s.color }));
  // A solid bound to a variable draws the variable's colour, its alpha as the paint's opacity (as Figma caches it).
  const solid = bound && paint.type === 'SOLID' ? { color: { ...bound, a: 1 }, opacity: bound.a ?? 1 } : bound ? { color: bound } : {};
  return { ...paint, ...solid, ...(stops ? { stops } : {}) };
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function cssColor(color, opacity = 1) {
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const a = ((color.a ?? 1) * opacity).toFixed(4);
  return `rgba(${r},${g},${b},${a})`;
}

function rgb(color) {
  return `rgb(${Math.round((color?.r ?? 0) * 255)},${Math.round((color?.g ?? 0) * 255)},${Math.round((color?.b ?? 0) * 255)})`;
}

function num(v) { return +(+v).toFixed(4); }

function resolveFill(fillPaints) {
  if (!fillPaints?.length) return null;
  const p = fillPaints.find(p => p.visible !== false && p.type === 'SOLID');
  if (!p) return null;
  return cssColor(p.color ?? {}, p.opacity ?? 1);
}

function appendDefs(defs, extra) {
  if (!extra) return defs;
  return defs
    ? defs.replace('</defs>', `${extra}</defs>`)
    : `<defs>${extra}</defs>`;
}

/** Get effective fillPaints for any node type. */
function getFillPaints(node) {
  if (node.fillPaints?.length) return node.fillPaints;
  // SHAPE_WITH_TEXT stores fill in nodeGenerationData.overrides[0].fillPaints
  return node.nodeGenerationData?.overrides?.[0]?.fillPaints ?? null;
}

function visiblePaints(paints) {
  return (paints ?? []).filter(p => p && p.visible !== false && (p.opacity ?? 1) > 0);
}

function strokeSpec(node) {
  if (!node.strokeWeight || node.strokeWeight === 0) return null;
  const color = resolveFill(node.strokePaints) ?? 'none';
  if (color === 'none') return null;
  return {
    color,
    width: node.strokeWeight,
    align: node.strokeAlign ?? 'CENTER',
  };
}

function rectStrokeSvg(x, y, w, h, rx, stroke) {
  if (!stroke) return '';
  let sx = x;
  let sy = y;
  let sw = w;
  let sh = h;
  let srx = Math.min(rx, w / 2, h / 2);

  if (stroke.align === 'INSIDE') {
    sx += stroke.width / 2;
    sy += stroke.width / 2;
    sw -= stroke.width;
    sh -= stroke.width;
    srx = Math.max(0, srx - stroke.width / 2);
  } else if (stroke.align === 'OUTSIDE') {
    sx -= stroke.width / 2;
    sy -= stroke.width / 2;
    sw += stroke.width;
    sh += stroke.width;
    srx += stroke.width / 2;
  }

  if (sw <= 0 || sh <= 0) return '';
  return `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${srx}" ry="${srx}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}"/>`;
}

// ── Transform helpers ─────────────────────────────────────────────────────────

/** Return the full SVG transform attribute value for a node.
 *  Uses `translate(x,y)` for pure translations, `matrix(a,b,c,d,e,f)` when
 *  rotation or scale is present. */
function svgTransform(node) {
  const t = node.transform;
  if (!t) return 'translate(0,0)';
  const m00 = t.m00 ?? 1, m01 = t.m01 ?? 0, m02 = t.m02 ?? 0;
  const m10 = t.m10 ?? 0, m11 = t.m11 ?? 1, m12 = t.m12 ?? 0;
  // Pure translation — no rotation or scale
  if (Math.abs(m00 - 1) < 1e-6 && Math.abs(m01) < 1e-6 &&
      Math.abs(m10) < 1e-6 && Math.abs(m11 - 1) < 1e-6) {
    return `translate(${m02},${m12})`;
  }
  // Use high precision for rotation/scale — 2dp on a 2000px element = ~8px error
  const h = v => +v.toFixed(6);
  return `matrix(${h(m00)},${h(m10)},${h(m01)},${h(m11)},${f(m02)},${f(m12)})`;
}

function size(node) {
  return { w: node.size?.x ?? 0, h: node.size?.y ?? 0 };
}

/**
 * The SVG matrix that carries paint space (the unit square a Figma paint is
 * defined in) onto the node's w×h box: scale(w, h) · inverse(paint.transform).
 */
function paintSpace(t, w, h) {
  const m00 = t?.m00 ?? 1, m01 = t?.m01 ?? 0, m02 = t?.m02 ?? 0;
  const m10 = t?.m10 ?? 0, m11 = t?.m11 ?? 1, m12 = t?.m12 ?? 0;
  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < 1e-12) return null;
  const i00 = m11 / det, i01 = -m01 / det, i10 = -m10 / det, i11 = m00 / det;
  const i02 = -(i00 * m02 + i01 * m12), i12 = -(i10 * m02 + i11 * m12);
  return [i00 * w, i10 * h, i01 * w, i11 * h, i02 * w, i12 * h].map(v => +v.toFixed(6));
}

// ── Paints ────────────────────────────────────────────────────────────────────

const BLEND_MODES = {
  MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

/** ` style="mix-blend-mode:…"` for a Figma blend mode; '' for normal / pass-through. */
function blendStyle(node, mode) {
  if (!mode || mode === 'NORMAL' || mode === 'PASS_THROUGH') return '';
  const css = BLEND_MODES[mode];
  if (!css) { unsupported(node, `blendMode=${mode}`); return ''; }
  return ` style="mix-blend-mode:${css}"`;
}

function gradientStops(paint) {
  return [...(paint.stops ?? [])]
    .sort((a, b) => a.position - b.position)
    .map(s => `<stop offset="${num(s.position)}" stop-color="${rgb(s.color)}"${(s.color?.a ?? 1) !== 1 ? ` stop-opacity="${num(s.color.a)}"` : ''}/>`)
    .join('');
}

/** Colour of a gradient at t (stops sorted, clamped at the ends). */
function gradientColorAt(stops, t) {
  if (!stops.length) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= stops[0].position) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (t <= b.position) {
      const k = b.position === a.position ? 1 : (t - a.position) / (b.position - a.position);
      const mix = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * k;
      return { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a ?? 1, b.color.a ?? 1) };
    }
  }
  return stops[stops.length - 1].color;
}

/** The bytes of an image paint, or null (reported) when the file names them but they are not at hand. */
function imageBytes(deck, node, paint) {
  const hashBytes = paint.image?.hash;
  const hash = hashBytes?.length ? hashToHex(hashBytes)
    : hashBytes && typeof hashBytes === 'object' ? hashToHex(Object.values(hashBytes))
    : paint.image?.name;
  if (!hash) throw new Error('Visible IMAGE fill is missing its asset hash');
  try {
    if (!deck.imagesDir) throw new Error('no imagesDir');
    return readFileSync(join(deck.imagesDir, hash));
  } catch {
    unsupported(node, `fillPaints IMAGE ${hash}: image bytes not at hand`);
    return null;
  }
}

function imageMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/png';
}

/** Intrinsic pixel size of a PNG/JPEG/GIF, or null. */
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0x47 && buf[1] === 0x49) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xFF) { off++; continue; }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
  }
  return null;
}

/** An image paint drawn in the node's w×h box (to be clipped by the geometry). */
function imageContent(deck, node, paint, w, h) {
  const filters = paint.paintFilter ?? paint.imageFilters;
  if (filters && Object.values(filters).some(v => typeof v === 'number' && Math.abs(v) > 1e-6)) {
    unsupported(node, `fillPaints IMAGE paintFilter=${JSON.stringify(filters)}`);
  }
  const buf = imageBytes(deck, node, paint);
  if (!buf) return null;
  const href = `data:${imageMime(buf)};base64,${buf.toString('base64')}`;
  const mode = paint.imageScaleMode ?? 'FILL';
  if (mode === 'TILE') {
    const dims = imageSize(buf) ?? { w: paint.originalImageWidth ?? 100, h: paint.originalImageHeight ?? 100 };
    const tw = dims.w * (paint.scale ?? 1), th = dims.h * (paint.scale ?? 1);
    const id = `img-tile-${++_svgIdSeq}`;
    return {
      defs: `<pattern id="${id}" x="0" y="0" width="${num(tw)}" height="${num(th)}" patternUnits="userSpaceOnUse"><image href="${href}" width="${num(tw)}" height="${num(th)}" preserveAspectRatio="none"/></pattern>`,
      content: `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#${id})"/>`,
    };
  }
  if (mode === 'STRETCH') {
    // Crop: the paint transform maps the node's unit box onto the image's unit box.
    const m = paintSpace(paint.transform, w, h);
    if (m) return { defs: '', content: `<image href="${href}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${m.join(',')})"/>` };
  }
  const par = mode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice';
  const rotation = ((paint.rotation ?? 0) % 360 + 360) % 360;
  if (rotation === 0) {
    return { defs: '', content: `<image href="${href}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${par}"/>` };
  }
  const quarter = rotation === 90 || rotation === 270;
  const iw = quarter ? h : w, ih = quarter ? w : h;
  return { defs: '', content: `<g transform="rotate(${rotation},${num(w / 2)},${num(h / 2)})"><image href="${href}" x="${num((w - iw) / 2)}" y="${num((h - ih) / 2)}" width="${num(iw)}" height="${num(ih)}" preserveAspectRatio="${par}"/></g>` };
}

/** An angular gradient drawn in paint space as fine wedges (SVG has no conic gradient). */
function angularContent(paint, w, h) {
  const m = paintSpace(paint.transform, w, h);
  if (!m) return null;
  const stops = [...(paint.stops ?? [])].sort((a, b) => a.position - b.position);
  const STEPS = 360;
  const R = 8;
  const wedges = [];
  for (let i = 0; i < STEPS; i++) {
    const a0 = (i / STEPS) * 2 * Math.PI, a1 = ((i + 1.5) / STEPS) * 2 * Math.PI;
    const c = gradientColorAt(stops, (i + 0.5) / STEPS);
    const p = (a) => `${num(0.5 + R * Math.cos(a))},${num(0.5 + R * Math.sin(a))}`;
    wedges.push(`<path d="M0.5,0.5L${p(a0)}L${p(a1)}Z" fill="${rgb(c)}"${(c.a ?? 1) !== 1 ? ` fill-opacity="${num(c.a)}"` : ''}/>`);
  }
  return { defs: '', content: `<g transform="matrix(${m.join(',')})">${wedges.join('')}</g>` };
}

/** A diamond gradient drawn in paint space: one exact linear gradient per quadrant. */
function diamondContent(paint, w, h) {
  const m = paintSpace(paint.transform, w, h);
  if (!m) return null;
  const stops = gradientStops(paint);
  const R = 8;
  const quads = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  let defs = '';
  const parts = [];
  for (const [sx, sy] of quads) {
    const id = `diamond-${++_svgIdSeq}`;
    defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0.5" y1="0.5" x2="${0.5 + sx * 0.25}" y2="${0.5 + sy * 0.25}">${stops}</linearGradient>`;
    const x = sx > 0 ? 0.5 : 0.5 - R, y = sy > 0 ? 0.5 : 0.5 - R;
    parts.push(`<rect x="${x}" y="${y}" width="${R}" height="${R}" fill="url(#${id})"/>`);
  }
  return { defs, content: `<g transform="matrix(${m.join(',')})">${parts.join('')}</g>` };
}

/**
 * One paint as an SVG fill: `{ defs, fill, opacity }` for a paint server
 * (solid, linear, radial) or `{ defs, content, opacity }` for content drawn in
 * the node box and clipped by the geometry (image, angular, diamond).
 */
function paintFill(deck, node, bound, w, h) {
  if (_outlineMode) return { defs: '', fill: '#ffffff', opacity: 1 };
  const paint = resolvePaint(deck, node, bound);
  const opacity = paint.opacity ?? 1;
  switch (paint.type) {
    case 'SOLID':
      return { defs: '', fill: rgb(paint.color), opacity: (paint.color?.a ?? 1) * opacity };
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL': {
      const m = paintSpace(paint.transform, w, h);
      if (!m || !paint.stops?.length) return null;
      const id = `grad-${++_svgIdSeq}`;
      const geometry = paint.type === 'GRADIENT_LINEAR'
        ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="matrix(${m.join(',')})">`
        : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="matrix(${m.join(',')})">`;
      const close = paint.type === 'GRADIENT_LINEAR' ? '</linearGradient>' : '</radialGradient>';
      return { defs: `${geometry}${gradientStops(paint)}${close}`, fill: `url(#${id})`, opacity };
    }
    case 'GRADIENT_ANGULAR': {
      const drawn = angularContent(paint, w, h);
      return drawn && { ...drawn, opacity };
    }
    case 'GRADIENT_DIAMOND': {
      const drawn = diamondContent(paint, w, h);
      return drawn && { ...drawn, opacity };
    }
    case 'IMAGE': {
      const drawn = imageContent(deck, node, paint, w, h);
      return drawn && { ...drawn, opacity };
    }
    default:
      unsupported(node, `paint type=${paint.type}`);
      return null;
  }
}

/**
 * A geometry drawn once per visible paint. `shape.draw(attrs)` emits the
 * geometry's elements with the given attributes; `shape.clip()` emits them
 * for a clipPath.
 */
function paintLayers(deck, node, shape, paints, w, h) {
  const layers = [];
  let defs = '';
  const list = _outlineMode ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] : visiblePaints(paints);
  for (const paint of list) {
    const p = paintFill(deck, node, paint, w, h);
    if (!p) continue;
    defs += p.defs;
    const blend = _outlineMode ? crisp() : blendStyle(node, paint.blendMode);
    if (p.fill !== undefined) {
      const op = p.opacity < 1 ? ` fill-opacity="${num(p.opacity)}"` : '';
      layers.push(shape.draw(`fill="${p.fill}"${op}${blend}`));
    } else {
      const id = `paint-clip-${++_svgIdSeq}`;
      defs += `<clipPath id="${id}">${shape.clip()}</clipPath>`;
      const op = p.opacity < 1 ? ` opacity="${num(p.opacity)}"` : '';
      layers.push(`<g clip-path="url(#${id})"${op}${blend}>${p.content}</g>`);
    }
  }
  return { defs, svg: layers.join('\n') };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Decoded path entries of a fillGeometry / strokeGeometry list: `[{ d, rule, styleID }]`. */
function geometryPaths(deck, geometry) {
  const blobs = deck.message?.blobs;
  if (!geometry?.length || !blobs) return [];
  const out = [];
  for (const geo of geometry) {
    const d = decodeCmdBlob(blobs, geo.commandsBlob);
    if (d) out.push({ d, rule: (geo.windingRule === 'EVENODD' || geo.windingRule === 'ODD') ? 'evenodd' : 'nonzero', styleID: geo.styleID ?? 0 });
  }
  return out;
}

/**
 * Corner radii [top-left, top-right, bottom-right, bottom-left] as Figma draws
 * them: each corner shrinks by the tighter of its two sides, a side fitting
 * when its two radii sum to at most its length.
 */
function cornerRadii(node, w, h) {
  const r = node.rectangleCornerRadiiIndependent
    ? [node.rectangleTopLeftCornerRadius, node.rectangleTopRightCornerRadius, node.rectangleBottomRightCornerRadius, node.rectangleBottomLeftCornerRadius]
    : [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  const [tl, tr, br, bl] = r.map(v => Math.max(0, v ?? 0));
  const fit = (length, a, b) => (a + b > length && a + b > 0 ? length / (a + b) : 1);
  const top = fit(w, tl, tr), right = fit(h, tr, br), bottom = fit(w, br, bl), left = fit(h, bl, tl);
  return [tl * Math.min(top, left), tr * Math.min(top, right), br * Math.min(bottom, right), bl * Math.min(bottom, left)];
}

function roundedRectPath(w, h, [tl, tr, br, bl]) {
  if (!(tl || tr || br || bl)) return `M0,0H${num(w)}V${num(h)}H0Z`;
  return `M${num(tl)},0H${num(w - tr)}${tr ? `A${num(tr)},${num(tr)} 0 0 1 ${num(w)},${num(tr)}` : ''}`
    + `V${num(h - br)}${br ? `A${num(br)},${num(br)} 0 0 1 ${num(w - br)},${num(h)}` : ''}`
    + `H${num(bl)}${bl ? `A${num(bl)},${num(bl)} 0 0 1 0,${num(h - bl)}` : ''}`
    + `V${num(tl)}${tl ? `A${num(tl)},${num(tl)} 0 0 1 ${num(tl)},0` : ''}Z`;
}

const RECT_LIKE = new Set(['ROUNDED_RECTANGLE', 'RECTANGLE', 'FRAME', 'SYMBOL', 'INSTANCE', 'SECTION']);

/** Bounds of a path's coordinates (control points included). */
function pathBounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    const values = p.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi)?.map(Number) ?? [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      minX = Math.min(minX, values[i]); maxX = Math.max(maxX, values[i]);
      minY = Math.min(minY, values[i + 1]); maxY = Math.max(maxY, values[i + 1]);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The node's fill geometry as path entries. A rectangle-like node or a whole
 * ellipse is its size and radii (an override that resizes it or changes a
 * radius leaves the stored geometry stale); Figma's stored geometry is kept
 * where only it can say the shape — corner smoothing whose outline still
 * spans the node, arcs, vectors, booleans.
 */
function shapePaths(deck, node) {
  const own = geometryPaths(deck, node.fillGeometry);
  const { w, h } = size(node);
  if (RECT_LIKE.has(node.type)) {
    if (own.length && (node.cornerSmoothing ?? 0) > 0) {
      const b = pathBounds(own);
      if (Math.abs(b.minX) < 0.5 && Math.abs(b.minY) < 0.5 && Math.abs(b.maxX - w) < 0.5 && Math.abs(b.maxY - h) < 0.5) return own;
    }
    return [{ d: roundedRectPath(w, h, cornerRadii(node, w, h)), rule: 'nonzero', styleID: 0 }];
  }
  const arc = node.arcData;
  const whole = !arc || ((arc.innerRadius ?? 0) === 0 && Math.abs((arc.endingAngle ?? 2 * Math.PI) - (arc.startingAngle ?? 0) - 2 * Math.PI) < 1e-3);
  if (node.type === 'ELLIPSE' && (whole || !own.length)) {
    return [{ d: `M${num(w)},${num(h / 2)}A${num(w / 2)},${num(h / 2)} 0 1 1 0,${num(h / 2)}A${num(w / 2)},${num(h / 2)} 0 1 1 ${num(w)},${num(h / 2)}Z`, rule: 'nonzero', styleID: 0 }];
  }
  return own;
}

function pathShape(paths) {
  return {
    draw: attrs => paths.map(p => `<path d="${p.d}"${p.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''} ${attrs}/>`).join(''),
    clip: () => paths.map(p => `<path d="${p.d}"${p.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}${crisp()}/>`).join(''),
  };
}

/**
 * The node's strokes, on top of its fills. strokeGeometry is Figma's outline
 * of a centred stroke, twice the weight wide for INSIDE and OUTSIDE: INSIDE is
 * clipped to the fill geometry, OUTSIDE has the fill geometry cut out.
 */
function strokeLayers(deck, node, fillPaths) {
  const paints = visiblePaints(node.strokePaints);
  const weight = node.strokeWeight ?? 0;
  if (!paints.length || !(weight > 0)) return { defs: '', svg: '' };
  const { w, h } = size(node);
  const align = node.strokeAlign ?? 'CENTER';
  const outline = geometryPaths(deck, node.strokeGeometry);
  let shape;
  if (outline.length) {
    shape = pathShape(outline);
  } else if (fillPaths.length) {
    // No outline in the source: stroke the fill geometry itself (twice as wide when one side is cut away).
    const width = align === 'CENTER' ? weight : weight * 2;
    const cap = node.strokeCap === 'ROUND' ? 'round' : node.strokeCap === 'SQUARE' ? 'square' : 'butt';
    const join = node.strokeJoin === 'ROUND' ? 'round' : node.strokeJoin === 'BEVEL' ? 'bevel' : 'miter';
    const dash = Array.isArray(node.dashPattern) && node.dashPattern.length ? ` stroke-dasharray="${node.dashPattern.join(' ')}"` : '';
    shape = {
      draw: attrs => fillPaths.map(p => `<path d="${p.d}" fill="none" ${attrs.replace(/\bfill(-opacity)?=/g, 'stroke$1=')} stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="${join}"${dash}/>`).join(''),
      clip: () => fillPaths.map(p => `<path d="${p.d}"${crisp()}/>`).join(''),
    };
    if (paints.some(p => p.type !== 'SOLID' && p.type !== 'GRADIENT_LINEAR' && p.type !== 'GRADIENT_RADIAL')) {
      unsupported(node, 'strokePaints without strokeGeometry: only solid and linear/radial gradients');
    }
  } else {
    return { defs: '', svg: '' };
  }
  const layers = paintLayers(deck, node, shape, paints, w, h);
  if (!layers.svg || align === 'CENTER' || !fillPaths.length) return layers;
  let defs = layers.defs;
  if (align === 'INSIDE') {
    const id = `stroke-inside-${++_svgIdSeq}`;
    defs += `<clipPath id="${id}">${pathShape(fillPaths).clip()}</clipPath>`;
    return { defs, svg: `<g clip-path="url(#${id})">${layers.svg}</g>` };
  }
  const id = `stroke-outside-${++_svgIdSeq}`;
  const m = weight * 2 + 1;
  defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="${num(-m)}" y="${num(-m)}" width="${num(w + 2 * m)}" height="${num(h + 2 * m)}">`
    + `<rect x="${num(-m)}" y="${num(-m)}" width="${num(w + 2 * m)}" height="${num(h + 2 * m)}" fill="#fff"/>`
    + pathShape(fillPaths).draw(`fill="#000"${crisp()}`) + '</mask>';
  return { defs, svg: `<g mask="url(#${id})">${layers.svg}</g>` };
}

function wrapDefs(defs) {
  return defs ? `<defs>${defs}</defs>` : '';
}

// ── Node renderers (content in the node's own coordinates) ───────────────────

/** A shape (rectangle, ellipse, star, polygon): fills, then strokes. */
function renderShape(deck, node) {
  const { w, h } = size(node);
  const paths = shapePaths(deck, node);
  const fills = paintLayers(deck, node, pathShape(paths), getFillPaints(node), w, h);
  const strokes = _outlineMode ? { defs: '', svg: '' } : strokeLayers(deck, node, paths);
  const inner = [fills.svg, strokes.svg].filter(Boolean).join('\n');
  if (!inner) return '';
  return `${wrapDefs(fills.defs + strokes.defs)}${inner}`;
}

// ── Text ──────────────────────────────────────────────────────────────────────

function resolveLineHeight(lh, fontSize) {
  if (!lh) return fontSize * 1.2;
  switch (lh.units) {
    case 'RAW':     return lh.value * fontSize;
    case 'PERCENT': return (lh.value / 100) * fontSize;
    case 'PIXELS':  return lh.value;
    default:        return fontSize * 1.2;
  }
}

// ── Text width approximation (Inter-like proportional metrics) ──────────────
//
// Used only when wrapping text in the fallback layout path (no derivedTextData,
// e.g. programmatically-generated text). Values are expressed as a fraction of
// fontSize and tuned for Inter Regular — close enough for word-wrap decisions.
const _NARROW   = new Set('iIlt.,:;!|\'`"()[]{}/\\'.split(''));
const _WIDE     = new Set('ABCDEFGHJKLNOPQRSTUVXYZmw'.split(''));
const _XWIDE    = new Set('MW@%'.split(''));
function approxCharWidth(ch, fontSize) {
  if (ch === ' ') return fontSize * 0.28;
  if (_NARROW.has(ch))  return fontSize * 0.28;
  if (_XWIDE.has(ch))   return fontSize * 0.85;
  if (_WIDE.has(ch))    return fontSize * 0.66;
  return fontSize * 0.52; // default for lowercase + digits + punctuation
}

function approxTextWidth(str, fontSize, letterSpacingPx = 0) {
  let w = 0;
  for (let i = 0; i < str.length; i++) w += approxCharWidth(str[i], fontSize);
  if (str.length > 1) w += letterSpacingPx * (str.length - 1);
  return w;
}

/**
 * Word-wrap a single line into multiple lines that each fit within maxWidth.
 * Breaks on ASCII spaces only. If a single "word" overflows maxWidth it is
 * placed on its own line (no mid-word break).
 * @param {string} line
 * @param {number} fontSize
 * @param {number} maxWidth
 * @param {number} letterSpacingPx
 * @returns {string[]}
 */
function wrapLineByWidth(line, fontSize, maxWidth, letterSpacingPx = 0) {
  if (!line) return [line];
  if (!(maxWidth > 0)) return [line];
  if (approxTextWidth(line, fontSize, letterSpacingPx) <= maxWidth) return [line];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? cur + ' ' + word : word;
    if (approxTextWidth(candidate, fontSize, letterSpacingPx) <= maxWidth || !cur) {
      cur = candidate;
    } else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** A font family as an attribute value (escaped, with a generic fallback). */
function familyAttr(family) {
  return `${esc(family).replace(/"/g, '&quot;')}, sans-serif`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Detect stale derivedTextData: text was edited outside Figma but glyph layout
 * wasn't recomputed. Returns true when the layout clearly doesn't match the text.
 */
function isStaleLayout(chars, baselines, glyphs) {
  if (!chars) return false;
  // No derivedTextData at all (e.g. programmatically created text)
  if (!baselines?.length && !glyphs?.length) return true;
  const len = chars.length;

  if (baselines?.length) {
    const lastEnd = baselines[baselines.length - 1]?.endCharacter;
    // baselines endCharacter should match chars length (±1 for trailing newline)
    if (lastEnd != null && Math.abs(lastEnd - len) > 1) return true;
  }

  if (glyphs?.length) {
    const maxFirstChar = glyphs.reduce((max, g) =>
      Math.max(max, g.firstCharacter ?? 0), 0);
    if (maxFirstChar >= len) return true;        // glyphs point beyond new text
    if (len > maxFirstChar + 3) return true;     // new text much longer than glyph coverage
  }

  return false;
}

/**
 * Fallback text layout for stale derivedTextData.
 * Emits line-level <tspan> elements and lets resvg handle per-glyph layout.
 * Uses original baseline metrics (line height, ascent, position) where available
 * since those are style-dependent, not content-dependent.
 * Auto-scales font size down when new text is longer than the original.
 * Returns { tspans, fontSize } so the caller can use the adjusted size.
 */
function fallbackTextTspans(dispChars, fontSize, node, letterSpacingPx = 0) {
  const baselines = node.derivedTextData?.baselines;
  const rawLines = dispChars.split('\n');
  // Drop trailing empty line from trailing newline
  if (rawLines.length > 1 && !rawLines[rawLines.length - 1]) rawLines.pop();

  // Use original baseline metrics for spacing (style property, still valid).
  // When baselines are absent (programmatically-generated text), honour the
  // node's own lineHeight (RAW/PERCENT/PIXELS) rather than falling back to
  // a hard-coded 1.2× multiplier, so hand-authored lineHeight values render
  // correctly. Ultimate default 1.25× per spec.
  const lhFromNode = node.lineHeight ? resolveLineHeight(node.lineHeight, fontSize) : null;
  let lineHeightPx = baselines?.[0]?.lineHeight ?? lhFromNode ?? fontSize * 1.25;
  let lineAscent   = baselines?.[0]?.lineAscent ?? fontSize * 0.8;

  // Auto-fit: scale font size down when new text is longer than original.
  // Uses character count ratio per line as a proxy for width ratio.
  const nodeW = node.size?.x ?? 1920;
  const nodeH = node.size?.y ?? 0;
  let scale = 1;
  if (baselines?.length) {
    const maxOrigCharsPerLine = Math.max(...baselines.map(b =>
      Math.max(0, (b.endCharacter ?? 0) - (b.firstCharacter ?? 0))));
    const maxNewCharsPerLine = Math.max(...rawLines.map(l => l.length));

    // Scale down if widest new line has more chars than widest original line
    if (maxNewCharsPerLine > maxOrigCharsPerLine && maxOrigCharsPerLine > 0) {
      scale = Math.min(scale, maxOrigCharsPerLine / maxNewCharsPerLine);
    }

    // Also scale down if more lines than original (would overflow vertically)
    if (rawLines.length > baselines.length && nodeH > 0) {
      scale = Math.min(scale, baselines.length / rawLines.length);
    }

    scale = Math.max(scale, 0.15); // don't shrink below 15%
  }

  const adjFontSize    = fontSize * scale;
  const adjLineHeight  = lineHeightPx * scale;
  const adjLineAscent  = lineAscent * scale;
  const adjLetterSpacingPx = letterSpacingPx * scale;

  // Horizontal alignment → text-anchor + x position
  const align  = node.textAlignHorizontal ?? 'LEFT';
  const anchor = align === 'CENTER' ? 'middle' : align === 'RIGHT' ? 'end' : 'start';
  const anchorX = align === 'CENTER' ? nodeW / 2 : align === 'RIGHT' ? nodeW : 0;

  // Use first baseline position if available (preserves Figma's padding/offset),
  // otherwise compute from vertical alignment
  let startX, startY;
  if (baselines?.[0]?.position) {
    startX = align === 'LEFT' ? baselines[0].position.x : anchorX;
    // Scale startY relative to the baseline position for auto-fit
    startY = baselines[0].position.y * scale;
  } else {
    startX = anchorX;
    const vAlign = node.textAlignVertical ?? 'TOP';
    // Placeholder; recomputed below once we know the wrapped line count.
    startY = adjLineAscent;
    // Mark that we need to recompute after word-wrap based on final line count
    // (kept here for readability — actual recompute below).
    if (vAlign !== 'TOP') startY = null;
  }

  // Word-wrap each hard-newline-delimited line to fit within the node's width.
  // Only wrap when the node has an explicit size.x and ≥1 hard line overflows.
  // Preserves alignment via the outer text-anchor/startX logic.
  const lineType0 = null;
  const linesMeta = node.textData?.lines ?? [];
  // Interpret each rawLine and wrap — track (text, metaIndex) for each output line
  const wrapped = []; // array of { text, metaIndex }
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    // Reserve horizontal space consumed by list marker + indent on this meta line
    const meta = linesMeta[i];
    const indent = (meta?.indentationLevel ?? 0) * adjFontSize * 0.8;
    const effectiveMaxW = Math.max(0, nodeW - indent);
    const pieces = wrapLineByWidth(rawLine, adjFontSize, effectiveMaxW, adjLetterSpacingPx);
    for (const piece of pieces) wrapped.push({ text: piece, metaIndex: i });
  }

  // Recompute startY for non-TOP vertical alignment now that we know final line count
  if (startY === null) {
    const totalH = wrapped.length * adjLineHeight;
    const nodeHH = node.size?.y ?? totalH;
    const vAlign = node.textAlignVertical ?? 'TOP';
    startY = vAlign === 'CENTER' ? (nodeHH - totalH) / 2 + adjLineAscent
           : vAlign === 'BOTTOM' ? nodeHH - totalH + adjLineAscent
           : adjLineAscent;
  }

  // List marker support: read lineType from textData.lines. Only apply marker
  // to the first visual line of a wrapped paragraph.
  let orderedCounter = 0;
  let lastMetaIdx = -1;

  const tspans = wrapped.map(({ text, metaIndex }, i) => {
    const y = startY + i * adjLineHeight;
    const meta = linesMeta[metaIndex];
    const lineType = meta?.lineType;
    const indent = (meta?.indentationLevel ?? 0) * adjFontSize * 0.8;
    let prefix = '';
    const isFirstVisualOfMeta = metaIndex !== lastMetaIdx;
    if (isFirstVisualOfMeta) {
      if (lineType === 'UNORDERED_LIST') {
        prefix = '\u2022 ';  // bullet •
        orderedCounter = 0;
      } else if (lineType === 'ORDERED_LIST') {
        orderedCounter++;
        prefix = `${orderedCounter}. `;
      } else {
        orderedCounter = 0;
      }
      lastMetaIdx = metaIndex;
    }
    const x = startX + indent;
    return `<tspan x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}">${esc(prefix + text) || ' '}</tspan>`;
  }).join('');

  return { tspans, fontSize: adjFontSize };
}

function glyphSlice(chars, glyphs, index) {
  const g = glyphs[index];
  if (g.firstCharacter == null) {
    throw new Error('Unexpected glyph without firstCharacter');
  }
  let nextChar = null;
  for (let j = index + 1; j < glyphs.length; j++) {
    const fc = glyphs[j].firstCharacter;
    if (fc != null && fc > g.firstCharacter) {
      nextChar = fc;
      break;
    }
  }
  return chars.slice(g.firstCharacter, nextChar ?? (g.firstCharacter + 1));
}


const STYLE_WEIGHTS = [
  [/hairline|thin/i, 100], [/ultra\s*light|extra\s*light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600], [/ultra\s*bold|extra\s*bold|heavy/i, 800], [/black/i, 900], [/bold/i, 700],
];

function styleAttrsFromFontName(fontName, derivedFontWeight) {
  const style = fontName?.style ?? 'Regular';
  const named = STYLE_WEIGHTS.find(([pattern]) => pattern.test(style))?.[1] ?? 400;
  const weight = String(derivedFontWeight || named);
  const italic = /italic|oblique/i.test(style) ? 'italic' : 'normal';
  return { weight, italic };
}

/** The characters one glyph draws: up to the next glyph's first character (a whole code point at least). */
function glyphText(chars, glyphs, index) {
  const first = glyphs[index].firstCharacter;
  let next = null;
  for (let j = index + 1; j < glyphs.length; j++) {
    const fc = glyphs[j].firstCharacter;
    if (fc != null && fc > first) { next = fc; break; }
  }
  const code = chars.codePointAt(first);
  const own = code !== undefined && code > 0xFFFF ? 2 : 1;
  return chars.slice(first, Math.max(next ?? first + own, first + own));
}

function renderText(deck, node) {
  const chars = node.textData?.characters ?? '';
  if (!chars.trim()) return '';
  const dispChars = node.textCase === 'UPPER' ? chars.toUpperCase()
                  : node.textCase === 'LOWER' ? chars.toLowerCase()
                  : chars;
  if (node.textCase && !['ORIGINAL', 'UPPER', 'LOWER'].includes(node.textCase)) {
    unsupported(node, `textCase=${node.textCase}`);
  }
  if (node.fontVariations?.length) unsupported(node, `fontVariations=${JSON.stringify(node.fontVariations.map(v => [v.axisName ?? v.axisTag, v.value]))}`);
  if (visiblePaints(node.strokePaints).length && (node.strokeWeight ?? 0) > 0) unsupported(node, 'TEXT strokePaints');

  let   fontSize   = node.derivedTextData?.glyphs?.[0]?.fontSize ?? node.fontSize ?? 24;
  const fontFamily = node.fontName?.family ?? 'Inter';
  // Letter spacing: PERCENT is % of fontSize, PIXELS is absolute
  const ls = node.letterSpacing;
  let   letterSpacingPx = !ls ? 0
    : ls.units === 'PERCENT' ? (ls.value / 100) * fontSize
    : ls.units === 'PIXELS'  ? ls.value
    : 0;
  const derived    = node.derivedTextData ?? {};
  const baselines  = derived.baselines;
  const glyphs     = derived.glyphs;
  const styleIds   = node.textData?.characterStyleIDs;
  const styleTable = node.textData?.styleOverrideTable;
  const truncation = derived.truncationStartIndex >= 0 ? derived.truncationStartIndex : null;
  const stale = isStaleLayout(chars, baselines, glyphs?.filter(g => g.firstCharacter != null));
  if (!glyphs?.length && !stale) {
    throw new Error(`TEXT ${node.name ?? nid(node)} is missing derived glyph layout`);
  }

  // styleID → run attributes (family, weight, slant, fill) that differ from the node's
  const styleMap = {};
  for (const ov of styleTable ?? []) {
    const hasFontName = ov.fontName?.family || ov.fontName?.style;
    const { weight, italic } = hasFontName ? styleAttrsFromFontName(ov.fontName, null) : {};
    const runPaints = visiblePaints(ov.fillPaints).map(p => resolvePaint(deck, node, p));
    styleMap[ov.styleID] = {
      family: hasFontName ? (ov.fontName?.family ?? fontFamily) : null,
      weight: hasFontName ? weight : null,
      italic: hasFontName ? italic : null,
      fill: runPaints.length === 1 && runPaints[0].type === 'SOLID'
        ? { color: rgb(runPaints[0].color), opacity: (runPaints[0].color?.a ?? 1) * (runPaints[0].opacity ?? 1) }
        : null,
    };
    if (runPaints.length > 1 || runPaints.some(p => p.type !== 'SOLID')) unsupported(node, `styleOverrideTable[${ov.styleID}].fillPaints non-solid`);
  }

  const { weight: defWeight, italic: defItalic } = styleAttrsFromFontName(
    node.fontName, derived.fontMetaData?.[0]?.fontWeight
  );

  // One <tspan> per glyph cluster at Figma's glyph origin: the source's own shaping decides what a glyph draws.
  let tspans = '';
  if (stale || !glyphs?.length) {
    // Fallback: derivedTextData is stale (text was edited outside Figma).
    // Emit line-level tspans and let resvg handle per-glyph layout.
    const origFontSize = fontSize;
    const fb = fallbackTextTspans(dispChars, fontSize, node, letterSpacingPx);
    tspans = fb.tspans;
    fontSize = fb.fontSize;                              // auto-fit may have scaled down
    if (origFontSize > 0) letterSpacingPx *= fontSize / origFontSize;
  } else {
    // The top of the line a glyph sits on (the line of the preceding character for the truncation ellipsis).
    const lineTop = (g) => {
      const at = g.firstCharacter ?? Math.max(0, (truncation ?? 1) - 1);
      const line = baselines?.find(b => at >= (b.firstCharacter ?? 0) && at < (b.endCharacter ?? Infinity)) ?? baselines?.[0];
      return line?.lineY ?? 0;
    };
    const drawn = glyphs.filter(g => g.firstCharacter != null
      ? truncation == null || g.firstCharacter < truncation
      : truncation != null);
    for (let i = 0; i < drawn.length; i++) {
      const g = drawn[i];
      // A glyph without a first character is the ellipsis Figma adds at truncation.
      const slice = g.firstCharacter == null ? '…' : glyphText(dispChars, drawn, i).replace(/\n$/, '');
      if (!slice || /^\s+$/.test(slice)) continue;
      const sid = g.firstCharacter == null ? (styleIds?.[Math.max(0, (truncation ?? 1) - 1)] ?? 0) : (styleIds?.[g.firstCharacter] ?? 0);
      const st = styleMap[sid] ?? {};
      const attrs = [];
      if (st.family && st.family !== fontFamily) attrs.push(`font-family="${familyAttr(st.family)}"`);
      if (st.weight && st.weight !== defWeight) attrs.push(`font-weight="${st.weight}"`);
      if (st.italic && st.italic !== defItalic) attrs.push(`font-style="${st.italic}"`);
      if (g.fontSize && Math.abs(g.fontSize - fontSize) > 1e-6) attrs.push(`font-size="${num(g.fontSize)}"`);
      if (st.fill && !_outlineMode) attrs.push(`fill="${st.fill.color}"${st.fill.opacity < 1 ? ` fill-opacity="${num(st.fill.opacity)}"` : ''}`);
      tspans += `<tspan x="${g.position.x}" y="${num(snapBaseline(lineTop(g), g.position.y))}"${attrs.length ? ' ' + attrs.join(' ') : ''}>${esc(slice)}</tspan>`;
    }
  }
  if (!tspans) return '';

  const lsAttr = letterSpacingPx === 0 ? '' : ` letter-spacing="${letterSpacingPx.toFixed(3)}"`;
  const open = `<text font-size="${fontSize}" font-family="${familyAttr(fontFamily)}" font-weight="${defWeight}" font-style="${defItalic}"${lsAttr} text-rendering="geometricPrecision"`;
  const shape = {
    draw: attrs => `${open} ${attrs}>${tspans}</text>`,
    clip: () => `${open}>${tspans}</text>`,
  };
  const { w, h } = size(node);
  const paints = getFillPaints(node);
  const layers = paintLayers(deck, node, shape, paints, w, h);

  // Figma's pre-computed decoration rectangles (underline/strikethrough), in node coordinates.
  const rects = (derived.decorations ?? []).flatMap(d => (d.rects ?? []).map(r =>
    ({ d: `M${num(r.x)},${num(r.y)}h${num(r.w)}v${num(r.h)}h${num(-r.w)}Z`, rule: 'nonzero' })));
  const decorations = rects.length ? paintLayers(deck, node, pathShape(rects), paints, w, h) : { defs: '', svg: '' };
  const inner = [layers.svg, decorations.svg].filter(Boolean).join('\n');
  if (!inner) return '';
  return `${wrapDefs(layers.defs + decorations.defs)}${inner}`;
}

/** Frame clipping: "Clip content" (frameMaskDisabled === false) clips children to the frame's shape. */
function clipChildren(node, paths, inner) {
  if (!inner || node.frameMaskDisabled !== false) return { defs: '', svg: inner };
  const id = `frame-clip-${++_svgIdSeq}`;
  return { defs: `<clipPath id="${id}">${pathShape(paths).clip()}</clipPath>`, svg: `<g clip-path="url(#${id})">${inner}</g>` };
}

function renderFrame(deck, node) {
  const { w, h } = size(node);
  const paths = shapePaths(deck, node);
  const fills = paintLayers(deck, node, pathShape(paths), getFillPaints(node), w, h);
  const clipped = clipChildren(node, paths, childrenSvg(deck, node));
  const strokes = _outlineMode ? { defs: '', svg: '' } : strokeLayers(deck, node, paths);
  const parts = [fills.svg, clipped.svg, strokes.svg].filter(Boolean).join('\n');
  if (!parts) return '';
  return `${wrapDefs(fills.defs + clipped.defs + strokes.defs)}${parts}`;
}

function renderGroup(deck, node) {
  return childrenSvg(deck, node);
}

/**
 * SHAPE_WITH_TEXT: pill/badge nodes — styling and text stored in nodeGenerationData.overrides.
 * overrides[0] = shape (fill, stroke, cornerRadius)
 * overrides[1] = text (textData.characters, fontName, fontSize, textCase)
 * Text position comes from derivedImmutableFrameData.overrides[1].
 */
function renderShapeWithText(deck, node) {
  const { w, h } = size(node);
  const genOvs  = node.nodeGenerationData?.overrides ?? [];
  const shapeOv = genOvs[0] ?? {};
  const textOv  = genOvs[1] ?? {};

  // Shape styling
  const rawRx = shapeOv.cornerRadius ?? 0;
  const rx = Math.min(rawRx, w / 2, h / 2);  // 1000000 → pill
  const fill   = resolveFill(shapeOv.fillPaints) ?? 'none';

  // Prefer strokeGeometry (pre-computed filled outlines) over manual SVG strokes
  const geoStroke = strokeGeometrySvg(deck, node);
  let strokeAttr = '';
  if (!geoStroke) {
    const sw     = shapeOv.strokeWeight ?? 0;
    const stroke = sw > 0 ? resolveFill(shapeOv.strokePaints) ?? 'none' : 'none';
    strokeAttr = sw > 0 && stroke !== 'none' ? `stroke="${stroke}" stroke-width="${sw}"` : '';
  }

  const fillSvg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" ${strokeAttr}/>`;
  // Stroke-under-fill compositing: strokeGeometry underneath, fill on top
  const rectSvg = geoStroke ? `${geoStroke}\n${fillSvg}` : fillSvg;

  // Text
  const chars = textOv.textData?.characters ?? '';
  if (!chars.trim()) return rectSvg;

  const textCase  = textOv.textCase ?? 'ORIGINAL';
  const dispChars = textCase === 'UPPER' ? chars.toUpperCase()
                  : textCase === 'LOWER' ? chars.toLowerCase()
                  : chars;


  // Text offset + authoritative font metrics from derivedImmutableFrameData
  const derivedOvs  = node.derivedImmutableFrameData?.overrides ?? [];
  const textDerived = derivedOvs.find(o => o.derivedTextData) ?? {};
  const textBoxX    = textDerived.transform?.m02 ?? 0;
  const textBoxY    = textDerived.transform?.m12 ?? 0;
  const derivedText = textDerived.derivedTextData ?? {};
  const glyphs      = derivedText.glyphs;
  const truncationStartIndex = derivedText.truncationStartIndex >= 0
    ? derivedText.truncationStartIndex
    : null;
  const swtStale = isStaleLayout(chars, derivedText.baselines, glyphs);
  if (!glyphs?.length && !swtStale) {
    throw new Error(`SHAPE_WITH_TEXT ${node.name ?? nid(node)} is missing derived glyph layout`);
  }

  // derivedTextData is authoritative — nodeGenerationData can have stale/wrong values
  const derivedFont  = textDerived.derivedTextData?.fontMetaData?.[0]?.key;
  const fontSize     = textDerived.derivedTextData?.glyphs?.[0]?.fontSize ?? textOv.fontSize ?? 24;
  const fontFamily   = derivedFont?.family ?? textOv.fontName?.family ?? 'Inter';
  const fontStyle    = derivedFont?.style  ?? textOv.fontName?.style  ?? 'Regular';
  const fontWeight   = /semibold|bold/i.test(fontStyle) ? 'bold'
                     : /medium/i.test(fontStyle) ? '500' : 'normal';
  const fontItalic   = /italic/i.test(fontStyle) ? 'italic' : 'normal';
  const textFill     = resolveFill(textOv.fillPaints) ?? '#000000';

  let tspan;

  if (swtStale || !glyphs?.length) {
    // Fallback: stale layout — center text in shape using textBox offset
    const swtBaselines = derivedText.baselines;
    const lineHeightPx = swtBaselines?.[0]?.lineHeight ?? fontSize * 1.2;
    const lineAscent   = swtBaselines?.[0]?.lineAscent ?? fontSize * 0.8;
    const lines = dispChars.split('\n').filter((l, i, a) => i < a.length - 1 || l);
    const totalH = lines.length * lineHeightPx;
    // Center vertically in the text box area
    const textBoxH = textDerived.size?.y ?? h;
    const startY = textBoxY + (textBoxH - totalH) / 2 + lineAscent;
    const textBoxW = textDerived.size?.x ?? w;
    const cx = textBoxX + textBoxW / 2;
    tspan = lines.map((line, i) => {
      const y = startY + i * lineHeightPx;
      return `<tspan x="${cx}" y="${y.toFixed(2)}" text-anchor="middle">${esc(line) || ' '}</tspan>`;
    }).join('');
  } else {
    const spans = [];
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      if (truncationStartIndex != null && g.firstCharacter != null && g.firstCharacter >= truncationStartIndex) continue;

      let slice = '';
      let stopAfter = false;
      if (g.firstCharacter == null) {
        if (truncationStartIndex == null) continue;
        slice = '…';
        stopAfter = true;
      } else {
        let nextChar = null;
        for (let j = i + 1; j < glyphs.length; j++) {
          const fc = glyphs[j].firstCharacter;
          if (fc != null && fc > g.firstCharacter) {
            nextChar = fc;
            break;
          }
        }
        slice = dispChars.slice(g.firstCharacter, nextChar ?? (g.firstCharacter + 1));
      }

      if (!slice) continue;
      spans.push(`<tspan x="${textBoxX + g.position.x}" y="${textBoxY + g.position.y}">${esc(slice)}</tspan>`);
      if (stopAfter) break;
    }
    tspan = spans.join('');
  }

  const textSvg = [
    `<text font-size="${fontSize}" font-family="${familyAttr(fontFamily)}"`,
    `  font-weight="${fontWeight}" font-style="${fontItalic}" fill="${textFill}"`,
    `  text-rendering="geometricPrecision">${tspan}</text>`,
  ].join('\n');

  return `${rectSvg}\n${textSvg}`;
}

/** Render strokeGeometry blobs as one filled <path> in the first solid stroke colour (SHAPE_WITH_TEXT). */
function strokeGeometrySvg(deck, node) {
  const strokeColor = resolveFill(node.strokePaints);
  const sw = node.strokeWeight ?? 0;
  const blobs = deck.message?.blobs;
  if (!strokeColor || sw <= 0 || !node.strokeGeometry?.length || !blobs) return '';
  const segments = [];
  let hasEvenOdd = false;
  for (const geo of node.strokeGeometry) {
    const d = decodeCmdBlob(blobs, geo.commandsBlob);
    if (d) segments.push(d);
    if ((geo.windingRule === 'EVENODD' || geo.windingRule === 'ODD')) hasEvenOdd = true;
  }
  if (!segments.length) return '';
  const rule = (segments.length > 1 || hasEvenOdd) ? ' fill-rule="evenodd"' : '';
  return `<path d="${segments.join('')}" fill="${strokeColor}"${rule}/>`;
}

function renderLine(deck, node) {
  // A line is its stroke: Figma's outline when present.
  const strokes = strokeLayers(deck, node, []);
  if (strokes.svg) return `${wrapDefs(strokes.defs)}${strokes.svg}`;
  const len = node.size?.x ?? 0;
  const stroke = resolveFill(node.strokePaints) ?? '#000000';
  const sw = node.strokeWeight ?? 1;
  return `<line x1="0" y1="0" x2="${len}" y2="0" stroke="${stroke}" stroke-width="${sw}"/>`;
}

/**
 * VECTOR — Figma's fill regions (fillGeometry), each with its own paints when
 * the vector network styles it (styleID → vectorData.styleOverrideTable), then
 * the stroke outline. Nodes that carry no computed geometry fall back to the
 * vector network itself.
 */
function renderVector(deck, node, { placeholder = true } = {}) {
  const { w, h } = size(node);
  const paths = geometryPaths(deck, node.fillGeometry);
  const styles = new Map();
  for (const s of node.vectorData?.styleOverrideTable ?? []) {
    if (s.styleID != null && s.fillPaints) styles.set(s.styleID, s.fillPaints);
  }
  let defs = '';
  const parts = [];
  const own = getFillPaints(node);
  const groups = new Map();
  for (const p of paths) {
    const paints = p.styleID && styles.has(p.styleID) ? styles.get(p.styleID) : own;
    if (!groups.has(paints)) groups.set(paints, []);
    groups.get(paints).push(p);
  }
  for (const [paints, group] of groups) {
    for (const p of group) {
      const layers = paintLayers(deck, node, pathShape([p]), paints, w, h);
      defs += layers.defs;
      if (layers.svg) parts.push(layers.svg);
    }
  }
  const strokes = _outlineMode ? { defs: '', svg: '' } : strokeLayers(deck, node, paths);
  defs += strokes.defs;
  if (strokes.svg) parts.push(strokes.svg);

  // Fallback: decode vectorNetworkBlob when no pre-computed fill/strokeGeometry
  const blobs = deck.message?.blobs;
  if (!paths.length && !node.strokeGeometry?.length && node.vectorData?.vectorNetworkBlob != null && blobs) {
    const vnbD = decodeVnb(blobs, node.vectorData.vectorNetworkBlob, node.vectorData.normalizedSize, node.size);
    if (vnbD) {
      const fillColor = resolveFill(own);
      const strokeColor = resolveFill(node.strokePaints);
      const sw = node.strokeWeight ?? 0;
      const lineCap = node.strokeCap === 'ROUND' ? 'round' : node.strokeCap === 'SQUARE' ? 'square' : 'butt';
      const lineJoin = node.strokeJoin === 'ROUND' ? 'round' : node.strokeJoin === 'BEVEL' ? 'bevel' : 'miter';
      const dashAttr = Array.isArray(node.dashPattern) && node.dashPattern.length
        ? ` stroke-dasharray="${node.dashPattern.join(' ')}"`
        : '';
      if (!fillColor && strokeColor && sw > 0) {
        parts.push(
          `<path d="${vnbD}" fill="none" stroke="${strokeColor}" stroke-width="${sw}" ` +
          `stroke-linecap="${lineCap}" stroke-linejoin="${lineJoin}"${dashAttr}/>`
        );
      } else {
        const color = fillColor ?? strokeColor ?? '#000000';
        parts.push(`<path d="${vnbD}" fill="${color}" fill-rule="evenodd"/>`);
      }
    }
  }

  if (!parts.length) return placeholder && !paths.length && !node.strokeGeometry?.length ? renderPlaceholder(deck, node) : '';
  return `${wrapDefs(defs)}${parts.join('\n')}`;
}

/**
 * BOOLEAN_OPERATION — fillGeometry is the computed result of the operation;
 * the children are its operands and are not drawn. A node the source stored
 * without the result is drawn from its operands in its own paints.
 */
function renderBooleanOp(deck, node) {
  if (node.fillGeometry?.length) return renderVector(deck, node, { placeholder: false });
  unsupported(node, `BOOLEAN_OPERATION ${node.booleanOperation ?? ''} without fillGeometry: operands drawn as a union`);
  // The operands' outlines, as a mask over the boolean's own paints in the boolean's box.
  const { w, h } = size(node);
  _outlineMode++;
  let operands;
  try {
    operands = deck.getChildren(nid(node)).filter(child => child.phase !== 'REMOVED').map(child => renderNode(deck, child)).join('');
  } finally { _outlineMode--; }
  if (!operands) return '';
  const fills = paintLayers(deck, node, pathShape([{ d: `M0,0H${num(w)}V${num(h)}H0Z`, rule: 'nonzero' }]), getFillPaints(node), w, h);
  if (!fills.svg) return '';
  const id = `boolean-operands-${++_svgIdSeq}`;
  return `<defs>${fills.defs}<mask id="${id}" maskUnits="userSpaceOnUse" x="${num(-w)}" y="${num(-h)}" width="${num(3 * w)}" height="${num(3 * h)}" mask-type="alpha">${operands}</mask></defs><g mask="url(#${id})">${fills.svg}</g>`;
}

/** Decode a commandsBlob index into an SVG path d-string. */
function decodeCmdBlob(blobs, blobIdx) {
  if (blobIdx == null || !blobs?.[blobIdx]) return null;
  const raw = blobs[blobIdx].bytes ?? blobs[blobIdx];
  if (!raw) return null;

  // Convert indexed object to Buffer if needed
  let buf;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    buf = Buffer.from(raw);
  } else {
    const len = Object.keys(raw).length;
    buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = raw[i];
  }

  const cmds = [];
  let off = 0;
  while (off < buf.length) {
    const cmd = buf[off++];
    if (cmd === 0x01) { // moveTo
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`M${f(x)},${f(y)}`);
    } else if (cmd === 0x02) { // lineTo
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`L${f(x)},${f(y)}`);
    } else if (cmd === 0x04) { // cubicTo
      const c1x = buf.readFloatLE(off); off += 4;
      const c1y = buf.readFloatLE(off); off += 4;
      const c2x = buf.readFloatLE(off); off += 4;
      const c2y = buf.readFloatLE(off); off += 4;
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(x)},${f(y)}`);
    } else if (cmd === 0x00) { // close
      cmds.push('Z');
    } else {
      break; // unknown command — stop
    }
  }
  return cmds.length ? cmds.join('') : null;
}

function f(v) { return +v.toFixed(2); }

/**
 * Decode a vectorNetworkBlob into an SVG path d-string.
 *
 * The byte layout lives in `openfig-core`'s `parseVectorNetworkBlob`, which is held
 * to it by a byte-identical round-trip over a 42-blob reference corpus. This
 * function is a thin adapter: it scales coordinates from `normalizedSize` space to
 * `nodeSize` and emits path commands. It deliberately does not parse bytes — this
 * package used to carry its own walker, and the two descriptions of the format
 * drifted apart, with the rasterizer flattening every curve for as long as they did.
 *
 * A segment is straight iff all four tangent components are zero; there is no
 * segment-type field. See `openfig-core/docs/vector.md` and
 * `docs/figma-behaviour.md`.
 */
export function decodeVnb(blobs, blobIdx, normalizedSize, nodeSize) {
  const buf = blobToBuffer(blobs, blobIdx);
  if (!buf) return null;

  let network;
  try {
    network = parseVectorNetworkBlob(new Uint8Array(buf));
  } catch {
    // A blob we cannot account for byte-for-byte is one we do not understand.
    // Returning null lets the caller fall through to its placeholder rather than
    // rendering geometry we half-read.
    return null;
  }

  const scaleX = (nodeSize?.x ?? 1) / (normalizedSize?.x ?? 1);
  const scaleY = (nodeSize?.y ?? 1) / (normalizedSize?.y ?? 1);
  const verts = network.vertices.map((v) => ({ x: v.x * scaleX, y: v.y * scaleY }));
  const segs = network.segments.map((s) => ({
    sv: s.start.vertex,
    ev: s.end.vertex,
    tsx: s.start.dx * scaleX,
    tsy: s.start.dy * scaleY,
    tex: s.end.dx * scaleX,
    tey: s.end.dy * scaleY,
    isStraight: s.isStraight,
  }));

  const segToPathCmd = (seg, start, end) => {
    if (seg.isStraight) return `L${f(end.x)},${f(end.y)}`;
    const c1x = start.x + seg.tsx;
    const c1y = start.y + seg.tsy;
    const c2x = end.x + seg.tex;
    const c2y = end.y + seg.tey;
    return `C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(end.x)},${f(end.y)}`;
  };

  // Regions → SVG subpaths. Each loop is its own closed subpath.
  const cmds = [];
  for (const region of network.regions) {
    for (const loop of region.loops) {
      loop.forEach((segIdx, s) => {
        const seg = segs[segIdx];
        if (!seg) return;
        const start = verts[seg.sv];
        const end = verts[seg.ev];
        if (!start || !end) return;
        if (s === 0) cmds.push(`M${f(start.x)},${f(start.y)}`);
        cmds.push(segToPathCmd(seg, start, end));
      });
      cmds.push('Z');
    }
  }

  // Fallback for blobs that carry no usable region loops — an open path authored
  // via addPath(), or a region block this walk could not consume. Recover the
  // centerline by walking the stored segments in order so the node renders as a
  // stroke instead of falling through to the magenta placeholder.
  //
  // Note this is genuinely a fallback, not the common case: every stroke-only node
  // in the current deck fixtures carries regionCount === 1 and is handled above.
  if (!cmds.length && segs.length) {
    let currentEnd = null;
    let subpathStart = null;
    for (const seg of segs) {
      const start = verts[seg.sv];
      const end = verts[seg.ev];
      if (!start || !end) continue;
      if (currentEnd == null || seg.sv !== currentEnd) {
        cmds.push(`M${f(start.x)},${f(start.y)}`);
        subpathStart = seg.sv;
      }
      cmds.push(segToPathCmd(seg, start, end));
      if (subpathStart != null && seg.ev === subpathStart) {
        cmds.push('Z');
        currentEnd = null;
        subpathStart = null;
      } else {
        currentEnd = seg.ev;
      }
    }
  }

  return cmds.length ? cmds.join('') : null;
}

function blobToBuffer(blobs, blobIdx) {
  if (blobIdx == null || !blobs?.[blobIdx]) return null;
  const raw = blobs[blobIdx].bytes ?? blobs[blobIdx];
  if (!raw) return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw);
  const len = Object.keys(raw).length;
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = raw[i];
  return buf;
}

function renderPlaceholder(deck, node) {
  const { w, h } = size(node);
  const type = node.type ?? '?';
  unsupported(node, `type=${type}`);
  return `<rect x="0" y="0" width="${w || 40}" height="${h || 40}" fill="none" stroke="#ff00ff" stroke-width="2" stroke-dasharray="6" opacity="0.5"/><!-- ${type} -->`;
}

/**
 * INSTANCE → SYMBOL resolution.
 *
 * Figma templates use INSTANCE nodes that reference a SYMBOL definition.
 * The SYMBOL's children (TEXT, shapes, frames, etc.) define the visual content.
 * The INSTANCE may carry symbolOverrides that modify specific child properties
 * (text content, fills, etc.).
 *
 * Strategy:
 * - Resolve the SYMBOL via symbolData.symbolID
 * - Render the SYMBOL's children tree (they live in the normal node hierarchy)
 * - Apply symbolOverrides: text and fill overrides are temporarily applied
 *   to the target nodes, rendered, then restored.
 * - The instance's own appearance (fills, strokes, corner radius, clip) is the
 *   instance node's: Figma stores it on the instance, at the instance's size.
 */
function renderInstance(deck, node) {
  const symbolId = node.symbolData?.symbolID;
  if (!symbolId) return renderPlaceholder(deck, node);

  const symNid = `${symbolId.sessionID}:${symbolId.localID}`;
  const symbol = deck.getNode(symNid);
  if (!symbol) return renderPlaceholder(deck, node);

  // Figma-parity: reject instances of symbols with invalid variant specs.
  // Figma Desktop silently shows blank slides for these. We match that behavior
  // deliberately so our preview catches invalid decks instead of hiding them.
  // Root cause: older tooling created SYMBOL variants with names (e.g.
  // "Size=Wide") that don't exist in the component set's variantPropSpecs.
  if (symbol.componentKey && symbol.variantPropSpecs) {
    const specValues = new Set(symbol.variantPropSpecs.map(s => s.value));
    const nameValues = (symbol.name || '').split(', ').map(p => p.split('=')[1]).filter(Boolean);
    const invalid = nameValues.some(v => !specValues.has(v));
    if (invalid) {
      const nid = `${node.guid.sessionID}:${node.guid.localID}`;
      console.warn(`⚠️  Skipping INSTANCE ${nid}: symbol ${symNid} "${symbol.name}" has invalid variant specs — Figma would show blank`);
      return renderPlaceholder(deck, node);
    }
  }

  // Temporarily apply symbolOverrides so rendered content reflects overrides.
  // Override guidPaths may reference library-original IDs (e.g. 100:656) rather
  // than local node IDs (e.g. 1:1131). Nodes expose their library ID via the
  // `overrideKey` property, so we build a lookup from overrideKey → local node.
  const overrides = node.symbolData?.symbolOverrides ?? [];
  const restores = [];

  // Build overrideKey → node map for all SYMBOL descendants
  const okMap = new Map();
  function buildOkMap(nid) {
    for (const child of deck.getChildren(nid)) {
      const ok = child.overrideKey;
      if (ok) okMap.set(`${ok.sessionID}:${ok.localID}`, child);
      buildOkMap(`${child.guid.sessionID}:${child.guid.localID}`);
    }
  }
  buildOkMap(symNid);

  // Build derivedSymbolData lookup: guidPath ID → entry.
  // Contains Figma-computed layout (size, transform, derivedTextData) for child
  // nodes as they appear in this INSTANCE, accounting for auto-layout resizing.
  const dsdMap = new Map();
  for (const entry of node.derivedSymbolData ?? []) {
    const guids = entry.guidPath?.guids;
    if (!guids?.length) continue;
    // Use the last guid in the path for single-level lookups
    const g = guids[guids.length - 1];
    dsdMap.set(`${g.sessionID}:${g.localID}`, entry);
  }

  // Apply symbolOverrides (symbol swaps, text characters, fill paints).
  // overriddenSymbolID entries swap which SYMBOL a nested INSTANCE renders —
  // e.g. swapping a body pose or head style in a character component.
  // These must be processed first so okMap gets extended with the new symbol's
  // descendants before text/fill overrides are applied.
  for (const ov of overrides) {
    const guids = ov.guidPath?.guids;
    if (!guids?.length || guids.length !== 1) continue;
    const targetId = `${guids[0].sessionID}:${guids[0].localID}`;
    const target = deck.getNode(targetId) ?? okMap.get(targetId);
    if (!target) continue;

    if (ov.overriddenSymbolID && target.symbolData) {
      const origSymbolID = target.symbolData.symbolID;
      restores.push(() => { target.symbolData.symbolID = origSymbolID; });
      target.symbolData.symbolID = ov.overriddenSymbolID;
      // Extend okMap with the new symbol's descendants so downstream
      // overrides and derivedSymbolData can find them by overrideKey.
      const newSymNid = `${ov.overriddenSymbolID.sessionID}:${ov.overriddenSymbolID.localID}`;
      buildOkMap(newSymNid);
    }

    if (ov.textData?.characters != null && target.textData) {
      const origChars = target.textData.characters;
      restores.push(() => { target.textData.characters = origChars; });
      target.textData.characters = ov.textData.characters;
    }

    if (ov.fillPaints) {
      const origFill = target.fillPaints;
      restores.push(() => { target.fillPaints = origFill; });
      target.fillPaints = ov.fillPaints;
    }
  }

  // Apply derivedSymbolData to matching nodes.
  // Auto-layout symbols (stackMode set): Figma re-positions/resizes children,
  // so apply size + transform + derivedTextData and skip global scale.
  // Non-auto-layout symbols: children scale proportionally, so only apply
  // derivedTextData (glyph re-layout) and use global scale for positioning.
  const isAutoLayout = !!symbol.stackMode;
  for (const [dsdId, dsd] of dsdMap) {
    const target = deck.getNode(dsdId) ?? okMap.get(dsdId);
    if (!target) continue;

    if (dsd.derivedTextData) {
      const orig = target.derivedTextData;
      restores.push(() => { target.derivedTextData = orig; });
      target.derivedTextData = dsd.derivedTextData;
    }
    if (isAutoLayout && dsd.size) {
      const orig = target.size;
      restores.push(() => { target.size = orig; });
      target.size = dsd.size;
    }
    if (isAutoLayout && dsd.transform) {
      const orig = target.transform;
      restores.push(() => { target.transform = orig; });
      target.transform = dsd.transform;
    }
  }

  // Scale when INSTANCE size differs from SYMBOL size.
  // Auto-layout symbols have per-node layout from derivedSymbolData, so skip scale.
  const instSize = size(node);
  const symSize = size(symbol.size ? symbol : node);
  const sx = symSize.w ? instSize.w / symSize.w : 1;
  const sy = symSize.h ? instSize.h / symSize.h : 1;
  const needsScale = !isAutoLayout && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001);

  // The instance's own look at its own size; what the instance node does not
  // carry comes from its definition.
  const look = { ...symbol, ...node, type: 'FRAME' };
  for (const key of ['fillGeometry', 'strokeGeometry']) if (!node[key]?.length) delete look[key];
  const paths = shapePaths(deck, look);
  const fills = paintLayers(deck, look, pathShape(paths), Array.isArray(node.fillPaints) ? node.fillPaints : getFillPaints(symbol), instSize.w, instSize.h);

  const outer = _ctm;
  if (needsScale) _ctm = multiply(outer, [sx, 0, 0, sy, 0, 0]);
  let inner;
  try { inner = withModes(modeMap(symbol), () => withModes(modeMap(node), () => childrenSvg(deck, symbol))); } finally { _ctm = outer; }

  // Restore mutations
  for (const fn of restores) fn();

  if (inner && needsScale) inner = `<g transform="scale(${sx},${sy})">\n${inner}\n</g>`;
  const clipped = clipChildren(look, paths, inner);
  const strokes = _outlineMode ? { defs: '', svg: '' } : strokeLayers(deck, look, paths);
  const content = [fills.svg, clipped.svg, strokes.svg].filter(Boolean).join('\n');
  if (!content) return '';
  return `${wrapDefs(fills.defs + clipped.defs + strokes.defs)}${content}`;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const RENDERERS = {
  ROUNDED_RECTANGLE: renderShape,
  RECTANGLE:         renderShape,
  SHAPE_WITH_TEXT:   renderShapeWithText,
  ELLIPSE:           renderShape,
  TEXT:              renderText,
  FRAME:             renderFrame,
  // A component drawn on its own (a variant of a set) is the frame it is.
  SYMBOL:            renderFrame,
  GROUP:             renderGroup,
  SECTION:           renderGroup,
  BOOLEAN_OPERATION: renderBooleanOp,
  VECTOR:            renderVector,
  LINE:              renderLine,
  STAR:              renderVector,
  REGULAR_POLYGON:   renderVector,
  POLYGON:           renderVector,
  INSTANCE:          renderInstance,
  SLICE:             () => '',
};

/**
 * One SVG filter for a node's visible effects, in the node's own coordinates:
 * drop shadows under the layer (knocked out beneath it unless the source shows
 * them behind transparent areas), inner shadows over it, clipped to it, and a
 * layer blur over the result. Figma's blur radius is twice the Gaussian sigma.
 */
function buildEffectFilter(deck, node) {
  if (_outlineMode) return null;
  const effects = node.effects?.filter(e => e.visible !== false) ?? [];
  if (!effects.length) return null;
  const { w, h } = size(node);
  const prims = [];
  const under = [];
  const over = [];
  let blur = 0;
  let margin = 0;
  effects.forEach((e, i) => {
    const sigma = Math.max(0, (e.radius ?? 0) / 2);
    const dx = e.offset?.x ?? 0, dy = e.offset?.y ?? 0, spread = e.spread ?? 0;
    const color = resolvedColor(deck, node, e) ?? {};
    const flood = `<feFlood flood-color="${rgb(color)}" flood-opacity="${num(color.a ?? 1)}" result="e${i}c"/>`;
    if (e.blendMode && e.blendMode !== 'NORMAL' && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) unsupported(node, `effects[${i}].blendMode=${e.blendMode}`);
    if (e.type === 'DROP_SHADOW') {
      margin = Math.max(margin, 3 * sigma + Math.abs(dx) + Math.abs(dy) + Math.abs(spread));
      let src = 'SourceAlpha';
      if (spread) {
        prims.push(`<feMorphology in="SourceAlpha" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${num(Math.abs(spread))}" result="e${i}m"/>`);
        src = `e${i}m`;
      }
      prims.push(
        `<feGaussianBlur in="${src}" stdDeviation="${num(sigma)}" result="e${i}b"/>`,
        `<feOffset in="e${i}b" dx="${num(dx)}" dy="${num(dy)}" result="e${i}o"/>`,
        flood,
        `<feComposite in="e${i}c" in2="e${i}o" operator="in" result="e${i}s"/>`,
      );
      if (e.showShadowBehindNode === true) under.push(`e${i}s`);
      else {
        prims.push(`<feComposite in="e${i}s" in2="SourceAlpha" operator="out" result="e${i}k"/>`);
        under.push(`e${i}k`);
      }
    } else if (e.type === 'INNER_SHADOW') {
      prims.push(`<feComponentTransfer in="SourceAlpha" result="e${i}i"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
      let src = `e${i}i`;
      if (spread) {
        prims.push(`<feMorphology in="${src}" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${num(Math.abs(spread))}" result="e${i}m"/>`);
        src = `e${i}m`;
      }
      prims.push(
        `<feGaussianBlur in="${src}" stdDeviation="${num(sigma)}" result="e${i}b"/>`,
        `<feOffset in="e${i}b" dx="${num(dx)}" dy="${num(dy)}" result="e${i}o"/>`,
        flood,
        `<feComposite in="e${i}c" in2="e${i}o" operator="in" result="e${i}s"/>`,
        `<feComposite in="e${i}s" in2="SourceAlpha" operator="in" result="e${i}k"/>`,
      );
      over.push(`e${i}k`);
    } else if (e.type === 'FOREGROUND_BLUR') {
      blur = Math.max(blur, sigma);
      margin = Math.max(margin, 3 * sigma);
    } else {
      unsupported(node, `effects[${i}].type=${e.type}`);
    }
  });
  if (!under.length && !over.length && !blur) return null;
  const id = `fx-${++_svgIdSeq}`;
  const merge = [...under, 'SourceGraphic', ...over].map(r => `<feMergeNode in="${r}"/>`).join('');
  prims.push(`<feMerge result="fx">${merge}</feMerge>`);
  if (blur) prims.push(`<feGaussianBlur in="fx" stdDeviation="${num(blur)}"/>`);
  // The region holds the effects' reach around the node box and a stroke drawn outside it. (A larger region —
  // room for overflowing children — makes resvg drop part of the layer at a supersampled scale.)
  const m = Math.ceil(margin + 2 * (node.strokeWeight ?? 0)) + 2;
  const defs = `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-m}" y="${-m}" width="${num(w + 2 * m)}" height="${num(h + 2 * m)}" color-interpolation-filters="sRGB">${prims.join('')}</filter>`;
  return { defs, id };
}

function renderNode(deck, node) {
  if (node.phase === 'REMOVED' || node.visible === false) return '';
  const fn = RENDERERS[node.type] ?? renderPlaceholder;
  const parent = _ctm;
  _ctm = multiply(parent, nodeMatrix(node));
  let svg, fx;
  try {
    [svg, fx] = withModes(modeMap(node), () => {
      const drawn = fn(deck, node);
      return [drawn, drawn ? buildEffectFilter(deck, node) : null];
    });
  } finally { _ctm = parent; }
  if (!svg) return '';

  if (fx) svg = `<defs>${fx.defs}</defs>\n<g filter="url(#${fx.id})">${svg}</g>`;

  const op = node.opacity;
  const opacity = op != null && op < 1 ? ` opacity="${num(op)}"` : '';
  const blend = _outlineMode ? '' : blendStyle(node, node.blendMode);
  return `<g transform="${svgTransform(node)}"${opacity}${blend}>\n${svg}\n</g>`;
}

/** The axis-aligned box a node covers in its parent's coordinates, grown by `grow`. */
function parentBox(node, grow) {
  const { w, h } = size(node);
  const t = node.transform ?? {};
  const m00 = t.m00 ?? 1, m01 = t.m01 ?? 0, m02 = t.m02 ?? 0, m10 = t.m10 ?? 0, m11 = t.m11 ?? 1, m12 = t.m12 ?? 0;
  const xs = [], ys = [];
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) { xs.push(m00 * x + m01 * y + m02); ys.push(m10 * x + m11 * y + m12); }
  return { x: Math.min(...xs) - grow, y: Math.min(...ys) - grow, w: Math.max(...xs) - Math.min(...xs) + 2 * grow, h: Math.max(...ys) - Math.min(...ys) + 2 * grow };
}

function childrenSvg(deck, node) {
  const out = [];
  let activeMask = null;
  let masked = [];

  // A mask shapes the siblings above it: ALPHA by its rendered alpha, OUTLINE
  // (vector) by its geometry whatever its paints, LUMINANCE by its brightness.
  const flushMask = () => {
    if (!activeMask) return;
    const body = masked.filter(Boolean).join('\n');
    if (body) {
      const id = `alpha-mask-${++_svgIdSeq}`;
      const type = activeMask.maskType ?? 'ALPHA';
      const outline = type === 'OUTLINE' || type === 'VECTOR';
      if (outline) _outlineMode++;
      const maskSvg = renderNode(deck, activeMask);
      if (outline) _outlineMode--;
      const effects = (activeMask.effects ?? []).filter(e => e.visible !== false)
        .reduce((m, e) => Math.max(m, (e.radius ?? 0) * 1.5 + Math.abs(e.offset?.x ?? 0) + Math.abs(e.offset?.y ?? 0) + Math.abs(e.spread ?? 0)), 0);
      const box = parentBox(activeMask, Math.ceil((activeMask.strokeWeight ?? 0) * 2 + effects + 2));
      out.push(
        `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${num(box.x)}" y="${num(box.y)}" `
        + `width="${num(box.w)}" height="${num(box.h)}" mask-type="${type === 'LUMINANCE' ? 'luminance' : 'alpha'}">${maskSvg}</mask></defs>`,
        `<g mask="url(#${id})">${body}</g>`,
      );
    }
    activeMask = null;
    masked = [];
  };

  // Auto layout with "first on top" (stackReverseZIndex) stacks its children in reverse.
  const children = deck.getChildren(nid(node));
  const ordered = node.stackMode && node.stackMode !== 'NONE' && node.stackReverseZIndex ? [...children].reverse() : children;
  for (const child of ordered) {
    if (child.phase === 'REMOVED' || child.visible === false) continue;
    if (child.mask === true) {
      flushMask();
      activeMask = child;
      continue;
    }
    const svg = renderNode(deck, child);
    if (!svg) continue;
    if (activeMask) masked.push(svg);
    else out.push(svg);
  }
  flushMask();
  return out.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a single slide node and its subtree to an SVG string.
 *
 * @param {import('../fig-deck.mjs').FigDeck} deck
 * @param {object} slideNode  - The SLIDE node object
 * @returns {string}          - Complete SVG string (1920×1080)
 */
export function slideToSvg(deck, slideNode) {
  _svgIdSeq = 0;
  _outlineMode = 0;
  _crispClips = false;
  _pixelScale = 0;
  _ctm = [1, 0, 0, 1, 0, 0];
  _modes = [];
  _unsupported = new Set();
  const bg = resolveFill(getFillPaints(slideNode)) ?? 'white';

  const body = childrenSvg(deck, slideNode);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" \
width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}">
  <defs>
    <clipPath id="slide-clip"><rect width="${SLIDE_W}" height="${SLIDE_H}"/></clipPath>
  </defs>
  <rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${bg}"/>
  <g clip-path="url(#slide-clip)">
${body}
  </g>
</svg>`;
}

/**
 * Render any node (FRAME, GROUP, etc.) to SVG using its own size as the viewport.
 * Works for Design file frames, standalone components, or any node with a size field.
 *
 * Note: Figma's export expands bounds to include overflow content when a frame has
 * When frameMaskDisabled=true (clip content OFF), Figma's export expands the
 * bounds to include overflowing children.  We replicate this by computing the
 * content bounding box and expanding the SVG viewport accordingly.
 *
 * @param {FigDeck} fig - Parsed Figma file (works with both .deck and .fig)
 * @param {object} node - The node to render (typically a FRAME)
 */
export function frameToSvg(fig, node) {
  return frameToSvgWithReport(fig, node).svg;
}

/**
 * frameToSvg, and the source properties of the drawn tree that the builder
 * does not draw (`nodeId property=value`), sorted: an empty list means every
 * visible construct was drawn by a supported path.
 *
 * `crispClips`: clip paths and outline masks without antialiasing. Figma's
 * coverage of a shape clipped by an equal shape is the shape's own; an
 * antialiased clip multiplies the two edge coverages. A caller that
 * rasterizes several times larger and averages down gets Figma's edges.
 * `pixelScale`: the scale the SVG will be exported at; each text baseline is
 * moved onto a whole pixel of that scale, as Figma draws text.
 */
export function frameToSvgWithReport(fig, node, options = {}) {
  try {
    return frameReport(fig, node, options);
  } finally {
    _crispClips = false;
    _pixelScale = 0;
    _outlineMode = 0;
    _modes = [];
  }
}

function frameReport(fig, node, { crispClips = false, pixelScale = 0 }) {
  _svgIdSeq = 0;
  _outlineMode = 0;
  _crispClips = crispClips;
  _pixelScale = pixelScale;
  _ctm = [1, 0, 0, 1, 0, 0];
  _unsupported = new Set();
  const fw = Math.round(node.size?.x ?? 100);
  const fh = Math.round(node.size?.y ?? 100);
  const body = childrenSvg(fig, node);

  // Background: the node's own fills (solid, gradient, image); white for a node without fill paints.
  const fills = paintLayers(fig, node, pathShape([{ d: `M0,0H${fw}V${fh}H0Z`, rule: 'nonzero' }]), getFillPaints(node), fw, fh);
  const bgContent = fills.svg || (getFillPaints(node)?.length ? '' : `<rect x="0" y="0" width="${fw}" height="${fh}" fill="white"/>`);
  const defsBlock = fills.defs ? `<defs>${fills.defs}</defs>\n` : '';

  // When clip content is OFF, expand viewport to include overflow.
  // Use fractional viewBox origin for exact positioning; ceil the total
  // coordinate range for pixel dimensions (matches Figma's export sizing).
  let vx = 0, vy = 0, w = fw, h = fh;
  if (node.frameMaskDisabled === true) {
    const bounds = _contentBounds(fig, node);
    vx = bounds.minX;
    vy = bounds.minY;
    w = Math.ceil(bounds.maxX - bounds.minX);
    h = Math.ceil(bounds.maxY - bounds.minY);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" \
width="${w}" height="${h}" viewBox="${vx} ${vy} ${w} ${h}">
${defsBlock}${bgContent}
${body}
</svg>`;
  _crispClips = false;
  _pixelScale = 0;
  _modes = [];
  return { svg, unsupported: [..._unsupported].sort() };
}

/** Compute content bounding box of a node's children in the node's local space.
 *  Recurses into INSTANCE→SYMBOL to catch overflow from scaled symbol children. */
function _contentBounds(deck, node, depth = 2) {
  const fw = node.size?.x ?? 0;
  const fh = node.size?.y ?? 0;
  let minX = 0, minY = 0, maxX = fw, maxY = fh;

  for (const child of deck.getChildren(nid(node))) {
    if (child.phase === 'REMOVED' || child.visible === false) continue;

    const cx = child.transform?.m02 ?? 0;
    const cy = child.transform?.m12 ?? 0;
    const cw = child.size?.x ?? 0;
    const ch = child.size?.y ?? 0;

    minX = Math.min(minX, cx);
    minY = Math.min(minY, cy);
    maxX = Math.max(maxX, cx + cw);
    maxY = Math.max(maxY, cy + ch);

    // For INSTANCE nodes, check if symbol children overflow (scaled)
    if (depth > 0 && child.type === 'INSTANCE' && child.symbolData?.symbolID) {
      const symId = child.symbolData.symbolID;
      const sym = deck.getNode(`${symId.sessionID}:${symId.localID}`);
      if (sym) {
        const sw = sym.size?.x || cw;
        const sh = sym.size?.y || ch;
        const sx = cw / sw;
        const sy = ch / sh;
        const symBounds = _contentBounds(deck, sym, depth - 1);
        minX = Math.min(minX, cx + symBounds.minX * sx);
        minY = Math.min(minY, cy + symBounds.minY * sy);
        maxX = Math.max(maxX, cx + symBounds.maxX * sx);
        maxY = Math.max(maxY, cy + symBounds.maxY * sy);
      }
    }
  }

  return { minX, minY, maxX, maxY };
}
