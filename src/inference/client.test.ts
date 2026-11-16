import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentationClient } from "./client";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  messages: Record<string, unknown>[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(result: unknown) {
    this.onmessage?.({ data: { id: this.messages[0].id, result } });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
describe("worker cancellation and recovery", () => {
  it("rejects pending jobs, terminates runtime, and starts a fresh worker on next load", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new SegmentationClient();
    const pending = client.load();
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const old = FakeWorker.instances[0];
    client.cancel();
    await rejection;
    expect(old.terminated).toBe(true);
    const next = client.status();
    const current = FakeWorker.instances[1];
    expect(current).not.toBe(old);
    current.reply({
      ready: false,
      backend: "Not loaded",
      cached: true,
      message: "cache ready",
    });
    await expect(next).resolves.toMatchObject({ ready: false, cached: true });
    client.dispose();
  });
  it("disposal prevents a new runtime and forced WASM is included in worker requests", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new SegmentationClient({ forceWasm: true });
    const pending = client.status();
    const worker = FakeWorker.instances[0];
    expect(worker.messages[0].forceWasm).toBe(true);
    worker.reply({ ready: false });
    await pending;
    client.dispose();
    await expect(client.load()).rejects.toThrow("closed");
    expect(FakeWorker.instances.length).toBe(1);
  });
});
