import type { PrinterSubmissions } from './domain';
const unavailable = async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Local print submission is unavailable.' } });
export const unsupportedSubmissions: PrinterSubmissions = {
  prepare: unavailable, submit: unavailable, get: unavailable, cancel: unavailable,
  watch: async function* () { throw new Error('Local print submission is unavailable.'); },
};
