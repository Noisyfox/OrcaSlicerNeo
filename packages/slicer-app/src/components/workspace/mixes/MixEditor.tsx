import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type {
  FilamentSessionSlot,
  MixedFilamentRecipe,
  MixedFilamentPreview,
  MixedFilamentRecommendation,
} from '@slicer/client';
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GradientControls, PercentageInput, RatioTriangle, setRatio } from './RecipeControls';

const defaultRecipe: MixedFilamentRecipe = {
  components: [1, 2],
  ratios: [50, 50],
  gradient: false,
  reverse: false,
  perPart: false,
  points: [],
};
export function mixBackground(colour: string, ramp: readonly string[]) {
  return ramp.length > 1 ? `linear-gradient(to right, ${ramp.join(', ')})` : colour;
}

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
  const [draft, setDraft] = useState(initial ?? defaultRecipe);
  const [result, setResult] = useState<{
    draft: MixedFilamentRecipe;
    preview: MixedFilamentPreview | { error: string };
  }>();
  const [suggestions, setSuggestions] = useState<MixedFilamentRecommendation[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const physical = slots.filter((s) => !s.mix);
  const size = draft.components.length === 3 ? 3 : 2;
  useEffect(() => {
    let active = true;
    runtime
      .previewMixedFilament(draft)
      .then((preview) => {
        if (active) setResult({ draft, preview });
      })
      .catch((e) => {
        if (active) setResult({ draft, preview: { error: String(e) } });
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
  const preview = result?.draft === draft ? result.preview : undefined;
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
      <DialogContent className="max-h-[90vh] overflow-y-auto text-sm">
        <DialogTitle>{initial ? 'Edit mix' : 'Create mix'}</DialogTitle>
        <fieldset disabled={saving} className="grid gap-3">
          <label>
            Components{' '}
            <select
              aria-label="Components"
              value={size}
              onChange={(e) => {
                const three = e.target.value === '3';
                const ids = draft.components.slice(0, 2);
                if (three) ids.push(physical.find((s) => !ids.includes(s.slot))?.slot ?? 0);
                patch({ ...defaultRecipe, components: ids, ratios: three ? [50, 25, 25] : [50, 50] });
              }}
            >
              <option value="2">Two</option>
              <option value="3" disabled={physical.length < 3}>
                Three
              </option>
            </select>
          </label>
          {draft.components.map((id, i) => (
            <div key={i} className="flex gap-2">
              <select
                className="min-w-0 flex-1"
                aria-label={`Component ${i + 1}`}
                value={id}
                onChange={(e) =>
                  patch({
                    components: draft.components.map((v, j) => (i === j ? Number(e.target.value) : v)),
                  })
                }
              >
                {!physical.some((s) => s.slot === id) && <option value={id}>Missing filament</option>}
                {physical.map((s) => (
                  <option key={s.logicalId} value={s.slot}>
                    {s.slot} · {s.preset.label} ({s.materialType})
                  </option>
                ))}
              </select>
              {!draft.gradient && (
                <label>
                  <PercentageInput
                    label={`Percentage ${i + 1}`}
                    value={draft.ratios[i]}
                    min={10}
                    max={size === 2 ? 90 : 80}
                    onChange={(n) => patch({ ratios: setRatio(draft.ratios, i, n) })}
                  />{' '}
                  %
                </label>
              )}
            </div>
          ))}
          {!draft.gradient &&
            (size === 2 ? (
              <input
                type="range"
                aria-label="Mix ratio"
                min="10"
                max="90"
                value={draft.ratios[0]}
                onChange={(e) => patch({ ratios: setRatio(draft.ratios, 0, Number(e.target.value)) })}
              />
            ) : (
              <RatioTriangle
                ratios={draft.ratios}
                colours={draft.components.map((id) => slots[id - 1]?.colour.effective ?? 'transparent')}
                onChange={(ratios) => patch({ ratios })}
              />
            ))}
          {size === 2 && (
            <label>
              <input
                type="checkbox"
                checked={draft.gradient}
                onChange={(e) =>
                  patch({ gradient: e.target.checked, points: [], perPart: false, reverse: false })
                }
              />{' '}
              Z gradient
            </label>
          )}
          {draft.gradient && (
            <GradientControls
              recipe={draft}
              samples={result && 'samples' in result.preview ? result.preview.samples : []}
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
                    <button
                      key={label}
                      type="button"
                      className="size-6 rounded border"
                      title={label}
                      aria-label={label}
                      style={{ background: s.colour }}
                      onClick={() => patch({ ...defaultRecipe, components: s.components, ratios: s.ratios })}
                    />
                  );
                })}
              </div>
            </fieldset>
          )}
          {preview &&
            ('error' in preview ? (
              <p role="alert">{preview.error}</p>
            ) : (
              <div
                aria-label="Mix preview"
                className="h-7 rounded border"
                style={{ background: mixBackground(preview.colour, preview.ramp) }}
              />
            ))}
        </fieldset>
        {failure && <p role="alert">{failure}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !preview || 'error' in preview} onClick={() => void save()}>
            Save mix
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
