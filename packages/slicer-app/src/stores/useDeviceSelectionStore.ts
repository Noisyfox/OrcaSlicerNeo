import { create } from 'zustand';
import { synchronizationSource, type SynchronizationSource } from '@orca/printer-control';
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
  publishConnection(owner: object, snapshot: D.PrinterSnapshot): void;
  clearConnection(owner: object): void;
  setCurrent(id: string | null): void;
  selectPrinter(id: string): void;
  showPrinter(id: string): void;
}>(set => ({
  currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0,
  connection: null, connectionOwner: null, materials: null,
  publishConnection: (owner, snapshot) => set(state => {
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
  }),
  clearConnection: owner => set(state => state.connectionOwner === owner ? { connection: null, connectionOwner: null, materials: null } : state),
  setCurrent: currentPrinterId => set({ currentPrinterId }),
  selectPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1 })),
  showPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1, navigationRequestVersion: state.navigationRequestVersion + 1 })),
}));
