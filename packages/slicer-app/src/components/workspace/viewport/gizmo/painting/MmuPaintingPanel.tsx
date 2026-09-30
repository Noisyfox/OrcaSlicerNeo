import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { usePaintingController, usePaintingState } from './PaintingProvider';
import type { PaintTool } from './PaintingController';

const tools: readonly [PaintTool, string][] = [['circle', 'Circle'], ['sphere', 'Sphere'], ['triangle', 'Triangle'], ['height', 'Height range'], ['region', 'Region fill'], ['gap', 'Gap fill']];
export function MmuPaintingPanel() {
  const controller = usePaintingController(), state = usePaintingState();
  const slots = useFilamentSessionStore((s) => s.snapshot?.slots ?? []);
  if (!controller || !state || state.phase === 'closed') return null;
  const idle = state.phase === 'idle', s = state.settings;
  return <section className="absolute top-14 right-3 flex w-64 flex-col gap-3 rounded-md border bg-card/95 p-3 text-sm shadow-sm" aria-label="Surface painting" data-testid="painting-panel" data-phase={state.phase}>
    <div className="flex items-center justify-between"><h2 className="font-semibold">Surface painting</h2><Button size="sm" variant="ghost" onClick={() => void controller.close()} disabled={!idle && state.phase !== 'error'} aria-label="Close painting">Close</Button></div>
    <fieldset disabled={!idle}><legend className="mb-2 text-xs text-muted-foreground">Tool</legend>
      <RadioGroup disabled={!idle} value={state.tool} onValueChange={(v) => controller.setTool(v as PaintTool)} className="grid-cols-2 gap-2" aria-label="Painting tool">
        {tools.map(([tool, label]) => <Label key={tool} className="flex items-center gap-2"><RadioGroupItem value={tool} data-testid={`painting-tool-${tool}`} />{label}</Label>)}
      </RadioGroup>
    </fieldset>
    {state.tool !== 'gap' && <fieldset><legend className="mb-2 text-xs text-muted-foreground">Filament</legend>
      <RadioGroup value={String(s.state)} onValueChange={(v) => controller.setSettings({ state: Number(v) })} className="grid-cols-4 gap-2" aria-label="Painting filament">
        {slots.slice(0, 16).map((slot) => <Label key={slot.slot} className="flex items-center gap-1" title={slot.preset.name}><RadioGroupItem value={String(slot.slot)} /><span className="size-3 rounded-full border" style={{ backgroundColor: slot.colour.effective }} /><span className="sr-only">Paint filament </span>{slot.slot}</Label>)}
      </RadioGroup>
      {slots.length > 16 && <p className="mt-2 text-xs text-muted-foreground">Explicit painting supports filaments 1–16. Unpainted areas keep their assigned material.</p>}
    </fieldset>}
    {(state.tool === 'circle' || state.tool === 'sphere') && <NumberSetting label="Radius (mm)" value={s.radius} min={0.01} step={0.1} change={(radius) => controller.setSettings({ radius })} />}
    {state.tool === 'height' && <NumberSetting label="Height (mm)" value={s.height} min={0.01} step={0.1} change={(height) => controller.setSettings({ height })} />}
    {state.tool === 'region' && <>
      <Label className="flex items-center gap-2"><Checkbox checked={s.angle !== null} onCheckedChange={(enabled) => controller.setSettings({ angle: enabled ? 30 : null })} />Detect geometry edges</Label>
      {s.angle !== null && <NumberSetting label="Edge angle (degrees)" value={s.angle} min={0} max={90} step={1} change={(angle) => controller.setSettings({ angle })} />}
    </>}
    {state.tool === 'gap' ? <>
      <NumberSetting label="Gap area (mm²)" value={s.gapArea} min={0} max={5} step={0.1} change={(gapArea) => controller.setSettings({ gapArea })} />
      <Button disabled={!idle} onClick={() => void controller.apply('gap')}>Apply gap fill</Button>
    </> : <Label className="flex items-center gap-2"><Checkbox checked={s.erase} onCheckedChange={(erase) => controller.setSettings({ erase })} />Erase (unpainted)</Label>}
    <Button variant="secondary" disabled={!idle} onClick={() => void controller.apply('eraseAll')}>Erase all</Button>
    {state.phase !== 'idle' && <p role="status">{state.phase === 'error' ? 'Recovery required; retry Close.' : 'Processing…'}</p>}
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    <p className="text-xs text-muted-foreground">Shift: erase · Ctrl/Cmd + wheel: size · Escape: cancel stroke / close</p>
  </section>;
}
function NumberSetting({ label, value, min, max, step, change }: { label: string; value: number; min: number; max?: number; step: number; change(value: number): void }) {
  return <Label className="flex items-center justify-between gap-2">{label}<Input className="w-24" type="number" aria-label={label} value={value} min={min} max={max} step={step} onChange={(e) => { if (e.target.value !== '') change(Number(e.target.value)); }} /></Label>;
}
