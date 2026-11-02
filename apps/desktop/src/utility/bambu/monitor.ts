import type { BambuDeviceContext, CommandContext } from './controlContext';
import type { NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuDeviceAccess } from './deviceAccess';
import type { BambuObjectSkipping } from './objectSkipping';
import { BambuRecovery } from './recovery';
import { commandCapabilities } from './commands';
import { BambuMaterialSettings } from './materialSettings';

/** Assembles business projections over the shared device-access owner. */
export class BambuMonitor {
  private readonly recovery = new BambuRecovery();
  private readonly materials: BambuMaterialSettings;
  constructor(private readonly access: BambuDeviceAccess,
    private readonly objectSkipping: Pick<BambuObjectSkipping, 'projectContext' | 'snapshotContext' | 'readCatalogue'>) { this.materials = new BambuMaterialSettings(access); }
  private projectContext(base: BambuDeviceContext): CommandContext {
    const context = this.recovery.decorate(base);
    return { ...context, objectSkipping: this.objectSkipping.projectContext(base), calibrationHistory: this.materials.history(base) };
  }
  private snapshotContext(base: BambuDeviceContext): CommandContext {
    const context = this.recovery.snapshotContext(base);
    return { ...context, objectSkipping: this.objectSkipping.snapshotContext(base), calibrationHistory: this.materials.history(base) };
  }
  async context(target: D.PrinterTarget): Promise<D.Result<CommandContext>> {
    const result = await this.access.context(target);
    return result.ok ? { ok: true, value: this.snapshotContext(result.value) } : result;
  }
  async describe(target: D.PrinterTarget): Promise<D.Result<D.PrinterDescription>> {
    const result = await this.access.read({ target, topics: ['descriptor'], source: 'cache' });
    if (!result.ok) return result;
    return { ok: true, value: { target, configurationRevision: result.value.configurationRevision,
      capabilities: commandCapabilities(this.snapshotContext(result.value.context)), descriptor: result.value.values.descriptor } };
  }
  async read<K extends D.StateTopic>(request: D.ObservationRequest<K> & { source: 'cache' | 'device' }, readId?: string): Promise<D.Result<D.PrinterSnapshot<K>>> {
    if (request.source === 'device' && request.topics.some(topic => topic === 'printObjects')) {
      const result = await this.objectSkipping.readCatalogue(request.target, readId);
      if (!result.ok) return result;
      if (request.topics.length === 1) return { ok: true, value: { target: request.target,
        configurationRevision: result.value.value.contextRef.configurationRevision, values: Object.fromEntries([['printObjects', result.value]]) as D.ObservationValues<K> } };
    }
    const result = await this.access.read(request);
    if (!result.ok) return result;
    const { context: base, ...snapshot } = result.value;
    const context = this.snapshotContext(base);
    const values = Object.fromEntries(request.topics.map(topic => {
      if (topic === 'printObjects') {
        const template = context.values.status.printStatus.phase;
        return [topic, context.objectSkipping && template.kind === 'known' ? { ...template, value: context.objectSkipping.snapshot } : { kind: 'unknown', reason: 'unavailable' }];
      }
      const reading = snapshot.values[topic];
      return [topic, reading?.kind === 'known' ? { ...reading, value: context.values[topic] } : reading];
    })) as D.ObservationValues<K>;
    return { ok: true, value: { ...snapshot, values } };
  }
  acquire(target: D.PrinterTarget) { return this.access.acquire(target); }
  async prepareMaterials(target: D.PrinterTarget, params: D.PrinterCommandSpecs['materials.configure']['params']) {
    await this.materials.prepare(target, params);
    return this.context(target);
  }
  close() { this.materials.close(); }
  start(target: D.PrinterTarget, token: string) { return this.access.start(target, token); }
  stop(token: string) { return this.access.stop(token); }
  dispatch<T>(target: D.PrinterTarget, work: (context: CommandContext, send: (section: string, fields: Record<string, unknown>, qos: number) => Promise<number>) => Promise<D.Result<T>>): Promise<D.Result<T>> {
    return this.access.dispatch(target, (context, send) => work(this.projectContext(context), send));
  }
  onEvent(event: NativeEvent) {
    const context = this.access.onEvent(event);
    this.materials.onEvent(event);
    if (context) this.projectContext(context);
  }
}
