import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useObjectListStore } from '@/components/workspace/objectList/useObjectListStore';
import { useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { commitScopedConfigurationMutation } from '../../../settings/configurationActions';
import { fuzzyConfigurationProjection, fuzzyModeLabel, fuzzyModeKnown } from './fuzzyConfiguration';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { usePaintingController, usePaintingState } from './PaintingProvider';

export function FuzzyPaintingPanel() {
  const controller = usePaintingController(), state = usePaintingState();
  const platform = usePlatform();
  const structure = useObjectListStore(s => s.structure);
  const configuration = useSettingsStore();
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  if (!controller || !state || state.phase === 'closed') return null;
  const idle = state.phase === 'idle', settings = state.settings;
  const effective = fuzzyConfigurationProjection(state.session, configuration.metadata, configuration.baseValues, configuration.nativeScopedConfig, structure);
  const disabledParts = effective.filter(part => part.field?.value === 'disabled_fuzzy');
  const unknown = configuration.nativeScopedConfigRefreshRequired || effective.length === 0 || effective.some(part => !fuzzyModeKnown(part.field?.value));
  const enable = async () => {
    if (!idle || enabling || unknown || !state.session) return;
    const objectId = state.session.objectId;
    setEnabling(true); setConfigurationError(null);
    try { await commitScopedConfigurationMutation(platform, { version: 1, operation: 'set', targets: [{ scope: 'object', id: objectId }], key: 'fuzzy_skin', value: 'none' }); }
    catch (error) { setConfigurationError(error instanceof Error ? error.message : String(error)); }
    finally { setEnabling(false); }
  };
  return <section className="flex min-w-0 flex-col gap-3 text-sm" aria-label="Fuzzy skin painting" data-testid="painting-panel" data-phase={state.phase}>
    <div className="flex items-center justify-between"><h2 className="text-module font-semibold">Fuzzy skin painting</h2><Button size="sm" variant="ghost" onClick={() => void controller.close()} disabled={!idle && state.phase !== 'error'} aria-label="Close painting">Close</Button></div>
    <fieldset disabled={!idle}><legend className="mb-2 text-module text-muted-foreground">Tool</legend>
      <RadioGroup disabled={!idle} value={state.tool} onValueChange={(tool) => controller.setTool(tool as 'circle' | 'sphere' | 'triangle' | 'smartFill')} className="grid-cols-2" aria-label="Painting tool">
        {(['circle', 'sphere', 'triangle', 'smartFill'] as const).map((tool) => <Label key={tool} className="flex items-center gap-2"><RadioGroupItem value={tool} data-testid={`painting-tool-${tool}`} />{{circle:'Circle',sphere:'Sphere',triangle:'Triangle',smartFill:'Smart Fill'}[tool]}</Label>)}
      </RadioGroup>
    </fieldset>
    <fieldset><legend className="mb-2 text-module text-muted-foreground">Fuzzy</legend>
      <RadioGroup value={settings.erase ? 'erase' : String(settings.state)} onValueChange={(choice) => controller.setSettings(choice === 'erase' ? { erase: true } : { erase: false, state: Number(choice) })} aria-label="Fuzzy skin action">
        {([['1', 'Enable'], ['erase', 'Erase']] as const).map(([value, label]) => <Label key={value} className="flex items-center gap-2"><RadioGroupItem value={value} data-testid={`painting-action-${value}`} />{label}</Label>)}
      </RadioGroup>
    </fieldset>
    <Label className="flex items-center justify-between gap-2">Radius (mm)<Input className="w-24" type="number" aria-label="Radius (mm)" value={settings.radius} min={0.01} step={0.1} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ radius: Number(event.target.value) }); }} /></Label>
    {state.tool === 'smartFill' && <Label className="flex items-center justify-between gap-2">Edge angle (degrees)<Input className="w-24" type="number" aria-label="Edge angle (degrees)" value={settings.angle ?? 30} min={0} max={90} onChange={(event) => { if (event.target.value !== '') controller.setSettings({ angle: Number(event.target.value) }); }} /></Label>}
    {unknown && <p role="status">Effective fuzzy configuration is unavailable.</p>}
    {!unknown && disabledParts.length > 0 && <p role="status" data-testid="fuzzy-disabled-warning">Fuzzy skin is disabled for {disabledParts.length === effective.length ? 'this object' : 'some parts or modifier regions'}. Annotations on disabled parts will not produce fuzzy texture. More-specific part overrides still apply after enabling the object.</p>}
    <p className="text-xs text-muted-foreground" data-testid="fuzzy-effective-configuration">{unknown ? 'Unavailable' : effective.map(part => `${part.modifier ? 'Modifier: ' : ''}${part.name}: ${fuzzyModeLabel(part.field?.value, configuration.metadata)} (${part.field?.source ?? 'unavailable'})`).join(' · ')}</p>
    <Button variant="secondary" disabled={!idle || enabling || unknown} onClick={() => void enable()}>Enable painted fuzzy skin</Button>
    {configurationError && <p role="alert" className="text-destructive">{configurationError}</p>}
    <p className="text-xs text-muted-foreground">Erase removes painted enablement; whole-surface fuzzy modes remain active.</p>
    <Button variant="secondary" disabled={!idle} onClick={() => void controller.apply('eraseAll')}>Erase all</Button>
    {state.phase !== 'idle' && <p role="status">{state.phase === 'error' ? 'Recovery required; retry Close.' : 'Processing…'}</p>}
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    <p className="text-xs text-muted-foreground">Shift: erase · Middle/right drag: pan · Ctrl/Cmd + wheel: size · Escape: cancel stroke / close</p>
  </section>;
}
