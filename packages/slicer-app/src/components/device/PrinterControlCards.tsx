import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function valueOf<T>(reading: D.Reading<T> | undefined): T | undefined { return reading?.kind === 'known' ? reading.value : undefined; }
export function display<T>(reading: D.Reading<T> | undefined, format: (value: T) => string = String) { return reading?.kind === 'known' ? `${format(reading.value)}${reading.freshness === 'stale' ? ' (stale)' : ''}` : 'Not reported'; }
export function ControlCard({ title, children }: { title: string; children: ReactNode }) { return <section className="space-y-3 rounded-lg border bg-card p-4"><h3 className="text-sm font-semibold">{title}</h3>{children}</section>; }
export interface CardControls { capabilities: D.PrinterCapabilities; snapshot: D.PrinterSnapshot | null; disabled: boolean; send(command: D.PrinterCommand): void }
/** Enter and blur share one submission path, bound to the target by the parent's keyed lifetime. */
export function TemperatureInput({ label, current, target, limits, disabled, submit }: { label: string; current?: D.Reading<number>; target?: D.Reading<number>; limits: D.Range; disabled: boolean; submit(value: number): void }) {
  const reported = valueOf(target), [draft, setDraft] = useState(reported === undefined ? '' : String(reported));
  const [validation, setValidation] = useState<string | null>(null);
  const editing = useRef(false), sent = useRef<string | null>(null), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!editing.current) { setDraft(reported === undefined ? '' : String(reported)); sent.current = null; } }, [reported]);
  const commit = () => {
    if (!live.current || disabled || !draft.trim()) return;
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 0 || limits.min !== null && value < limits.min || limits.max !== null && value > limits.max) { setValidation(`Enter a whole temperature from ${limits.min ?? 0} to ${limits.max ?? 'the supported maximum'} °C.`); return; }
    setValidation(null); if (value === reported || sent.current === draft) return;
    sent.current = draft; submit(value);
  };
  return <div><label className="flex items-center justify-between gap-3 text-sm"><span>{label}<span className="block text-xs text-muted-foreground">{display(current, value => `${value} °C`)}</span></span>
    <span className="flex items-center gap-1"><Input aria-label={`${label} target`} className="w-24" type="number" min={limits.min ?? 0} max={limits.max ?? undefined} step="1" value={draft} disabled={disabled} placeholder="—"
      onFocus={() => { editing.current = true; }} onChange={event => { setValidation(null); sent.current = null; setDraft(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } }} onBlur={() => { editing.current = false; commit(); }} /><span>°C</span></span></label>{validation && <p role="alert" className="mt-1 text-xs text-destructive">{validation}</p>}</div>;
}
export function ThermalCard({ capabilities, snapshot, disabled, send }: CardControls) {
  const topology = valueOf(snapshot?.values.descriptor)?.topology;
  const thermal = valueOf(snapshot?.values.thermal), sensors = valueOf(snapshot?.values.sensors);
  const c = capabilities.commands['thermal.setTarget'];
  return <ControlCard title="Temperature">{topology?.heaters.length ? topology.heaters.map(heater => {
    const sensor = sensors?.readings.find(sensor => sensor.sensorId === heater.temperatureSensorId);
    const limits = c.kind === 'supported' ? c.constraints.find(item => item.heaterId === heater.id)?.targetC : undefined;
    const target = thermal?.find(item => item.heaterId === heater.id)?.targetC;
    return limits ? <TemperatureInput key={heater.id} label={heater.name} current={sensor?.kind === 'temperature' ? sensor.reading : undefined} target={target} limits={limits} disabled={disabled}
      submit={targetC => send({ type: 'thermal.setTarget', params: { heaterId: heater.id, targetC } })} /> : <p className="text-sm" key={heater.id}>{heater.name}: {sensor?.kind === 'temperature' ? display(sensor.reading, value => `${value} °C`) : 'Not reported'}</p>;
  }) : <p className="text-sm text-muted-foreground">Waiting for heater information.</p>}</ControlCard>;
}
export function ActuatorCard({ capabilities, snapshot, disabled, send }: CardControls) {
  const topology = valueOf(snapshot?.values.descriptor)?.topology, actuators = valueOf(snapshot?.values.actuators);
  const fans = capabilities.commands['fans.setSpeed'], lights = capabilities.commands['lights.set'];
  return <ControlCard title="Fans and lighting">{topology?.fans.map(fan => {
    const limit = fans.kind === 'supported' ? fans.constraints.find(item => item.fanId === fan.id)?.speedFraction : undefined;
    const current = valueOf(actuators?.fans.find(item => item.fanId === fan.id)?.speedFraction);
    const percentage = current === undefined ? -1 : Math.round(current * 100);
    const allowed = (value: number) => value >= 0 && value <= 100 && (!limit || (limit.min === null || value >= limit.min * 100) && (limit.max === null || value <= limit.max * 100));
    const options = [...new Set([...Array.from({ length: 11 }, (_, index) => index * 10), percentage,
      ...(limit?.min === null || limit?.min === undefined ? [] : [Math.ceil(limit.min * 100)]),
      ...(limit?.max === null || limit?.max === undefined ? [] : [Math.floor(limit.max * 100)])])]
      .filter(value => value >= 0 && (value === percentage || allowed(value))).sort((a, b) => a - b);
    return <label key={fan.id} className="flex items-center justify-between gap-3 text-sm"><span>{fan.name}</span>
      <select aria-label={`${fan.name} speed`} className="rounded border bg-background p-1" disabled={disabled || !limit} value={String(percentage)}
        onChange={event => send({ type: 'fans.setSpeed', params: { fanId: fan.id, speedFraction: Number(event.target.value) / 100 } })}>
        <option value="-1" disabled>Not reported</option>{options.map(value => <option key={value} value={value} disabled={!allowed(value)}>{value}%</option>)}</select></label>;
  })}
    {topology?.lights.map(light => <label key={light.id} className="flex items-center justify-between text-sm"><span>{light.name.replaceAll('_', ' ')}</span><input type="checkbox" aria-label={light.name.replaceAll('_', ' ')} disabled={disabled || lights.kind !== 'supported' || !lights.constraints.lightIds.includes(light.id)} checked={valueOf(actuators?.lights.find(item => item.lightId === light.id)?.on) ?? false} onChange={event => send({ type: 'lights.set', params: { lightId: light.id, on: event.target.checked } })} /></label>)}
    {!topology?.fans.length && !topology?.lights.length && <p className="text-sm text-muted-foreground">No actuators reported.</p>}</ControlCard>;
}
export function MotionCard({ capabilities, snapshot, disabled, send }: CardControls) {
  const [step, setStep] = useState('small'); const home = capabilities.commands['motion.home'], jog = capabilities.commands['motion.jog'], extrusion = capabilities.commands['extrusion.move'], tools = capabilities.commands['tools.select'];
  const topology = valueOf(snapshot?.values.descriptor)?.topology;
  return <ControlCard title="Motion and tools"><div className="flex flex-wrap items-center gap-2">
    {home.kind === 'supported' && home.constraints.map(group => <Button key={group.motionGroupId} size="sm" variant="secondary" disabled={disabled} onClick={() => send({ type: 'motion.home', params: { motionGroupId: group.motionGroupId, axes: group.axes } })}>Home axes</Button>)}
    {jog.kind === 'supported' && <><select aria-label="Movement step" className="rounded border bg-background p-1 text-sm" value={step} onChange={event => setStep(event.target.value)}>{jog.constraints.find(item => item.kind === 'step')?.steps.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      {jog.constraints.filter(item => item.kind === 'step').map(item => <span key={`${item.motionGroupId}:${item.axis}`} className="inline-flex gap-1">{(['negative', 'positive'] as const).map(direction => <Button size="sm" variant="outline" disabled={disabled} key={direction} aria-label={`Move ${item.axis.toUpperCase()} ${direction}`} onClick={() => send({ type: 'motion.jog', params: { kind: 'step', motionGroupId: item.motionGroupId, axis: item.axis, stepId: step, direction } })}>{item.axis.toUpperCase()}{direction === 'positive' ? '+' : '−'}</Button>)}</span>)}</>}
  </div>
    {topology?.tools.map(tool => <div key={tool.id} className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-16">{tool.name}</span>
      {tools.kind === 'supported' && tools.constraints.toolIds.includes(tool.id) && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => send({ type: 'tools.select', params: { toolId: tool.id } })}>Select {tool.name}</Button>}
      {extrusion.kind === 'supported' && extrusion.constraints.some(item => item.extruderId === tool.extruderId && item.speed.kind === 'device-controlled') && [-10, 10].map(distanceMm => <Button size="sm" variant="outline" disabled={disabled} key={distanceMm} onClick={() => send({ type: 'extrusion.move', params: { extruderId: tool.extruderId, distanceMm, speed: { kind: 'device-controlled' } } })}>{distanceMm > 0 ? 'Extrude' : 'Retract'} 10 mm</Button>)}
    </div>)}
    {!topology?.tools.length && <p className="text-sm text-muted-foreground">Waiting for motion information.</p>}</ControlCard>;
}
