import { useEffect, useState } from 'react';
import { Ellipsis, Flame, Pencil } from 'lucide-react';
import type * as D from '@orca/platform-contract';
import { colorSwatchStyle } from '@/components/ui/color-swatch';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ControlCard, display, TemperatureInput, valueOf, type CardControls } from './PrinterControlCards';
import { materialColorSwatch } from './material-color';
/** Reported hardware topology owns unit count, display names and tool routing. */
export function MaterialControlCard({ snapshot, capabilities, disabled, send, onEdit, visible = true }: CardControls & { visible?: boolean; onEdit?: (slot: D.MaterialSlot, material: D.MaterialMetadata | undefined) => void }) {
  const inventory = valueOf(snapshot?.values.materials), sensors = valueOf(snapshot?.values.sensors);
  const tools = valueOf(snapshot?.values.descriptor)?.topology.tools;
  const toolName = (id: string) => tools?.find(tool => tool.id === id)?.name ?? 'Unknown tool';
  const configure = capabilities.commands['materials.configure'], metadata = capabilities.commands['materials.writeMetadata'];
  const load = capabilities.commands['materials.load'], change = capabilities.commands['materials.switch'], unload = capabilities.commands['materials.unload'];
  return <ControlCard title="Material system"><Tabs className="printer-material-tabs" defaultValue="filament">
    <TabsList variant="line" aria-label="Material system">
      <TabsTrigger value="filament">Filament</TabsTrigger><TabsTrigger value="hotend">Hotend</TabsTrigger>
    </TabsList>
    <TabsContent value="hotend"><HotendControls snapshot={snapshot} capabilities={capabilities} disabled={disabled} send={send} visible={visible} /></TabsContent>
    <TabsContent value="filament"><div className="printer-material-units">{inventory?.topology.units.map(unit => <section className="printer-material-unit" data-kind={unit.kind} key={unit.id}>
    <h4 className="text-sm font-medium">{unit.name}</h4><div className="printer-material-sensors">{unit.sensorIds.map(id => {
      const definition = sensors?.definitions.find(sensor => sensor.id === id), state = sensors?.readings.find(sensor => sensor.sensorId === id);
      return <span key={id}>{definition?.name ?? id}: {display<unknown>(state?.reading, value => typeof value === 'object' ? 'Not reported' : String(value))}{definition?.unit ? ` ${definition.unit}` : ''}</span>;
    })}</div>
    <div className="printer-material-slots">{inventory.topology.slots.filter(slot => slot.unitId === unit.id).map(slot => {
      const state = inventory.state.slots.find(item => item.slotId === slot.id), material = valueOf(state?.material), color = material?.color;
      return <div className="printer-material-slot" key={slot.id}>
        <div className="flex items-center justify-between gap-1"><span className="flex min-w-0 items-center gap-1">{color && <span aria-label="Material color" className="printer-material-color" style={colorSwatchStyle(materialColorSwatch(color))} />}<strong>{slot.name}</strong></span>
        {(configure.kind === 'supported' && configure.constraints.some(target => target.slotId === slot.id) || metadata.kind === 'supported' && metadata.constraints.some(target => target.slotId === slot.id)) && <TooltipFor content="Material information" disabled={disabled} nonInteractive><Button size="icon-xs" variant="ghost" className="shrink-0" aria-label={`Material information for ${unit.name} · ${slot.name}`} disabled={disabled} onClick={() => onEdit?.(slot, material ?? undefined)}><Pencil className="size-3" /></Button></TooltipFor>}</div>
        <p className="printer-slot-material">{material?.materialType || 'Unknown material'}</p>
        <details className="printer-slot-details"><summary>Details</summary>
          <p>Presence: {display(state?.presence)}</p>
          {material?.manufacturer && <p>{material.manufacturer}</p>}
          <p>Remaining: {display(state?.remaining, value => `${value.unit === 'fraction' ? `${Math.round(value.value * 100)}%` : `${value.value} ${value.unit}`} (${value.basis})`)}</p>
        </details>
        {inventory.topology.paths.filter(path => path.slotId === slot.id).map(path => {
          const tool = inventory.state.tools.find(tool => tool.toolId === path.toolId), loaded = valueOf(tool?.loadedPathId) === path.id;
          const deviceAdmission = load.kind === 'supported' && load.constraints.admission === 'device';
          const capability = !deviceAdmission && valueOf(tool?.loadedPathId) ? change : load;
          const supported = capability.kind === 'supported' && capability.constraints.pathIds.includes(path.id);
          return <div key={path.id} className="printer-material-path"><p className="text-xs">{toolName(path.toolId)}{loaded ? ' · Loaded' : ''} · {display(tool?.activity)}</p>
            <Button size="sm" variant="secondary" aria-label={`Load to ${toolName(path.toolId)}`} disabled={disabled || !supported || loaded && !deviceAdmission} onClick={() => send({ type: !deviceAdmission && valueOf(tool?.loadedPathId) ? 'materials.switch' : 'materials.load', params: { pathId: path.id } })}>Load</Button></div>;
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
    </TabsContent>
  </Tabs></ControlCard>;
}

/** Card focus only opens its menu. The provider owns physical addressing and supported actions. */
function HotendControls({ snapshot, capabilities, disabled, send, visible }: CardControls & { visible: boolean }) {
  const topology = valueOf(snapshot?.values.descriptor)?.topology;
  const status = valueOf(snapshot?.values.status), reading = status?.activeToolIds;
  const active = reading?.kind === 'known' && reading.freshness === 'fresh' ? reading.value : undefined;
  const select = capabilities.commands['tools.select'], park = capabilities.commands['tools.park'];
  const thermal = capabilities.commands['thermal.setTarget'];
  const sensors = valueOf(snapshot?.values.sensors), targets = valueOf(snapshot?.values.thermal);
  const [temperatureTool, setTemperatureTool] = useState<D.Id<'tool'> | null>(null);
  const [detailsTool, setDetailsTool] = useState<D.Id<'tool'> | null>(null);
  const [action, setAction] = useState<{ command: Extract<D.PrinterCommand, { type: 'tools.select' | 'tools.park' }>; name: string } | null>(null);
  useEffect(() => { if (!visible) setAction(null); }, [visible]);
  return <><div className="printer-hotend-cards">{topology?.tools.map(tool => {
    const nozzle = topology.nozzles.find(nozzle => nozzle.id === tool.nozzleId);
    const heater = topology.heaters.find(heater => heater.id === nozzle?.heaterId);
    const sensor = sensors?.readings.find(sensor => sensor.sensorId === heater?.temperatureSensorId);
    const current = sensor?.kind === 'temperature' ? sensor.reading : undefined;
    const target = targets?.find(target => target.heaterId === heater?.id)?.targetC;
    const limits = thermal.kind === 'supported' ? thermal.constraints.find(item => item.heaterId === heater?.id)?.targetC : undefined;
    const mounted = active?.includes(tool.id) === true;
    const canTake = select.kind === 'supported' && select.constraints.toolIds.includes(tool.id);
    const canPlace = park.kind === 'supported' && park.constraints.toolIds.includes(tool.id);
    return <div className="printer-hotend-card" data-active={mounted} key={tool.id}>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="printer-hotend-trigger" aria-label={`Hotend menu for ${tool.name}`} />}>
        <span className="printer-hotend-heading"><strong>{tool.name}</strong><Ellipsis className="size-4" /></span>
        <span className="printer-hotend-temperature">{display(current, value => `${Math.round(value)}`)} / {display(target, value => `${Math.round(value)} °C`)}</span>
        <Flame className="size-8" /><span>{nozzle?.diameterMm === null || nozzle?.diameterMm === undefined ? 'Diameter not reported' : `${nozzle.diameterMm} mm`}</span>
        <span className="text-muted-foreground">{nozzle?.flowType ?? 'Flow not reported'}</span>
        <span className="printer-hotend-state">{mounted ? 'Mounted' : active === undefined ? 'Mount state not reported' : 'Standby'}</span>
      </DropdownMenuTrigger><DropdownMenuContent>
        {heater && limits && <DropdownMenuItem disabled={disabled} onClick={() => setTemperatureTool(tool.id)}>Set temperature</DropdownMenuItem>}
        {mounted && canPlace ? <DropdownMenuItem disabled={disabled} onClick={() => setAction({ command: { type: 'tools.park', params: { toolId: tool.id } }, name: tool.name })}>Place</DropdownMenuItem>
          : canTake && <DropdownMenuItem disabled={disabled || mounted} onClick={() => setAction({ command: { type: 'tools.select', params: { toolId: tool.id } }, name: tool.name })}>Take</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => setDetailsTool(detailsTool === tool.id ? null : tool.id)}>Details</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      {temperatureTool === tool.id && heater && limits && <TemperatureInput label={`${tool.name} nozzle`} current={current} target={target} limits={limits} disabled={disabled} submit={targetC => send({ type: 'thermal.setTarget', params: { heaterId: heater.id, targetC } })} />}
      {detailsTool === tool.id && <dl className="text-xs"><dt>Nozzle type</dt><dd>{nozzle?.type ?? 'Not reported'}</dd><dt>Material</dt><dd>{nozzle?.constructionMaterial ?? 'Not reported'}</dd></dl>}
    </div>;
  })}</div>{!topology?.tools.length && <p className="text-sm text-muted-foreground">No tools reported.</p>}
    <Dialog open={action !== null} onOpenChange={open => { if (!open) setAction(null); }}>
      {action && <DialogContent>
        <DialogTitle>{action.command.type === 'tools.park' ? 'Place' : 'Take'} {action.name}?</DialogTitle>
        <DialogDescription>The printer may move and home its axes. Keep the toolhead path clear.</DialogDescription>
        <DialogFooter><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
          <Button disabled={disabled || !topology?.tools.some(tool => tool.id === action.command.params.toolId)} onClick={() => { send(action.command); setAction(null); }}>Confirm</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </>;
}
