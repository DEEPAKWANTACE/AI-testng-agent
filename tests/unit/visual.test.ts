import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { executableStepSchema, stepSequenceIssues } from "@/modules/execution/steps";
import { compareImages } from "@/worker/execution/visual";

/** Solid image with an optional rectangle painted in another colour. */
function png(width: number, height: number, rect?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inRect = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inRect ? rect.rgb : [255, 255, 255];
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const options = { threshold: 0.1, maxDiffRatio: 0.001 };

describe("visual comparison", () => {
  it("matches identical images", () => {
    expect(compareImages(png(100, 100), png(100, 100), options)).toMatchObject({ match: true, diffPixels: 0 });
  });

  it("tolerates differences within the allowed ratio", () => {
    // 3×3 = 9 of 10,000 pixels (0.09%) is within 0.1%.
    expect(compareImages(png(100, 100), png(100, 100, { x: 10, y: 10, w: 3, h: 3, rgb: [0, 0, 0] }), options)).toMatchObject({ match: true, diffPixels: 9 });
  });

  it("reports pixel differences beyond the ratio with a diff image", () => {
    const result = compareImages(png(100, 100), png(100, 100, { x: 10, y: 10, w: 20, h: 20, rgb: [200, 0, 0] }), options);
    expect(result).toMatchObject({ match: false, reason: "pixels", diffPixels: 400, diffRatio: 0.04 });
    expect(result.match === false && result.reason === "pixels" && PNG.sync.read(result.diffPng).width).toBe(100);
  });

  it("ignores colour changes below the per-pixel threshold", () => {
    expect(compareImages(png(50, 50), png(50, 50, { x: 0, y: 0, w: 50, h: 50, rgb: [252, 252, 252] }), options).match).toBe(true);
    expect(compareImages(png(50, 50), png(50, 50, { x: 0, y: 0, w: 50, h: 50, rgb: [252, 252, 252] }), { threshold: 0, maxDiffRatio: 0 }).match).toBe(false);
  });

  it("treats a size change as a mismatch", () => {
    expect(compareImages(png(100, 100), png(100, 120), options)).toEqual({ match: false, reason: "size", expected: { width: 100, height: 100 }, actual: { width: 100, height: 120 } });
  });
});

describe("visual steps", () => {
  const step = (params: unknown) => ({ kind: "ASSERT_VISUAL", description: "Looks right", params });
  it("validates parameters strictly", () => {
    expect(executableStepSchema.safeParse(step({ name: "product-list", target: { by: "css", value: "main ul" }, mask: [{ by: "testId", value: "clock" }], maxDiffRatio: 0.01 })).success).toBe(true);
    for (const bad of [{ name: "Product List" }, { name: "x", maxDiffRatio: 0.5 }, { name: "x", mask: Array(11).fill({ by: "css", value: "a" }) }, { name: "x", fullPage: true }, { name: "x", threshold: 2 }]) {
      expect(executableStepSchema.safeParse(step(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("rejects a baseline name used twice in a case", () => {
    expect(stepSequenceIssues([{ kind: "ASSERT_VISUAL", params: { name: "a" } }, { kind: "ASSERT_VISUAL", params: { name: "a" } }])).toEqual(["Step 2: visual baseline name a is used twice in this case"]);
  });
});
