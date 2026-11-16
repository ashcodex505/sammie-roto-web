# A guide to the code

This is an independent browser implementation inspired by Sammie Roto's workflow. It does not modify or load the desktop application, and it does not embed a desktop Python server.

## Where to start

Read `src/core/types.ts` first. A **project** describes the clip and its in/out range. Each **object** has its own ID, display color, visibility, frame-specific prompts, correction strokes, and inferred masks. A point is positive (`label: 1`) or negative (`label: 0`). Coordinates are fractions of image width/height so resizing the viewport does not move the prompts.

`src/App.tsx` connects those pieces to React. Look here when changing controls, keyboard shortcuts, job handling, or how the current frame is drawn. `src/styles.css` controls the visual design. `src/components/` holds supporting interface pieces where present.

## Corrections are layers

`src/core/project.ts` contains small immutable operations. Adding a point replaces only that frame's point list; it does not delete any saved mask. A brush stroke is also stored independently. The visible mask is computed from a saved inference mask plus paint/erase strokes. Running inference again replaces its base mask while keeping the correction strokes.

This gives you two different kinds of editing: prompts tell the model what to infer; strokes tell the compositor exactly which pixels to change. Undo/redo stores bounded snapshots and shares unchanged mask buffers. Buffers must never be edited in place, because older history entries may still refer to them.

## The model runs in a worker

`src/inference/client.ts` is the interface between the editor and the segmentation worker. The worker downloads the pinned SlimSAM encoder/decoder, validates SHA-256, and tries ONNX Runtime Web's WebGPU execution provider before its WASM fallback. See `docs/MODELS.md` for the actual artifact contract and verification results.

Preprocessing, coordinate scaling, model inputs, output selection, and mask resizing live under `src/inference/`. Treat these as one contract. Changing the model URL alone is not enough to support an arbitrary SAM export.

The runtime retains a bounded current-frame embedding rather than all decoded video frames. Canceling a model job terminates its worker, which also releases its runtime state; the next operation loads sessions again. The persistent weight cache can survive this reset.

## What range segmentation means

This release has **no video-memory inference**. It obtains prompts from the closest manually annotated frame for the selected object and runs image segmentation on each sampled frame in the selected range. Later-frame prompt edits act as additional anchors; correction strokes remain local to their frame. Objects that move away from static seed points can need more anchors. No optical flow or synthetic mask animation is substituted for a model.

## Video decoding and exports

`src/media/video.ts` uses the browser's native video decoder through an HTML video element and seeks on a user-specified FPS time grid. It keeps decoded work bounded instead of reading the whole clip into a frame array. This is practical for the initial editor but is not a frame-accurate WebCodecs demuxer, especially for variable-frame-rate clips.

`src/media/export.ts` rasterizes final masks, creates PNGs/ZIP sequences, and records a silent processed WebM with Canvas + MediaRecorder when supported. Video export is real-time and can drop timing precision under load. PNG sequences are the safer finishing format. The WebCodecs capability probe is diagnostic; a full demux/encode/mux implementation is deferred.

## Saving and reopening

`src/core/storage.ts` serializes autosaves through IndexedDB, including typed mask buffers and the source Blob. Each website origin gets its own private local database; this is not cloud storage. Browser quota errors must reach the UI. A browser may evict storage, so exported archives are your durable backup.

`src/core/archive.ts` writes a ZIP with project metadata, binary masks, and optional source video. Imports validate the schema and declared/expanded sizes before trusting entries. This browser archive is separate from the desktop application's project formats.

## Static hosting

Vite builds the app to `dist`. The prebuild step copies the exact ONNX Runtime 1.23.2 JSEP runtime into `public/ort`, which is copied into `dist/ort`; these generated files are excluded from Git. They use revalidation caching because their URLs are stable. Vite's content-hashed app assets use immutable caching. Model weights are external and versioned, with their checksums pinned by `model-manifest.json`.

`public/_headers` provides the isolation headers for Cloudflare Pages. The local dev/preview server sets the same headers. R2 model delivery needs successful CORS under COEP. No backend binding, R2 write credential, or cloud GPU is part of the editor.

## Sensible next extensions

A genuine video-memory model requires an inspected ONNX export covering memory encoding/attention, object state, correction conditioning, and propagation. Keep that behind a separate model adapter so the current image pipeline stays honest and testable. For precise video I/O, add a demuxer, frame timestamps, WebCodecs decode/encode, and a muxer as a complete feature. PWA/offline shell installation, matting, object removal, and native desktop project compatibility are separate future work.
