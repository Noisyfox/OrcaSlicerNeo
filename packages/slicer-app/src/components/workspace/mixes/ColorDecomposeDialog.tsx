import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { ColorDecomposeProposal, ColorDecomposeQuery, FilamentSessionSlot } from '@slicer/client';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

function category(slot: FilamentSessionSlot) {
  return slot.preset.name.includes('Bambu PLA Basic') ? 'PLA Basic' : slot.materialType;
}

export function ColorDecomposeDialog({
  source,
  slots,
  onClose,
  onApply,
}: {
  source: FilamentSessionSlot;
  slots: readonly FilamentSessionSlot[];
  onClose: () => void;
  onApply: (query: ColorDecomposeQuery) => Promise<string | null>;
}) {
  const { runtime } = usePlatform();
  const [material, setMaterial] = useState(category(source));
  const [method, setMethod] = useState<ColorDecomposeQuery['method']>('project');
  const physical = slots.filter((s) => !s.mix);
  const projectAvailable =
    physical.filter((s) => s.slot !== source.slot && category(s) === material).length >= 2;
  const effectiveMethod =
    material === 'PLA Basic' && !projectAvailable && method === 'project' ? 'CMYW' : method;
  const [result, setResult] = useState<{
    material: string;
    method: string;
    value: ColorDecomposeProposal | { error: string };
  }>();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let active = true;
    setFailure('');
    runtime
      .previewColorDecomposition({ source: source.slot, material, method: effectiveMethod })
      .then((value) => {
        if (active) setResult({ material, method: effectiveMethod, value });
      })
      .catch((e) => {
        if (active) setResult({ material, method: effectiveMethod, value: { error: String(e) } });
      });
    return () => {
      active = false;
    };
  }, [source, material, effectiveMethod, runtime, slots]);
  const preview =
    result?.material === material && result.method === effectiveMethod ? result.value : undefined;
  const proposal = preview && 'recipe' in preview ? (preview as ColorDecomposeProposal) : undefined;
  async function apply() {
    setSaving(true);
    try {
      const error = await onApply({ source: source.slot, material, method: effectiveMethod });
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
      <DialogContent className="text-sm">
        <DialogTitle>Decompose Color · Slot {source.slot}</DialogTitle>
        <label>
          Candidate material{' '}
          <select
            disabled={saving}
            value={material}
            onChange={(e) => {
              setMaterial(e.target.value);
              setMethod('project');
            }}
          >
            {[...new Set([...physical.map(category), 'PLA Basic'])].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Palette{' '}
          <select
            disabled={saving}
            value={effectiveMethod}
            onChange={(e) => setMethod(e.target.value as ColorDecomposeQuery['method'])}
          >
            <option value="project" disabled={!projectAvailable}>
              Project materials
            </option>
            {material === 'PLA Basic' && (
              <>
                <option>CMYW</option>
                <option>RYBW</option>
              </>
            )}
          </select>
        </label>
        {proposal && (
          <>
            <div className="flex gap-4">
              {[
                ['Target', proposal.target],
                ['Matched', proposal.matched],
              ].map(([label, colour]) => (
                <span key={label} className="flex items-center gap-1">
                  <i className="size-6 rounded border" style={{ background: colour }} />
                  {label} {colour}
                </span>
              ))}
            </div>
            <p>
              {proposal.recipe.components
                .map((id, i) => `Slot ${id} · ${proposal.recipe.ratios[i]}%`)
                .join(' + ')}
            </p>
            {!!proposal.additions.length && (
              <div>
                <p>Creating this mix will add these physical filaments:</p>
                <ul>
                  {proposal.additions.map((a) => (
                    <li key={a.colour}>
                      {a.name} · {a.colour} · {a.preset}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {(failure || preview?.error) && <p role="alert">{failure || preview?.error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !proposal || !!proposal.error} onClick={() => void apply()}>
            {proposal?.additions.length ? 'Add filaments and create mix' : 'Create mix'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
