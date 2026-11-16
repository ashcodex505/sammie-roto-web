import type { Project } from "./types";

type SavedProject = { project: Project; video?: Blob };
const DB_NAME = "sammie-roto-local-v1";
const STORE = "workspace";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(
        new Error(
          "Local recovery is unavailable in this browser. Export a project archive to keep your work.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open local storage."));
    request.onblocked = () =>
      reject(
        new Error("Close other Sammie Roto tabs so local storage can update."),
      );
  });
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error(
            "Local save failed. Your browser storage may be full. Export an archive now.",
          ),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local save was interrupted."));
  });
  // A request can reject before its transaction settles. Keep that later rejection
  // observed even when the caller has already left through the request's error.
  void done.catch(() => {});
  return done;
}
let saveQueue: Promise<void> = Promise.resolve();
let lastSource: Blob | undefined;
let lastSourceId: string | undefined;
function queueWrite(write: () => Promise<void>): Promise<void> {
  const task = saveQueue.catch(() => {}).then(write);
  saveQueue = task;
  return task;
}
/** Clip bytes have their own IDB key: autosave does not clone a large video with every edit. */
export function saveProject(project: Project, video?: Blob): Promise<void> {
  return queueWrite(async () => {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const done = committed(transaction);
      const store = transaction.objectStore(STORE);
      try {
        const previous = await requestValue<Project | SavedProject | undefined>(
          store.get("latest"),
        );
        const previousId =
          previous && "project" in previous
            ? previous.project.id
            : previous?.id;
        if (previousId && previousId !== project.id)
          store.delete(`video:${previousId}`);
        if (video && (video !== lastSource || lastSourceId !== project.id))
          store.put(video, `video:${project.id}`);
        store.put(project, "latest");
        await done;
      } catch (error) {
        // In particular, a synchronous clone failure must roll back any source
        // deletion or insertion already scheduled in this transaction.
        try {
          transaction.abort();
        } catch {
          /* already finished */
        }
        await done.catch(() => {});
        throw error;
      }
      if (video) {
        lastSource = video;
        lastSourceId = project.id;
      }
    } finally {
      db.close();
    }
  });
}
export async function loadLatestProject(): Promise<SavedProject | null> {
  await saveQueue.catch(() => {});
  const db = await openDatabase();
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const saved = await requestValue<Project | SavedProject | undefined>(
      store.get("latest"),
    );
    if (!saved) return null;
    if ("project" in saved) return saved; // recovery from early local builds
    const video = await requestValue<Blob | undefined>(
      store.get(`video:${saved.id}`),
    );
    return { project: saved, video };
  } finally {
    db.close();
  }
}
export function deleteSavedProject(): Promise<void> {
  return queueWrite(async () => {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const done = committed(transaction);
      transaction.objectStore(STORE).clear();
      await done;
      lastSource = undefined;
      lastSourceId = undefined;
    } finally {
      db.close();
    }
  });
}
