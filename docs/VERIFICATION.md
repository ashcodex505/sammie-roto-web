# Verification record

Tested locally on November 15, 2026. No Cloudflare deployment or paid resource creation was performed. These checks establish a working first vertical slice, not desktop feature parity or a cross-browser certification.

## Automated checks

- `npm test`: **25 tests across six files passed**. Includes independent object masks, preservation when prompts change, stroke compositing, undo/redo, ZIP round trips and invalid imports, sparse export over a long timeline, cancellation, recovery write/clear ordering and rollback, RGB normalization, prompt coordinates, score selection, and letterbox removal.
- `npm run typecheck`: passed.
- `npm run build`: passed with the locked dependencies.
- `npm run check:pages`: passed; nine output files, largest asset approximately **22.72 MiB**, below Pages' 25 MiB limit. Both required isolation headers are present.
- Vite reports a dependency warning about `eval` inside the bundled ONNX Runtime library. The build succeeds. No application eval was added.

## Real model verification

Both pinned FP32 ONNX artifacts passed SHA-256/size validation and native ONNX checker/signature inspection. Actual native ONNX Runtime 1.32 CPU inference on the model card's corgi image produced a nonempty mask with highest model IoU estimate about 0.979. That score is the model's estimate, not independently measured accuracy.

The browser worker was then checked with the exact application runtime: **onnxruntime-web 1.23.2**, using its `all` entry and matching JSEP files. Chrome completed real WebGPU inference and a separate forced WASM four-thread run. The 614×410 source image produced a 614×410 mask with **22,225 foreground pixels**. Cached startup plus GPU inference was around 3.1 seconds on this machine; this is not a general performance promise.

A pending worker request was canceled and rejected with `AbortError`; creating a fresh worker and reloading cached weights recovered successfully. The test also confirmed `crossOriginIsolated === true`. WebGPU includes internal CPU/WASM execution for some shape/unsupported operations; the backend label does not claim every operation runs on GPU.

An early smoke test caught an incompatible runtime entry that could silently fall back to WASM while reporting GPU. The final implementation uses the compatible JSEP `all` entry and explicitly requests the GPU provider before falling back. Native ONNX warnings about CPU shape operations are expected and appeared on stderr in the browser console; they were distinguished from actual initialization errors.

## Editor workflow in a production preview

A real local MP4 created from the test photo was imported through the editor file chooser, with a 12 FPS working grid. The browser reported 641×428 display dimensions and a two-second duration.

Completed through visible browser controls:

1. Imported the clip and placed a positive point; generated a real subject mask.
2. Added a negative background point and an erase stroke, then exercised undo and redo.
3. Renamed the first object `Rust` and created a separate coral `Road` object. The original object's mask remained intact.
4. Set an inclusive range of frames 0–2, and segmented those three frames independently using the prompt anchor.
5. Exported a current-frame PNG and visually inspected its actual white subject silhouette.
6. Exported a PNG sequence ZIP and inspected its entries: exactly `frame-000000.png`, `frame-000001.png`, `frame-000002.png`, and the manifest.
7. Exported silent overlay WebM. ffprobe identified VP9 at the displayed dimensions and three decoded frames with timestamps near 0.000, 0.085, and 0.170 seconds. ffmpeg decoded the file without error. Real-time MediaRecorder output is approximate and may omit a duration field until played/remuxed.
8. Exported and inspected a project archive. It retained both objects/colors, three masks for Rust, its positive/negative prompts and erase layer, and the original 62,218-byte source clip. Road remained independent with no invented mask.
9. Reopened the exported archive in the editor. Reloaded the page, restored browser recovery, and confirmed the clip, both objects, three masks, 12 FPS and in/out range survived.
10. Exported a second archive without source video, opened it, relinked the original MP4, and confirmed all three masks survived. This also passed at the 390-pixel viewport width.

The development server was also opened separately to check React StrictMode cleanup and a fresh model load. Device diagnostics show the actual selected runtime, recorder codec, isolation, and local storage mechanism. API availability for WebCodecs/OPFS is reported separately from implemented use.

## Layout and hosting preparation

Desktop and 390×844 viewport layouts were visually inspected. The final narrow layout reports document width equal to its 390-pixel viewport; objects and export settings stack below the viewer. Desktop remains the primary practical target for GPU video work.

The local development and production preview responses expose COOP `same-origin` and COEP `require-corp`. Model downloads use pinned Hugging Face URLs until the R2 base variable is configured. The complete Cloudflare setup is documented in [CLOUDFLARE.md](CLOUDFLARE.md), with provider documentation checked on the same date.

## Limits of this verification

No live R2 CORS/cache configuration, Pages build service, custom domain, or public HTTPS deployment was created or tested. Safari, Firefox, mobile GPU inference, large/long clips, and every possible codec were not certified. Test artifacts live in ignored `work/qa`; model downloads are in ignored `work/models`. No third-party test image is shipped in the source repository.

Temporal-memory tracking, full WebCodecs video I/O, audio-preserving export, matting, object removal, PWA offline installation, and native desktop project compatibility remain deferred. Range segmentation is real per-frame inference using static nearby prompts, not AI video memory.
