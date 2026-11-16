import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Brush,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cpu,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  HardDrive,
  Image,
  LoaderCircle,
  Minus,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Mask, ModelStatus, Point, Project, Stroke } from "./core/types";
import {
  addPoint,
  addStroke,
  compositeMask,
  createObject,
  createProject,
  nearestPoints,
  setMask,
} from "./core/project";
import { loadLatestProject, saveProject } from "./core/storage";
import { exportProject, importProject } from "./core/archive";
import { openVideo, seekFrame } from "./media/video";
import {
  exportCompositeVideo,
  exportMaskPng,
  exportMaskSequence,
  supportedVideoExportType,
} from "./media/export";
import { SegmentationClient } from "./inference/client";

type Tool = "positive" | "negative" | "paint" | "erase";
type OpenedVideo = Awaited<ReturnType<typeof openVideo>>;
const MAX_EDGE = 1280;
const MASK_BUDGET = 256 * 1024 * 1024;
const colors = ["#a7e9c2", "#f29a80", "#b6a5f3", "#8fc5f2", "#e7c779"];
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function timecode(frame: number, fps: number) {
  const seconds = Math.floor(frame / fps);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(seconds % 60).toString().padStart(2, "0")}:${Math.floor(frame % fps)
    .toString()
    .padStart(2, "0")}`;
}
function resized(image: ImageData): ImageData {
  if (Math.max(image.width, image.height) <= MAX_EDGE) return image;
  const scale = MAX_EDGE / Math.max(image.width, image.height);
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  source.getContext("2d")!.putImageData(image, 0, 0);
  const target = document.createElement("canvas");
  target.width = Math.round(image.width * scale);
  target.height = Math.round(image.height * scale);
  const ctx = target.getContext("2d")!;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return ctx.getImageData(0, 0, target.width, target.height);
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const videoRef = useRef<OpenedVideo | null>(null);
  const fileRef = useRef<Blob | undefined>(undefined);
  const undoRef = useRef<Project[]>([]);
  const redoRef = useRef<Project[]>([]);
  const [, refreshHistory] = useState(0);
  const [frame, setFrame] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [tool, setTool] = useState<Tool>("positive");
  const [radius, setRadius] = useState(18);
  const [opacity, setOpacity] = useState(0.48);
  const [view, setView] = useState<"overlay" | "mask" | "source">("overlay");
  const [image, setImage] = useState<ImageData | null>(null);
  const [rendered, setRendered] = useState<{
    frame: number;
    projectId: string;
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<ModelStatus>({
    ready: false,
    backend: "Not loaded",
    cached: false,
    message: "Download the model once to enable AI masks.",
  });
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("Local autosave");
  const [help, setHelp] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [includeVideo, setIncludeVideo] = useState(true);
  const [videoExportMode, setVideoExportMode] = useState<
    "overlay" | "mask" | "cutout"
  >("overlay");
  const exportAbort = useRef<AbortController | null>(null);
  const [draftStroke, setDraftStroke] = useState<Stroke | null>(null);
  const draftRef = useRef<Stroke | null>(null);
  const [recoverable, setRecoverable] =
    useState<Awaited<ReturnType<typeof loadLatestProject>>>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<SegmentationClient | null>(null);
  const cancelled = useRef(false);
  const jobType = useRef("");
  const renderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const selected = project?.objects.find((object) => object.id === selectedId);
  const edits = selected?.edits[frame];
  const currentMask = selected?.masks[frame];
  const maskCount = selected ? Object.keys(selected.masks).length : 0;
  const hasCorrection = !!edits?.strokes.length;

  const commit = useCallback((next: Project, history = true) => {
    const old = projectRef.current;
    if (history && old) {
      undoRef.current = [...undoRef.current.slice(-29), old];
      redoRef.current = [];
    }
    projectRef.current = next;
    setProject(next);
    refreshHistory((value) => value + 1);
  }, []);
  const getClient = () =>
    clientRef.current ?? (clientRef.current = new SegmentationClient());
  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous || !projectRef.current) return;
    redoRef.current.push(projectRef.current);
    projectRef.current = previous;
    setProject(previous);
    refreshHistory((value) => value + 1);
  }, []);
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next || !projectRef.current) return;
    undoRef.current.push(projectRef.current);
    projectRef.current = next;
    setProject(next);
    refreshHistory((value) => value + 1);
  }, []);
  const changeFrame = useCallback((next: number) => {
    if (!busyRef.current && projectRef.current)
      setFrame(Math.max(0, Math.min(projectRef.current.frameCount - 1, next)));
  }, []);

  useEffect(() => {
    let live = true;
    loadLatestProject()
      .then((value) => {
        if (live) setRecoverable(value);
      })
      .catch((error) => {
        if (live) setNotice(`Recovery unavailable: ${message(error)}`);
      });
    getClient()
      .status()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(
    () => () => {
      clientRef.current?.dispose();
      clientRef.current = null;
      videoRef.current?.dispose();
      videoRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!project) return;
    setSaved("Saving…");
    const timer = setTimeout(() => {
      saveProject(project, fileRef.current)
        .then(() => setSaved("Saved on this device"))
        .catch((error) => {
          setSaved("Autosave unavailable");
          setError(
            `Autosave: ${message(error)}. Export a project archive to keep your work.`,
          );
        });
    }, 1200);
    return () => clearTimeout(timer);
  }, [project]);

  const loadOpened = async (value: Project, blob?: Blob) => {
    const opened = blob ? await openVideo(blob) : null;
    if (cancelled.current) {
      opened?.dispose();
      return;
    }
    if (
      opened &&
      (opened.width !== value.width ||
        opened.height !== value.height ||
        Math.abs(opened.duration - value.duration) >
          Math.max(0.02, 1 / value.fps))
    ) {
      opened.dispose();
      throw new Error(
        "The footage in this archive does not match its project dimensions or duration.",
      );
    }
    videoRef.current?.dispose();
    videoRef.current = opened;
    fileRef.current = blob;
    undoRef.current = [];
    redoRef.current = [];
    commit(value, false);
    setSelectedId(value.objects[0]?.id ?? "");
    setFrame(value.inFrame);
    setImage(null);
    setPlaying(false);
    setRecoverable(null);
    if (!opened)
      setNotice(
        "Project restored. Relink the original clip to view and segment its frames. Your masks and edits are preserved.",
      );
  };
  const importVideo = async (file: File) => {
    if (busyRef.current) return;
    busyRef.current = true;
    cancelled.current = false;
    setBusy("Opening local clip");
    setError("");
    setPlaying(false);
    try {
      const opened = await openVideo(file);
      if (cancelled.current) {
        opened.dispose();
        return;
      }
      const old = projectRef.current;
      if (old && !videoRef.current) {
        if (
          opened.width !== old.width ||
          opened.height !== old.height ||
          Math.abs(opened.duration - old.duration) > Math.max(0.02, 1 / old.fps)
        ) {
          opened.dispose();
          throw new Error(
            "This clip has different dimensions or duration. Choose the original clip, or start a new project.",
          );
        }
        videoRef.current = opened;
        fileRef.current = file;
        commit({ ...old, updatedAt: Date.now() }, false);
        setNotice("Original clip relinked.");
        return;
      }
      videoRef.current?.dispose();
      videoRef.current = opened;
      fileRef.current = file;
      const next = createProject({
        name: file.name.replace(/\.[^.]+$/, ""),
        videoName: file.name,
        width: opened.width,
        height: opened.height,
        duration: opened.duration,
        fps: 30,
      });
      if (!next.objects.length)
        next.objects.push(createObject("Object 01", colors[0]));
      undoRef.current = [];
      redoRef.current = [];
      commit(next, false);
      setSelectedId(next.objects[0].id);
      setFrame(0);
      setImage(null);
      setNotice(
        "Clip opened locally. Set its frame rate, then add a positive point on your subject.",
      );
      setRecoverable(null);
    } catch (error) {
      setError(message(error));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };
  const importArchiveFile = async (file: File) => {
    if (busyRef.current) return;
    setBusy("Opening project");
    busyRef.current = true;
    cancelled.current = false;
    setError("");
    try {
      const data = await importProject(file);
      if (cancelled.current) return;
      await loadOpened(data.project, data.video);
      if (cancelled.current) return;
      setNotice(
        "Project archive opened. Masks and correction layers are ready.",
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy("");
      busyRef.current = false;
    }
  };

  useEffect(() => {
    const opened = videoRef.current;
    if (!project || !opened || busy) return;
    let live = true;
    const timer = setTimeout(() => {
      renderQueue.current = renderQueue.current
        .catch(() => {})
        .then(async () => {
          if (!live) return;
          const result = resized(
            await seekFrame(opened.video, frame, project.fps),
          );
          if (live) {
            setImage(result);
            setRendered({ frame, projectId: project.id });
          }
        })
        .catch((error) => {
          if (live) setError(message(error));
        });
    }, 15);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [frame, project?.id, project?.fps, project?.updatedAt, busy]);
  useEffect(() => {
    if (!playing || !project) return;
    const timer = setInterval(
      () =>
        setFrame((previous) => {
          if (previous >= project.outFrame) {
            setPlaying(false);
            return project.outFrame;
          }
          return Math.min(
            project.outFrame,
            previous + Math.max(1, Math.round(project.fps / 8)),
          );
        }),
      125,
    );
    return () => clearInterval(timer);
  }, [playing, project?.fps, project?.outFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project) return;
    const width =
      image?.width ??
      Math.round(
        project.width *
          Math.min(1, MAX_EDGE / Math.max(project.width, project.height)),
      );
    const height =
      image?.height ??
      Math.round(
        project.height *
          Math.min(1, MAX_EDGE / Math.max(project.width, project.height)),
      );
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0b0f0d";
    ctx.fillRect(0, 0, width, height);
    if (
      image &&
      rendered?.frame === frame &&
      rendered.projectId === project.id &&
      view !== "mask"
    )
      ctx.putImageData(image, 0, 0);
    for (const object of project.objects) {
      if (
        !object.visible ||
        view === "source" ||
        (view === "mask" && object.id !== selectedId)
      )
        continue;
      const strokes = object.edits[frame]?.strokes ?? [];
      const extra =
        object.id === selectedId && draftStroke
          ? [...strokes, draftStroke]
          : strokes;
      if (!object.masks[frame] && !extra.length) continue;
      const mask = compositeMask(object.masks[frame], extra, width, height);
      const layer = document.createElement("canvas");
      layer.width = width;
      layer.height = height;
      const lc = layer.getContext("2d")!;
      const pixels = lc.createImageData(width, height);
      const hex = object.color.replace("#", "");
      const rgb = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
      for (let i = 0; i < mask.data.length; i++) {
        const offset = i * 4;
        const value = mask.data[i];
        pixels.data[offset] = view === "mask" ? value : rgb[0];
        pixels.data[offset + 1] = view === "mask" ? value : rgb[1];
        pixels.data[offset + 2] = view === "mask" ? value : rgb[2];
        pixels.data[offset + 3] =
          view === "mask" ? 255 : Math.round(value * opacity);
      }
      lc.putImageData(pixels, 0, 0);
      ctx.drawImage(layer, 0, 0);
    }
    if (view !== "mask" && selected)
      for (const point of selected.edits[frame]?.points ?? []) {
        const x = point.x * width;
        const y = point.y * height;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = point.label ? "#a7e9c2" : "#f29a80";
        ctx.fill();
        ctx.strokeStyle = "#14221a";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 3, y);
        ctx.lineTo(x + 3, y);
        if (point.label) {
          ctx.moveTo(x, y - 3);
          ctx.lineTo(x, y + 3);
        }
        ctx.stroke();
      }
  }, [project, frame, image, selectedId, opacity, view, draftStroke, rendered]);

  const canvasPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (
      !project ||
      !selected ||
      busy ||
      !image ||
      rendered?.frame !== frame ||
      rendered.projectId !== project.id ||
      event.button !== 0
    )
      return;
    const point = canvasPoint(event);
    if (tool === "positive" || tool === "negative") {
      commit(
        addPoint(project, selectedId, frame, {
          ...point,
          label: tool === "positive" ? 1 : 0,
        }),
      );
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = {
      points: [point],
      radius: Math.min(1, radius / Math.min(image.width, image.height)),
      mode: tool,
    };
    draftRef.current = stroke;
    setDraftStroke(stroke);
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!draftRef.current) return;
    const stroke = {
      ...draftRef.current,
      points: [...draftRef.current.points, canvasPoint(event)],
    };
    draftRef.current = stroke;
    setDraftStroke(stroke);
  };
  const pointerUp = () => {
    const stroke = draftRef.current;
    if (stroke && projectRef.current)
      commit(addStroke(projectRef.current, selectedId, frame, stroke));
    draftRef.current = null;
    setDraftStroke(null);
  };
  const stop = () => {
    cancelled.current = true;
    exportAbort.current?.abort();
    if (/model|segment/i.test(jobType.current)) {
      getClient().cancel();
      setStatus((previous) => ({
        ...previous,
        ready: false,
        message: "Job cancelled. Load the model again when ready.",
      }));
    }
  };
  const run = async (name: string, job: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    cancelled.current = false;
    jobType.current = name;
    exportAbort.current = new AbortController();
    setBusy(name);
    setProgress(0);
    setError("");
    setPlaying(false);
    try {
      await renderQueue.current.catch(() => {});
      await job();
    } catch (error) {
      if (!cancelled.current) setError(message(error));
    } finally {
      setBusy("");
      busyRef.current = false;
      jobType.current = "";
      exportAbort.current = null;
      setProgress(0);
    }
  };
  const loadModel = () =>
    run("Loading segmentation model", async () => {
      setStatus(
        await getClient().load((value) => {
          setProgress(value.progress);
          setBusy(value.stage);
        }),
      );
      setNotice(
        "Model ready. Positive and negative points guide each AI mask.",
      );
    });
  const segment = (range: boolean) =>
    run(
      range ? "Segmenting independent frames" : "Segmenting this frame",
      async () => {
        const base = projectRef.current;
        const opened = videoRef.current;
        if (!base || !opened || !selectedId)
          throw new Error("Open a clip and select an object first.");
        const object = base.objects.find((item) => item.id === selectedId)!;
        const start = range ? base.inFrame : frame;
        const end = range ? base.outFrame : frame;
        const count = end - start + 1;
        if (count > 300)
          throw new Error(
            "Choose an in/out range of 300 frames or fewer. This keeps browser memory bounded.",
          );
        const scale = Math.min(1, MAX_EDGE / Math.max(base.width, base.height));
        const bytes =
          Math.round(base.width * scale) * Math.round(base.height * scale);
        const existing = base.objects.reduce(
          (sum, obj) =>
            sum +
            Object.values(obj.masks).reduce(
              (total, mask) => total + mask.data.byteLength,
              0,
            ),
          0,
        );
        const replacedBytes = Object.entries(object.masks)
          .filter(([index]) => Number(index) >= start && Number(index) <= end)
          .reduce((sum, [, mask]) => sum + mask.data.byteLength, 0);
        if (existing - replacedBytes + bytes * count > MASK_BUDGET)
          throw new Error(
            "This range would exceed the 256 MiB mask budget. Export your work and use a shorter range.",
          );
        if (
          !Object.values(object.edits).some((edit) =>
            edit.points.some((point) => point.label === 1),
          )
        )
          throw new Error(
            "Add at least one positive point on this object first.",
          );
        if (!status.ready)
          setStatus(
            await getClient().load((value) => {
              setProgress(value.progress);
              setBusy(value.stage);
            }),
          );
        let next = base;
        let completed = 0;
        for (let index = start; index <= end; index++) {
          if (cancelled.current) break;
          const points: Point[] = range
            ? nearestPoints(object, index)
            : (object.edits[index]?.points ?? []);
          if (!points.some((point) => point.label === 1))
            throw new Error(
              "This frame needs a positive point. Add one, or use the range command to reuse nearby annotations.",
            );
          const pixels = resized(
            await seekFrame(opened.video, index, base.fps),
          );
          if (cancelled.current) break;
          const mask = await getClient().segment(pixels, points);
          if (cancelled.current) break;
          next = setMask(next, selectedId, index, mask);
          completed++;
          commit(next, completed === 1);
          setFrame(index);
          setImage(pixels);
          setRendered({ frame: index, projectId: base.id });
          setProgress(completed / count);
          setBusy(`Segmenting frame ${index + 1} · ${completed}/${count}`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        setNotice(
          `${completed} AI mask${completed === 1 ? "" : "s"} saved. Corrections remain in their own editable layer.${range ? " Each frame was segmented independently; this model has no video memory." : ""}`,
        );
      },
    );
  const changeObject = (patch: Partial<Project["objects"][number]>) => {
    if (project)
      commit({
        ...project,
        updatedAt: Date.now(),
        objects: project.objects.map((object) =>
          object.id === selectedId ? { ...object, ...patch } : object,
        ),
      });
  };
  const addObject = () => {
    if (!project) return;
    const object = createObject(
      `Object ${String(project.objects.length + 1).padStart(2, "0")}`,
      colors[project.objects.length % colors.length],
    );
    commit({
      ...project,
      updatedAt: Date.now(),
      objects: [...project.objects, object],
    });
    setSelectedId(object.id);
  };
  const exportCurrent = () =>
    run("Exporting mask PNG", async () => {
      if (!project || !selected) return;
      if (!currentMask && !hasCorrection)
        throw new Error(
          "Generate a mask or paint a correction on this frame first.",
        );
      const width = image?.width ?? currentMask?.width ?? project.width;
      const height = image?.height ?? currentMask?.height ?? project.height;
      const blob = await exportMaskPng(
        compositeMask(currentMask, edits?.strokes ?? [], width, height),
      );
      if (cancelled.current) return;
      download(
        blob,
        `${project.name}-${selected.name}-${String(frame + 1).padStart(6, "0")}.png`,
      );
      setNotice(
        `Mask PNG exported at ${width} × ${height}. White is foreground.`,
      );
    });
  const exportVideo = () =>
    run("Exporting silent WebM · real time", async () => {
      if (!project || !videoRef.current) return;
      exportAbort.current = new AbortController();
      const blob = await exportCompositeVideo(project, videoRef.current.video, {
        mode: videoExportMode,
        onProgress: (value) => setProgress(value),
        signal: exportAbort.current.signal,
      });
      if (!cancelled.current) {
        download(blob, `${project.name}-${videoExportMode}.webm`);
        setNotice(
          "Silent WebM exported in real time. Codec support and timing depend on your browser.",
        );
      }
      exportAbort.current = null;
    });
  const exportSequence = () =>
    run("Exporting mask sequence", async () => {
      if (!project || !selected) return;
      const blob = await exportMaskSequence(
        project,
        selected.id,
        (value) => setProgress(value),
        exportAbort.current?.signal,
      );
      if (cancelled.current) return;
      download(blob, `${project.name}-${selected.name}-masks.zip`);
      setNotice(
        "Mask sequence exported. Missing frames stay unmasked; no masks are invented.",
      );
    });
  const exportArchive = () =>
    run("Packing project archive", async () => {
      if (!project) return;
      const blob = await exportProject(
        project,
        includeVideo ? fileRef.current : undefined,
      );
      if (cancelled.current) return;
      download(blob, `${project.name}.sammie.zip`);
      setNotice(
        includeVideo
          ? "Project archive exported with local footage when available."
          : "Project archive exported. Relink the original clip after importing.",
      );
    });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if (event.key === "Escape") {
        if (busyRef.current) stop();
        setHelp(false);
        setDiagnostics(false);
        return;
      }
      if (busyRef.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        changeFrame(frame - (event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        changeFrame(frame + (event.shiftKey ? 10 : 1));
      } else if (event.code === "Space" && project) {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key === "Enter" && project && videoRef.current) {
        event.preventDefault();
        void segment(false);
      } else if (event.key === "1") setTool("positive");
      else if (event.key === "2") setTool("negative");
      else if (event.key.toLowerCase() === "b") setTool("paint");
      else if (event.key.toLowerCase() === "e") setTool("erase");
      else if (event.key.toLowerCase() === "i" && project)
        commit({
          ...project,
          inFrame: Math.min(frame, project.outFrame),
          updatedAt: Date.now(),
        });
      else if (event.key.toLowerCase() === "o" && project)
        commit({
          ...project,
          outFrame: Math.max(frame, project.inFrame),
          updatedAt: Date.now(),
        });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [frame, project, undo, redo, changeFrame, selectedId, status.ready]);

  const onFile = (event: ChangeEvent<HTMLInputElement>, archive = false) => {
    const file = event.target.files?.[0];
    if (file) void (archive ? importArchiveFile(file) : importVideo(file));
    event.target.value = "";
  };
  const doneFrames = selected ? Object.keys(selected.masks).map(Number) : [];
  return (
    <div className="app-shell">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={(event) => onFile(event)}
        aria-label="Import local video"
      />
      <input
        ref={archiveRef}
        type="file"
        accept=".zip,.sammie.zip"
        className="sr-only"
        onChange={(event) => onFile(event, true)}
        aria-label="Import project archive"
      />
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(event) => event.preventDefault()}
          aria-label="Sammie Roto home"
        >
          <span className="brand-mark">
            <Square size={19} />
            <span />
          </span>
          <strong>
            sammie<span>roto</span>
          </strong>
          <span className="beta">WEB / 01</span>
        </a>
        <div className="project-heading">
          <span className="divider" />
          <span>{project?.name ?? "Untitled workspace"}</span>
          <span className="save-status">
            <span className="status-dot" />
            {project ? saved : "Everything stays local"}
          </span>
        </div>
        <div className="top-actions">
          {project && (
            <button
              className="text-button new-workspace"
              disabled={!!busy}
              onClick={() => {
                videoRef.current?.dispose();
                videoRef.current = null;
                fileRef.current = undefined;
                projectRef.current = null;
                setProject(null);
                setImage(null);
                setPlaying(false);
                undoRef.current = [];
                redoRef.current = [];
                setNotice(
                  "New workspace opened. The previous autosave stays available until a new project is saved.",
                );
              }}
            >
              New workspace
            </button>
          )}
          <button className="text-button" onClick={() => setHelp(true)}>
            <CircleHelp size={16} />
            <span>Quick guide</span>
          </button>
          <button
            className="secondary small"
            disabled={!!busy}
            onClick={() => archiveRef.current?.click()}
          >
            <FolderOpen size={15} />
            <span>Open project</span>
          </button>
          <button
            className="primary small"
            disabled={!!busy}
            onClick={() => inputRef.current?.click()}
          >
            <Plus size={16} />
            <span>
              {project && !videoRef.current ? "Relink clip" : "Import clip"}
            </span>
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="object-panel">
          <div className="panel-title">
            <span>YOUR WORKSPACE</span>
            <span className="tiny-index">01</span>
          </div>
          <div className="clip-card">
            <div className="clip-icon">
              <Film size={21} />
            </div>
            <div>
              <strong>{project?.videoName ?? "No clip imported"}</strong>
              <small>
                {project
                  ? `${project.width} × ${project.height} · ${project.duration.toFixed(1)}s`
                  : "Start with a local video"}
              </small>
            </div>
          </div>
          <div className="section-heading">
            <h2>Objects</h2>
            <button
              className="icon-button"
              aria-label="Add object"
              disabled={!project || !!busy}
              onClick={addObject}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="object-list">
            {project?.objects.map((object, index) => (
              <div
                className={`object-row ${object.id === selectedId ? "selected" : ""}`}
                key={object.id}
              >
                <button
                  className="object-select"
                  disabled={!!busy}
                  onClick={() => setSelectedId(object.id)}
                >
                  <span
                    className="object-color"
                    style={{ background: object.color }}
                  />
                  <span>
                    <strong>{object.name}</strong>
                    <small>
                      {Object.keys(object.masks).length} masked frames
                    </small>
                  </span>
                  <span className="object-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </button>
                <button
                  className="visibility-button"
                  disabled={!!busy}
                  aria-label={`${object.visible ? "Hide" : "Show"} ${object.name}`}
                  onClick={() =>
                    commit({
                      ...project,
                      updatedAt: Date.now(),
                      objects: project.objects.map((item) =>
                        item.id === object.id
                          ? { ...item, visible: !item.visible }
                          : item,
                      ),
                    })
                  }
                >
                  {object.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </div>
            ))}
            {!project && (
              <div className="empty-objects">
                <span className="dashed-object" />
                <p>
                  One object, one mask.
                  <br />
                  Keep every subject separate.
                </p>
              </div>
            )}
          </div>
          {selected && (
            <div className="object-properties">
              <label>
                Object name
                <input
                  value={selected.name}
                  maxLength={60}
                  disabled={!!busy}
                  onChange={(event) =>
                    changeObject({ name: event.target.value })
                  }
                />
              </label>
              <div className="color-row">
                <span>Overlay color</span>
                <input
                  type="color"
                  value={selected.color}
                  aria-label="Object overlay color"
                  disabled={!!busy}
                  onChange={(event) =>
                    changeObject({ color: event.target.value })
                  }
                />
              </div>
              <button
                className="danger-link"
                disabled={!!busy}
                onClick={() => {
                  if (!project || project.objects.length < 2) return;
                  commit({
                    ...project,
                    updatedAt: Date.now(),
                    objects: project.objects.filter(
                      (object) => object.id !== selectedId,
                    ),
                  });
                  setSelectedId(
                    project.objects.find((object) => object.id !== selectedId)!
                      .id,
                  );
                }}
              >
                <Trash2 size={12} />
                Remove object
              </button>
            </div>
          )}
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Your footage. Your device.</strong>
              <p>
                Video and masks stay in your browser. Only model weights
                download.
              </p>
            </div>
          </div>
          <button
            className="diagnostics-button"
            onClick={() => setDiagnostics(true)}
          >
            <Cpu size={15} />
            <span>Device & storage</span>
            <ChevronRight size={14} />
          </button>
        </aside>
        <main className="editor">
          <div className="viewer-toolbar">
            <div className="viewer-label">
              <span className="live-dot" />
              {project ? "CLIP VIEWER" : "LOCAL MASKING STUDIO"}
            </div>
            <div className="view-switch" aria-label="Viewer mode">
              {(["overlay", "mask", "source"] as const).map((mode) => (
                <button
                  disabled={!project}
                  className={view === mode ? "active" : ""}
                  key={mode}
                  onClick={() => setView(mode)}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div className="viewer-meta">
              {image ? `${image.width} × ${image.height}` : "LOCAL FIRST"}
            </div>
          </div>
          <div
            className={`viewer ${project ? "has-video" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy && event.dataTransfer.files[0])
                void importVideo(event.dataTransfer.files[0]);
            }}
          >
            {project ? (
              <>
                <div
                  className="canvas-wrap"
                  style={{ aspectRatio: `${project.width}/${project.height}` }}
                >
                  <canvas
                    ref={canvasRef}
                    onPointerDown={pointerDown}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={pointerUp}
                    aria-label="Video frame. Click to add a prompt or drag to paint a correction."
                    className={
                      tool === "paint" || tool === "erase"
                        ? "brush-cursor"
                        : "point-cursor"
                    }
                  />
                  {(!image ||
                    rendered?.frame !== frame ||
                    rendered.projectId !== project.id) && (
                    <div className="canvas-loading">
                      {videoRef.current ? (
                        <>
                          <LoaderCircle size={22} className="spin" /> Decoding
                          frame
                        </>
                      ) : (
                        <>
                          <Film size={24} />
                          <button
                            className="secondary"
                            onClick={() => inputRef.current?.click()}
                          >
                            Relink original clip
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className="viewer-bottom">
                  <span>
                    {selected?.name ?? "Select an object"}
                    <span className="muted"> / </span>
                    {tool === "positive"
                      ? "+ Foreground point"
                      : tool === "negative"
                        ? "− Background point"
                        : tool === "paint"
                          ? "Paint foreground"
                          : "Erase foreground"}
                  </span>
                  <span>
                    {currentMask
                      ? "AI mask"
                      : hasCorrection
                        ? "Manual correction"
                        : "No mask on this frame"}
                  </span>
                </div>
              </>
            ) : (
              <div className="welcome">
                <div className="welcome-art">
                  <span className="art-frame" />
                  <span className="art-orbit orbit-one" />
                  <span className="art-orbit orbit-two" />
                  <span className="art-corner corner-one" />
                  <span className="art-corner corner-two" />
                  <MousePointer2 size={23} className="art-pointer" />
                  <span className="art-point">
                    <Plus size={13} />
                  </span>
                  <span className="art-label">
                    A little guidance. A clear subject.
                  </span>
                </div>
                <span className="eyebrow">A NEW SPACE FOR YOUR SUBJECTS</span>
                <h1>Find your edge.</h1>
                <p>
                  Precise masks, one object at a time.
                  <br />
                  Open a clip and make it yours — entirely on your device.
                </p>
                <button
                  className="primary import-large"
                  onClick={() => inputRef.current?.click()}
                >
                  <Plus size={18} />
                  Import a local clip
                  <ArrowUpFromLine size={16} />
                </button>
                <small>or drop a video here · no upload, no account</small>
                <div className="welcome-features">
                  <span>
                    <MousePointer2 size={14} />
                    Point & segment
                  </span>
                  <span>
                    <Brush size={14} />
                    Refine by hand
                  </span>
                  <span>
                    <Download size={14} />
                    Export your masks
                  </span>
                </div>
              </div>
            )}
            {recoverable && !project && (
              <div className="recovery-banner">
                <HardDrive size={17} />
                <span>
                  Saved workspace: <strong>{recoverable.project.name}</strong>
                </span>
                <button
                  onClick={() =>
                    void run("Restoring local project", async () => {
                      await loadOpened(recoverable.project, recoverable.video);
                    })
                  }
                >
                  Restore
                  <ChevronRight size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Dismiss recovery"
                  onClick={() => setRecoverable(null)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="editing-tools">
            <div className="tool-group">
              {(
                [
                  {
                    id: "positive",
                    icon: Plus,
                    title: "Foreground point",
                    key: "1",
                  },
                  {
                    id: "negative",
                    icon: Minus,
                    title: "Background point",
                    key: "2",
                  },
                  {
                    id: "paint",
                    icon: Brush,
                    title: "Paint correction",
                    key: "B",
                  },
                  {
                    id: "erase",
                    icon: Eraser,
                    title: "Erase correction",
                    key: "E",
                  },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  className={`tool-button ${tool === item.id ? "active" : ""}`}
                  aria-label={`${item.title} (${item.key})`}
                  title={`${item.title} (${item.key})`}
                  disabled={!project || !!busy}
                  onClick={() => setTool(item.id)}
                >
                  <item.icon size={17} />
                  <span>{item.key}</span>
                </button>
              ))}
            </div>
            <span className="tool-divider" />
            {tool === "paint" || tool === "erase" ? (
              <label className="inline-slider">
                Brush{" "}
                <input
                  aria-label="Brush radius"
                  type="range"
                  min="2"
                  max="100"
                  value={radius}
                  onChange={(event) => setRadius(Number(event.target.value))}
                />
                <span>{radius}px</span>
              </label>
            ) : (
              <span className="tool-hint">
                {tool === "positive"
                  ? "Click inside the subject"
                  : "Click what the mask should exclude"}
              </span>
            )}
            <div className="history-tools">
              <button
                className="icon-button"
                aria-label="Undo"
                title="Undo (⌘/Ctrl Z)"
                disabled={!undoRef.current.length || !!busy}
                onClick={undo}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Redo"
                title="Redo (⌘/Ctrl Shift Z)"
                disabled={!redoRef.current.length || !!busy}
                onClick={redo}
              >
                <Redo2 size={17} />
              </button>
            </div>
          </div>
          <section className="timeline" aria-label="Timeline">
            <div className="timeline-header">
              <div>
                <Film size={14} />
                <span>Timeline</span>
                <small>
                  {project ? `${project.frameCount} frames` : "No clip"}
                </small>
              </div>
              <span className="range-label">
                {project
                  ? `IN ${project.inFrame + 1} — OUT ${project.outFrame + 1}`
                  : "Set your working range"}
              </span>
            </div>
            <div className="timeline-track">
              <div className="timeline-ruler">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <span key={index}>
                    {project
                      ? timecode(
                          Math.round(((project.frameCount - 1) * index) / 5),
                          project.fps,
                        )
                      : `00:${String(index * 2).padStart(2, "0")}`}
                  </span>
                ))}
              </div>
              <div className="mask-track">
                <span className="track-name">{selected?.name ?? "MASK"}</span>
                <div className="track-content">
                  {project && (
                    <>
                      <div
                        className="range-highlight"
                        style={{
                          left: `${(project.inFrame / project.frameCount) * 100}%`,
                          width: `${((project.outFrame - project.inFrame + 1) / project.frameCount) * 100}%`,
                        }}
                      />
                      {doneFrames.map((index) => (
                        <span
                          key={index}
                          className="mask-tick"
                          style={{
                            left: `${(index / project.frameCount) * 100}%`,
                            width: `${Math.max(0.3, 100 / project.frameCount)}%`,
                            background: selected?.color,
                          }}
                        />
                      ))}
                      {Object.keys(selected?.edits ?? {})
                        .map(Number)
                        .map((index) => (
                          <span
                            key={index}
                            className="edit-keyframe"
                            style={{
                              left: `${(index / project.frameCount) * 100}%`,
                            }}
                          />
                        ))}
                      <div
                        className="playhead"
                        style={{
                          left: `${(frame / Math.max(1, project.frameCount - 1)) * 100}%`,
                        }}
                      />
                      <input
                        aria-label="Frame timeline"
                        type="range"
                        min="0"
                        max={Math.max(0, project.frameCount - 1)}
                        value={frame}
                        disabled={!!busy}
                        onChange={(event) => {
                          setPlaying(false);
                          changeFrame(Number(event.target.value));
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="transport">
              <div className="range-buttons">
                <button
                  disabled={!project || !!busy}
                  onClick={() =>
                    project &&
                    commit({
                      ...project,
                      inFrame: Math.min(frame, project.outFrame),
                      updatedAt: Date.now(),
                    })
                  }
                >
                  Set in <kbd>I</kbd>
                </button>
                <button
                  disabled={!project || !!busy}
                  onClick={() =>
                    project &&
                    commit({
                      ...project,
                      outFrame: Math.max(frame, project.inFrame),
                      updatedAt: Date.now(),
                    })
                  }
                >
                  Set out <kbd>O</kbd>
                </button>
              </div>
              <div className="playback-controls">
                <button
                  className="icon-button"
                  aria-label="Previous frame"
                  disabled={!project || !!busy}
                  onClick={() => {
                    setPlaying(false);
                    changeFrame(frame - 1);
                  }}
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  className="play-button"
                  aria-label={
                    playing
                      ? "Pause preview"
                      : "Play preview at 8 frames per second"
                  }
                  title="Preview playback · 8 fps"
                  disabled={!project || !!busy || !videoRef.current}
                  onClick={() => {
                    if (project && frame >= project.outFrame)
                      setFrame(project.inFrame);
                    setPlaying((value) => !value);
                  }}
                >
                  {playing ? (
                    <Pause size={15} fill="currentColor" />
                  ) : (
                    <Play size={15} fill="currentColor" />
                  )}
                </button>
                <button
                  className="icon-button"
                  aria-label="Next frame"
                  disabled={!project || !!busy}
                  onClick={() => {
                    setPlaying(false);
                    changeFrame(frame + 1);
                  }}
                >
                  <ChevronRight size={17} />
                </button>
                <span className="timecode">
                  {timecode(frame, project?.fps ?? 30)}
                </span>
                <span className="frame-number">
                  {project ? `${frame + 1} / ${project.frameCount}` : "— / —"}
                </span>
              </div>
              <label className="fps-control">
                FPS
                <input
                  type="number"
                  aria-label="Clip frame rate"
                  min="1"
                  max="120"
                  step=".001"
                  value={project?.fps ?? 30}
                  disabled={
                    !project ||
                    !!busy ||
                    !!project.objects.some(
                      (object) =>
                        Object.keys(object.edits).length ||
                        Object.keys(object.masks).length,
                    )
                  }
                  onChange={(event) => {
                    if (!project) return;
                    const fps = Number(event.target.value);
                    if (fps >= 1 && fps <= 120) {
                      const count = Math.max(
                        1,
                        Math.ceil(project.duration * fps),
                      );
                      commit({
                        ...project,
                        fps,
                        frameCount: count,
                        inFrame: 0,
                        outFrame: count - 1,
                        updatedAt: Date.now(),
                      });
                      setFrame(0);
                    }
                  }}
                />
              </label>
            </div>
          </section>
          <footer className="editor-footer">
            <span>
              <span className="status-dot" />
              Local processing
            </span>
            <span>
              {project
                ? "Frame rate is manual · set it before editing"
                : "Built for a little more control"}
            </span>
            <button onClick={() => setHelp(true)}>
              Keyboard shortcuts
              <CircleHelp size={12} />
            </button>
          </footer>
        </main>
        <aside className="inspector">
          <div className="panel-title">
            <span>THE DETAILS</span>
            <SlidersHorizontal size={14} />
          </div>
          <section className="inspector-section">
            <div className="section-heading">
              <h2>Make a mask</h2>
              <span className="step-badge">01</span>
            </div>
            <p className="section-copy">
              Tell the model what to keep, then refine the result.
            </p>
            <div className="prompt-summary">
              <span>
                <span className="prompt-dot positive" />
                Foreground
                <strong>
                  {edits?.points.filter((point) => point.label === 1).length ??
                    0}
                </strong>
              </span>
              <span>
                <span className="prompt-dot negative" />
                Background
                <strong>
                  {edits?.points.filter((point) => point.label === 0).length ??
                    0}
                </strong>
              </span>
            </div>
            <button
              className="segment-button"
              disabled={!project || !selected || !!busy || !videoRef.current}
              onClick={() => void segment(false)}
            >
              <Sparkles size={17} />
              Segment this frame<span>↵</span>
            </button>
            <button
              className="secondary full range-segment"
              disabled={!project || !selected || !!busy || !videoRef.current}
              onClick={() => void segment(true)}
            >
              <Film size={15} />
              Segment range
              <ChevronRight size={14} />
            </button>
            <p className="fine-print">
              Range mode segments independent frames using the nearest
              annotation. It has no video memory; moving subjects need new
              points.
            </p>
            <button
              className="text-button reset-points"
              disabled={!edits?.points.length || !!busy}
              onClick={() => {
                if (project && selected)
                  changeObject({
                    edits: {
                      ...selected.edits,
                      [frame]: { points: [], strokes: edits?.strokes ?? [] },
                    },
                  });
              }}
            >
              <RotateCcw size={12} />
              Clear frame points<span>keeps masks</span>
            </button>
            {hasCorrection && (
              <button
                className="text-button reset-points"
                disabled={!!busy}
                onClick={() =>
                  selected &&
                  changeObject({
                    edits: {
                      ...selected.edits,
                      [frame]: { points: edits?.points ?? [], strokes: [] },
                    },
                  })
                }
              >
                <Eraser size={12} />
                Clear correction layer
              </button>
            )}
          </section>
          <section className="inspector-section">
            <div className="section-heading">
              <h2>Preview</h2>
              <span className="step-badge">02</span>
            </div>
            <label className="overlay-slider">
              <span>
                Overlay opacity<strong>{Math.round(opacity * 100)}%</strong>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step=".01"
                value={opacity}
                aria-label="Overlay opacity"
                onChange={(event) => setOpacity(Number(event.target.value))}
              />
            </label>
            <div className="correction-note">
              <Brush size={14} />
              <span>
                Brush and erase sit above your AI mask. Re-segmenting preserves
                corrections.
              </span>
            </div>
          </section>
          <section className="inspector-section model-section">
            <div className="section-heading">
              <h2>Local AI</h2>
              <span
                className={`model-indicator ${status.ready ? "ready" : ""}`}
              />
            </div>
            <div className="model-name">
              <Cpu size={18} />
              <div>
                <strong>SlimSAM</strong>
                <small>
                  {status.ready
                    ? status.backend
                    : status.cached
                      ? "Cached on this device"
                      : "Point-guided segmentation"}
                </small>
              </div>
              <span className="model-tag">ONNX</span>
            </div>
            <p className="fine-print">{status.message}</p>
            <button
              className="secondary full"
              disabled={!!busy}
              onClick={() => void loadModel()}
            >
              {status.ready ? (
                <Check size={14} />
              ) : (
                <ArrowDownToLine size={14} />
              )}
              {status.ready
                ? "Model ready"
                : status.cached
                  ? "Load cached model"
                  : "Download & load model"}
            </button>
            <button
              className="text-button cache-button"
              disabled={!!busy}
              onClick={() =>
                void run("Clearing model cache", async () => {
                  await getClient().clearCache();
                  setStatus(await getClient().status());
                  setNotice(
                    "Model download cache cleared. Project footage and masks are unaffected.",
                  );
                })
              }
            >
              Clear model cache
            </button>
          </section>
          <section className="inspector-section export-section">
            <div className="section-heading">
              <h2>Take it with you</h2>
              <span className="step-badge">03</span>
            </div>
            <div className="export-grid">
              <button
                className="export-card"
                disabled={
                  !project || !!busy || (!currentMask && !hasCorrection)
                }
                onClick={() => void exportCurrent()}
              >
                <Image size={17} />
                <strong>Mask PNG</strong>
                <small>Current frame</small>
              </button>
              <button
                className="export-card"
                disabled={
                  !project ||
                  !!busy ||
                  !(
                    maskCount ||
                    Object.values(selected?.edits ?? {}).some(
                      (edit) => edit.strokes.length,
                    )
                  )
                }
                onClick={() => void exportSequence()}
              >
                <Film size={17} />
                <strong>Sequence</strong>
                <small>PNG files · ZIP</small>
              </button>
            </div>
            <div className="video-export-row">
              <select
                aria-label="Video export mode"
                value={videoExportMode}
                onChange={(event) =>
                  setVideoExportMode(
                    event.target.value as typeof videoExportMode,
                  )
                }
              >
                <option value="overlay">Colored overlay</option>
                <option value="mask">Combined mask</option>
                <option value="cutout">Cutout on black</option>
              </select>
              <button
                className="secondary full"
                disabled={
                  !project ||
                  !!busy ||
                  !videoRef.current ||
                  !project.objects.some(
                    (object) =>
                      Object.keys(object.masks).length ||
                      Object.values(object.edits).some(
                        (edit) => edit.strokes.length,
                      ),
                  )
                }
                onClick={() => void exportVideo()}
              >
                <Film size={14} />
                Export WebM
              </button>
              <small>Silent · real time · browser codec</small>
            </div>
            <button
              className="secondary full project-export"
              disabled={!project || !!busy}
              onClick={() => void exportArchive()}
            >
              <Download size={14} />
              Save project archive
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeVideo}
                onChange={(event) => setIncludeVideo(event.target.checked)}
              />
              Include original clip
            </label>
            <p className="fine-print">
              Archives keep every object, prompt, mask, and correction. Browser
              storage can be cleared; keep an archive.
            </p>
          </section>
          <div className="inspector-bottom">
            <span>sammie roto</span>
            <span>A LOCAL-FIRST EXPERIMENT</span>
          </div>
        </aside>
      </div>
      {(notice || error || busy) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : error ? (
            <CircleHelp size={17} />
          ) : (
            <Check size={17} />
          )}
          <div>
            <strong>
              {busy ||
                (error ? "Something needs attention" : "Workspace update")}
            </strong>
            <p>
              {busy
                ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}% · Keep this tab open`
                : error || notice}
            </p>
            {busy && (
              <div className="progress-bar">
                <span
                  style={{
                    width: `${Math.max(2, Math.min(100, progress * 100))}%`,
                  }}
                />
              </div>
            )}
          </div>
          {busy ? (
            <button className="text-button" onClick={stop}>
              Cancel
            </button>
          ) : (
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => {
                setNotice("");
                setError("");
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {(help || diagnostics) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setHelp(false);
            setDiagnostics(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={help ? "Quick guide" : "Device diagnostics"}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => {
                setHelp(false);
                setDiagnostics(false);
              }}
            >
              <X size={19} />
            </button>
            {help ? (
              <>
                <span className="eyebrow">A FEW SIMPLE STEPS</span>
                <h2>A little guidance goes a long way.</h2>
                <ol className="guide-list">
                  <li>
                    <strong>Open your clip.</strong>
                    <p>
                      Set its true frame rate before making edits. The browser
                      supplies duration and dimensions, but not a reliable frame
                      rate.
                    </p>
                  </li>
                  <li>
                    <strong>Choose a subject.</strong>
                    <p>
                      Add foreground points with <kbd>1</kbd>, background points
                      with <kbd>2</kbd>, then segment. Use separate objects for
                      rust, road, or anything else.
                    </p>
                  </li>
                  <li>
                    <strong>Refine with confidence.</strong>
                    <p>
                      Paint with <kbd>B</kbd>, erase with <kbd>E</kbd>.
                      Correction layers and existing masks survive prompt edits
                      and new inference. Undo with <kbd>⌘/Ctrl Z</kbd>.
                    </p>
                  </li>
                  <li>
                    <strong>Work through the clip.</strong>
                    <p>
                      Move with <kbd>←</kbd> <kbd>→</kbd>; hold Shift to move
                      ten frames. Set <kbd>I</kbd> and <kbd>O</kbd> for a range.
                      The range command reuses nearby points; it does not track
                      objects with AI memory.
                    </p>
                  </li>
                  <li>
                    <strong>Keep a copy.</strong>
                    <p>
                      Export PNG masks or a complete project archive. Previews
                      and current-frame PNG use a maximum 1280 px edge. Sequence
                      PNGs use source dimensions, upscaled from working masks.
                      Accurate source frame indexing assumes constant frame
                      rate.
                    </p>
                  </li>
                </ol>
                <div className="modal-note">
                  This first browser version runs real point-guided inference.
                  Silent WebM export uses real-time browser recording. Temporal
                  AI tracking, matting, removal, audio-preserving video export,
                  and exact variable-frame-rate indexing are not included.
                </div>
              </>
            ) : (
              <>
                <span className="eyebrow">ON YOUR DEVICE</span>
                <h2>Ready for local work?</h2>
                <div className="diagnostic-list">
                  {[
                    {
                      name: "Secure connection",
                      value: window.isSecureContext
                        ? "Available"
                        : "HTTPS required",
                    },
                    {
                      name: "Cross-origin isolation",
                      value: window.crossOriginIsolated
                        ? "Enabled"
                        : "Off · single-thread fallback",
                    },
                    {
                      name: "WebGPU",
                      value:
                        "gpu" in navigator
                          ? "API available · tested at model load"
                          : "Unavailable · WASM fallback",
                    },
                    {
                      name: "WebCodecs",
                      value:
                        "VideoDecoder" in window
                          ? "API available"
                          : "Unavailable",
                    },
                    {
                      name: "WebM export codec",
                      value:
                        supportedVideoExportType() ??
                        "Unavailable · use PNG masks",
                    },
                    {
                      name: "Project storage",
                      value: "IndexedDB · this browser",
                    },
                    {
                      name: "OPFS API",
                      value:
                        "getDirectory" in navigator.storage
                          ? "Available · not used by this release"
                          : "Unavailable",
                    },
                    {
                      name: "AI runtime",
                      value: status.ready ? status.backend : "Model not loaded",
                    },
                  ].map((item) => (
                    <div key={item.name}>
                      <span>{item.name}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
                <p className="section-copy">
                  Clips decode with the browser video element. Current-frame
                  previews and masks are bounded to a 1280 px edge. Range jobs
                  cap at 300 frames and 256 MiB of stored masks.
                </p>
                <button
                  className="secondary full"
                  onClick={() =>
                    void navigator.storage
                      ?.estimate()
                      .then((value) =>
                        setNotice(
                          `Browser storage: ${((value.usage ?? 0) / 1048576).toFixed(1)} MiB used of ${((value.quota ?? 0) / 1073741824).toFixed(1)} GiB quota.`,
                        ),
                      )
                      .catch((error) => setError(message(error)))
                  }
                >
                  <HardDrive size={15} />
                  Check browser storage
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
