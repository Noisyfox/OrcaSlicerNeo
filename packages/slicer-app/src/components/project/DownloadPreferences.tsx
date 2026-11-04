import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';

/** One host-owned download location for every printer agent. Filesystem paths stay private. */
export function DownloadPreferences() {
  const downloads = usePlatform().printers.downloads;
  const [folder, setFolder] = useState('');
  const [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (downloads.capability.kind === 'supported') {
      setLoaded(false); setError(null);
      void downloads.directory().then(result => {
        if (!active) return;
        if (result.ok) { setFolder(result.value.label); setLoaded(true); }
        else setError(result.error.message);
      }).catch(() => { if (active) setError('The download folder could not be loaded.'); });
    }
    return () => { active = false; mounted.current = false; };
  }, [downloads, attempt]);
  const choose = async () => {
    setSaving(true); setError(null);
    try {
      const result = await downloads.chooseDirectory();
      if (!mounted.current) return;
      if (result.ok) { if (result.value.status === 'selected') setFolder(result.value.label); }
      else setError(result.error.message);
    } catch { if (mounted.current) setError('The download folder could not be saved.'); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <section aria-label="Downloads" className="flex flex-col gap-2 border-t pt-3">
    <h3 className="font-medium">Downloads</h3>
    {downloads.capability.kind === 'supported' ? <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Default download folder</span>
        <output aria-label="Default download folder" className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={folder}>{loaded ? folder : error ? 'Unavailable' : 'Loading…'}</output>
        <Button variant="outline" disabled={!loaded || saving} onClick={() => void choose()}>Change…</Button>
      </div>
      <p className="text-sm text-muted-foreground">Used for downloads from all printer agents. Changes are saved immediately.</p>
      {error && <div className="flex items-center gap-2"><p role="alert" className="text-sm text-destructive">{error}</p>
        {!loaded && <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button>}</div>}
    </> : <p className="text-sm text-muted-foreground">The download location is managed by your browser.</p>}
  </section>;
}
