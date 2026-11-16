# Local model pipeline

This release runs **real SlimSAM image segmentation** in a dedicated browser worker. It does **not** run SAM 2 / EdgeTAM video memory. A mask is inferred from the current frame and its positive/negative points. Repeating points across frames is repeated image inference, not learned temporal tracking. Fast motion, occlusion and changing object appearance need new prompts. Manual paint/erase strokes remain separate from the AI mask, so regenerating a mask does not destroy corrections.

## Why this model

The [official EdgeTAM repository](https://github.com/facebookresearch/EdgeTAM) publishes a PyTorch checkpoint, a PyTorch video predictor and a CoreML export path. The inspected official release does not supply an ONNX browser video-memory bundle with a verified state/tensor contract. Its iPhone performance is not a browser performance promise. Integrating that temporal pipeline remains future work.

[Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform) publishes actual ONNX image encoder and prompt/mask decoder files, derived from [nielsr/slimsam-77-uniform](https://huggingface.co/nielsr/slimsam-77-uniform). This build pins revision `5850ab45f587c112167512ffef949107115e26a0` and uses FP32 for consistent WASM and GPU compatibility. The declared model license is Apache-2.0. Downloaded metadata and the license are retained by the download script; keep notices with redistributed weights.

The model is smaller and less precise than desktop SAM models. Masks have binary alpha, not hair-quality matting. ONNX inference chooses the mask with the highest model IoU score; this is an estimate, not measured accuracy for your frame.

## Exact files

Single source of truth: [`model-manifest.json`](../model-manifest.json).

- `vision_encoder.onnx`: 23,276,014 bytes; SHA-256 `9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0`.
- `prompt_encoder_mask_decoder.onnx`: 16,557,892 bytes; SHA-256 `f4514391764fbd56e08e119060d874ecd7d52994bfb1968af159e12d4943b5bb`.

Run `node scripts/download-models.mjs` to obtain and verify them in `work/models/`, or pass another destination directory. It downloads the pinned model card, processor/config metadata and Apache-2.0 license, and prints exact R2 keys and upload commands. No inference server is called. Default browser downloads use the same pinned Hugging Face revision. For your own bucket, set the build-time `VITE_MODEL_BASE_URL` to a directory containing these exact filenames. Changing URLs does not disable checksum validation.

Example base: `https://models.example.com/slimsam/5850ab45f587c112167512ffef949107115e26a0`.

## Inspected ONNX signatures

These names, types and shapes were read from the downloaded files and validated with `onnx.checker`, not guessed from another SAM export.

Encoder input: `pixel_values`, float32 `[batch, 3, 1024, 1024]`.
Encoder outputs: `image_embeddings` and `image_positional_embeddings`, both float32 `[batch, 256, 64, 64]`.

Decoder inputs:

- `input_points`, float32 `[batch, point_batch, number_of_points, 2]`.
- `input_labels`, int64 `[batch, point_batch, number_of_points]`; 1 means positive and 0 means negative.
- `image_embeddings` and `image_positional_embeddings`, float32 `[batch, 256, 64, 64]`.

Decoder outputs: `iou_scores`, float32 `[batch, point_batch, 3]`; `pred_masks`, float32 `[batch, point_batch, 3, 256, 256]`.

This app uses batch=1 and point_batch=1. The exported prompt encoder itself adds the no-box sentinel; the app must not add another sentinel. Prompt coordinates are normalized in the editor, then multiplied by resized image dimensions for the model.

## Processing and memory

The worker resizes RGB to longest edge 1024, applies the pinned ImageNet RGB mean/std normalization, and pads with normalized zeros at the bottom/right. It encodes the image, decodes all current points, selects the highest IoU mask, upsamples logits to 1024, crops padding, then resizes to frame aspect ratio before thresholding at zero. The mask's longest edge is at most 1024; sequence PNG exports scale it to the original resolution, while current-frame PNGs use the working preview dimensions (at most a 1280-pixel edge). Source-image detail beyond this model resolution cannot be recovered by upscaling.

Only one frame's embeddings are retained. SHA-256 of RGBA pixels identifies when those embeddings may be reused for prompt refinement. Model sessions and embeddings belong to one disposable worker. Cancel terminates that worker and rejects pending requests, stopping active work and releasing its memory. The next inference recreates sessions using cached model bytes.

Model bytes are fetched with CORS and no credentials, checked against both byte size and SHA-256 before use, then kept in browser Cache Storage. Cached bytes are reverified when loaded. Storage denial/quota failures do not stop inference; the browser downloads again on the next visit. Cache management never uploads footage. Browser storage may be evicted; the project archive is the durable portable backup.

The runtime first tries ONNX Runtime Web 1.23.2 with the `onnxruntime-web/all` JSEP build, a WebGPU execution provider, and CPU/WASM fallback for unsupported operators. If GPU initialization or execution fails, it retries with WASM. WebGPU availability does not imply every operation is on GPU. Threads are capped at four when cross-origin isolation is enabled, otherwise one. ONNX Runtime's `.jsep.mjs` and `.jsep.wasm` files are copied from the pinned npm dependency to same-origin `/ort/` by the repository's preparation script. Do not mix runtime versions.

See [ONNX Runtime Web deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html) and [performance guidance](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html).

## Verification

Meaningful unit tests cover RGB normalization, padding, aspect ratio, positive/negative prompt coordinates, graph-owned sentinel behavior, mask score selection and letterbox removal. During implementation both pinned artifacts passed ONNX checker and actual native CPU inference on the model card's corgi photograph produced a nonempty mask (highest IoU score approximately 0.979). Native CPU success alone does not prove a browser backend works.

Actual Chrome worker inference also passed with ONNX Runtime Web **1.23.2**, the exact checked-in npm version, using the JSEP runtime with WebGPU initialization. The corgi image produced a 614×410 mask with 22,225 foreground pixels. Cached model initialization plus inference took about 3.1 seconds on the test machine. This is a smoke test, not a performance guarantee. A forced WASM run and worker cancellation/recovery were also exercised. The JSEP `onnxruntime-web/all` import is deliberate: the separate `onnxruntime-web/webgpu` entry in this version expects the Asyncify runtime, and mixing that entry with JSEP can silently fall back to WASM.
