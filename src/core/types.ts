export type Point = { x: number; y: number; label: 0 | 1 };
export type Stroke = {
  points: { x: number; y: number }[];
  radius: number;
  mode: "paint" | "erase";
};
export type FrameEdit = { points: Point[]; strokes: Stroke[] };
export type Mask = { width: number; height: number; data: Uint8Array };
export type RotoObject = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  edits: Record<number, FrameEdit>;
  masks: Record<number, Mask>;
};
export type Project = {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  frameCount: number;
  inFrame: number;
  outFrame: number;
  objects: RotoObject[];
  updatedAt: number;
  videoName: string;
};
export type ModelProgress = { stage: string; progress: number };
export type ModelStatus = {
  ready: boolean;
  backend: string;
  cached: boolean;
  message: string;
};
