import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { updateUserPreferences, usePlatform } from '@orca/platform-contract';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { SceneInteractionController } from '../../SceneInteractionController';

export function MixedLayerHeightWarning({ scene }: { scene: SceneInteractionController }) {
  const platform = usePlatform();
  const subscribe = useCallback((notify: () => void) => scene.subscribe(notify), [scene]);
  const editor = useSyncExternalStore(subscribe, () => scene.gizmo === 'layer-height');
  const enabled = useSettingsStore(s => ['1', 'true'].includes(s.values.enable_mixed_color_sublayer));
  const previous = useRef({ enabled, editor: false });
  const [visible, setVisible] = useState(false);
  const [suppress, setSuppress] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const entered = editor && !previous.current.editor;
    const activated = enabled && !previous.current.enabled;
    previous.current = { enabled, editor };
    if (!enabled || (!entered && !activated)) return;
    let current = true;
    async function check() {
      const prefs = await platform.preferences.load();
      if (!current || prefs.suppressMixedLayerHeightWarning) return;
      if (!entered) {
        const model = await platform.runtime.getModelStructure();
        if (!model.ok) throw new Error(model.error);
        if (!model.objects.some(object => object.hasVariableLayerHeight)) return;
      }
      if (current) { setSuppress(false); setError(''); setVisible(true); }
    }
    void check().catch(reason => { if (current) useSlicerStore.getState().setError(String(reason)); });
    return () => { current = false; };
  }, [enabled, editor, platform]);

  async function acknowledge() {
    if (saving) return;
    setSaving(true);
    try {
      if (suppress) await updateUserPreferences(platform.preferences, prefs => ({ ...prefs, suppressMixedLayerHeightWarning: true }));
      setVisible(false);
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  }
  if (!visible) return null;
  return <Dialog open onOpenChange={open => { if (!open) void acknowledge(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Variable layer height</DialogTitle>
        <DialogDescription>Using variable layer height together with mixed color sublayer may result in poor color mixing quality.</DialogDescription>
      </DialogHeader>
      <Label><Checkbox checked={suppress} onCheckedChange={setSuppress} disabled={saving} />Do not show again</Label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button disabled={saving} onClick={() => void acknowledge()}>OK</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
