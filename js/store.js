// Minimal IndexedDB wrapper. Two stores: the places FeatureCollection (one row)
// and a key/value settings bag holding the GitHub credentials.

const DB_NAME = 'places-map';
const DB_VERSION = 1;
const PLACES = 'places';
const SETTINGS = 'settings';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PLACES)) db.createObjectStore(PLACES);
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getPlaces   = ()      => tx(PLACES, 'readonly',  s => s.get('current'));
export const setPlaces   = (data)  => tx(PLACES, 'readwrite', s => s.put(data, 'current'));
export const getSetting  = (key)   => tx(SETTINGS, 'readonly',  s => s.get(key));
export const setSetting  = (k, v)  => tx(SETTINGS, 'readwrite', s => s.put(v, k));

export async function getSettings() {
  const keys = ['owner', 'repo', 'path', 'token', 'lastSync', 'placeCount'];
  const out = {};
  for (const k of keys) out[k] = await getSetting(k);
  return out;
}

export async function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj)) await setSetting(k, v);
}
