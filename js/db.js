// IndexedDB 저장소 — 모든 데이터는 이 기기(브라우저) 안에만 저장됩니다.
const DB_NAME = 'wishbox';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = work(store);
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const getAllItems = () => run('readonly', (s) => s.getAll());
export const putItem = (item) => run('readwrite', (s) => s.put(item));
export const deleteItem = (id) => run('readwrite', (s) => s.delete(id));

export function putItems(items) {
  return run('readwrite', (s) => {
    items.forEach((it) => s.put(it));
    return null;
  });
}

// 브라우저가 저장 공간 부족 시 데이터를 지우지 않도록 "영구 저장"을 요청
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* 지원하지 않는 브라우저 */ }
  return false;
}

export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    return { persisted, usage: est?.usage ?? null };
  } catch {
    return { persisted: false, usage: null };
  }
}
