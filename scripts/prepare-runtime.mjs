import { mkdir, copyFile } from "node:fs/promises";
const names = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];
await mkdir("public/ort", { recursive: true });
for (const name of names)
  await copyFile(
    `node_modules/onnxruntime-web/dist/${name}`,
    `public/ort/${name}`,
  );
console.log("Prepared matching ONNX Runtime Web 1.23.2 files in public/ort.");
