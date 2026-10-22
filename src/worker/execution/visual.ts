import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Result of comparing a capture with its approved baseline. */
export type VisualComparison =
  | { match: true; diffRatio: number; diffPixels: number; width: number; height: number }
  | { match: false; reason: "size"; expected: { width: number; height: number }; actual: { width: number; height: number } }
  | { match: false; reason: "pixels"; diffRatio: number; diffPixels: number; width: number; height: number; diffPng: Buffer };

export function pngSize(png: Buffer): { width: number; height: number } {
  const { width, height } = PNG.sync.read(png);
  return { width, height };
}

/**
 * Deterministic pixel comparison (pixelmatch, anti-aliasing ignored). A size change is a
 * mismatch on its own; otherwise the share of differing pixels must stay within maxDiffRatio.
 */
export function compareImages(baseline: Buffer, actual: Buffer, options: { threshold: number; maxDiffRatio: number }): VisualComparison {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return { match: false, reason: "size", expected: { width: a.width, height: a.height }, actual: { width: b.width, height: b.height } };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: options.threshold, includeAA: false, alpha: 0.2 });
  const diffRatio = diffPixels / (a.width * a.height || 1);
  if (diffRatio <= options.maxDiffRatio) return { match: true, diffRatio, diffPixels, width: a.width, height: a.height };
  return { match: false, reason: "pixels", diffRatio, diffPixels, width: a.width, height: a.height, diffPng: PNG.sync.write(diff) };
}
