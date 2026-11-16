/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/all";
import type { ModelProgress, ModelStatus, Point } from "../core/types";
import { MODEL_CACHE, MODEL_MANIFEST, modelUrl } from "./manifest";
import { postprocess, preprocess, promptArrays } from "./preprocess";

type Request = {
  id: number;
  method: "load" | "status" | "segment" | "clearCache";
  image?: { width: number; height: number; data: Uint8ClampedArray };
  points?: Point[];
  forceWasm?: boolean;
};
const scope = self as DedicatedWorkerGlobalScope;
ort.env.wasm.wasmPaths = {
  wasm: new URL("/ort/ort-wasm-simd-threaded.jsep.wasm", self.location.origin)
    .href,
  mjs: new URL("/ort/ort-wasm-simd-threaded.jsep.mjs", self.location.origin)
    .href,
};
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;
ort.env.wasm.proxy = false;
let encoder: ort.InferenceSession | undefined;
let decoder: ort.InferenceSession | undefined;
let embeddings: ort.InferenceSession.ReturnType | undefined;
let frameHash = "";
let backend = "Not loaded";
let cacheWarning = "";
const files = Object.values(MODEL_MANIFEST.files);
const key = (sha: string) =>
  new URL(`/__sammie_models__/${sha}`, self.location.origin).href;
