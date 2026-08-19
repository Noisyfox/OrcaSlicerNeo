import { normalizeUserPreferences, type PlatformCapabilities, type SlicerRuntime } from '@orca/platform-contract';

export function createBrowserAdapter(runtime: SlicerRuntime): PlatformCapabilities {
  return {
    models: { pick: pickModel },
    exports: { save: downloadGcode },
    preferences: {
      async load() { try { return normalizeUserPreferences(JSON.parse(localStorage.getItem('orca-slicer-neo:preferences') ?? 'null')); } catch { return normalizeUserPreferences(null); } },
      async save(value) { try { localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify(normalizeUserPreferences(value))); } catch { /* ephemeral fallback */ } },
    },
    runtime,
    profiles: { resolve: (relativePath) => {
      const Url = globalThis.URL;
      return new Url(relativePath, new Url(import.meta.env.BASE_URL, String(import.meta.url))).href;
    } },
    chrome: { kind: 'web', platform: navigator.platform },
  };
}

export function pickModel(): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.stl,.3mf'; input.hidden = true;
    const cleanup = () => input.remove();
    input.onchange = async () => { const file = input.files?.[0]; if (!file) { cleanup(); return resolve(null); } resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); cleanup(); };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
    document.body.append(input); input.click();
  });
}

export async function downloadGcode(defaultName: string, bytes: Uint8Array): Promise<void> {
  const href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = href; link.download = defaultName.endsWith('.gcode') ? defaultName : `${defaultName}.gcode`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
