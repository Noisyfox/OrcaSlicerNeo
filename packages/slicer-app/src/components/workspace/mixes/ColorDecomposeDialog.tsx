import { useEffect, useId, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { ColorDecomposeProposal, ColorDecomposeQuery, FilamentSessionSlot } from '@slicer/client';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FilamentSwatch } from '../FilamentSwatch';

const projectPalette = { value: 'project', label: 'Project materials' } as const;
const standardPalettes = [{ value: 'CMYW', label: 'CMYW' }, { value: 'RYBW', label: 'RYBW' }] as const;

function category(slot: FilamentSessionSlot) {
  if (slot.preset.name.includes('Bambu PLA Basic')) return 'PLA Basic';
  if (slot.preset.name.includes('Bambu PETG Basic')) return 'PETG Basic';
  return slot.materialType;
}

function matchesProjectMaterial(candidate: string, selected: string) {
  return !!candidate && !!selected &&
    (candidate === selected || candidate === `${selected} Basic` || selected === `${candidate} Basic`);
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
  const fieldsId = useId();
  const [material, setMaterial] = useState(category(source));
  const [method, setMethod] = useState<ColorDecomposeQuery['method']>('project');
  const physical = slots.filter((s) => !s.mix);
  const materials = [...new Set([...physical.map(category), 'PLA Basic'])].map(name => ({ value: name, label: name }));
  const palettes = material === 'PLA Basic' ? [projectPalette, ...standardPalettes] : [projectPalette];
  const projectAvailable =
    physical.filter((s) => s.slot !== source.slot && matchesProjectMaterial(category(s), material)).length >= 2;
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
      <DialogContent className="flex max-h-[85vh] w-[min(95vw,28rem)] flex-col text-xs">
        <DialogHeader>
          <DialogTitle>Decompose Color · Slot {source.slot}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto p-1">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <Label htmlFor={`${fieldsId}-material`}>Candidate material</Label>
            <Select
              items={materials}
              disabled={saving}
              value={material}
              onValueChange={(value) => {
                if (value === null) return;
                setMaterial(value);
                setMethod('project');
              }}
            >
              <SelectTrigger id={`${fieldsId}-material`} variant="sidebar" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>{materials.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup>
              </SelectContent>
            </Select>
            <Label htmlFor={`${fieldsId}-palette`}>Palette</Label>
            <Select
              items={palettes}
              disabled={saving}
              value={effectiveMethod}
              onValueChange={(value) => { if (value !== null) setMethod(value); }}
            >
              <SelectTrigger id={`${fieldsId}-palette`} variant="sidebar" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {palettes.map(({ value, label }) => (
                    <SelectItem key={value} value={value} disabled={value === 'project' && !projectAvailable}>{label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {proposal && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {[
                  ['Target', proposal.target],
                  ['Matched', proposal.matched],
                ].map(([label, colour]) => (
                  <span key={label} className="flex items-center gap-1">
                    <FilamentSwatch display={{ mode: 'solid', colors: [colour] }} className="size-6 rounded-sm border" />
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
                  <ul className="list-inside list-disc text-muted-foreground">
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
          {(failure || preview?.error) && <p className="text-destructive" role="alert">{failure || preview?.error}</p>}
        </div>
        <DialogFooter className="shrink-0 flex-wrap">
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
