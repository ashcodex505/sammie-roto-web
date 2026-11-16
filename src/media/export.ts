import { strToU8, zip, type Zippable } from "fflate";
import { compositeMask } from "../core/project";
import type { Mask, Project } from "../core/types";
import { seekFrame } from "./video";

const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
function abort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Export cancelled.", "AbortError");
}
function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  return result;
}
function context(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = element.getContext("2d");
  if (!result) throw new Error("Canvas rendering is unavailable.");
  return result;
}
function png(element: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    element.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("PNG encoding failed.")),
      "image/png",
    ),
  );
}
function checkMask(mask: Mask) {
  if (
    mask.width < 1 ||
    mask.height < 1 ||
    mask.width * mask.height !== mask.data.length
  )
    throw new Error("Mask dimensions do not match the mask data.");
}

/** White foreground on black, lossless PNG at the mask's stored dimensions. */
export async function exportMaskPng(mask: Mask): Promise<Blob> {
  checkMask(mask);
  const result = canvas(mask.width, mask.height);
  const ctx = context(result);
  const pixels = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    pixels.data[i * 4] = mask.data[i];
    pixels.data[i * 4 + 1] = mask.data[i];
    pixels.data[i * 4 + 2] = mask.data[i];
    pixels.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return png(result);
}

export async function exportMaskSequence(
  project: Project,
  objectId: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) throw new Error("Select an object before exporting.");
  // Clips can span millions of timestamps while containing only a few masks.
  // Walk saved frames rather than allocating the entire selected range.
  const frames = [
    ...new Set(
      [
        ...Object.keys(object.masks),
        ...Object.entries(object.edits)
          .filter(([, edit]) => edit.strokes.length)
          .map(([frame]) => frame),
      ].map(Number),
    ),
  ]
    .filter(
      (frame) =>
        Number.isInteger(frame) &&
        frame >= project.inFrame &&
        frame <= project.outFrame,
    )
    .sort((a, b) => a - b);
  if (!frames.length)
    throw new Error(
      "This object has no masks or brush corrections in the selected range.",
    );
  const files: Zippable = {};
  let bytes = 0;
  for (const [index, frame] of frames.entries()) {
    abort(signal);
    const base = object.masks[frame];
    const mask = compositeMask(
      base,
      object.edits[frame]?.strokes ?? [],
      project.width,
      project.height,
    );
    const blob = await exportMaskPng(mask);
    bytes += blob.size;
    if (bytes > MAX_EXPORT_BYTES)
      throw new Error(
        "This sequence exceeds the 512 MiB export limit. Use a smaller in/out range.",
      );
    files[`frame-${String(frame).padStart(6, "0")}.png`] = [
      new Uint8Array(await blob.arrayBuffer()),
      { level: 0 },
    ];
    onProgress?.((index + 1) / frames.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        format: "sammie-roto-mask-sequence",
        object: object.name,
        objectId,
        fps: project.fps,
        width: project.width,
        height: project.height,
        inFrame: project.inFrame,
        outFrame: project.outFrame,
        frames,
        notes:
          "Zero-based frame filenames. Only frames with saved masks or brush corrections are included. White foreground, black background. No interpolation.",
      },
      null,
      2,
    ),
  );
  abort(signal);
  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 0 }, (error, data) =>
      error ? reject(error) : resolve(data),
    ),
  );
  abort(signal);
  if (zipped.length > MAX_EXPORT_BYTES)
    throw new Error(
      "This sequence exceeds the 512 MiB export limit. Use a smaller in/out range.",
    );
  return new Blob([new Uint8Array(zipped)], { type: "application/zip" });
}

export type VideoExportOptions = {
  mode?: "overlay" | "mask" | "cutout";
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};
export function supportedVideoExportType(): string | undefined {
  if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream)
    return undefined;
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
}

