// Persistent IndexedDB cache for rendered creation thumbnails.
//
// Rendering a thumbnail is expensive (a Supabase Storage download for meshes,
// or an OpenSCAD compile for parametric models, plus a WebGL render). Without
// a persistent cache this work would repeat on every page load — and the
// sidebar mounts on every page, so at scale that is a large amount of
// needless storage egress and CPU. Caching the small final image locally
// makes repeat visits essentially free for the backend.
//
// Dependency-free and SSR/prerender-safe: all access is guarded behind
// runtime checks and failures degrade gracefully to "no cache".

const DB_NAME = 'azurefilm-thumbnails';
const STORE_NAME = 'thumbnails';
const DB_VERSION = 1;

export interface CachedThumbnail {
  // The conversation's updated_at when this thumbnail was rendered. Used to
  // invalidate the cache when the conversation changes (e.g. a new generation).
  updatedAt: string;
  // The compressed thumbnail data URL, or null if the conversation has no
  // renderable creation (cached so we don't re-query messages for it).
  dataUrl: string | null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function getCachedThumbnail(
  key: string,
): Promise<CachedThumbnail | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () =>
        resolve((request.result as CachedThumbnail | undefined) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedThumbnail(
  key: string,
  value: CachedThumbnail,
): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
