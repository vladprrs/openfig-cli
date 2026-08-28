import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { FigDeck } from 'openfig-cli/deck';
import { nid } from 'openfig-cli/node-helpers';
import { frameToSvg, svgToPng } from 'openfig-cli/rasterizer';

const FIXTURE = join(
  import.meta.dirname,
  '../fixtures/figs/reference/basic-shapes.fig',
);

describe('public rasterizer API', () => {
  it('exports one supported .fig frame-to-SVG-to-PNG boundary', async () => {
    const fig = await FigDeck.fromDeckFile(FIXTURE);
    const page = fig.getPages()[0];
    const frame = fig.getChildren(nid(page))
      .filter(node => node.phase !== 'REMOVED' && node.type === 'FRAME')
      .find(node => node.name === 'basic_shapes');

    expect(frame).toBeTruthy();

    const svg = frameToSvg(fig, frame);
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('<path');

    const png = await svgToPng(svg, {
      background: 'rgba(0,0,0,0)',
      scale: 1,
    });
    expect(Buffer.from(png.subarray(1, 4)).toString('ascii')).toBe('PNG');
  });

  it('renders a gradient UNION boolean from child geometry without a sentinel', async () => {
    const fig = FigDeck.createEmpty({ name: 'gradient boolean regression' });
    const frame = node('1:1', 'FRAME', 'Frame', 80, 80);
    const union = node('1:2', 'BOOLEAN_OPERATION', 'PLUS-SYMBOL', 40, 40, '1:1');
    union.booleanOperation = 'UNION';
    union.fillPaints = [{
      type: 'GRADIENT_LINEAR',
      visible: true,
      opacity: 1,
      blendMode: 'NORMAL',
      stops: [
        { position: 0, color: { r: 1, g: 0.36, b: 0.3, a: 1 } },
        { position: 1, color: { r: 0.51, g: 0.25, b: 0.94, a: 1 } },
      ],
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    }];
    const horizontal = node('1:3', 'RECTANGLE', 'Horizontal', 32, 10, '1:2');
    horizontal.transform = { m00: 1, m01: 0, m02: 4, m10: 0, m11: 1, m12: 15 };
    horizontal.fillPaints = [solidBlack()];
    const vertical = node('1:4', 'RECTANGLE', 'Vertical', 10, 32, '1:2');
    vertical.transform = { m00: 1, m01: 0, m02: 15, m10: 0, m11: 1, m12: 4 };
    vertical.fillPaints = [solidBlack()];
    fig.message.nodeChanges.push(frame, union, horizontal, vertical);
    fig.rebuildMaps();

    const svg = frameToSvg(fig, frame);
    expect(svg).not.toContain('#ff00ff');
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('rgba(255,92,77,1.0000)');
    expect(svg).toContain('rgba(130,64,240,1.0000)');

    const png = await svgToPng(svg, { background: '#fff', scale: 1 });
    expect(Buffer.from(png.subarray(1, 4)).toString('ascii')).toBe('PNG');
  });
});

function node(id, type, name, width, height, parentId) {
  const [sessionID, localID] = id.split(':').map(Number);
  const parent = parentId?.split(':').map(Number);
  return {
    guid: { sessionID, localID },
    type,
    name,
    phase: 'CREATED',
    size: { x: width, y: height },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    ...(parent
      ? {
          parentIndex: {
            guid: { sessionID: parent[0], localID: parent[1] },
            position: localID.toString(36),
          },
        }
      : {}),
  };
}

function solidBlack() {
  return {
    type: 'SOLID',
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
    color: { r: 0, g: 0, b: 0, a: 1 },
  };
}
