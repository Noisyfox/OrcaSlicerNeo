/** Pinned Orca HMS resources; English UI, indexed once, selected by serial prefix as HMSQuery does. */
type Messages = { data: { device_error: { en: { ecode: string; intro: string }[] } } };
type Actions = { data: { ecode: string; actions: number[] }[] };
const messages = import.meta.glob<Messages>('../../../../../packages/slicer-wasm/cpp/resources/hms/hms_en_*.json', { eager: true, import: 'default' });
const actions = import.meta.glob<Actions>('../../../../../packages/slicer-wasm/cpp/resources/hms/hms_action_*.json', { eager: true, import: 'default' });
const catalogs = new Map(Object.entries(messages).map(([path, value]) => {
  const prefix = /hms_en_(\w+)\.json$/.exec(path)![1];
  const buttons = actions[path.replace(`hms_en_${prefix}`, `hms_action_${prefix}`)]?.data ?? [];
  // Orca's sequential lookup takes the first match; some bundled tables contain duplicate codes.
  const byCode = new Map(buttons.slice().reverse().map(item => [item.ecode.toUpperCase(), item.actions]));
  return [prefix, new Map(value.data.device_error.en.slice().reverse().map(item => [item.ecode.toUpperCase(), { message: item.intro, actions: byCode.get(item.ecode.toUpperCase()) ?? [] }]))];
}));
export function printErrorResource(serial: string | null, error: number) {
  return catalogs.get(serial?.slice(0, 3) ?? '')?.get(error.toString(16).toUpperCase().padStart(8, '0'));
}
