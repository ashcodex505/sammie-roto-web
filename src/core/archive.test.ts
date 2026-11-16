import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { exportProject, importProject, validateProject } from "./archive";
import { addPoint, addStroke, createProject, setMask } from "./project";
const project = () =>
  createProject({
    name: "Rust repair",
    width: 8,
    height: 8,
    duration: 1,
    fps: 24,
    videoName: "source.mp4",
  });
const archive = (manifest: unknown, files: Record<string, Uint8Array> = {}) =>
  new Blob([
    new Uint8Array(
      zipSync({ "project.json": strToU8(JSON.stringify(manifest)), ...files }),
    ),
  ]);
describe("portable project archives", () => {
  it("roundtrips masks, prompt labels, separate corrections, and optional source bytes", async () => {
    let p = project();
    const id = p.objects[0].id;
    p = addPoint(p, id, 0, { x: 0.2, y: 0.3, label: 1 });
    p = addPoint(p, id, 0, { x: 0.6, y: 0.7, label: 0 });
    p = addStroke(p, id, 0, {
      mode: "erase",
      radius: 0.05,
      points: [{ x: 0.5, y: 0.5 }],
    });
    p = setMask(p, id, 0, {
      width: 2,
      height: 2,
      data: new Uint8Array([0, 255, 255, 0]),
    });
    const source = new Blob(["source-video-placeholder"], {
      type: "video/mp4",
    });
    const result = await importProject(await exportProject(p, source));
    expect(result.project).toEqual(p);
    expect(await result.video?.text()).toBe(await source.text());
    expect(result.video?.type).toBe("video/mp4");
  });
  it("accepts a project without embedded source", async () => {
    const result = await importProject(await exportProject(project()));
    expect(result.video).toBeUndefined();
  });
  it("rejects unsafe metadata and impossible frame ranges", async () => {
    const p = project();
    expect(() => validateProject({ ...p, inFrame: 100 })).toThrow();
    expect(() => validateProject({ ...p, frameCount: 999 })).toThrow();
    expect(() => validateProject({ ...p, fps: Infinity })).toThrow();
    const bad = {
      ...p,
      objects: [
        {
          ...p.objects[0],
          edits: { 0: { points: [{ x: 0.5, y: 2, label: 1 }], strokes: [] } },
        },
      ],
    };
    await expect(
      importProject(archive({ format: "sammie-roto-web", project: bad })),
    ).rejects.toThrow();
  });
  it("rejects missing binary masks, unsupported versions, malformed ZIP, and traversal paths", async () => {
    const p = project();
    const missing = {
      ...p,
      objects: [
        {
          ...p.objects[0],
          masks: { 0: { width: 2, height: 2, path: "masks/0/0.bin" } },
        },
      ],
    };
    await expect(
      importProject(archive({ format: "sammie-roto-web", project: missing })),
    ).rejects.toThrow("missing or damaged");
    await expect(
      importProject(
        archive({ format: "sammie-roto-web", project: { ...p, version: 2 } }),
      ),
    ).rejects.toThrow();
    await expect(importProject(new Blob(["invalid"]))).rejects.toThrow(
      "Could not open",
    );
    await expect(
      importProject(
        archive(
          { format: "sammie-roto-web", project: p },
          { "../unsafe": new Uint8Array([1]) },
        ),
      ),
    ).rejects.toThrow("unsafe");
  });
  it("rejects duplicate object ids to preserve independence", () => {
    const p = project();
    expect(() =>
      validateProject({ ...p, objects: [p.objects[0], p.objects[0]] }),
    ).toThrow();
  });
  it("rejects frame aliases before they can overwrite masks or break prompt lookup", async () => {
    const p = project();
    const corrections = {
      ...p,
      objects: [
        {
          ...p.objects[0],
          edits: {
            "01": { points: [{ x: 0.5, y: 0.5, label: 1 }], strokes: [] },
          },
        },
      ],
    };
    expect(() => validateProject(corrections)).toThrow("invalid corrections");
    const masks = {
      ...p,
      objects: [
        {
          ...p.objects[0],
          masks: { "01": { width: 1, height: 1, path: "masks/0/1.bin" } },
        },
      ],
    };
    await expect(
      importProject(
        archive(
          { format: "sammie-roto-web", project: masks },
          { "masks/0/1.bin": new Uint8Array([255]) },
        ),
      ),
    ).rejects.toThrow("invalid mask reference");
  });
  it("rejects oversized metadata from its ZIP entry size before expanding it", async () => {
    const oversized = new Blob([
      new Uint8Array(
        zipSync({ "project.json": strToU8(" ".repeat(4 * 1024 * 1024 + 1)) }),
      ),
    ]);
    await expect(importProject(oversized)).rejects.toThrow("metadata exceeds");
  });
});
