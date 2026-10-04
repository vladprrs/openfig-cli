import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { stateImagePaints, assertImagePaintBinding } from '../../bin/commands/browser-images.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { nativeImageFromPdf, compactBrowserImageLeaves, imageDigest } from '../../lib/rasterizer/browser-image-assets.mjs';

async function nativePdf({ width = 2, height = 1, alpha = Buffer.from([0, 255]) } = {}) {
  const doc = await PDFDocument.create();
  const jpeg = await sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const image = await doc.embedJpg(jpeg);
  await image.embed();
  if (alpha) {
    const mask = doc.context.register(doc.context.flateStream(alpha, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 8, ColorSpace: 'DeviceGray' }));
    doc.context.lookup(image.ref).dict.set(PDFName.of('SMask'), mask);
  }
  doc.addPage([32, 32]).drawImage(image, { x: 0, y: 0, width: 32, height: 32 });
  return { pdf: await doc.save(), jpeg };
}
const png = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const svg = bytes => `<svg viewBox="-2 -1 34 34"><defs><clipPath id="c"><path d="M0 0h32v32H0Z"/></clipPath></defs><g clip-path="url(#c)" transform="translate(-2,-1)"><image width="2000" height="2000" transform="matrix(1,0,0,1,0,0)" href="data:image/png;base64,${bytes.toString('base64')}"/></g></svg>`;

describe('native browser image leaves', () => {
  it('rejects altered filter values, wrong original images and wrong file authority', () => {
    const paint = { type: 'IMAGE', image: { hash: 'original' }, paintFilter: { shadows: -1, vibrance: 1, contrast: 0.11 } };
    const record = { nodeId: 'leaf', fileKey: 'source', imageHash: 'original', paintFilter: { contrast: 0.11, vibrance: 1, shadows: -1 } };
    expect(() => assertImagePaintBinding(paint, record, 'source')).not.toThrow();
    expect(() => assertImagePaintBinding(paint, { ...record, paintFilter: { ...record.paintFilter, contrast: 0 } }, 'source')).toThrow('Wrong source paint binding');
    expect(() => assertImagePaintBinding(paint, { ...record, imageHash: 'other' }, 'source')).toThrow('Wrong source paint binding');
    expect(() => assertImagePaintBinding(paint, record, 'another-file')).toThrow('Wrong source paint binding');
  });
  it('retains visible leaves and excludes descendants of hidden source groups', () => {
    const paint = { type: 'IMAGE', image: { hash: 'visible' } };
    const hiddenPaint = { type: 'IMAGE', image: { hash: 'hidden' } };
    const nodes = [
      { nodeId: 'state', state: 'state', parentId: null, raw: {} },
      { nodeId: 'group', state: 'state', parentId: 'state', raw: { visible: false } },
      { nodeId: 'hidden-leaf', state: 'state', parentId: 'group', raw: { visible: true, fillPaints: [hiddenPaint] } },
      { nodeId: 'visible-leaf', state: 'state', parentId: 'state', raw: { fillPaints: [paint] } },
    ];
    expect(stateImagePaints(nodes, 'state')).toEqual([paint]);
    expect(() => stateImagePaints(nodes.slice(1), 'state')).toThrow('Incomplete source ancestry');
  });
  it('extracts intrinsic image pixels and exact soft alpha rather than the PDF page', async () => {
    const input = await nativePdf();
    const bytes = await nativeImageFromPdf(input.pdf, { width: 2, height: 1 });
    const raw = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const rgb = await sharp(input.jpeg).raw().toBuffer();
    expect(raw.info.width).toBe(2);
    expect([...raw.data]).toEqual([...rgb.subarray(0, 3), 0, ...rgb.subarray(3, 6), 255]);
  });
  it('preserves an opaque intrinsic image without inventing transparency', async () => {
    const input = await nativePdf({ alpha: null });
    const output = await sharp(await nativeImageFromPdf(input.pdf, { width: 2, height: 1 })).raw().toBuffer();
    expect(output[3]).toBe(255);
    expect(output[7]).toBe(255);
  });
  it('rejects a page raster or a truncated alpha plane', async () => {
    const input = await nativePdf();
    await expect(nativeImageFromPdf(input.pdf, { width: 32, height: 32 })).rejects.toThrow('intrinsic extent');
    const broken = await nativePdf({ alpha: Buffer.from([255]) });
    await expect(nativeImageFromPdf(broken.pdf, { width: 2, height: 1 })).rejects.toThrow('alpha length');
  });
  it('compacts image leaves while preserving every geometry and mask byte', async () => {
    const original = await png(512, 256, '#336699');
    const input = svg(original);
    const result = await compactBrowserImageLeaves(input, { maxDimension: 128 });
    const hide = value => value.replace(/base64,[A-Za-z0-9+/=]+/g, 'base64,IMAGE');
    expect(hide(result.svg)).toBe(hide(input));
    const derivative = Buffer.from(result.svg.match(/base64,([A-Za-z0-9+/=]+)/)[1], 'base64');
    expect((await sharp(derivative).metadata()).width).toBe(128);
    expect((await sharp(derivative).metadata()).height).toBe(64);
    expect(result.evidence[0].intrinsic).toEqual([512, 256]);
    expect(result.evidence[0].replacementSha256).toBeNull();
  });
  it('uses a bound adjusted image and rejects an unused or differently sized substitute', async () => {
    const original = await png(2, 1, '#336699');
    const adjusted = await png(2, 1, '#aa0044');
    const replacements = new Map([[imageDigest(original), adjusted]]);
    const result = await compactBrowserImageLeaves(svg(original), { replacements });
    expect(result.evidence[0].replacementSha256).toBe(imageDigest(adjusted));
    const output = Buffer.from(result.svg.match(/base64,([A-Za-z0-9+/=]+)/)[1], 'base64');
    expect([...(await sharp(output).raw().toBuffer()).subarray(0, 4)]).toEqual([170, 0, 68, 255]);
    await expect(compactBrowserImageLeaves(svg(original), { replacements: new Map([['wrong', adjusted]]) })).rejects.toThrow('not used');
    const wrongSize = await png(1, 1, '#aa0044');
    await expect(compactBrowserImageLeaves(svg(original), { replacements: new Map([[imageDigest(original), wrongSize]]) })).rejects.toThrow('intrinsic image extent');
  });
});
