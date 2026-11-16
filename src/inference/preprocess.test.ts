import { describe, it, expect } from "vitest";
import {
  preprocess,
  resizedDimensions,
  promptArrays,
  postprocess,
} from "./preprocess";
describe("SlimSAM preprocessing", () => {
  it("preserves aspect ratio, normalizes RGB and zero pads after normalization", () => {
    expect(resizedDimensions(1920, 1080)).toEqual([1024, 576]);
    const result = preprocess({
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]),
    });
    expect(result.width).toBe(1024);
    expect(result.height).toBe(512);
    expect(result.pixels[0]).toBeCloseTo((1 - 0.485) / 0.229);
    expect(result.pixels[1024 * 1024]).toBeCloseTo(-0.456 / 0.224);
    expect(result.pixels[512 * 1024]).toBe(0);
  });
  it("transforms mixed prompts without duplicating the graph-owned no-box sentinel", () => {
    const p = promptArrays(
      [
        { x: 0.25, y: 0.75, label: 1 },
        { x: 0.8, y: 0.2, label: 0 },
      ],
      1024,
      576,
    );
    expect([...p.coordinates]).toEqual([
      256, 432, 819.2000122070312, 115.19999694824219,
    ]);
    expect([...p.labels]).toEqual([1n, 0n]);
    expect(p.count).toBe(2);
    expect(() =>
      promptArrays([{ x: 0.5, y: 0.5, label: 0 }], 1024, 576),
    ).toThrow("positive");
  });
  it("chooses the highest scoring mask, crops letterbox and bounds output memory", () => {
    const logits = new Float32Array(3 * 256 * 256).fill(-5);
    // Chosen mask is foreground in the left half only.
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 128; x++) logits[256 * 256 + y * 256 + x] = 5;
    const mask = postprocess(
      logits,
      new Float32Array([0.1, 0.9, 0.3]),
      1920,
      1080,
      1024,
      576,
    );
    expect([mask.width, mask.height]).toEqual([1024, 576]);
    expect(mask.data[0]).toBe(255);
    expect(mask.data[1023]).toBe(0);
    expect(mask.data[575 * 1024]).toBe(255);
  });
  it("never samples padding when cropping a narrow portrait mask", () => {
    const logits = new Float32Array(3 * 256 * 256).fill(-8);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 64; x++) logits[y * 256 + x] = 8;
    const mask = postprocess(
      logits,
      new Float32Array([1, 0, 0]),
      100,
      400,
      256,
      1024,
    );
    expect(mask.data[0]).toBe(255);
    expect(mask.width).toBe(100);
    expect(mask.height).toBe(400);
  });
});
