import { useEffect, useState } from 'react';
import type { CutGroove } from '@slicer/client';
import type { CutSession } from './CutSession';

export const initialGroove: CutGroove = {
  depth: 1, width: 4, flankAngle: 60, angle: 0, depthTolerance: 0.1, widthTolerance: 0.1, count: 1, gap: 1,
};
export function grooveSpacing(g: CutGroove, radius: number) {
  return g.gap + Math.max(g.width, g.width + 2*g.depth/Math.tan(g.flankAngle*Math.PI/180)) +
    2.25*radius*Math.tan(g.angle*Math.PI/180);
}

function Field({ cut, field, label }: { cut: CutSession; field: keyof CutGroove; label: string }) {
  const value = cut.draft!.groove![field];
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label className="flex justify-between">{label}
    <input aria-label={label} className="w-20 rounded border px-1" type="number" step={field === 'count' ? 1 : 'any'}
      disabled={field === 'gap' && cut.draft!.groove!.count === 1} value={text}
      onFocus={() => cut.begin()} onChange={event => {
        const input = event.currentTarget;
        setText(input.value);
        if (Number.isFinite(input.valueAsNumber)) cut.update({ groove:{ ...cut.draft!.groove!, [field]:input.valueAsNumber } });
      }} onBlur={() => { setText(String(cut.draft?.groove?.[field] ?? value)); cut.finish(); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
  </label>;
}

export function CutGroovePanel({ cut }: { cut: CutSession }) {
  const groove = cut.draft!.groove!;
  return <div className="space-y-1">
    {([['count','Groove count'],['depth','Depth (mm)'],['width','Width (mm)'],['flankAngle','Flank angle (°)'],
      ['angle','Groove angle (°)'],['depthTolerance','Depth tolerance (mm)'],['widthTolerance','Width tolerance (mm)'],
      ['gap','Clear gap (mm)']] as const).map(([field,label]) => <Field key={field} cut={cut} field={field} label={label}/>)}
    {groove.count > 1 && <p>Spacing {grooveSpacing(groove, cut.target!.solidRadius).toFixed(2)} mm</p>}
    <p data-testid="cut-groove-status" role="status">{cut.gestureActive ? 'Editing groove' : cut.groovePreview ?
      cut.groovePreview.error || 'Mating surfaces ready' : 'Computing mating surfaces…'}</p>
  </div>;
}
