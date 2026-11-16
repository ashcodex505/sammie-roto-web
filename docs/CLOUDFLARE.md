# Hosting Sammie Roto Web on Cloudflare Pages + R2

Checked against official Cloudflare documentation on **November 15, 2026**. Nothing in this guide has been deployed on your behalf. You do not need a hosted GPU, a server, or an API key in the editor. Source clips, projects, and inference stay in the browser; only application and model downloads cross the network.

## 1. Understand the two pieces

**Pages** serves `dist/`: the editor, JavaScript workers, and matching ONNX Runtime Web files. **R2** holds the two larger ONNX model files. A useful production arrangement is `roto.example.com` for Pages and `models.example.com` for R2. The app also works on its free `*.pages.dev` address. A domain costs money separately if you do not already own one.

Pages limits individual assets to **25 MiB**. The build's `check:pages` command checks this before upload. Keep downloaded models outside `public/` and `dist/`. [Official Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

## 2. Run it locally first

Install Node.js 22.12 or later, open Terminal, and run these commands from this repository's folder:

```sh
npm ci
npm test
npm run build
npm run check:pages
npm run dev
```

Open the local address printed by Vite. Import a short clip, set its frame rate, add a positive point, download/load the model, and segment the frame. Add negative points where background leaked in. Test brush/erase and save a project archive before hosting. Model downloads use pinned Hugging Face URLs until you configure R2.

## 3. Obtain the exact model artifacts

Follow [MODELS.md](MODELS.md) for the pinned revision, artifact names, licenses, signatures, checksums, and the download command. Run `node scripts/download-models.mjs work/models`; it verifies SHA-256 and prints the local paths, expected R2 object keys, and upload commands. Do not substitute a different SAM model behind the same filenames: tensor signatures and preprocessing differ.

The chosen pipeline is SlimSAM image segmentation. It is real inference, but does **not** implement SAM/EdgeTAM temporal memory. Range processing repeats image segmentation using the nearest manually prompted frame. This distinction matters when testing moving objects.

Keep the model card and upstream license notices alongside your distribution. Review the model's license before public/commercial use. The model downloader obtains public artifacts without credentials. Never put Cloudflare account tokens into `VITE_` variables: those are embedded in the public application.

## 4. Enable R2 and create one bucket

1. Sign into the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Storage & databases → R2 → Overview**.
3. Complete the R2 subscription checkout. R2 has included monthly usage, but enabling it is a billing subscription; provide billing/payment details if the account's checkout requires them. Review the checkout before accepting it. [Official R2 getting started](https://developers.cloudflare.com/r2/get-started/).
4. Select **Create bucket**. Choose a name such as `sammie-roto-models`; names must be available within your account. Use **Standard** storage, and the automatic location unless you have a specific need. Create the bucket. [Bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/).
5. Keep this bucket dedicated to public model assets. Do not put personal clips or project archives in it.

## 5. Upload the model files with immutable metadata

Use the exact object keys printed by the model downloader. The version and checksum in each key make future updates safe. Dashboard uploads are possible, but the CLI makes the metadata explicit. Install/run Wrangler from this repository's terminal, then sign in:

```sh
npx wrangler@4 login
```

The model download script prints ready-to-review `wrangler r2 object put` commands for your files. Replace its example bucket name with `sammie-roto-models`. Each upload must use:

```sh
npx wrangler@4 r2 object put 'sammie-roto-models/EXACT_OBJECT_KEY' \
  --file='EXACT_LOCAL_FILE' \
  --content-type='application/octet-stream' \
  --cache-control='public, max-age=31536000, immutable' \
  --remote
```

