import type { Mask, ModelProgress, ModelStatus, Point } from "../core/types";
export { MODEL_MANIFEST } from "./manifest";
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress?: (value: ModelProgress) => void;
};
/** A disposable worker owns the runtime, one frame's embeddings, and all model memory. */
export class SegmentationClient {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private disposed = false;
  constructor(private options: { forceWasm?: boolean } = {}) {}
  private ensureWorker(): Worker {
    if (this.disposed) throw new Error("The segmentation client is closed.");
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "sammie-inference",
      });
      this.worker.onmessage = (event) => {
        const { id, result, error, progress } = event.data;
        const pending = this.pending.get(id);
        if (!pending) return;
        if (progress) {
          pending.progress?.(progress);
          return;
        }
        this.pending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      };
      this.worker.onerror = (event) => {
        this.reset(
          new Error(event.message || "The model worker stopped unexpectedly."),
        );
      };
    }
    return this.worker;
  }
  private request<T>(
    method: string,
    payload: Record<string, unknown> = {},
    progress?: (value: ModelProgress) => void,
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = this.ensureWorker(),
        id = ++this.nextId;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
      });
      worker.postMessage(
        { id, method, forceWasm: this.options.forceWasm, ...payload },
        transfer,
      );
    });
  }
  status(): Promise<ModelStatus> {
    return this.request("status");
  }
  load(onProgress?: (value: ModelProgress) => void): Promise<ModelStatus> {
    return this.request("load", {}, onProgress);
  }
  segment(
    image: ImageData,
    points: Point[],
    onProgress?: (value: ModelProgress) => void,
  ): Promise<Mask> {
    const data = image.data.slice();
    return this.request(
      "segment",
      { image: { width: image.width, height: image.height, data }, points },
      onProgress,
      [data.buffer],
    );
  }
  private reset(error: Error) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  cancel(): void {
    this.reset(new DOMException("Inference cancelled.", "AbortError"));
  }
  async clearCache(): Promise<void> {
    this.cancel();
    await this.request("clearCache");
  }
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}
