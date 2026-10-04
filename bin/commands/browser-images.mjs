import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { compactBrowserImageLeaves, imageDigest, nativeImageFromPdf } from '../../lib/rasterizer/browser-image-assets.mjs';

const canonical = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const key = paint => `${paint.image.hash}:${canonical(paint.paintFilter)}`;
const adjusted = paint => Object.values(paint.paintFilter ?? {}).some(value => typeof value === 'number' && Math.abs(value) > 1e-6);

export function assertImagePaintBinding(paint, record, fileKey) {
  if (!paint || paint.type !== 'IMAGE' || record.fileKey !== fileKey || record.imageHash !== paint.image.hash || canonical(record.paintFilter) !== canonical(paint.paintFilter)) throw new Error(`Wrong source paint binding: ${record.nodeId}`);
}

/** A hidden ancestor hides its paints too, even when the leaf is individually visible. */
export function stateImagePaints(nodes, stateId) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const visible = node => {
    const visited = new Set();
    while (node) {
      if (visited.has(node.nodeId)) throw new Error('Cyclic source ancestry');
      visited.add(node.nodeId);
      if (node.raw.visible === false || node.raw.phase === 'REMOVED') return false;
      if (node.nodeId === stateId) return true;
      node = byId.get(node.parentId);
    }
    throw new Error('Incomplete source ancestry');
  };
  return nodes.filter(node => node.state === stateId && visible(node))
    .flatMap(node => (node.raw.fillPaints ?? []).filter(paint => paint.type === 'IMAGE' && paint.visible !== false));
}

/** Build already-native SVGs; no page rasterization and no approximate filter mapping. */
export async function run(args, flags) {
  if (args.length !== 1 || !flags.out) throw new Error('Usage: openfig browser-images SPEC.json --out DIRECTORY');
  const spec = JSON.parse(readFileSync(args[0], 'utf8'));
  const facts = JSON.parse(readFileSync(spec.sourceFacts, 'utf8'));
  if (facts.format !== 'migration-node-facts' || facts.refused.length || facts.sources.length !== 1 || facts.sources[0].sha256 !== spec.sourceSha256) throw new Error('Unbound source facts');
  const records = new Map();
  const byId = new Map(facts.nodes.map(node => [node.nodeId, node]));
  for (const record of spec.adjustments) {
    const node = byId.get(record.nodeId);
    const paint = node?.raw.fillPaints?.[record.paintIndex];
    assertImagePaintBinding(paint, record, facts.fileKey);
    const bytes = readFileSync(record.pdf);
    if (imageDigest(bytes) !== record.pdfSha256) throw new Error(`Changed official image export: ${record.nodeId}`);
    if (records.has(key(paint))) throw new Error('Duplicate adjusted image binding');
    records.set(key(paint), { record, width: paint.originalImageWidth, height: paint.originalImageHeight, bytes });
  }
  const prepared = [];
  for (const state of spec.states) {
    const svg = readFileSync(state.svg, 'utf8');
    if (imageDigest(svg) !== state.svgSha256) throw new Error(`Changed retained native SVG: ${state.nodeId}`);
    if (!byId.has(state.nodeId)) throw new Error(`State outside source closure: ${state.nodeId}`);
    const paints = stateImagePaints(facts.nodes, state.nodeId);
    const embedded = [...svg.matchAll(/data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)/g)].map(match => Buffer.from(match[1], 'base64'));
    const hashes = new Map(embedded.map(bytes => [createHash('sha1').update(bytes).digest('hex'), imageDigest(bytes)]));
    for (const hash of hashes.keys()) if (!paints.some(paint => paint.image.hash === hash)) throw new Error(`SVG image outside source paints: ${state.nodeId}`);
    for (const paint of paints) {
      if (!hashes.has(paint.image.hash)) throw new Error(`Source image omitted: ${state.nodeId}`);
      if (adjusted(paint) && !records.has(key(paint))) throw new Error(`Missing official adjusted leaf: ${state.nodeId}`);
    }
    const paintKeys = new Map();
    for (const paint of paints) {
      if (paintKeys.has(paint.image.hash) && paintKeys.get(paint.image.hash) !== key(paint)) throw new Error('Ambiguous repeated image with different adjustments');
      paintKeys.set(paint.image.hash, key(paint));
    }
    prepared.push({ state, svg, paints, hashes });
  }
  // Resolve and validate every native leaf before writing any state output.
  const assets = new Map();
  for (const [id, item] of records) assets.set(id, await nativeImageFromPdf(item.bytes, item));
  mkdirSync(flags.out, { recursive: true });
  const states = [];
  for (const item of prepared) {
    const replacements = new Map(item.paints.filter(adjusted).map(paint => [item.hashes.get(paint.image.hash), assets.get(key(paint))]));
    const result = await compactBrowserImageLeaves(item.svg, { maxDimension: spec.maxDimension ?? 256, replacements });
    const file = `${item.state.nodeId.replace(':', '-')}.svg`;
    writeFileSync(path.join(flags.out, file), result.svg);
    states.push({ nodeId: item.state.nodeId, file, retainedSvgSha256: item.state.svgSha256, runtimeSha256: imageDigest(result.svg), runtimeBytes: Buffer.byteLength(result.svg), imageLeaves: result.evidence,
      adjustments: item.paints.filter(adjusted).map(paint => ({ imageHash: paint.image.hash, paintFilter: paint.paintFilter, officialPdfSha256: records.get(key(paint)).record.pdfSha256 })) });
  }
  const report = { format: 'native-browser-image-build', sourceSha256: spec.sourceSha256, maxDimension: spec.maxDimension ?? 256,
    states, summary: { states: states.length, adjustedStates: states.filter(state => state.adjustments.length).length, nativeAdjustedImages: assets.size, runtimeBytes: states.reduce((sum, state) => sum + state.runtimeBytes, 0) } };
  writeFileSync(path.join(flags.out, 'image-build.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
}
