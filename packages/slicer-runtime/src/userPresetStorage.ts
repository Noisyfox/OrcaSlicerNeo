import type { UserPresetFile, UserPresetStorage, UserPresetWrite } from '@slicer/client';
import { validateUserPresetPath } from '@slicer/client';

/** One transaction per user action; no account, network, or renderer dependency. */
export function createBrowserUserPresetStorage(factory: IDBFactory = indexedDB): UserPresetStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('orca-user-presets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('default', { keyPath: 'path' });
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opened = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { opened = undefined; reject(request.error); };
    request.onblocked = () => { opened = undefined; reject(new Error('User preset storage is blocked by another tab')); };
  });
  return {
    async load() {
      const db = await database();
      return new Promise<UserPresetFile[]>((resolve, reject) => {
        const tx = db.transaction('default', 'readonly');
        const request = tx.objectStore('default').getAll();
        tx.oncomplete = () => {
          try {
            const files = request.result as UserPresetFile[];
            for (const file of files) {
              validateUserPresetPath(file.path);
              if (typeof file.content !== 'string') throw new Error('Invalid stored user preset');
            }
            resolve(files);
          } catch (error) { reject(error); }
        };
        tx.onabort = () => reject(tx.error ?? new Error('User preset read failed'));
        tx.onerror = () => {};
      });
    },
    async write(change: UserPresetWrite) {
      validateUserPresetPath(change.path);
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('default', 'readwrite');
        const store = tx.objectStore('default');
        if (change.content === null) store.delete(change.path);
        else store.put(change);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('User preset write failed'));
        tx.onerror = () => {};
      });
    },
  };
}
