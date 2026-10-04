/** Native image-leaf derivatives. Geometry and page pixels are never rasterized here. */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';

export const imageDigest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Extract a full intrinsic image and its soft mask from an official image-leaf PDF.
 * Reject page rasters, ambiguous image sets and unsupported encodings. A caller must
 * bind the official export to the exact source leaf/paint; PDF has no Figma node IDs.
 */
export async function nativeImageFromPdf(bytes, { width, height }) {
  const doc = await PDFDocument.load(bytes);
  const images = doc.context.enumerateIndirectObjects().map(([, value]) => value)
    .filter(value => value instanceof PDFRawStream && value.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
  const candidates = images.filter(image => image.dict.lookup(PDFName.of('ColorSpace')).toString() !== '/DeviceGray');
  if (doc.getPageCount() !== 1 || candidates.length !== 1) throw new Error('Expected one native colour image');
  const image = candidates[0];
  const size = value => [value.dict.lookup(PDFName.of('Width')).asNumber(), value.dict.lookup(PDFName.of('Height')).asNumber()];
  if (size(image)[0] !== width || size(image)[1] !== height) throw new Error('PDF image is not the source intrinsic extent');
  if (image.dict.lookup(PDFName.of('BitsPerComponent')).asNumber() !== 8) throw new Error('Unsupported PDF image depth');
  const filter = image.dict.lookup(PDFName.of('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray().map(value => value.toString()) : [filter?.toString()];
  if (filters.length !== 1 || filters[0] !== '/DCTDecode') throw new Error('Expected a native JPEG image stream');
  const maskRef = image.dict.get(PDFName.of('SMask'));
  const mask = maskRef ? doc.context.lookup(maskRef) : null;
  let alpha = Buffer.alloc(width * height, 255);
  if (mask) {
  if (!(mask instanceof PDFRawStream) || size(mask)[0] !== width || size(mask)[1] !== height ||
      mask.dict.lookup(PDFName.of('ColorSpace')).toString() !== '/DeviceGray' ||
      mask.dict.lookup(PDFName.of('BitsPerComponent')).asNumber() !== 8) throw new Error('Unsupported native alpha mask');
  const maskFilter = mask.dict.lookup(PDFName.of('Filter'));
  if (maskFilter.toString() !== '[ /FlateDecode ]' && maskFilter.toString() !== '/FlateDecode') throw new Error('Unsupported native alpha encoding');
  if (mask.dict.has(PDFName.of('DecodeParms')) || mask.dict.has(PDFName.of('Decode'))) throw new Error('Unsupported native alpha predictor');
  alpha = inflateSync(mask.contents);
  if (alpha.length !== width * height) throw new Error('Invalid native alpha length');
  }
  const rgb = await sharp(image.contents).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (rgb.info.width !== width || rgb.info.height !== height || rgb.info.channels !== 3) throw new Error('Invalid native image dimensions');
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < alpha.length; i++) {
    rgb.data.copy(rgba, i * 4, i * 3, i * 3 + 3);
    rgba[i * 4 + 3] = alpha[i];
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Compact only embedded image leaves; every SVG attribute/geometry stays intact.
 * Replacements are bound by the original leaf's bytes, never by filename or ordinal.
 * Dimensions stay intrinsic in SVG (including TILE geometry). Source PNGs stay private.
 */
export async function compactBrowserImageLeaves(svg, { maxDimension = 256, replacements = new Map() } = {}) {
  if (!Number.isInteger(maxDimension) || maxDimension < 1) throw new Error('Invalid image derivative size');
  const pattern = /data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)/g;
  const matches = [...svg.matchAll(pattern)];
  const derivatives = new Map();
  const used = new Set();
  const evidence = [];
  for (const match of matches) {
    const original = Buffer.from(match[2], 'base64');
    const originalSha256 = imageDigest(original);
    const replacement = replacements.get(originalSha256);
    if (replacement) used.add(originalSha256);
    if (!derivatives.has(originalSha256)) {
      const input = replacement ?? original;
      const originalSize = await sharp(original).metadata();
      const inputSize = await sharp(input).metadata();
      if ((originalSize.pages ?? 1) !== 1 || (inputSize.pages ?? 1) !== 1) throw new Error('Animated image compaction is unsupported');
      if (originalSize.width !== inputSize.width || originalSize.height !== inputSize.height) throw new Error('Replacement changes intrinsic image extent');
      const output = await sharp(input, { animated: true }).resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      derivatives.set(originalSha256, `data:image/png;base64,${output.toString('base64')}`);
      evidence.push({ originalSha256, replacementSha256: replacement ? imageDigest(replacement) : null,
        derivativeSha256: imageDigest(output), originalBytes: original.length, derivativeBytes: output.length,
        intrinsic: [originalSize.width, originalSize.height] });
    }
  }
  for (const key of replacements.keys()) if (!used.has(key)) throw new Error(`Replacement source image was not used: ${key}`);
  let index = 0;
  const output = svg.replace(pattern, () => derivatives.get(imageDigest(Buffer.from(matches[index++][2], 'base64'))));
  return { svg: output, evidence };
}
