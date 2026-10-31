import { create } from 'zustand';
import type * as D from '@orca/printer-control/domain';
type Connection = { target: D.PrinterTarget; configurationRevision: D.Revision; identity: D.PrinterIdentity };
/** Device selection and page navigation have separate callers and lifetimes. */
export const useDeviceSelectionStore = create<{
  currentPrinterId: string | null;
  requestedPrinterId: string | null;
  selectionRequestVersion: number;
  navigationRequestVersion: number;
  connection: Connection | null;
  connectionOwner: object | null;
  publishConnection(owner: object, snapshot: D.PrinterSnapshot): void;
  clearConnection(owner: object): void;
  setCurrent(id: string | null): void;
  selectPrinter(id: string): void;
  showPrinter(id: string): void;
}>(set => ({
  currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0,
  connection: null, connectionOwner: null,
  publishConnection: (owner, snapshot) => set(state => {
    const descriptor = snapshot.values.descriptor;
    const status = snapshot.values.status;
    if (descriptor?.kind !== 'known' || descriptor.freshness !== 'fresh' || descriptor.sourceRouteId !== snapshot.target.routeId
      || descriptor.value.identity.id !== snapshot.target.printerId || status?.kind === 'known'
        && (status.freshness !== 'fresh' || status.sourceRouteId !== snapshot.target.routeId))
      return state.connectionOwner === owner ? { connection: null, connectionOwner: null } : state;
    const connection = { target: snapshot.target, configurationRevision: snapshot.configurationRevision, identity: descriptor.value.identity };
    if (state.connectionOwner === owner && JSON.stringify(state.connection) === JSON.stringify(connection)) return state;
    return { connection, connectionOwner: owner };
  }),
  clearConnection: owner => set(state => state.connectionOwner === owner ? { connection: null, connectionOwner: null } : state),
  setCurrent: currentPrinterId => set({ currentPrinterId }),
  selectPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1 })),
  showPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1, navigationRequestVersion: state.navigationRequestVersion + 1 })),
}));
