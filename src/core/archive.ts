import { strFromU8, strToU8, unzipSync, zip, type Zippable } from "fflate";
import type { Mask, Point, Project, RotoObject, Stroke } from "./types";

const MiB = 1024 * 1024;
export const ARCHIVE_LIMITS = {
  archiveBytes: 512 * MiB,
  expandedBytes: 768 * MiB,
  maskBytes: 256 * MiB,
  metadataBytes: 4 * MiB,
};
const fail = (
  message = "This is not a valid Sammie Roto project archive.",
): never => {
  throw new Error(message);
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (
  value: unknown,
  min: number,
  max: number,
  integer = false,
): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max &&
  (!integer || Number.isInteger(value));
const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const frameKey = (key: string) =>
  /^(0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key));
function point(value: unknown): value is Point {
  return (
    record(value) &&
    number(value.x, 0, 1) &&
    number(value.y, 0, 1) &&
    (value.label === 0 || value.label === 1)
  );
}
function stroke(value: unknown): value is Stroke {
  return (
    record(value) &&
    number(value.radius, Number.EPSILON, 1) &&
    ["paint", "erase"].includes(String(value.mode)) &&
    Array.isArray(value.points) &&
    value.points.length <= 100_000 &&
    value.points.every(
      (p) => record(p) && number(p.x, 0, 1) && number(p.y, 0, 1),
    )
  );
}

/** Strict import boundary. IDs are opaque strings and never used as archive paths. */
export function validateProject(value: unknown): Project {
  if (
    !record(value) ||
    value.version !== 1 ||
    !text(value.id) ||
    !text(value.name) ||
    !text(value.videoName, 1000) ||
    !number(value.width, 1, 16384, true) ||
    !number(value.height, 1, 16384, true) ||
    value.width * value.height > 34_000_000 ||
    !number(value.fps, 1, 240) ||
    !number(value.duration, 0.001, 86_400) ||
    !number(value.frameCount, 1, 20_736_000, true) ||
    !number(value.inFrame, 0, value.frameCount - 1, true) ||
    !number(value.outFrame, value.inFrame, value.frameCount - 1, true) ||
    !number(value.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(value.objects) ||
    value.objects.length > 64
  )
    return fail();
  if (value.frameCount !== Math.ceil(value.duration * value.fps))
    return fail(
      "Archive frame count does not match its duration and frame rate.",
    );
  const ids = new Set<string>();
  let maskBytes = 0;
  for (const object of value.objects) {
    if (
      !record(object) ||
      !text(object.id) ||
      ids.has(object.id) ||
      !text(object.name) ||
      typeof object.visible !== "boolean" ||
      typeof object.color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(object.color) ||
      !record(object.edits) ||
      !record(object.masks)
    )
      return fail();
    ids.add(object.id);
    for (const [key, edit] of Object.entries(object.edits)) {
      if (
        !frameKey(key) ||
        !number(Number(key), 0, value.frameCount - 1, true) ||
        !record(edit) ||
        !Array.isArray(edit.points) ||
        edit.points.length > 1000 ||
        !edit.points.every(point) ||
        !Array.isArray(edit.strokes) ||
        edit.strokes.length > 10000 ||
        !edit.strokes.every(stroke)
      )
        return fail("Archive contains invalid corrections.");
    }
    for (const [key, mask] of Object.entries(object.masks)) {
      if (
        !frameKey(key) ||
        !number(Number(key), 0, value.frameCount - 1, true) ||
        !record(mask) ||
        !number(mask.width, 1, 16384, true) ||
        !number(mask.height, 1, 16384, true) ||
        !(mask.data instanceof Uint8Array) ||
        mask.data.length !== mask.width * mask.height
      )
        return fail("Archive contains invalid masks.");
      maskBytes += mask.data.length;
      if (maskBytes > ARCHIVE_LIMITS.maskBytes)
        return fail("Project masks exceed the 256 MiB import limit.");
    }
  }
  return value as unknown as Project;
}

function zipFiles(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    zip(files, { level: 1 }, (error, data) =>
      error ? reject(error) : resolve(data),
    ),
  );
}

