import type { Mask, Point, Project, RotoObject, Stroke } from "./types";

export const OBJECT_COLORS = [
  "#b7ef63",
  "#65c7ff",
  "#f7ae68",
  "#ee88bc",
  "#ba9cff",
  "#65dfc1",
];
const uid = () => crypto.randomUUID();
const finite = (value: number) => Number.isFinite(value);
const normalized = (value: number) => Math.max(0, Math.min(1, value));

export function createObject(
  name = "Object 1",
  color = OBJECT_COLORS[0],
): RotoObject {
  return { id: uid(), name, color, visible: true, edits: {}, masks: {} };
}

export function createProject(meta: {
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  videoName: string;
}): Project {
  if (
    ![meta.width, meta.height, meta.duration, meta.fps].every(finite) ||
    meta.width < 1 ||
    meta.height < 1 ||
    meta.duration <= 0 ||
    meta.fps < 1 ||
    meta.fps > 240
  )
    throw new Error(
      "The clip needs valid dimensions, duration, and a frame rate from 1 to 240.",
    );
  if (
    meta.width > 16384 ||
    meta.height > 16384 ||
    meta.width * meta.height > 34_000_000 ||
    meta.duration > 86_400
  )
    throw new Error(
      "Clips are limited to 34 megapixels per frame and 24 hours.",
    );
  const frameCount = Math.max(1, Math.ceil(meta.duration * meta.fps));
  return {
    ...meta,
    width: Math.round(meta.width),
    height: Math.round(meta.height),
    version: 1,
    id: uid(),
    frameCount,
    inFrame: 0,
    outFrame: frameCount - 1,
    objects: [createObject()],
    updatedAt: Date.now(),
  };
}

export function updateObject(
  project: Project,
  objectId: string,
  update: (object: RotoObject) => RotoObject,
): Project {
  if (!project.objects.some((object) => object.id === objectId))
    throw new Error("Select an existing object.");
  return {
    ...project,
    objects: project.objects.map((object) =>
      object.id === objectId ? update(object) : object,
    ),
    updatedAt: Date.now(),
  };
}

function checkFrame(project: Project, frame: number) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= project.frameCount)
    throw new Error("Frame is outside this clip.");
}

export function addPoint(
  project: Project,
  objectId: string,
  frame: number,
  point: Point,
): Project {
  checkFrame(project, frame);
  if (
    ![point.x, point.y].every(finite) ||
    (point.label !== 0 && point.label !== 1)
  )
    throw new Error("Invalid point.");
  const safe = { ...point, x: normalized(point.x), y: normalized(point.y) };
  return updateObject(project, objectId, (object) => {
    const edit = object.edits[frame] ?? { points: [], strokes: [] };
    return {
      ...object,
      edits: {
        ...object.edits,
        [frame]: { ...edit, points: [...edit.points, safe] },
      },
    };
  });
}

export function addStroke(
  project: Project,
  objectId: string,
  frame: number,
  stroke: Stroke,
): Project {
  checkFrame(project, frame);
  if (
    !finite(stroke.radius) ||
    stroke.radius <= 0 ||
    stroke.radius > 1 ||
    !["paint", "erase"].includes(stroke.mode) ||
    stroke.points.some((point) => ![point.x, point.y].every(finite))
  )
    throw new Error("Invalid brush stroke.");
  const safe = {
    ...stroke,
    points: stroke.points.map((point) => ({
      x: normalized(point.x),
      y: normalized(point.y),
    })),
  };
  return updateObject(project, objectId, (object) => {
    const edit = object.edits[frame] ?? { points: [], strokes: [] };
    return {
      ...object,
      edits: {
        ...object.edits,
        [frame]: { ...edit, strokes: [...edit.strokes, safe] },
      },
    };
  });
}

export function setMask(
  project: Project,
  objectId: string,
  frame: number,
  mask: Mask,
): Project {
  checkFrame(project, frame);
  if (
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    mask.width < 1 ||
    mask.height < 1 ||
    mask.data.length !== mask.width * mask.height
  )
    throw new Error("Invalid mask dimensions.");
  return updateObject(project, objectId, (object) => ({
    ...object,
    masks: { ...object.masks, [frame]: { ...mask, data: mask.data.slice() } },
  }));
}

/** Remove only point prompts: saved inference and manual corrections survive. */
export function clearFramePrompts(
  project: Project,
  objectId: string,
  frame: number,
): Project {
  checkFrame(project, frame);
  return updateObject(project, objectId, (object) => ({
    ...object,
    edits: {
      ...object.edits,
      [frame]: { points: [], strokes: object.edits[frame]?.strokes ?? [] },
    },
  }));
}

/** Nearest annotation is a static prompt seed, never temporal model memory. */
export function nearestPoints(object: RotoObject, frame: number): Point[] {
  const anchor = Object.keys(object.edits)
    .map(Number)
    .filter((index) => object.edits[index].points.length > 0)
    .sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame) || a - b)[0];
  return anchor === undefined
    ? []
    : object.edits[anchor].points.map((point) => ({ ...point }));
}

/** Rasterize base + edit layers without changing either. Radius is relative to the shorter edge. */
export function compositeMask(
  mask: Mask | undefined,
  strokes: Stroke[],
  width: number,
  height: number,
): Mask {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const data = new Uint8Array(width * height);
  if (mask) {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(
        mask.height - 1,
        Math.floor((y * mask.height) / height),
      );
      for (let x = 0; x < width; x++)
        data[y * width + x] =
          mask.data[
            sy * mask.width +
              Math.min(mask.width - 1, Math.floor((x * mask.width) / width))
          ];
    }
  }
  for (const stroke of strokes) {
    const radius = Math.max(0.5, stroke.radius * Math.min(width, height));
    const paint = (px: number, py: number) => {
      const left = Math.max(0, Math.floor(px - radius)),
        right = Math.min(width - 1, Math.ceil(px + radius));
      const top = Math.max(0, Math.floor(py - radius)),
        bottom = Math.min(height - 1, Math.ceil(py + radius));
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++)
          if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 <= radius ** 2)
            data[y * width + x] = stroke.mode === "paint" ? 255 : 0;
    };
    stroke.points.forEach((point, index) => {
      const previous = stroke.points[Math.max(0, index - 1)];
      const x = point.x * width,
        y = point.y * height;
      const dx = x - previous.x * width,
        dy = y - previous.y * height;
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(dx, dy) / Math.max(0.5, radius / 2)),
      );
      for (let step = 0; step <= steps; step++)
        paint(
          previous.x * width + (dx * step) / steps,
          previous.y * height + (dy * step) / steps,
        );
    });
  }
  return { width, height, data };
}

/** Small immutable history. Uint8Arrays are shared between snapshots, never mutated. */
export class ProjectHistory {
  private past: Project[] = [];
  private future: Project[] = [];
  constructor(private limit = 30) {}
  record(project: Project) {
    this.past.push(project);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: Project): Project | undefined {
    const previous = this.past.pop();
    if (previous) this.future.push(current);
    return previous;
  }
  redo(current: Project): Project | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
