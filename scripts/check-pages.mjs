import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
async function files(dir) {
  const results = await Promise.all(
    (await readdir(dir)).map(async (name) => {
      const path = join(dir, name);
      return (await stat(path)).isDirectory() ? files(path) : [path];
    }),
  );
  return results.flat();
}
const paths = await files("dist");
const oversized = [];
let largest = { path: "", bytes: 0 };
for (const path of paths) {
  const { size } = await stat(path);
  if (size > 25 * 1024 * 1024) oversized.push(path);
  if (size > largest.bytes) largest = { path, bytes: size };
}
const headers = await readFile("dist/_headers", "utf8");
if (
  !headers.includes("Cross-Origin-Opener-Policy: same-origin") ||
  !headers.includes("Cross-Origin-Embedder-Policy: require-corp")
)
  throw new Error("Isolation headers missing.");
if (oversized.length)
  throw new Error(
    `Pages 25 MiB asset limit exceeded: ${oversized.join(", ")}. Host models on R2, not Pages.`,
  );
console.log(
  `Pages package OK: ${paths.length} files. Largest: ${largest.path} (${(largest.bytes / 1024 / 1024).toFixed(2)} MiB). Isolation headers present.`,
);
