export type LocalVideo = {
  video: HTMLVideoElement;
  url: string;
  width: number;
  height: number;
  duration: number;
  dispose(): void;
};
export async function openVideo(file: Blob): Promise<LocalVideo> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Video loading timed out. Try a browser-compatible MP4 or WebM clip.",
        ),
      );
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        new Error(
          "This browser could not decode the clip. Try H.264 MP4 or VP9 WebM.",
        ),
      );
    };
    video.addEventListener("loadeddata", loaded);
    video.addEventListener("error", failed);
  });
  video.src = url;
  try {
    await ready;
    if (
      !video.videoWidth ||
      !video.videoHeight ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      throw new Error(
        "This clip has no finite video duration. Remux it to a standard MP4 or WebM first.",
      );
    if (
      video.videoWidth > 16384 ||
      video.videoHeight > 16384 ||
      video.videoWidth * video.videoHeight > 34_000_000 ||
      video.duration > 86_400
    )
      throw new Error(
        "Clips are limited to 34 megapixels per frame and 24 hours.",
      );
    return {
      video,
      url,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      dispose() {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    throw error;
  }
}
/** Timestamp seek with a 1280px working edge. fps is user supplied, not exact VFR indexing. */
export async function seekFrame(
  video: HTMLVideoElement,
  frame: number,
  fps: number,
): Promise<ImageData> {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(frame) || frame < 0)
    throw new Error("Invalid frame position.");
  video.pause();
  const time = Math.min(Math.max(0, video.duration - 0.001), frame / fps);
  if (
    Math.abs(video.currentTime - time) > 0.0001 ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Could not decode this frame."));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", failed);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Video decoding failed."));
      };
      video.addEventListener("seeked", done);
      video.addEventListener("error", failed);
      video.currentTime = time;
    });
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    1280 / Math.max(video.videoWidth, video.videoHeight),
  );
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
