import type { Mask, Point } from "../core/types";
export const MODEL_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
export function resizedDimensions(
  width: number,
  height: number,
): [number, number] {
  if (width <= 0 || height <= 0) throw new Error("The frame has no pixels.");
  const scale = MODEL_SIZE / Math.max(width, height);
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}
/** RGB, longest edge 1024, ImageNet normalization, then bottom/right zero padding. */
export function preprocess(image: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): { pixels: Float32Array; width: number; height: number } {
  const [width, height] = resizedDimensions(image.width, image.height);
  const pixels = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, ((y + 0.5) * image.height) / height - 0.5);
    const y0 = Math.floor(sy),
      y1 = Math.min(image.height - 1, y0 + 1),
      dy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, ((x + 0.5) * image.width) / width - 0.5);
      const x0 = Math.floor(sx),
        x1 = Math.min(image.width - 1, x0 + 1),
        dx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const a = image.data[(y0 * image.width + x0) * 4 + c];
        const b = image.data[(y0 * image.width + x1) * 4 + c];
        const d = image.data[(y1 * image.width + x0) * 4 + c];
        const e = image.data[(y1 * image.width + x1) * 4 + c];
        const value =
          (a * (1 - dx) + b * dx) * (1 - dy) + (d * (1 - dx) + e * dx) * dy;
        pixels[c * MODEL_SIZE * MODEL_SIZE + y * MODEL_SIZE + x] =
          (value / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return { pixels, width, height };
}
export function promptArrays(
  points: Point[],
  width: number,
  height: number,
): { coordinates: Float32Array; labels: BigInt64Array; count: number } {
  if (!points.length || !points.some((p) => p.label === 1))
    throw new Error(
      "Add at least one positive point before generating a mask.",
    );
  if (points.length > 128)
    throw new Error("Use at most 128 points on one frame.");
  if (
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        (p.label !== 0 && p.label !== 1),
    )
  )
    throw new Error("Prompt coordinates and labels are invalid.");
  // This ONNX graph itself appends SAM's no-box sentinel; do not append it twice.
  const coordinates = new Float32Array(points.length * 2);
  const labels = new BigInt64Array(points.length);
  points.forEach((p, i) => {
    coordinates[2 * i] = Math.min(1, Math.max(0, p.x)) * width;
    coordinates[2 * i + 1] = Math.min(1, Math.max(0, p.y)) * height;
    labels[i] = BigInt(p.label);
  });
  return { coordinates, labels, count: labels.length };
}
function sample(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  offset = 0,
  stride = width,
): number {
  const sx = Math.max(0, Math.min(width - 1, x)),
    sy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(sx),
    y0 = Math.floor(sy),
    x1 = Math.min(x0 + 1, width - 1),
    y1 = Math.min(y0 + 1, height - 1);
  const dx = sx - x0,
    dy = sy - y0;
  return (
    (data[offset + y0 * stride + x0] * (1 - dx) +
      data[offset + y0 * stride + x1] * dx) *
      (1 - dy) +
    (data[offset + y1 * stride + x0] * (1 - dx) +
      data[offset + y1 * stride + x1] * dx) *
      dy
  );
}
/** Select highest IoU mask; upsample logits before thresholding and remove letterbox. */
export function postprocess(
  logits: Float32Array,
  scores: Float32Array,
  originalWidth: number,
  originalHeight: number,
  resizedWidth: number,
  resizedHeight: number,
): Mask {
  let best = 0;
  for (let i = 1; i < scores.length; i++)
    if (scores[i] > scores[best]) best = i;
  const expanded = new Float32Array(MODEL_SIZE * MODEL_SIZE);
  for (let y = 0; y < MODEL_SIZE; y++)
    for (let x = 0; x < MODEL_SIZE; x++) {
      expanded[y * MODEL_SIZE + x] = sample(
        logits,
        256,
        256,
        (x + 0.5) / 4 - 0.5,
        (y + 0.5) / 4 - 0.5,
        best * 256 * 256,
      );
    }
  const scale = Math.min(
    1,
    MODEL_SIZE / Math.max(originalWidth, originalHeight),
  );
  const width = Math.max(1, Math.round(originalWidth * scale)),
    height = Math.max(1, Math.round(originalHeight * scale));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      data[y * width + x] =
        sample(
          expanded,
          resizedWidth,
          resizedHeight,
          ((x + 0.5) * resizedWidth) / width - 0.5,
          ((y + 0.5) * resizedHeight) / height - 0.5,
          0,
          MODEL_SIZE,
        ) > 0
          ? 255
          : 0;
    }
  return { width, height, data };
}
