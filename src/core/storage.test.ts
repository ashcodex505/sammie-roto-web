import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "./project";
import { deleteSavedProject, loadLatestProject, saveProject } from "./storage";

const project = (name: string) =>
  createProject({
    name,
    width: 8,
    height: 8,
    duration: 1,
    fps: 24,
    videoName: "clip.mp4",
  });
afterEach(() => deleteSavedProject());

describe("local recovery transactions", () => {
  it("orders saves, clear, and a following save in invocation order", async () => {
    const first = project("First"),
      second = project("Second");
    const writes = [
      saveProject(first, new Blob(["old"])),
      deleteSavedProject(),
      saveProject(second, new Blob(["new"])),
    ];
    await Promise.all(writes);
    const saved = await loadLatestProject();
    expect(saved?.project.id).toBe(second.id);
    expect(await saved?.video?.text()).toBe("new");
  });

  it("rolls back clip deletion and insertion when cloning the project fails", async () => {
    const original = project("Original");
    await saveProject(original, new Blob(["original-source"]));
    const invalid = Object.assign(project("Invalid"), {
      notCloneable: () => {},
    });
    await expect(
      saveProject(invalid, new Blob(["replacement-source"])),
    ).rejects.toThrow();
    const saved = await loadLatestProject();
    expect(saved?.project.id).toBe(original.id);
    expect(await saved?.video?.text()).toBe("original-source");
    // A failed write does not poison subsequent saves.
    const next = { ...original, name: "Recovered" };
    await saveProject(next);
    expect((await loadLatestProject())?.project.name).toBe("Recovered");
  });

  it("writes source bytes again after clearing recovery even for the same Blob", async () => {
    const p = project("Restored"),
      source = new Blob(["same-source"]);
    await saveProject(p, source);
    await deleteSavedProject();
    await saveProject(p, source);
    expect(await (await loadLatestProject())?.video?.text()).toBe(
      "same-source",
    );
  });
});
