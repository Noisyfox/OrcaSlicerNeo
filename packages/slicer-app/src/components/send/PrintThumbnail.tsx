import { useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import type { PrintRequirements, PrintMaterialBinding, PrintMaterialSource } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, SlicerClient } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useObjectListStore } from '../workspace/objectList/useObjectListStore';
import { glVolumeCollection } from '../workspace/viewport/GLVolume';
import { projectPlateThumbnail } from '../workspace/plateThumbnailScene';
import { createThumbnailRenderer, PlateThumbnailService } from '../workspace/plateThumbnailService';


type ThumbnailInputs = {
  requirements: PrintRequirements | null;
  bindings: readonly PrintMaterialBinding[];
  candidates?: readonly PrintMaterialSource[];
  runtime: Pick<SlicerClient, 'previewMixedFilament'>;
};

export async function mappedThumbnailRack(rack: FilamentSessionSnapshot, { requirements, bindings, candidates, runtime }: ThumbnailInputs) {
  const overrides = new Map<number, string>();
  for (const material of requirements?.materials ?? []) {
    const path = bindings.find(b => b.materialKey === material.key)?.pathId;
    const colour = candidates?.find(c => c.materialKey === material.key && c.pathId === path)?.color;
    if (colour && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(colour)) overrides.set(material.index + 1, colour);
  }
  if (!overrides.size) return rack;
  const slots = await Promise.all(rack.slots.map(async slot => {
    let colour = overrides.get(slot.slot);
    if (slot.mix && !slot.mix.error && slot.mix.components.some(id => overrides.has(id))) {
      const colours = slot.mix.components.map(id => overrides.get(id) ?? rack.slots[id - 1].colour.effective);
      const preview = await runtime.previewMixedFilament(slot.mix, colours);
      if ('colour' in preview) colour = preview.colour;
    }
    return colour ? { ...slot, colour: { ...slot.colour, effective: colour } } : slot;
  }));
  return { ...rack, slots };
}

export function PrintThumbnail({ requirements, bindings, candidates, runtime }: ThumbnailInputs) {
  const [image, setImage] = useState<{ plateId: string; url: string }>();
  const session = usePlateSessionStore(s => s.snapshot);
  const rack = useFilamentSessionStore(s => s.snapshot);
  const plateId = requirements?.plateId;
  useEffect(() => {
    if (!plateId || !session || !rack) return;
    let active = true;
    const renderer = createThumbnailRenderer(), service = new PlateThumbnailService(renderer.render);
    const render = async () => {
      const filaments = await mappedThumbnailRack(rack, { requirements, bindings, candidates, runtime });
      if (!active) return;
      const projection = projectPlateThumbnail(plateId, glVolumeCollection.volumes,
        useObjectListStore.getState().structure, session, filaments);
      if (!projection.parts.length) return;
      const url = await service.request(plateId, projection.key, projection.parts, 256);
      if (active && url) setImage({ plateId, url });
    };
    void render().catch(() => { if (active) setImage(undefined); });
    return () => { active = false; service.dispose(); renderer.dispose(); };
  }, [plateId, requirements, bindings, candidates, runtime, session, rack]);
  return <div className="flex aspect-square w-full items-center justify-center" data-testid="print-job-thumbnail">
    {image && image.plateId === plateId ? <img src={image.url} alt="Print model preview" className="size-full object-contain" />
      : <Box className="size-24 text-muted-foreground/40" aria-label="Model preview unavailable" strokeWidth={1} />}
  </div>;
}
