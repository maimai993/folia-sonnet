// test/manual/issue125-inject-invalid-embedded-cover.js
// Paste into the Folia DevTools console to corrupt one local song cover for issue #125 testing.

(async () => {
  const DB_NAME = 'KineticPlayerDB';
  const DB_VERSION = 5;
  const STORE = 'local_music';

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });

  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  const songs = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });

  const target =
    songs.find(song => song?.embeddedCover instanceof Blob) ||
    songs.find(Boolean);

  if (!target) {
    db.close();
    throw new Error('[issue125] No local songs found in IndexedDB.');
  }

  target.embeddedCover = {
    __issue125InvalidEmbeddedCover: true,
    size: target.embeddedCover?.size ?? 12345,
    type: target.embeddedCover?.type ?? 'image/png',
    note: 'Plain object injected to reproduce URL.createObjectURL overload failure.',
  };

  store.put(target);

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  db.close();
  window.dispatchEvent(new CustomEvent('folia-local-music-updated'));

  console.warn('[issue125] injected invalid embeddedCover', {
    id: target.id,
    fileName: target.fileName,
    embeddedCoverIsBlob: target.embeddedCover instanceof Blob,
    nextStep: 'Open Local Music > All Songs. Before the fix this should reproduce createObjectURL Overload resolution failed.',
  });
})();