export async function exportProject(
  project: Project,
  video?: Blob,
): Promise<Blob> {
  validateProject(project);
  if (video && video.size > ARCHIVE_LIMITS.archiveBytes)
    throw new Error(
      "Source clip exceeds the 512 MiB project archive limit. Export without the clip and keep the source file separately.",
    );
  const files: Zippable = {};
  const objects = project.objects.map((object, index) => ({
    ...object,
    masks: Object.fromEntries(
      Object.entries(object.masks).map(([frame, mask]) => {
        const path = `masks/${index}/${frame}.bin`;
        files[path] = mask.data;
        return [frame, { width: mask.width, height: mask.height, path }];
      }),
    ),
  }));
  const metadata = strToU8(
    JSON.stringify({
      format: "sammie-roto-web",
      project: { ...project, objects },
      video: video ? { path: "source/clip", type: video.type } : undefined,
    }),
  );
  if (metadata.length > ARCHIVE_LIMITS.metadataBytes)
    throw new Error("Project annotations exceed the archive metadata limit.");
  const expandedBytes =
    metadata.length +
    (video?.size ?? 0) +
    project.objects.reduce(
      (total, object) =>
        total +
        Object.values(object.masks).reduce(
          (sum, mask) => sum + mask.data.length,
          0,
        ),
      0,
    );
  if (expandedBytes > ARCHIVE_LIMITS.expandedBytes)
    throw new Error(
      "Project contents exceed the 768 MiB expanded archive limit. Export without the clip and keep the source file separately.",
    );
  files["project.json"] = metadata;
  if (video)
    files["source/clip"] = [
      new Uint8Array(await video.arrayBuffer()),
      { level: 0 },
    ];
  const result = await zipFiles(files);
  if (result.length > ARCHIVE_LIMITS.archiveBytes)
    throw new Error(
      "Project archive exceeds 512 MiB. Export without the clip and keep the source file separately.",
    );
  return new Blob([new Uint8Array(result)], { type: "application/zip" });
}

export async function importProject(
  blob: Blob,
): Promise<{ project: Project; video?: Blob }> {
  if (blob.size > ARCHIVE_LIMITS.archiveBytes)
    throw new Error("Project archives are limited to 512 MiB.");
  let expanded = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
      filter: (file) => {
        expanded += file.originalSize;
        if (
          expanded > ARCHIVE_LIMITS.expandedBytes ||
          file.name.includes("..") ||
          file.name.startsWith("/") ||
          file.name.includes("\\")
        )
          return fail("Archive is too large or has unsafe file paths.");
        if (
          file.name === "project.json" &&
          file.originalSize > ARCHIVE_LIMITS.metadataBytes
        )
          return fail("Archive metadata exceeds the 4 MiB import limit.");
        return true;
      },
    });
  } catch (error) {
    throw new Error(
      `Could not open project archive: ${error instanceof Error ? error.message : "invalid ZIP data"}`,
    );
  }
  const metadata = files["project.json"];
  if (!metadata || metadata.length > ARCHIVE_LIMITS.metadataBytes)
    return fail("Archive is missing valid project metadata.");
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(metadata));
  } catch {
    return fail("Archive metadata is not valid JSON.");
  }
  if (
    !record(manifest) ||
    manifest.format !== "sammie-roto-web" ||
    !record(manifest.project) ||
    !Array.isArray(manifest.project.objects)
  )
    return fail();
  let bytes = 0;
  const objects = manifest.project.objects.map(
    (object: unknown): RotoObject => {
      if (!record(object) || !record(object.masks)) return fail();
      const masks: Record<number, Mask> = {};
      for (const [frame, mask] of Object.entries(object.masks)) {
        if (
          !frameKey(frame) ||
          !record(mask) ||
          typeof mask.path !== "string" ||
          !mask.path.startsWith("masks/") ||
          !number(mask.width, 1, 16384, true) ||
          !number(mask.height, 1, 16384, true)
        )
          return fail("Archive has an invalid mask reference.");
        const data = files[mask.path];
        if (!data || data.length !== mask.width * mask.height)
          return fail("Archive mask data is missing or damaged.");
        bytes += data.length;
        if (bytes > ARCHIVE_LIMITS.maskBytes)
          return fail("Project masks exceed the 256 MiB import limit.");
        masks[Number(frame)] = { width: mask.width, height: mask.height, data };
      }
      return { ...object, masks } as RotoObject;
    },
  );
  const project = validateProject({ ...manifest.project, objects });
  let video: Blob | undefined;
  if (manifest.video !== undefined) {
    if (
      !record(manifest.video) ||
      manifest.video.path !== "source/clip" ||
      typeof manifest.video.type !== "string" ||
      !files["source/clip"]
    )
      return fail("Archive source clip is missing.");
    video = new Blob([new Uint8Array(files["source/clip"])], {
      type: manifest.video.type,
    });
  }
  return { project, video };
}
