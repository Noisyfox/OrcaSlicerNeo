import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { usePaintingController, usePaintingState } from './PaintingProvider';

export function SeamPaintingPanel() {
  const controller = usePaintingController(), state = usePaintingState();
  if (!controller || !state || state.phase === 'closed') return null;
  const idle = state.phase === 'idle', settings = state.settings;
  return <section className="absolute top-14 right-0 flex w-64 flex-col gap-3 rounded-md border bg-card/95 p-3 text-sm shadow-sm" aria-label="Seam painting" data-testid="painting-panel" data-phase={state.phase}>
    <div className="flex items-center justify-between"><h2 className="font-semibold">Seam painting</h2><Button size="sm" variant="ghost" onClick={() => void controller.close()} disabled={!idle && state.phase !== 'error'} aria-label="Close painting">Close</Button></div>
    <fieldset disabled={!idle}><legend className="mb-2 text-xs text-muted-foreground">Tool</legend>
      <RadioGroup disabled={!idle} value={state.tool} onValueChange={(tool) => controller.setTool(tool as 'circle' | 'sphere')} className="grid-cols-2" aria-label="Painting tool">
        {(['circle', 'sphere'] as const).map((tool) => <Label key={tool} className="flex items-center gap-2"><RadioGroupItem value={tool} data-testid={`painting-tool-${tool}`} />{tool === 'circle' ? 'Circle' : 'Sphere'}</Label>)}
      </RadioGroup>
    </fieldset>
    <fieldset><legend className="mb-2 text-xs text-muted-foreground">Seam</legend>
      <RadioGroup value={settings.erase ? 'erase' : String(settings.state)} onValueChange={(choice) => controller.setSettings(choice === 'erase' ? { erase: true } : { erase: false, state: Number(choice) })} aria-label="Seam action">
        {([['1', 'Enforce'], ['2', 'Block'], ['erase', 'Erase']] as const).map(([value, label]) => <Label key={value} className="flex items-center gap-2"><RadioGroupItem value={value} data-testid={`painting-action-${value}`} />{label}</Label>)}
      </RadioGroup>
    </fieldset>
    <Label className="flex items-center justify-between gap-2">Radius (mm)<Input className="w-24" type="number" aria-label="Radius (mm)" value={settings.radius} min={0.01} step={0.1} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ radius: Number(event.target.value) }); }} /></Label>
    <Label className="flex items-center gap-2"><Checkbox checked={settings.vertical} onCheckedChange={(vertical) => controller.setSettings({ vertical })} />Vertical</Label>
    <Button variant="secondary" disabled={!idle} onClick={() => void controller.apply('eraseAll')}>Erase all</Button>
    {state.phase !== 'idle' && <p role="status">{state.phase === 'error' ? 'Recovery required; retry Close.' : 'Processing…'}</p>}
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    <p className="text-xs text-muted-foreground">Shift: erase · Middle/right drag: pan · Ctrl/Cmd + wheel: size · Escape: cancel stroke / close</p>
  </section>;
}
