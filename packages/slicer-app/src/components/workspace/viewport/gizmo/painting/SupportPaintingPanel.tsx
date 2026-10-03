import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { usePaintingController, usePaintingState } from './PaintingProvider';

export function SupportPaintingPanel() {
  const controller = usePaintingController(), state = usePaintingState();
  if (!controller || !state || state.phase === 'closed') return null;
  const idle = state.phase === 'idle', settings = state.settings;
  return <section className="absolute top-14 right-0 flex w-64 flex-col gap-3 rounded-md border bg-card/95 p-3 text-sm shadow-sm" aria-label="Support painting" data-testid="painting-panel" data-phase={state.phase}>
    <div className="flex items-center justify-between"><h2 className="font-semibold">Support painting</h2><Button size="sm" variant="ghost" onClick={() => void controller.close()} disabled={!idle && state.phase !== 'error'} aria-label="Close painting">Close</Button></div>
    <fieldset disabled={!idle}><legend className="mb-2 text-xs text-muted-foreground">Tool</legend>
      <RadioGroup disabled={!idle} value={state.tool} onValueChange={(tool) => controller.setTool(tool as 'circle' | 'sphere' | 'smartFill' | 'gap')} className="grid-cols-2" aria-label="Painting tool">
        {(['circle', 'sphere', 'smartFill', 'gap'] as const).map((tool) => <Label key={tool} className="flex items-center gap-2"><RadioGroupItem value={tool} data-testid={`painting-tool-${tool}`} />{{circle:'Circle',sphere:'Sphere',smartFill:'Smart Fill',gap:'Gap Fill'}[tool]}</Label>)}
      </RadioGroup>
    </fieldset>
    <fieldset><legend className="mb-2 text-xs text-muted-foreground">Support</legend>
      <RadioGroup value={settings.erase ? 'erase' : String(settings.state)} onValueChange={(choice) => controller.setSettings(choice === 'erase' ? { erase: true } : { erase: false, state: Number(choice) })} aria-label="Support action">
        {([['1', 'Enforce'], ['2', 'Block'], ['erase', 'Erase']] as const).map(([value, label]) => <Label key={value} className="flex items-center gap-2"><RadioGroupItem value={value} data-testid={`painting-action-${value}`} />{label}</Label>)}
      </RadioGroup>
    </fieldset>
    <Label className="flex items-center justify-between gap-2">Radius (mm)<Input className="w-24" type="number" aria-label="Radius (mm)" value={settings.radius} min={0.01} step={0.1} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ radius: Number(event.target.value) }); }} /></Label>
    {state.tool === 'smartFill' && <Label className="flex items-center justify-between gap-2">Edge angle (degrees)<Input className="w-24" type="number" aria-label="Edge angle (degrees)" value={settings.angle ?? 30} min={0} max={90} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ angle: Number(event.target.value) }); }} /></Label>}
    {state.tool === 'gap' && <>
      <Label className="flex items-center justify-between gap-2">Gap area (mm²)<Input className="w-24" type="number" aria-label="Gap area (mm²)" value={settings.gapArea} min={0} max={5} step={0.1} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ gapArea: Number(event.target.value) }); }} /></Label>
      <p className="text-xs text-muted-foreground">Object-wide gaps use the lowest neighboring native state, including Auto/Default. Apply commits the highlighted gaps. Overhang restriction applies to Circle, Sphere and Smart Fill; Gap Fill is unrestricted.</p>
      <Button variant="secondary" disabled={!idle} onClick={() => void controller.apply('gap')}>Apply gaps</Button>
    </>}
    <Label className="flex items-center gap-2"><Checkbox disabled={!idle} checked={!!state.highlightEnabled} onCheckedChange={(enabled) => controller.setHighlight(enabled)} />Highlight overhangs</Label>
    <Label className="flex items-center justify-between gap-2">Overhang angle (degrees)<Input className="w-24" type="number" aria-label="Overhang angle (degrees)" value={settings.overhangAngle ?? 0} min={0} max={90} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ overhangAngle: Number(event.target.value) }); }} /></Label>
    <Label className="flex items-center gap-2"><Checkbox disabled={state.tool === 'gap'} checked={settings.restrictToOverhangs} onCheckedChange={(restricted) => controller.setSettings({ restrictToOverhangs: restricted })} />Restrict to overhangs</Label>
    <p className="text-xs text-muted-foreground">Zero disables restriction and highlights all eligible surfaces. Erase restores Auto/Default. Painting does not enable support generation; the existing support settings apply.</p>
    <Button variant="secondary" disabled={!idle} onClick={() => void controller.apply('eraseAll')}>Erase all</Button>
    {state.phase !== 'idle' && <p role="status">{state.phase === 'error' ? 'Recovery required; retry Close.' : 'Processing…'}</p>}
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    <p className="text-xs text-muted-foreground">Shift: erase · Middle/right drag: pan · Ctrl/Cmd + wheel: size · Escape: cancel stroke / close</p>
  </section>;
}
