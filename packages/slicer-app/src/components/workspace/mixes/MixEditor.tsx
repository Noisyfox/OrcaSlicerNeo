import { useEffect, useId, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type {
  FilamentSessionSlot,
  MixedFilamentRecipe,
  MixedFilamentPreview,
  MixedFilamentRecommendation,
} from '@slicer/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { type ColorSwatchDisplay } from '@/components/ui/color-swatch';
import { FilamentChoiceContent, FilamentSwatch, filamentSlotChoice } from '../FilamentSwatch';
import { GradientControls, PercentageInput, RatioTriangle, setRatio } from './RecipeControls';

const defaultRecipe: MixedFilamentRecipe = {
  components: [1, 2],
  ratios: [50, 50],
  gradient: false,
  reverse: false,
  perPart: false,
  points: [],
};
export function mixSwatchDisplay(colour: string, ramp: readonly string[]): ColorSwatchDisplay {
  return ramp.length > 1 ? { mode: 'gradient', colors: ramp } : { mode: 'solid', colors: [colour] };
}

const componentCounts = [{ value: 2, label: 'Two' }, { value: 3, label: 'Three' }];

export function MixEditor({
  slots,
  initial,
  onClose,
  onSave,
}: {
  slots: readonly FilamentSessionSlot[];
  initial?: MixedFilamentRecipe;
  onClose: () => void;
  onSave: (recipe: MixedFilamentRecipe) => Promise<string | null>;
}) {
  const { runtime } = usePlatform();
  const fieldsId = useId();
  const [draft, setDraft] = useState(initial ?? defaultRecipe);
  const [result, setResult] = useState<{
    draft: MixedFilamentRecipe;
    slots: readonly FilamentSessionSlot[];
    preview: MixedFilamentPreview | { error: string };
  }>();
  const [suggestions, setSuggestions] = useState<MixedFilamentRecommendation[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const physical = slots.filter((s) => !s.mix);
  const physicalOptions = physical.map(slot => ({
    value: slot.slot,
    ...filamentSlotChoice(slot),
    materialType: slot.materialType,
  }));
  const size = draft.components.length === 3 ? 3 : 2;
  useEffect(() => {
    let active = true;
    runtime
      .previewMixedFilament(draft)
      .then((preview) => {
        if (active) setResult({ draft, slots, preview });
      })
      .catch((e) => {
        if (active) setResult({ draft, slots, preview: { error: String(e) } });
      });
    return () => {
      active = false;
    };
  }, [runtime, draft, slots]);
  useEffect(() => {
    let active = true;
    runtime
      .getMixRecommendations(size)
      .then((items) => {
        if (active) setSuggestions(items);
      })
      .catch(() => {
        if (active) setSuggestions([]);
      });
    return () => {
      active = false;
    };
  }, [size, runtime, slots]);
  function patch(value: Partial<MixedFilamentRecipe>) {
    setFailure('');
    setDraft((d) => ({ ...d, ...value }));
  }
  const preview = result?.preview;
  const validPreview = preview && 'colour' in preview ? preview : undefined;
  const previewIsCurrent = result?.draft === draft && result.slots === slots;
  async function save() {
    setSaving(true);
    try {
      const error = await onSave(draft);
      if (error) setFailure(error);
      else onClose();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[min(95vw,28rem)] flex-col text-xs">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit mix' : 'Create mix'}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto p-1">
          <fieldset disabled={saving} className="grid min-w-0 gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${fieldsId}-count`}>Components</Label>
              <Select
                items={componentCounts}
                disabled={saving}
                value={size}
                onValueChange={(value) => {
                  if (value === null) return;
                  const three = value === 3;
                  const ids = draft.components.slice(0, 2);
                  if (three) ids.push(physical.find((s) => !ids.includes(s.slot))?.slot ?? 0);
                  patch({ ...defaultRecipe, components: ids, ratios: three ? [50, 25, 25] : [50, 50] });
                }}
              >
                <SelectTrigger id={`${fieldsId}-count`} variant="sidebar" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectGroup>
                    {componentCounts.map(({ value, label }) => (
                      <SelectItem key={value} value={value} disabled={value === 3 && physical.length < 3}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {draft.components.map((id, i) => {
              const physicalOption = physicalOptions.find(option => option.value === id);
              const selected = physicalOption ?? { value: id, label: 'Missing filament', display: null, materialType: '' };
              const options = physicalOption ? physicalOptions : [selected, ...physicalOptions];
              return <div key={i} className="flex items-center gap-2">
                <Select
                  items={options}
                  disabled={saving}
                  value={id}
                  onValueChange={(value) => {
                    if (value === null) return;
                    patch({ components: draft.components.map((slot, j) => i === j ? value : slot) });
                  }}
                >
                  <SelectTrigger variant="sidebar" className="min-w-0 flex-1" aria-label={`Component ${i + 1}`}
                    title={selected.materialType ? `${selected.label} (${selected.materialType})` : selected.label}>
                    <SelectValue className="flex! items-center gap-2">
                      <FilamentChoiceContent display={selected.display} label={<span className="truncate">{selected.label}</span>} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      {options.map(({ value, label, display, materialType }) => (
                        <SelectItem key={value} value={value} title={materialType ? `${label} (${materialType})` : label}>
                          <FilamentChoiceContent display={display} label={label} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {!draft.gradient && (
                  <div className="flex shrink-0 items-center gap-1">
                    <PercentageInput
                      label={`Percentage ${i + 1}`}
                      value={draft.ratios[i]}
                      min={10}
                      max={size === 2 ? 90 : 80}
                      onChange={(n) => patch({ ratios: setRatio(draft.ratios, i, n) })}
                    />
                    <span aria-hidden="true">%</span>
                  </div>
                )}
              </div>;
            })}
            {!draft.gradient &&
              (size === 2 ? (
                <Slider
                  aria-label="Mix ratio"
                  min={10}
                  max={90}
                  value={[draft.ratios[0]]}
                  disabled={saving}
                  onValueChange={(value) => patch({
                    ratios: setRatio(draft.ratios, 0, typeof value === 'number' ? value : value[0]),
                  })}
                />
              ) : (
                <RatioTriangle
                  ratios={draft.ratios}
                  colours={draft.components.map((id) => slots[id - 1]?.colour.effective ?? 'transparent')}
                  disabled={saving}
                  onChange={(ratios) => patch({ ratios })}
                />
              ))}
            {size === 2 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${fieldsId}-gradient`}
                  checked={draft.gradient}
                  disabled={saving}
                  onCheckedChange={(gradient) =>
                    patch({ gradient, points: [], perPart: false, reverse: false })
                  }
                />
                <Label htmlFor={`${fieldsId}-gradient`}>Z gradient</Label>
              </div>
            )}
            {draft.gradient && (
              <GradientControls
                recipe={draft}
                samples={validPreview?.samples ?? []}
                disabled={saving}
                onChange={patch}
              />
            )}
            {!!suggestions.length && (
              <fieldset>
                <legend>Recommended mixes</legend>
                <div className="flex max-h-20 flex-wrap gap-1 overflow-auto">
                  {suggestions.map((s) => {
                    const label = s.components.map((v, i) => `Slot ${v} · ${s.ratios[i]}%`).join(', ');
                    return (
                      <Button
                        key={label}
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="p-0"
                        title={label}
                        aria-label={label}
                        onClick={() => patch({ ...defaultRecipe, components: s.components, ratios: s.ratios })}
                      >
                        <FilamentSwatch className="size-full rounded-sm" display={{ mode: 'solid', colors: [s.colour] }} />
                      </Button>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <div aria-busy={!previewIsCurrent}>
              {preview && 'error' in preview ? (
                <p className="text-destructive" role="alert">{preview.error}</p>
              ) : validPreview ? (
                <div role="img" aria-label="Mix preview">
                  <FilamentSwatch className="block h-7 rounded border" display={mixSwatchDisplay(validPreview.colour, validPreview.ramp)} />
                </div>
              ) : (
                <div aria-hidden="true" className="h-7 rounded border bg-control-background" />
              )}
            </div>
          </fieldset>
          {failure && <p className="mt-2 text-destructive" role="alert">{failure}</p>}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !previewIsCurrent || !validPreview} onClick={() => void save()}>
            Save mix
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
