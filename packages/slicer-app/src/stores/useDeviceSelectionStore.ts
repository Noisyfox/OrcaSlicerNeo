import { create } from 'zustand';
import { deviceGroupingContext, synchronizationSource, type SynchronizationSource } from '@orca/printer-control';
import type { DeviceMaterialContext } from '@slicer/client';
import type * as D from '@orca/printer-control/domain';
type Connection = { target: D.PrinterTarget; configurationRevision: D.Revision; identity: D.PrinterIdentity };
/** Device selection and page navigation have separate callers and lifetimes. */
export const useDeviceSelectionStore = create<{
  currentPrinterId: string | null;
  requestedPrinterId: string | null;
  selectionRequestVersion: number;
  navigationRequestVersion: number;
  connection: Connection | null;
  materials: SynchronizationSource | null;
  connectionOwner: object | null;
  groupingSource: Connection | null;
  groupingContext: DeviceMaterialContext | null;
  groupingVersion: number;
  groupingReading: string | null;
  groupingFailedReading: string | null;
  groupingPullFailed: boolean;
  selectGroupingSource(printer: D.SavedPrinter | null, route: D.PrinterRoute | null): void;
  publishGrouping(snapshot: D.PrinterSnapshot, acquired?: boolean): void;
  failGroupingPull(target: D.PrinterTarget, configurationRevision: string): void;
  publishConnection(owner: object, snapshot: D.PrinterSnapshot): void;
  clearConnection(owner: object): void;
  setCurrent(id: string | null): void;
  selectPrinter(id: string): void;
  showPrinter(id: string): void;
}>((set, get) => ({
  currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0,
  connection: null, connectionOwner: null, materials: null,
  groupingSource: null, groupingContext: null, groupingVersion: 0, groupingReading: null, groupingFailedReading: null, groupingPullFailed: false,
  selectGroupingSource: (printer, route) => set(state => {
    const source: Connection | null = printer && route
      ? { target: { printerId: printer.identity.id, routeId: route.id }, configurationRevision: route.configurationRevision, identity: printer.identity } : null;
    if (JSON.stringify(source) === JSON.stringify(state.groupingSource) && (source !== null
      || JSON.stringify(printer?.identity ?? null) === JSON.stringify(state.groupingContext?.identity ?? null))) return state;
    const sameSource = source && state.groupingSource && JSON.stringify([source.target, source.configurationRevision])
      === JSON.stringify([state.groupingSource.target, state.groupingSource.configurationRevision]);
    return { groupingSource: source, groupingVersion: state.groupingVersion + 1,
      groupingContext: sameSource && state.groupingContext ? { ...state.groupingContext, identity: source.identity }
        : printer ? { identity: printer.identity, toolCount: 0, materials: [] } : null,
      groupingReading: sameSource ? state.groupingReading : null, groupingFailedReading: sameSource ? state.groupingFailedReading : null,
      groupingPullFailed: sameSource ? state.groupingPullFailed : false };
  }),
  publishGrouping: (snapshot, acquired = false) => set(state => {
    const source = state.groupingSource;
    if (!source || snapshot.target.printerId !== source.target.printerId || snapshot.target.routeId !== source.target.routeId
      || snapshot.configurationRevision !== source.configurationRevision) return state;
    const reading = snapshot.values.materials;
    if (reading?.kind !== 'known') return state;
    const key = JSON.stringify([reading.receivedAtMs, reading.value.state.inventoryRevision, reading.value.topologyRevision]);
    if (!acquired && state.groupingPullFailed && (state.groupingFailedReading === null || key === state.groupingFailedReading)) return state;
    const context = deviceGroupingContext(snapshot, source.identity);
    if (!context) return state;
    if (JSON.stringify(context) === JSON.stringify(state.groupingContext))
      return { groupingReading: key, groupingFailedReading: null, groupingPullFailed: false };
    return { groupingContext: context, groupingReading: key, groupingFailedReading: null, groupingPullFailed: false, groupingVersion: state.groupingVersion + 1 };
  }),
  failGroupingPull: (target, configurationRevision) => set(state => {
    const source = state.groupingSource;
    if (!source || source.target.printerId !== target.printerId || source.target.routeId !== target.routeId
      || source.configurationRevision !== configurationRevision) return state;
    return { groupingContext: { identity: state.groupingContext?.identity ?? source.identity,
      toolCount: state.groupingContext?.toolCount ?? 0, materials: [] },
      groupingFailedReading: state.groupingReading, groupingPullFailed: true, groupingVersion: state.groupingVersion + 1 };
  }),
  publishConnection: (owner, snapshot) => {
    get().publishGrouping(snapshot);
    set(state => {
    const descriptor = snapshot.values.descriptor;
    const status = snapshot.values.status;
    if (descriptor?.kind !== 'known' || descriptor.freshness !== 'fresh' || descriptor.sourceRouteId !== snapshot.target.routeId
      || descriptor.value.identity.id !== snapshot.target.printerId || status?.kind === 'known'
        && (status.freshness !== 'fresh' || status.sourceRouteId !== snapshot.target.routeId))
      return state.connectionOwner === owner ? { connection: null, connectionOwner: null, materials: null } : state;
    const connection = { target: snapshot.target, configurationRevision: snapshot.configurationRevision, identity: descriptor.value.identity };
    const sameConnection = state.connectionOwner === owner && JSON.stringify(state.connection) === JSON.stringify(connection);
    const observed = snapshot.values.materials;
    const previous = state.materials;
    const sameMaterials = sameConnection && previous && observed?.kind === 'known' && observed.freshness === 'fresh'
      && observed.sourceRouteId === snapshot.target.routeId && observed.value.topologyRevision === previous.topologyRevision
      && descriptor.value.topology.revision === previous.topologyRevision
      && observed.value.state.inventoryRevision === previous.inventoryRevision;
    const normalized = sameMaterials ? null : synchronizationSource({ ...snapshot, values: { descriptor, materials: observed ?? { kind: 'unknown', reason: 'not-reported' } } }, connection.identity, 'filament');
    const materials = sameMaterials ? previous : normalized?.ok ? normalized.value : null;
    if (sameConnection && materials === previous) return state;
    return { connection: sameConnection ? state.connection : connection, connectionOwner: owner, materials };
    });
  },
  clearConnection: owner => set(state => state.connectionOwner === owner ? { connection: null, connectionOwner: null, materials: null } : state),
  setCurrent: currentPrinterId => {
    if (get().currentPrinterId !== currentPrinterId) get().selectGroupingSource(null, null);
    set({ currentPrinterId });
  },
  selectPrinter: requestedPrinterId => {
    get().setCurrent(requestedPrinterId);
    set(state => ({ requestedPrinterId, selectionRequestVersion: state.selectionRequestVersion + 1 }));
  },
  showPrinter: requestedPrinterId => {
    get().setCurrent(requestedPrinterId);
    set(state => ({ requestedPrinterId, selectionRequestVersion: state.selectionRequestVersion + 1, navigationRequestVersion: state.navigationRequestVersion + 1 }));
  },
}));
