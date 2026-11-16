# Sammie Roto Web

A local-first browser masking studio, built as an independent repository. Your footage stays on your device. Real SlimSAM inference runs in a worker using ONNX Runtime Web, with WebGPU preferred and WASM as a fallback.

**Important scope:** this version generates real image masks and can segment a selected range frame by frame. It does not implement SAM/EdgeTAM video memory or desktop-quality tracking. Prompts from the nearest annotated frame are reused as static seeds; moving subjects need correction anchors. No mock masks or optical flow are presented as AI video memory.

## Start here

You need Node.js **22.12+** and a current desktop browser. Chrome/Edge are useful first targets; actual GPU/codec support depends on your device.

```sh
npm ci
npm run dev
```

Open the local URL printed in Terminal. The startup step prepares the matching ONNX runtime files automatically. For a production build:

```sh
npm test
npm run typecheck
npm run build
npm run check:pages
npm run preview
```

The build goes into `dist/`. This is a static app; there is no backend to start and no API key to configure.

## First masking session

1. Import a short local MP4/WebM that your browser can decode. Set the actual clip FPS; the default is a sampling assumption, not metadata extracted from the codec.
2. Select an object. Add positive points inside the subject and negative points on background leaks.
3. Load the model (about **39.8 MB** on the first download), then segment the current frame. Downloads use a pinned public model revision and are checksum verified.
4. Use brush/erase for precise local corrections. New prompts preserve saved masks and strokes; rerunning inference replaces only the base AI mask on the processed frame.
5. Make more independent objects, give them separate colors, and set in/out markers for a small range. Range segmentation runs independent image inference with the nearest prompt anchor. Add prompts on later frames as the subject moves.
6. Export a mask PNG or PNG sequence ZIP. Save a project archive to keep the editable state and optionally the clip. Local recovery is also saved in browser storage.

## What works

- Local video import, timestamp-grid frame navigation, manual FPS, and inclusive in/out markers.
- Independent object masks, names, colors, visibility, and positive/negative point prompts.
- Non-destructive paint/erase correction layers and bounded undo/redo.
- Real SlimSAM encoder/decoder worker, integrity-checked model download/cache, progress, cancellation, and WebGPU/WASM fallback.
- Independent-frame range segmentation with correction anchors and bounded jobs.
- Overlay/mask previews, local autosave/recovery, and ZIP project import/export.
- Lossless black/white mask PNG and mask sequence ZIP. Sequence manifests list exactly which frames are present; missing masks are not fabricated.
- Silent, real-time processed WebM export where Canvas capture + MediaRecorder are supported.
- Browser/hardware/codec diagnostics and prepared Cloudflare isolation headers.

## Current limits

This is a practical first browser version, not feature parity with the desktop app. Temporal-memory tracking, EdgeTAM/SAM quality adapters, matting, object removal, audio export, exact variable-frame-rate indexing, native desktop project compatibility, and installable/offline PWA shell support are deferred. Model weights are locally cached, but loading the application shell offline is not promised.

The browser media element decodes source video; WebCodecs availability is reported as a capability, but a complete WebCodecs demux/decode/encode/mux pipeline is not implemented. Frame indexing uses `frame / fps`; variable-frame-rate sources can repeat or skip source frames. Use constant-frame-rate media for predictable results. WebM export records in real time and is not frame accurate; use PNG masks for finishing work.

Model masks are bounded to a longest edge of 1024 pixels and can be upscaled for original-size PNG export. Fine hair, transparent edges, thin rust details, and rapidly changing road masks may require manual corrections. Browser GPU, RAM, disk quota, and codec availability vary. Keep range jobs short and export project backups; local browser storage can be evicted and is separate for localhost, Pages, and every custom domain.

Project archive limits are 512 MiB compressed, 768 MiB expanded, and 256 MiB of mask data. A source clip can be excluded when saving an archive and reattached later. Browser archives use their own versioned format and do not import desktop project files.

## Host it on Pages and R2

Follow **[the complete step-by-step Cloudflare guide](docs/CLOUDFLARE.md)**. It covers R2 subscription/billing setup, exact files and checksums, versioned uploads, public delivery, CORS/cache rules, build variables, Pages Git or direct upload, isolation checks, smoke tests, updates/rollback, and free allowances. No cloud resources have been created for you.

For model files, signatures, licenses, and verification, read **[MODELS.md](docs/MODELS.md)**. To understand and tweak the code, start with **[ARCHITECTURE.md](docs/ARCHITECTURE.md)**. See **[VERIFICATION.md](docs/VERIFICATION.md)** for the checks actually performed and their limits.

## Finding the right file

- `src/core/types.ts`: the small project/object/frame data model.
- `src/core/project.ts`: immutable edits, mask compositing, and history.
- `src/core/storage.ts` and `src/core/archive.ts`: local recovery and portable projects.
- `src/inference/`: model download, preprocessing, ONNX worker, and its client.
- `src/media/`: browser clip decoding and export.
- `src/App.tsx` and `src/styles.css`: editor behavior and appearance.
- `model-manifest.json`: pinned artifact revision, sizes, and SHA-256 hashes.
- `public/_headers`: Cloudflare Pages response headers.

## Privacy and licenses

Importing a clip creates a local Blob URL. Autosave uses IndexedDB on your device. There is no clip upload endpoint, analytics SDK, or server inference service. Downloading application/model assets still contacts their hosts. Project archives may include the original source clip, so treat them as private files.

This independently written application code is MIT licensed. The workflow is inspired by [Zarxrax/Sammie-Roto-2](https://github.com/Zarxrax/Sammie-Roto-2); no desktop source files are incorporated. SlimSAM, its ONNX conversion, ONNX Runtime, and other dependencies have their own notices and licenses; see MODELS.md and the installed dependency licenses. The model is not included in Git.