/** Silent, real-time canvas recording. This is timestamp-based media playback, not a frame-exact encoder. */
export async function exportCompositeVideo(
  project: Project,
  video: HTMLVideoElement,
  options: VideoExportOptions = {},
): Promise<Blob> {
  const mimeType = supportedVideoExportType();
  if (!mimeType)
    throw new Error(
      "This browser cannot record WebM canvas video. Export PNG masks or a project archive instead.",
    );
  abort(options.signal);
  if (
    !project.objects.some(
      (object) =>
        object.visible &&
        (Object.keys(object.masks).some(
          (key) =>
            Number(key) >= project.inFrame && Number(key) <= project.outFrame,
        ) ||
          Object.entries(object.edits).some(
            ([key, edit]) =>
              Number(key) >= project.inFrame &&
              Number(key) <= project.outFrame &&
              edit.strokes.length,
          )),
    )
  )
    throw new Error("There are no visible masks in the selected range.");
  const previous = {
    time: video.currentTime,
    rate: video.playbackRate,
    muted: video.muted,
  };
  const result = canvas(project.width, project.height),
    ctx = context(result);
  const layer = canvas(project.width, project.height),
    layerContext = context(layer);
  const union = canvas(project.width, project.height),
    unionContext = context(union);
  const start = project.inFrame / project.fps,
    end = Math.min(project.duration, (project.outFrame + 1) / project.fps);
  let stream: MediaStream | undefined;
  try {
    await seekFrame(video, project.inFrame, project.fps);
    abort(options.signal);
    stream = result.captureStream(Math.min(60, project.fps));
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    let lastFrame = -1;
    const draw = () => {
      const frame = Math.min(
        project.outFrame,
        Math.max(
          project.inFrame,
          Math.floor(video.currentTime * project.fps + 0.001),
        ),
      );
      if (frame !== lastFrame) {
        lastFrame = frame;
        layerContext.clearRect(0, 0, project.width, project.height);
        unionContext.clearRect(0, 0, project.width, project.height);
        for (const object of project.objects.filter((item) => item.visible)) {
          if (!object.masks[frame] && !object.edits[frame]?.strokes.length)
            continue;
          const mask = compositeMask(
            object.masks[frame],
            object.edits[frame]?.strokes ?? [],
            project.width,
            project.height,
          );
          const pixels = ctx.createImageData(project.width, project.height);
          const color = /^#[0-9a-f]{6}$/i.test(object.color)
            ? object.color
            : "#b7ef63";
          const r = parseInt(color.slice(1, 3), 16),
            g = parseInt(color.slice(3, 5), 16),
            b = parseInt(color.slice(5, 7), 16);
          const one = canvas(project.width, project.height),
            oneContext = context(one);
          for (let i = 0; i < mask.data.length; i++) {
            pixels.data[i * 4] = r;
            pixels.data[i * 4 + 1] = g;
            pixels.data[i * 4 + 2] = b;
            pixels.data[i * 4 + 3] = mask.data[i];
          }
          oneContext.putImageData(pixels, 0, 0);
          layerContext.drawImage(one, 0, 0);
          oneContext.globalCompositeOperation = "source-in";
          oneContext.fillStyle = "#fff";
          oneContext.fillRect(0, 0, project.width, project.height);
          unionContext.drawImage(one, 0, 0);
        }
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, project.width, project.height);
      if (options.mode === "mask") {
        ctx.drawImage(union, 0, 0);
      } else if (options.mode === "cutout") {
        ctx.clearRect(0, 0, project.width, project.height);
        ctx.drawImage(video, 0, 0, project.width, project.height);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(union, 0, 0);
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillRect(0, 0, project.width, project.height);
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.drawImage(video, 0, 0, project.width, project.height);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(layer, 0, 0);
        ctx.globalAlpha = 1;
      }
      options.onProgress?.(
        Math.min(1, Math.max(0, (video.currentTime - start) / (end - start))),
      );
    };
    draw();
    return await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      let size = 0,
        raf = 0,
        settled = false,
        failure: unknown;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        failure = error;
        video.pause();
        cancelAnimationFrame(raf);
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancelled);
        if (recorder.state !== "inactive") recorder.stop();
        else
          reject(
            error ??
              new Error("Recording stopped before video data was produced."),
          );
      };
      const cancelled = () =>
        finish(new DOMException("Export cancelled.", "AbortError"));
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "Recording stalled. Keep the tab visible and try a shorter range.",
            ),
          ),
        Math.max(20_000, (end - start) * 2000 + 15_000),
      );
      options.signal?.addEventListener("abort", cancelled, { once: true });
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
          if (size > MAX_EXPORT_BYTES) {
            const error = new Error(
              "Video exceeds 512 MiB. Use a shorter in/out range.",
            );
            if (settled) failure = error;
            else finish(error);
          }
        }
      };
      recorder.onerror = () =>
        finish(
          new Error(
            "The browser could not encode the video. Try PNG masks instead.",
          ),
        );
      recorder.onstop = () => {
        if (failure) reject(failure);
        else if (!size)
          reject(new Error("The recorder returned an empty video."));
        else {
          options.onProgress?.(1);
          resolve(new Blob(chunks, { type: mimeType }));
        }
      };
      const tick = () => {
        if (settled) return;
        try {
          draw();
          if (video.currentTime >= end - 0.002 || video.ended) finish();
          else raf = requestAnimationFrame(tick);
        } catch (error) {
          finish(error);
        }
      };
      video.muted = true;
      video.playbackRate = 1;
      try {
        recorder.start(250);
        void video.play().then(() => {
          raf = requestAnimationFrame(tick);
        }, finish);
      } catch (error) {
        finish(error);
      }
    });
  } finally {
    video.pause();
    stream?.getTracks().forEach((track) => track.stop());
    video.playbackRate = previous.rate;
    video.muted = previous.muted;
    video.currentTime = Math.min(
      previous.time,
      Math.max(0, video.duration - 0.001),
    );
  }
}
