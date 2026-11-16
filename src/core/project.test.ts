import { describe, expect, it } from "vitest";
import {
  addPoint,
  addStroke,
  clearFramePrompts,
  compositeMask,
  createObject,
  createProject,
  nearestPoints,
  ProjectHistory,
  setMask,
} from "./project";
const project = () =>
  createProject({
    name: "Rust repair",
    width: 8,
    height: 8,
    duration: 2,
    fps: 24,
    videoName: "road.mp4",
  });
describe("non-destructive object editing", () => {
  it("preserves independent masks and brush edits when adding or clearing prompts", () => {
    let p = project();
    const first = p.objects[0].id;
    const second = createObject("Road", "#65c7ff");
    p = { ...p, objects: [...p.objects, second] };
    p = setMask(p, first, 0, {
      width: 2,
      height: 2,
      data: new Uint8Array([255, 0, 0, 255]),
    });
    p = setMask(p, second.id, 0, {
      width: 2,
      height: 2,
      data: new Uint8Array([0, 255, 0, 0]),
    });
    p = addStroke(p, first, 0, {
      mode: "erase",
      radius: 0.1,
      points: [{ x: 0.5, y: 0.5 }],
    });
    const before = p;
    p = addPoint(p, first, 0, { x: 0.25, y: 0.25, label: 1 });
    expect(p.objects[0].masks).toBe(before.objects[0].masks);
    expect(p.objects[1]).toBe(before.objects[1]);
    p = clearFramePrompts(p, first, 0);
    expect(p.objects[0].edits[0].points).toHaveLength(0);
    expect(p.objects[0].edits[0].strokes).toHaveLength(1);
    expect(p.objects[0].masks[0].data).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    expect(before.objects[0].edits[0].points).toHaveLength(0);
  });
  it("copies an incoming mask buffer so outside mutation cannot corrupt project snapshots", () => {
    const p = project();
    const data = new Uint8Array([255]);
    const next = setMask(p, p.objects[0].id, 0, { width: 1, height: 1, data });
    data[0] = 0;
    expect(next.objects[0].masks[0].data[0]).toBe(255);
  });
  it("uses the nearest explicit correction anchor deterministically without writing masks", () => {
    let p = project();
    const id = p.objects[0].id;
    p = addPoint(p, id, 1, { x: 0.2, y: 0.3, label: 1 });
    p = addPoint(p, id, 9, { x: 0.8, y: 0.7, label: 0 });
    expect(nearestPoints(p.objects[0], 5)[0].label).toBe(1);
    expect(nearestPoints(p.objects[0], 8)[0].label).toBe(0);
    expect(Object.keys(p.objects[0].masks)).toHaveLength(0);
  });
  it("rejects out-of-range frames and invalid points", () => {
    const p = project();
    const id = p.objects[0].id;
    expect(() => addPoint(p, id, -1, { x: 0, y: 0, label: 1 })).toThrow();
    expect(() => addPoint(p, id, 0, { x: NaN, y: 0, label: 1 })).toThrow();
    expect(() =>
      setMask(p, id, 0, { width: 2, height: 2, data: new Uint8Array(1) }),
    ).toThrow();
  });
});
describe("brush compositor", () => {
  it("applies paint then erase without touching the base layer", () => {
    const base = { width: 8, height: 8, data: new Uint8Array(64) };
    const mask = compositeMask(
      base,
      [
        { mode: "paint", radius: 0.4, points: [{ x: 0.5, y: 0.5 }] },
        { mode: "erase", radius: 0.15, points: [{ x: 0.5, y: 0.5 }] },
      ],
      8,
      8,
    );
    expect(mask.data[3 * 8 + 3]).toBe(0);
    expect(mask.data[2 * 8 + 3]).toBe(255);
    expect(base.data.every((value) => value === 0)).toBe(true);
  });
  it("fills a continuous line and scales an existing low-resolution mask", () => {
    const mask = compositeMask(
      undefined,
      [
        {
          mode: "paint",
          radius: 0.08,
          points: [
            { x: 0.1, y: 0.5 },
            { x: 0.9, y: 0.5 },
          ],
        },
      ],
      20,
      20,
    );
    for (let x = 2; x < 18; x++) expect(mask.data[10 * 20 + x]).toBe(255);
    expect(
      compositeMask(
        { width: 1, height: 1, data: new Uint8Array([255]) },
        [],
        5,
        5,
      ).data.every((value) => value === 255),
    ).toBe(true);
  });
});
describe("bounded undo and redo", () => {
  it("restores previous snapshots and drops the redo branch after a new edit", () => {
    const history = new ProjectHistory(2),
      original = project();
    const second = addPoint(original, original.objects[0].id, 0, {
      x: 0.5,
      y: 0.5,
      label: 1,
    });
    history.record(original);
    expect(history.undo(second)).toBe(original);
    expect(history.canRedo).toBe(true);
    expect(history.redo(original)).toBe(second);
    history.record(second);
    history.undo(second);
    history.record(original);
    expect(history.canRedo).toBe(false);
  });
});
