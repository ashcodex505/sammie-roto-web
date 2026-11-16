#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const manifest = JSON.parse(
  await readFile(new URL("../model-manifest.json", import.meta.url), "utf8"),
);
const shellQuote = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";
const outputDir = resolve(process.argv[2] || "work/models");
await mkdir(outputDir, { recursive: true });
const prefix = `slimsam/${manifest.revision}`;
for (const file of Object.values(manifest.files)) {
  const url = `${manifest.baseUrl}/${file.name}`;
  let data;
  try {
    data = await readFile(resolve(outputDir, file.name));
  } catch {
    /* first download */
  }
  const valid = (bytes) =>
    bytes?.length === file.bytes &&
    createHash("sha256").update(bytes).digest("hex") === file.sha256;
  if (!valid(data)) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    data = Buffer.from(await response.arrayBuffer());
    if (!valid(data))
      throw new Error(`Checksum/size mismatch: ${file.name}. Nothing written.`);
    await writeFile(resolve(outputDir, file.name), data);
  }
  console.log(
    `${file.sha256}  ${resolve(outputDir, file.name)} (${file.bytes} bytes)`,
  );
  console.log(`R2 key: ${prefix}/${file.name}`);
  console.log(
    `npx wrangler@4 r2 object put sammie-roto-models/${prefix}/${file.name} --file=${shellQuote(resolve(outputDir, file.name))} --content-type=application/octet-stream --cache-control="public, max-age=31536000, immutable" --remote`,
  );
}
for (const name of ["README.md", "config.json", "preprocessor_config.json"]) {
  const base = manifest.baseUrl.replace(/\/onnx$/, "");
  const response = await fetch(`${base}/${name}`);
  if (!response.ok)
    throw new Error(`Could not download source metadata: ${name}`);
  await writeFile(
    resolve(outputDir, name),
    Buffer.from(await response.arrayBuffer()),
  );
}
const license = await fetch("https://www.apache.org/licenses/LICENSE-2.0.txt");
if (!license.ok) throw new Error("Could not fetch Apache-2.0 license");
await writeFile(
  resolve(outputDir, "LICENSE-Apache-2.0.txt"),
  await license.text(),
);
await writeFile(
  resolve(outputDir, "model-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `\nKeep README.md, config.json, preprocessor_config.json and LICENSE-Apache-2.0.txt with redistributed weights.\nSet VITE_MODEL_BASE_URL=https://models.example.com/${prefix} before building.\nThe app runtime stays on Pages under /ort/; upload only these model weights to R2.`,
);