Run one command for the encoder and one for the decoder. `--remote` ensures the upload goes to your Cloudflare bucket, rather than local development storage. Do not upload the original PyTorch checkpoint. [Upload documentation](https://developers.cloudflare.com/r2/objects/upload-objects/), [Wrangler flags](https://developers.cloudflare.com/r2/reference/wrangler-commands/).

The ONNX runtime `.wasm` and `.mjs` files belong to the Pages build; the prebuild script copies the pinned runtime into `dist/ort/`. You do not upload runtime files separately to R2. Keep the application and its exact runtime build together when updating.

## 6. Give the bucket a public delivery address

For production, use a domain managed in the same Cloudflare account:

1. Open the bucket → **Settings → Public access / Custom Domains → Connect Domain**.
2. Enter `models.example.com`, replacing `example.com` with your domain.
3. Review the DNS entry and select **Connect Domain**. Wait for the domain's status and HTTPS to become active.
4. Leave the separate public development URL disabled if you do not need it.

Connecting a custom domain makes those objects public. Root directory listings are not provided; test an actual model URL. The `r2.dev` development URL can be used for a prototype without a domain, but is rate limited and unsuitable for production. [Public bucket setup](https://developers.cloudflare.com/r2/buckets/public-buckets/), [R2 development limits](https://developers.cloudflare.com/r2/platform/limits/).

## 7. Set CORS for browser downloads

Open the bucket → **Settings → CORS Policy → Add CORS policy → JSON**. For these intentionally public, read-only model files, use:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

Save. The wildcard allows Pages production, changing preview addresses, and local development to download public weights. No write method is allowed. You can instead list specific origins, but must update that list when adding preview/custom origins. CORS is not access control for public weights. If changing CORS after delivery has begun, purge cached model URLs so old responses do not keep old CORS headers. [Official CORS guide](https://developers.cloudflare.com/r2/buckets/cors/).

## 8. Enable caching for ONNX files

In the Cloudflare zone for your domain, open **Caching → Cache Rules → Create rule**. Name it `Public roto model assets`. Match hostname `models.example.com`, set **Cache eligibility → Eligible for cache**, and respect the object Cache-Control header. Scope the rule only to this dedicated asset hostname. Save/deploy the rule. ONNX extensions may otherwise bypass default caching. [Create cache rules](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/).

Do not overwrite an immutable model URL with different bytes. Use new object keys for updates. Test a model URL twice and inspect `CF-Cache-Status`; a MISS followed by HIT indicates edge caching, though requests can reach different locations and cache eviction is normal.

## 9. Point this build at your R2 address

Set **VITE_MODEL_BASE_URL** to `https://models.example.com/slimsam/5850ab45f587c112167512ffef949107115e26a0`, without a trailing slash. The model manifest appends the two filenames. This directory must match your uploaded R2 keys. Configure it for both production and preview builds. If using `r2.dev` for a temporary test, replace `https://models.example.com` with that bucket's full HTTPS origin, keeping the versioned path.

For local testing create a `.env.local` file with `VITE_MODEL_BASE_URL=https://models.example.com/slimsam/5850ab45f587c112167512ffef949107115e26a0`, restart Vite, and check the Network panel. The two ONNX GET requests should go to your R2 address. Their SHA-256 must still match the checked-in manifest. The UI's model cache may already contain the same weights: clear it before testing the new delivery origin.

## 10. Choose how Pages gets the app

Choose **A** for automatic updates after Git pushes, or **B** for an initial local upload. Cloudflare treats these as different project setup modes; moving a Direct Upload project to Git integration requires creating another Pages project. [Direct Upload constraints](https://developers.cloudflare.com/pages/get-started/direct-upload/).

### A. Connect a Git repository (recommended)

1. Create a new empty GitHub or GitLab repository named `sammie-roto-web`. Push this independent repository to it. Do not use the desktop repository. Commit `package-lock.json`; do not commit `node_modules`, `dist`, or downloaded models.
2. Cloudflare → **Workers & Pages → Create application → Pages → Connect to Git**.
3. Connect your provider, grant access to the new repository, select it, and begin setup.
4. Choose production branch **main**. Root directory: repository root (leave blank). Framework preset: **React (Vite)**.
5. Build command: **`npm ci && npm run build && npm run check:pages`**. Build output directory: **`dist`**. Pages may also install dependencies automatically; the explicit `npm ci` ensures the lockfile is used.
6. Set **NODE_VERSION = 22** and the model-base variable from MODELS.md in the build environment for production and preview.
7. Select **Save and Deploy**. Read the build logs, then open the returned `https://PROJECT.pages.dev` address. Subsequent pushes build production or branch previews. [Git setup](https://developers.cloudflare.com/pages/get-started/git-integration/), [Vite build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/).

### B. Upload a local build

Set the R2 model-base value in `.env.local`, then run:

```sh
npm ci
npm run build
npm run check:pages
npx wrangler@4 login
npx wrangler@4 pages project create sammie-roto-web --production-branch=main
npx wrangler@4 pages deploy dist --project-name=sammie-roto-web --branch=main
```

Wrangler prints the deployment URL. Future releases repeat the build/check and `pages deploy` command; do not create another project. A preview can be uploaded with another branch name. Upload **dist**, never the source folder. [Official Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/).

## 11. Verify the live deployment

The checked-in `public/_headers` is copied to `dist/_headers`. Pages applies it to static responses. It enables COOP `same-origin` and COEP `require-corp`. No Pages Function is needed. If you later add Functions, their responses must set the headers themselves. [Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/).

In Terminal, replace the example addresses:

```sh
curl -I https://sammie-roto-web.pages.dev/
curl -I -H 'Origin: https://sammie-roto-web.pages.dev' \
  'https://models.example.com/EXACT_ENCODER_OBJECT_KEY'
curl -I -H 'Origin: https://sammie-roto-web.pages.dev' \
  -H 'Range: bytes=0-1023' \
  'https://models.example.com/EXACT_ENCODER_OBJECT_KEY'
```

Check HTTPS succeeds; the HTML returns both isolation headers; the model response includes `Access-Control-Allow-Origin: *` and its correct size. A real ranged GET should return 206 and Content-Range when supported; full GET is sufficient for this app's current downloader. CORS headers appear only when the request contains Origin.

Open the editor in a current desktop browser, expand diagnostics, and check secure context, isolation, WebGPU availability, and the selected backend. In browser DevTools, `window.isSecureContext` and `self.crossOriginIsolated` should be true. WebGPU can still be unavailable on a particular device; WASM is the fallback.

Run this smoke test:

1. Import a short, ordinary clip. Set the actual FPS; this release samples a time grid and does not demux the original frame timestamps.
2. Place a positive point on an obvious object and segment. The mask must follow image content. Add a negative point on a leak and run again.
3. Add another object with a different color. Confirm its prompts and masks do not replace the first object's data.
4. Set a short in/out range, segment it, cancel once, and rerun. Correct a later frame with new prompts.
5. Brush/erase and undo. Export a mask PNG, PNG sequence ZIP, and project archive; reopen the archive and confirm corrections survive.
6. Export the short processed WebM if MediaRecorder supports it. Play the saved result and check duration/range. This release's video export is silent and real-time; use PNG sequences for offline finishing.
7. Reload the page and recover the local project. Clear the model cache once to check an actual R2 download; then reload it to check cache reuse. Check Network shows no clip POST/upload.

Repeat on every browser you intend to support. Diagnostics showing WebCodecs does not mean this release uses a WebCodecs demux/export pipeline.

## 12. Updates, rollback, and costs

For UI updates, make and test a commit, then push or upload a new `dist`. For a production regression, open the Pages project's deployments, choose a prior successful production deployment, and select **Rollback**. Preview deployments are not production rollback targets. [Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/).

For a model update: obtain and inspect new artifacts, pin their revision, recompute and review checksums, check the license, adapt preprocessing/signatures if needed, run real inference, upload new immutable keys, then deploy the new manifest. Keep the previous model objects while old app builds may still request them. Rolling back the app restores its previous manifest. Clear the browser cache only for testing; do not silently alter checksum expectations to accept an unknown file.

R2 Standard includes **10 GB-month storage, 1 million Class A operations, and 10 million Class B operations per month**, with free Internet egress. Overages are billable: currently $0.015/GB-month, $4.50/million Class A, and $0.36/million Class B, with billing-unit rounding. These free allowances do not apply to Infrequent Access. Do not assume the free allowance is a spending cap. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Keep only needed model revisions, enable edge and browser caching, avoid automated repeated downloads, and review R2 usage and your account's available billing notifications regularly. Notifications are not a hard spending limit. No Worker, database, GPU server, paid plan, or paid resource is needed by this editor's core workflow; domain registration and any optional metered services are separate costs. Pages Free currently includes 500 builds/month, one concurrent build, a 20-minute build timeout, and 20,000 files. Recheck pricing and limits before launch.

## Troubleshooting

- **Model CORS / COEP error:** inspect the actual model GET, confirm Origin is allowed, check custom-domain HTTPS, and purge old cached responses after changing CORS. Do not disable isolation to hide the problem.
- **Checksum error:** compare the downloaded file to MODELS.md. A redirect/login/error HTML page is not an ONNX file. Restore the known artifact rather than accepting its new hash.
- **WASM missing:** deploy the entire `dist`, including hashed worker and runtime files. Keep the installed ONNX Runtime version and its emitted files in sync.
- **Pages rejects a large asset:** remove models accidentally put in `public`; run `check:pages`. Upload model weights to R2.
- **Wrong/duplicate frames:** use the actual clip FPS and a constant-frame-rate source. This first release uses browser video seeking, not a frame-accurate demuxer.
- **Local recovery disappears on another URL:** browser storage belongs to an origin. Export an archive before switching from localhost to Pages or to a custom domain.