function progress(id: number, stage: string, value: number) {
  scope.postMessage({
    id,
    progress: { stage, progress: value } satisfies ModelProgress,
  });
}
async function sha256(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function cache(): Promise<Cache | undefined> {
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    cacheWarning =
      " Browser storage is unavailable; models will download again next time.";
    return undefined;
  }
}
async function isCached(): Promise<boolean> {
  const store = await cache();
  if (!store) return false;
  try {
    return (
      await Promise.all(files.map((f) => store.match(key(f.sha256))))
    ).every(Boolean);
  } catch {
    cacheWarning = " Browser model storage is unavailable.";
    return false;
  }
}
async function status(): Promise<ModelStatus> {
  return {
    ready: !!encoder && !!decoder,
    backend,
    cached: await isCached(),
    message: encoder
      ? `SlimSAM ready. ${backend}. Single-frame AI; no temporal memory.${cacheWarning}`
      : `Download 39.8 MB once to generate local AI masks.${cacheWarning}`,
  };
}
async function weights(
  file: (typeof files)[number],
  id: number,
): Promise<ArrayBuffer> {
  const store = await cache();
  try {
    const cached = await store?.match(key(file.sha256));
    if (cached) {
      const data = await cached.arrayBuffer();
      if (
        data.byteLength === file.bytes &&
        (await sha256(data)) === file.sha256
      ) {
        progress(id, `Verified cached ${file.name}`, 1);
        return data;
      }
      await store?.delete(key(file.sha256));
    }
  } catch {
    cacheWarning = " Could not read model cache; downloading fresh files.";
  }
  const response = await fetch(modelUrl(file.name), {
    mode: "cors",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(
      `Model download failed (${response.status}). Check the model URL and R2 CORS.`,
    );
  const reader = response.body?.getReader();
  let data: ArrayBuffer;
  if (!reader) data = await response.arrayBuffer();
  else {
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > file.bytes) {
        await reader.cancel();
        throw new Error(
          `Unexpected size for ${file.name}; refusing this model.`,
        );
      }
      chunks.push(value);
      progress(
        id,
        `Downloading ${file.name}`,
        Math.min(1, received / file.bytes),
      );
    }
    const output = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    data = output.buffer;
  }
  progress(id, `Checking SHA-256 · ${file.name}`, 1);
  if (data.byteLength !== file.bytes || (await sha256(data)) !== file.sha256)
    throw new Error(
      `Checksum mismatch for ${file.name}. Download rejected; check the pinned manifest.`,
    );
  if (store) {
    try {
      await store.put(
        key(file.sha256),
        new Response(data, {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
    } catch {
      cacheWarning =
        " Model caching failed; inference still works for this visit.";
    }
  }
  return data;
}
async function releaseSessions() {
  if (embeddings) Object.values(embeddings).forEach((t) => t.dispose());
  embeddings = undefined;
  frameHash = "";
  await Promise.all([encoder?.release(), decoder?.release()]);
  encoder = undefined;
  decoder = undefined;
  backend = "Not loaded";
}
async function load(id: number, forceWasm = false): Promise<ModelStatus> {
  if (encoder && decoder && (!forceWasm || backend.startsWith("WASM")))
    return status();
  await releaseSessions();
  const encoderBytes = await weights(MODEL_MANIFEST.files.encoder, id);
  const decoderBytes = await weights(MODEL_MANIFEST.files.decoder, id);
  progress(id, "Starting local inference runtime", 0);
  const hasGPU = "gpu" in navigator && !forceWasm;
  if (hasGPU) {
    try {
      encoder = await ort.InferenceSession.create(encoderBytes, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      decoder = await ort.InferenceSession.create(decoderBytes, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      backend = "WebGPU (WASM fallback)";
    } catch (error) {
      await releaseSessions();
      progress(
        id,
        `WebGPU unavailable; starting WASM (${error instanceof Error ? error.message.slice(0, 100) : "unsupported device"})`,
        0,
      );
    }
  }
  if (!encoder || !decoder) {
    encoder = await ort.InferenceSession.create(encoderBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    decoder = await ort.InferenceSession.create(decoderBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    backend = `WASM · ${ort.env.wasm.numThreads} thread${ort.env.wasm.numThreads === 1 ? "" : "s"}`;
  }
  const requiredEncoder = ["pixel_values"];
  const requiredDecoder = [
    "input_points",
    "input_labels",
    "image_embeddings",
    "image_positional_embeddings",
  ];
  if (
    !requiredEncoder.every((x) => encoder!.inputNames.includes(x)) ||
    !requiredDecoder.every((x) => decoder!.inputNames.includes(x))
  ) {
    await releaseSessions();
    throw new Error(
      "Model signatures do not match the supported SlimSAM pipeline.",
    );
  }
  progress(id, "Model ready", 1);
  return status();
}
async function segment(request: Request, retry = true) {
  const { id, image, points } = request;
  if (!image || !points) throw new Error("Missing frame or prompts.");
  const processed = preprocess(image);
  const prompt = promptArrays(points, processed.width, processed.height);
  if (!encoder || !decoder) await load(id, request.forceWasm);
  try {
    const hash = `${image.width}x${image.height}:${await sha256(image.data.buffer as ArrayBuffer)}`;
    if (hash !== frameHash || !embeddings) {
      progress(id, "Encoding frame on your device", 0);
      if (embeddings) Object.values(embeddings).forEach((t) => t.dispose());
      embeddings = undefined;
      frameHash = "";
      const tensor = new ort.Tensor(
        "float32",
        processed.pixels,
        [1, 3, 1024, 1024],
      );
      try {
        embeddings = await encoder!.run({ pixel_values: tensor });
        frameHash = hash;
      } finally {
        tensor.dispose();
      }
    }
    progress(id, "Decoding prompt mask", 0.75);
    const inputPoints = new ort.Tensor("float32", prompt.coordinates, [
      1,
      1,
      prompt.count,
      2,
    ]);
    const inputLabels = new ort.Tensor("int64", prompt.labels, [
      1,
      1,
      prompt.count,
    ]);
    let output: ort.InferenceSession.ReturnType | undefined;
    try {
      output = await decoder!.run({
        input_points: inputPoints,
        input_labels: inputLabels,
        image_embeddings: embeddings!.image_embeddings,
        image_positional_embeddings: embeddings!.image_positional_embeddings,
      });
      const result = postprocess(
        output.pred_masks.data as Float32Array,
        output.iou_scores.data as Float32Array,
        image.width,
        image.height,
        processed.width,
        processed.height,
      );
      progress(id, "Mask ready", 1);
      return result;
    } finally {
      inputPoints.dispose();
      inputLabels.dispose();
      if (output) Object.values(output).forEach((t) => t.dispose());
    }
  } catch (error) {
    if (retry && backend.startsWith("WebGPU")) {
      progress(id, "GPU execution failed; retrying with WASM", 0);
      await load(id, true);
      return segment(request, false);
    }
    throw error;
  }
}
let queue = Promise.resolve();
scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (request.method === "load")
        result = await load(request.id, request.forceWasm);
      else if (request.method === "status") result = await status();
      else if (request.method === "clearCache") {
        await releaseSessions();
        try {
          await Promise.all(
            (await caches.keys())
              .filter((name) => name.startsWith("sammie-models-"))
              .map((name) => caches.delete(name)),
          );
        } catch {
          cacheWarning = " Browser model storage could not be cleared.";
        }
        backend = "Not loaded";
        result = undefined;
      } else result = await segment(request);
      if (request.method === "segment") {
        const mask = result as { data: Uint8Array };
        scope.postMessage({ id: request.id, result }, [mask.data.buffer]);
      } else scope.postMessage({ id: request.id, result });
    } catch (error) {
      scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
