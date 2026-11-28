import type { CutConnector } from '@slicer/client';
import { Button } from '@/components/ui/button';
import type { CutSession } from './CutSession';

export function CutConnectorPanel({ cut }: { cut: CutSession }) {
  const { items, selected } = cut.editor!;
  const current = items[selected];
  return <section aria-label="Cut connectors" data-testid="cut-connectors" className="space-y-2 text-sm">
    <h2 className="text-module font-semibold">Connectors</h2>
    <p>Click the plane to add a connector. Drag a connector to move it.</p>
    {current && <>
      <label>Connector <select value={selected} onChange={e => cut.selectConnector(Number(e.target.value))}>
        {items.map((c,i) => <option key={i} value={i}>{i+1} · {c.type}</option>)}</select></label>
      <label className="flex justify-between">Type <select value={current.type} onChange={e => {
        const type = e.target.value as CutConnector['type'];
        cut.changeConnector(type === 'snap' ? { type, shape:'circle', style:'prism' } : { type });
      }}>{['plug','dowel','snap'].map(v => <option key={v}>{v}</option>)}</select></label>
      {(['shape','style'] as const).map(key => <label key={key} className="flex justify-between">{key === 'shape' ? 'Shape' : 'Style'}
        <select value={current[key]} disabled={current.type === 'snap'} onChange={e => cut.changeConnector({ [key]:e.target.value })}>
          {(key === 'shape' ? ['triangle','square','hexagon','circle'] : ['prism','frustum']).map(v =>
            <option key={v}>{v}</option>)}</select></label>)}
      {([['diameter','Diameter (mm)'],['depth','Depth (mm)'],['diameterTolerance','Diameter tolerance (mm)'],
        ['depthTolerance','Depth tolerance (mm)'],['angle','Rotation (°)']] as const).map(([key,label]) =>
        <label key={key} className="flex justify-between">{label}
          <input className="w-20 rounded border px-1" type="number" step="any" value={current[key]}
            onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) cut.changeConnector({ [key]:e.target.valueAsNumber }); }}/>
        </label>)}
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => cut.removeConnectors(false)}>Remove</Button>
        <Button size="sm" variant="outline" onClick={() => cut.removeConnectors(true)}>Remove all</Button></div>
    </>}
    {!!cut.invalidConnectors?.length && <p role="alert">Outside the usable section or overlapping: {cut.invalidConnectors.map(i => i+1).join(', ')}</p>}
    <div className="flex gap-2"><Button size="sm" disabled={!cut.connectorsReady} onClick={() => cut.endConnectorEdit(true)}>Confirm</Button>
      <Button size="sm" variant="outline" onClick={() => cut.endConnectorEdit(false)}>Cancel</Button></div>
  </section>;
}
