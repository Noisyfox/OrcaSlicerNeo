import { colorSwatchStyle } from '@/components/ui/color-swatch';
import { Button } from '@/components/ui/button';
import { ControlCard, display, valueOf, type CardControls } from './PrinterControlCards';
/** Reported hardware topology owns unit count, display names and tool routing. */
export function MaterialControlCard({ snapshot, capabilities, disabled, send }: CardControls) {
  const inventory = valueOf(snapshot?.values.materials), sensors = valueOf(snapshot?.values.sensors);
  const tools = valueOf(snapshot?.values.descriptor)?.topology.tools;
  const toolName = (id: string) => tools?.find(tool => tool.id === id)?.name ?? 'Unknown tool';
  const load = capabilities.commands['materials.load'], change = capabilities.commands['materials.switch'], unload = capabilities.commands['materials.unload'];
  return <ControlCard title="Material system"><div className="printer-material-units">{inventory?.topology.units.map(unit => <section className="printer-material-unit" data-kind={unit.kind} key={unit.id}>
    <h4 className="text-sm font-medium">{unit.name}</h4><div className="printer-material-sensors">{unit.sensorIds.map(id => {
      const definition = sensors?.definitions.find(sensor => sensor.id === id), state = sensors?.readings.find(sensor => sensor.sensorId === id);
      return <span key={id}>{definition?.name ?? id}: {display<unknown>(state?.reading, value => typeof value === 'object' ? 'Not reported' : String(value))}{definition?.unit ? ` ${definition.unit}` : ''}</span>;
    })}</div>
    <div className="printer-material-slots">{inventory.topology.slots.filter(slot => slot.unitId === unit.id).map(slot => {
      const state = inventory.state.slots.find(item => item.slotId === slot.id), material = valueOf(state?.material), color = material?.color;
      return <div className="printer-material-slot" key={slot.id}>
        <div className="flex items-center gap-2">{color && <span aria-label="Material color" className="printer-material-color" style={colorSwatchStyle(color.kind === 'solid' ? { mode: 'solid', colors: [color.rgba] }
          : { mode: color.appearance === 'parallel' ? 'multicolor' : 'gradient', colors: color.rgba })} />}<strong>{slot.name}</strong></div>
        <p className="printer-slot-material">{material?.materialType || 'Unknown material'}</p>
        <details className="printer-slot-details"><summary>Details</summary>
          <p>Presence: {display(state?.presence)}</p>
          {material?.manufacturer && <p>{material.manufacturer}</p>}
          <p>Remaining: {display(state?.remaining, value => `${value.unit === 'fraction' ? `${Math.round(value.value * 100)}%` : `${value.value} ${value.unit}`} (${value.basis})`)}</p>
        </details>
        {inventory.topology.paths.filter(path => path.slotId === slot.id).map(path => {
          const tool = inventory.state.tools.find(tool => tool.toolId === path.toolId), loaded = valueOf(tool?.loadedPathId) === path.id;
          const capability = valueOf(tool?.loadedPathId) ? change : load;
          const supported = capability.kind === 'supported' && capability.constraints.pathIds.includes(path.id);
          return <div key={path.id} className="printer-material-path"><p className="text-xs">{toolName(path.toolId)}{loaded ? ' · Loaded' : ''} · {display(tool?.activity)}</p>
            <Button size="sm" variant="secondary" aria-label={`Load to ${toolName(path.toolId)}`} disabled={disabled || !supported || loaded} onClick={() => send({ type: valueOf(tool?.loadedPathId) ? 'materials.switch' : 'materials.load', params: { pathId: path.id } })}>Load</Button></div>;
        })}
        {!inventory.topology.paths.some(path => path.slotId === slot.id) && <p className="text-xs text-muted-foreground">No available tool path reported.</p>}
      </div>;
    })}</div>
    {inventory.topology.dryers.filter(dryer => dryer.unitIds.includes(unit.id)).map(dryer => {
      const state = inventory.state.dryers.find(item => item.dryerId === dryer.id);
      return <p key={dryer.id} className="text-xs">{dryer.name}: {display(state?.phase)} · Remaining {display(state?.remainingSeconds, seconds => `${Math.ceil(seconds / 60)} min`)}</p>;
    })}
  </section>)}</div>
    <div className="flex flex-wrap gap-2">{unload.kind === 'supported' && unload.constraints.toolIds.map(toolId => <Button key={toolId} size="sm" variant="outline" disabled={disabled} onClick={() => send({ type: 'materials.unload', params: { toolId } })}>Unload {toolName(toolId)}</Button>)}</div>
    {!inventory?.topology.units.length && <p className="text-sm text-muted-foreground">No material units reported.</p>}
  </ControlCard>;
}
