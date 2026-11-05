// Screenshot comparison against a baseline using pixelmatch. Images of different heights are
// padded to the same size, so added or removed content shows up as changed area.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface CompareResult {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  width: number;
  height: number;
  baselineHeight: number;
  currentHeight: number;
  diffPng: Buffer;
}

function padTo(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  // Fill padding with opaque magenta so it is counted as different from any real page content.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, width), Math.min(img.height, height), 0, 0);
  return out;
}

export function compareScreenshots(baseline: Buffer, current: Buffer, pixelTolerance: number): CompareResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = padTo(a, width, height);
  const pb = padTo(b, width, height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, {
    threshold: Math.min(1, Math.max(0, pixelTolerance)),
    includeAA: false,
    alpha: 0.25,
    diffColor: [220, 38, 38],
  });
  const totalPixels = width * height;
  return {
    diffPixels,
    totalPixels,
    ratio: totalPixels ? diffPixels / totalPixels : 0,
    width,
    height,
    baselineHeight: a.height,
    currentHeight: b.height,
    diffPng: PNG.sync.write(diff),
  };
}
