import type { PlatformCapabilities } from '@orca/platform-contract';

/** Resources belong to one catalogue opening, including failed-read deduplication. */
export function createWizardImageSession(runtime: Pick<PlatformCapabilities['runtime'], 'readFilesystemFile'>) {
  const requests = new Map<string, Promise<string | null>>();
  const urls = new Set<string>();
  let disposed = false;
  return {
    load(path: string): Promise<string | null> {
      if (disposed || !path) return Promise.resolve(null);
      const previous = requests.get(path);
      if (previous) return previous;
      const request = (async () => {
        try {
          const bytes = await runtime.readFilesystemFile(path);
          if (disposed) return null;
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {
            type: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          }));
          urls.add(url);
          return url;
        } catch { return null; }
      })();
      requests.set(path, request);
      return request;
    },
    dispose() {
      disposed = true;
      urls.forEach(url => URL.revokeObjectURL(url));
      urls.clear(); requests.clear();
    },
  };
}
export type WizardImageSession = ReturnType<typeof createWizardImageSession>;
