import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Home } from 'lucide-react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
export function valueOf<T>(reading: D.Reading<T> | undefined): T | undefined { return reading?.kind === 'known' ? reading.value : undefined; }
export function display<T>(reading: D.Reading<T> | undefined, format: (value: T) => string = String) { return reading?.kind === 'known' ? `${format(reading.value)}${reading.freshness === 'stale' ? ' (stale)' : ''}` : 'Not reported'; }
export function ControlCard({ title, children }: { title: string; children: ReactNode }) { return <section className="printer-control-card"><h3 className="text-sm font-semibold">{title}</h3>{children}</section>; }
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
  return <div className="printer-temperature-row"><label className="flex items-center justify-between gap-3 text-sm"><span>{label}<span className="block text-xs text-muted-foreground">{display(current, value => `${value} °C`)}</span></span>
    <span className="flex items-center gap-1"><Input aria-label={`${label} target`} className="printer-temperature-input w-24" type="number" min={limits.min ?? 0} max={limits.max ?? undefined} step="1" value={draft} disabled={disabled} placeholder="—"
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
  const fieldId = useId();
  const topology = valueOf(snapshot?.values.descriptor)?.topology, actuators = valueOf(snapshot?.values.actuators);
  const fans = capabilities.commands['fans.setSpeed'], lights = capabilities.commands['lights.set'];
  return <ControlCard title="Fans and lighting">{!!topology?.fans.length && <details className="printer-actuator-controls"><summary>Fans · {topology.fans.length}</summary><FieldGroup className="gap-2">{topology.fans.map(fan => {
    const limit = fans.kind === 'supported' ? fans.constraints.find(item => item.fanId === fan.id)?.speedFraction : undefined;
    const current = valueOf(actuators?.fans.find(item => item.fanId === fan.id)?.speedFraction);
    const percentage = current === undefined ? -1 : Math.round(current * 100);
    const allowed = (value: number) => value >= 0 && value <= 100 && (!limit || (limit.min === null || value >= limit.min * 100) && (limit.max === null || value <= limit.max * 100));
    const options = [...new Set([...Array.from({ length: 11 }, (_, index) => index * 10), percentage,
      ...(limit?.min === null || limit?.min === undefined ? [] : [Math.ceil(limit.min * 100)]),
      ...(limit?.max === null || limit?.max === undefined ? [] : [Math.floor(limit.max * 100)])])]
      .filter(value => value >= 0 && (value === percentage || allowed(value))).sort((a, b) => a - b);
    const id = `${fieldId}-${fan.id}`;
    const blocked = disabled || !limit;
    const items = [{ value: '-1', label: 'Not reported' }, ...options.map(value => ({ value: String(value), label: `${value}%` }))];
    return <Field key={fan.id} orientation="horizontal" data-disabled={blocked}>
      <FieldLabel htmlFor={id}>{fan.name}</FieldLabel>
      <Select items={items} disabled={blocked} value={String(percentage)}
        onValueChange={value => { if (value !== null) send({ type: 'fans.setSpeed', params: { fanId: fan.id, speedFraction: Number(value) / 100 } }); }}>
        <SelectTrigger id={id} aria-label={`${fan.name} speed`} className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem value="-1" disabled>Not reported</SelectItem>
          {options.map(value => <SelectItem key={value} value={String(value)} disabled={!allowed(value)}>{value}%</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </Field>;
  })}</FieldGroup></details>}
    {!!topology?.lights.length && <details className="printer-actuator-controls"><summary>Lights · {topology.lights.length}</summary>
      <FieldGroup className="gap-2">{topology.lights.map(light => {
        const id = `${fieldId}-${light.id}`;
        const label = light.name.replaceAll('_', ' ');
        const blocked = disabled || lights.kind !== 'supported' || !lights.constraints.lightIds.includes(light.id);
        return <Field key={light.id} orientation="horizontal" data-disabled={blocked}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Checkbox id={id} aria-label={label} disabled={blocked}
            checked={valueOf(actuators?.lights.find(item => item.lightId === light.id)?.on) ?? false}
            onCheckedChange={on => send({ type: 'lights.set', params: { lightId: light.id, on } })} />
        </Field>;
      })}</FieldGroup>
    </details>}
    {!topology?.fans.length && !topology?.lights.length && <p className="text-sm text-muted-foreground">No actuators reported.</p>}</ControlCard>;
}
/** Prefer a short 10 mm move, constrained to the reported range and increment.
 * Unknown bounds/granularity do not establish a safe UI preset; evaluation remains authoritative.
 */
function extrusionDistances(range: D.Range | undefined): number[] {
  if (!range || range.min === null || range.max === null || range.step === null) return [];
  const { min, max, step } = range;
  if (![min, max, step].every(Number.isFinite) || min > max || step <= 0) return [];
  const last = Math.floor((max - min) / step);
  return [-1, 1].flatMap(direction => {
    let index = Math.max(0, Math.min(last, Math.round((direction * 10 - min) / step)));
    let distance = min + index * step;
    if (direction * distance <= 0) {
      index += direction;
      distance = min + index * step;
    }
    distance = Number(distance.toFixed(10));
    return index >= 0 && index <= last && direction * distance > 0 && distance >= min && distance <= max ? [distance] : [];
  });
}
export function MotionCard({ capabilities, snapshot, disabled, send }: CardControls) {
  const stepFieldId = useId();
  const [selectedStep, setStep] = useState<string | null>(null); const home = capabilities.commands['motion.home'], jog = capabilities.commands['motion.jog'], extrusion = capabilities.commands['extrusion.move'];
  const topology = valueOf(snapshot?.values.descriptor)?.topology;
  const activeReading = valueOf(snapshot?.values.status)?.activeToolIds;
  const active = activeReading?.kind === 'known' && activeReading.freshness === 'fresh' ? activeReading.value : undefined;
  const tool = active?.length === 1 ? topology?.tools.find(item => item.id === active[0]) : undefined;
  const limit = tool && extrusion.kind === 'supported' ? extrusion.constraints.find(item => item.extruderId === tool.extruderId) : undefined;
  const distances = extrusionDistances(limit?.distanceMm);
  const speed: D.PrinterCommandSpecs['extrusion.move']['params']['speed'] | undefined = limit?.speed.kind === 'device-controlled'
    ? { kind: 'device-controlled' } : limit?.speed.kind === 'specified' && limit.speed.mmPerSecond.min !== null
      ? { kind: 'specified', mmPerSecond: limit.speed.mmPerSecond.min } : undefined;
  const groups = topology?.motionGroups ?? [];
  const hasAxes = home.kind === 'supported' || jog.kind === 'supported' || capabilities.observations.motion.kind === 'supported';
  const steps = jog.kind === 'supported' ? [...new Map(jog.constraints.flatMap(item => item.kind === 'step' ? item.steps.map(step => [step.id, step] as const) : [])).values()] : [];
  const step = steps.some(item => item.id === selectedStep) ? selectedStep! : steps[0]?.id;
  function move(group: D.Id<'motion'>, axis: D.Axis, direction: 'negative' | 'positive') {
    const limit = jog.kind === 'supported' ? jog.constraints.find(item => item.kind === 'step' && item.motionGroupId === group && item.axis === axis) : undefined;
    if (!limit || limit.kind !== 'step') return null;
    if (!step) return null;
    const supportsStep = limit.steps.some(item => item.id === step);
    return <Button className={`printer-jog printer-jog-${axis}-${direction}`} size="sm" variant="ghost" disabled={disabled || !supportsStep} title={supportsStep ? undefined : 'Selected step is unavailable for this axis'} aria-label={`Move ${axis.toUpperCase()} ${direction}`} onClick={() => send({ type: 'motion.jog', params: { kind: 'step', motionGroupId: group, axis, stepId: step, direction } })}>{direction === 'negative' ? '−' : '+'}{axis.toUpperCase()}</Button>;
  }
  return <div className="printer-motion-controls" data-has-axes={hasAxes}>
    {hasAxes && <section className="printer-axis-controls" aria-label="Motion">
      <h4>Motion</h4>
      {groups.map(group => <div key={group.id} className="printer-axis-group">
        <div className="printer-jog-wheel">
          {move(group.id, 'y', 'positive')}{move(group.id, 'x', 'negative')}{move(group.id, 'x', 'positive')}{move(group.id, 'y', 'negative')}
          {home.kind === 'supported' && home.constraints.filter(item => item.motionGroupId === group.id).map(item => <Button className="printer-home" key={item.motionGroupId} size="icon" variant="secondary" title="Home axes" aria-label="Home axes" disabled={disabled} onClick={() => send({ type: 'motion.home', params: { motionGroupId: item.motionGroupId, axes: item.axes } })}><Home size={20} /></Button>)}
        </div>
        <div className="printer-z-controls"><span>Z axis</span>{move(group.id, 'z', 'negative')}{move(group.id, 'z', 'positive')}</div>
      </div>)}
      {!!steps.length && <Field>
        <FieldLabel id={stepFieldId}>Movement step</FieldLabel>
        <Tabs value={step} onValueChange={value => setStep(String(value))}>
          <TabsList variant="segmented" className="w-full" aria-labelledby={stepFieldId}>
            {steps.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </Field>}
      {!groups.length && <p className="text-xs text-muted-foreground">Waiting for motion information.</p>}
    </section>}
    <section className="printer-tool-controls" aria-label="Extruders"><h4>Extruders</h4>
      <div className="printer-tool"><strong>{tool?.name ?? (active?.length === 0 ? 'No tool mounted' : 'Current tool not reported')}</strong>
        {tool && <span className="text-muted-foreground">Current tool</span>}
        <div className="printer-extrusion-controls">{[-1, 1].map(direction => {
          const distanceMm = distances.find(value => Math.sign(value) === direction);
          const label = direction > 0 ? 'Extrude' : 'Retract';
          return <Button key={label} size="sm" variant="outline" disabled={disabled || !tool || !speed || distanceMm === undefined}
            title={distanceMm === undefined ? 'No supported move reported for the current tool' : `${label} ${Math.abs(distanceMm)} mm`}
            aria-label={tool && distanceMm !== undefined ? `${label} ${Math.abs(distanceMm)} mm with ${tool.name}` : label}
            onClick={() => { if (tool && speed && distanceMm !== undefined) send({ type: 'extrusion.move', params: { extruderId: tool.extruderId, distanceMm, speed } }); }}>
            {direction > 0 ? <ArrowDown size={16} /> : <ArrowUp size={16} />}<span>{label}</span>
          </Button>;
        })}</div>
      </div>
    </section>
  </div>;
}
