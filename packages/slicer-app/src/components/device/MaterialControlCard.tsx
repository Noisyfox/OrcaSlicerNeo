import { Button } from '@/components/ui/button';
import { ControlCard, display, valueOf, type CardControls } from './PrinterControlCards';
/** Hardware topology drives layout; no AMS generation, unit count or tool routing is assumed. */
export function MaterialControlCard({ snapshot, capabilities, disabled, send }: CardControls) {
  const inventory = valueOf(snapshot?.values.materials), sensors = valueOf(snapshot?.values.sensors);
  const load = capabilities.commands['materials.load'], change = capabilities.commands['materials.switch'], unload = capabilities.commands['materials.unload'];
  return <ControlCard title="Material system">{inventory?.topology.units.map(unit => <section className="space-y-2 rounded border p-3" key={unit.id}>
    <h4 className="text-sm font-medium">{unit.name}</h4><div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{unit.sensorIds.map(id => {
      const definition = sensors?.definitions.find(sensor => sensor.id === id), state = sensors?.readings.find(sensor => sensor.sensorId === id);
      return <span key={id}>{definition?.name ?? id}: {display<unknown>(state?.reading, value => typeof value === 'object' ? 'Not reported' : String(value))}{definition?.unit ? ` ${definition.unit}` : ''}</span>;
    })}</div>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{inventory.topology.slots.filter(slot => slot.unitId === unit.id).map(slot => {
      const state = inventory.state.slots.find(item => item.slotId === slot.id), material = valueOf(state?.material), color = material?.color;
      return <div className="space-y-2 rounded border bg-background/50 p-3 text-sm" key={slot.id}>
        <div className="flex items-center gap-2">{color && <span aria-label="Material color" className="inline-block size-4 rounded-full border" style={{ background: color.kind === 'solid' ? color.rgba : `linear-gradient(90deg, ${color.rgba.join(', ')})` }} />}<strong>{slot.name}</strong></div>
        <p>{display(state?.presence)} · {material?.materialType ?? 'Unknown material'}</p>
        {material?.manufacturer && <p className="text-xs text-muted-foreground">{material.manufacturer}</p>}
        <p className="text-xs text-muted-foreground">Remaining: {display(state?.remaining, value => `${value.unit === 'fraction' ? `${Math.round(value.value * 100)}%` : `${value.value} ${value.unit}`} (${value.basis})`)}</p>
        {inventory.topology.paths.filter(path => path.slotId === slot.id).map(path => {
          const tool = inventory.state.tools.find(tool => tool.toolId === path.toolId), loaded = valueOf(tool?.loadedPathId) === path.id;
          const capability = valueOf(tool?.loadedPathId) ? change : load;
          const supported = capability.kind === 'supported' && capability.constraints.pathIds.includes(path.id);
          return <div key={path.id} className="space-y-1"><p className="text-xs">{path.toolId.replace('tool:', 'Tool ')}{loaded ? ' · Loaded' : ''} · {display(tool?.activity)}</p>
            <Button size="sm" variant="secondary" disabled={disabled || !supported || loaded} onClick={() => send({ type: valueOf(tool?.loadedPathId) ? 'materials.switch' : 'materials.load', params: { pathId: path.id } })}>Load to {path.toolId.replace('tool:', 'Tool ')}</Button></div>;
        })}
        {!inventory.topology.paths.some(path => path.slotId === slot.id) && <p className="text-xs text-muted-foreground">No available tool path reported.</p>}
      </div>;
    })}</div>
    {inventory.topology.dryers.filter(dryer => dryer.unitIds.includes(unit.id)).map(dryer => {
      const state = inventory.state.dryers.find(item => item.dryerId === dryer.id);
      return <p key={dryer.id} className="text-xs">{dryer.name}: {display(state?.phase)} · Remaining {display(state?.remainingSeconds, seconds => `${Math.ceil(seconds / 60)} min`)}</p>;
    })}
  </section>)}
    <div className="flex flex-wrap gap-2">{unload.kind === 'supported' && unload.constraints.toolIds.map(toolId => <Button key={toolId} size="sm" variant="outline" disabled={disabled} onClick={() => send({ type: 'materials.unload', params: { toolId } })}>Unload {toolId.replace('tool:', 'Tool ')}</Button>)}</div>
    {!inventory?.topology.units.length && <p className="text-sm text-muted-foreground">No material units reported.</p>}
  </ControlCard>;
}
