import manifest from "../../model-manifest.json";
export const MODEL_MANIFEST = manifest;
export const MODEL_CACHE = `sammie-models-${manifest.revision}`;
export function modelUrl(name: string): string {
  const base = import.meta.env.VITE_MODEL_BASE_URL?.trim() || manifest.baseUrl;
  return `${base.replace(/\/$/, "")}/${name}`;
}
