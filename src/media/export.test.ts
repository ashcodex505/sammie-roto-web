import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { addPoint, addStroke, createProject, setMask } from "../core/project";
import { exportMaskSequence } from "./export";

afterEach(() => vi.unstubAllGlobals());

describe("sparse mask sequences", () => {
  it("exports saved masks and brush-only frames in order across a 24-hour range", async () => {
    // Canvas encoding is covered by browser QA. This test exercises which frames
    // are selected and their portable ZIP metadata without allocating a clip.
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData() {},
        }),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"])),
      }),
    });
    let p = createProject({
      name: "Long clip",
      videoName: "long.mp4",
      width: 1,
      height: 1,
      duration: 86_400,
      fps: 240,
    });
    const id = p.objects[0].id;
    p = setMask(p, id, p.outFrame, {
      width: 1,
      height: 1,
      data: new Uint8Array([255]),
    });
    p = addStroke(p, id, 2, {
      mode: "paint",
      radius: 1,
      points: [{ x: 0.5, y: 0.5 }],
    });
    p = setMask(p, id, 2, { width: 1, height: 1, data: new Uint8Array([255]) });
    p = addPoint(p, id, 3, { x: 0.5, y: 0.5, label: 1 });
    const progress = vi.fn();
    const result = await exportMaskSequence(p, id, progress);
    const files = unzipSync(new Uint8Array(await result.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.frames).toEqual([2, p.outFrame]);
    expect(Object.keys(files)).toEqual([
      "frame-000002.png",
      `frame-${p.outFrame}.png`,
      "manifest.json",
    ]);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0.5, 1]);
  });

  it("rejects a pre-cancelled export before creating frames", async () => {
    const p = createProject({
      name: "Clip",
      videoName: "clip.mp4",
      width: 1,
      height: 1,
      duration: 1,
      fps: 24,
    });
    const withMask = setMask(p, p.objects[0].id, 0, {
      width: 1,
      height: 1,
      data: new Uint8Array([255]),
    });
    await expect(
      exportMaskSequence(
        withMask,
        p.objects[0].id,
        undefined,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
