import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/** Application-wide storage policy, stored separately from per-printer print options. */
export function PrinterStoragePreferences() {
  const repository = usePlatform().printers.configuration;
  const [value, setValue] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void repository.load().then(document => {
      if (active) { setValue(document.allowAbnormalStorage ?? false); setLoaded(true); }
    }).catch(() => { if (active) setError('Could not load storage preferences. Reopen Preferences to retry.'); });
    return () => { active = false; mounted.current = false; };
  }, [repository]);

  async function change(next: boolean) {
    if (!loaded || saving) return;
    const previous = value;
    setValue(next); setSaving(true); setError(null);
    try {
      const document = await repository.load();
      await repository.save({ ...document, allowAbnormalStorage: next });
    } catch {
      if (mounted.current) { setValue(previous); setError('Could not save the storage preference. Try changing it again.'); }
    } finally { if (mounted.current) setSaving(false); }
  }

  return <section aria-label="Developer" className="flex flex-col gap-2 border-t pt-3">
    <h3 className="font-medium">Developer</h3>
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Storage</legend>
      <div className="flex items-center gap-2">
        <Checkbox id="allow-abnormal-storage" checked={value} disabled={!loaded || saving}
          onCheckedChange={checked => void change(checked === true)} aria-describedby="allow-abnormal-storage-description" />
        <Label htmlFor="allow-abnormal-storage">Allow Abnormal Storage</Label>
      </div>
      <p id="allow-abnormal-storage-description" className="text-sm text-muted-foreground">Allow printing with storage marked abnormal by the printer. This can cause printing problems. Changes are saved immediately.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </fieldset>
  </section>;
}
