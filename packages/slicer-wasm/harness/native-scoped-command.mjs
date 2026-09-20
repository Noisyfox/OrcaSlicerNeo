export function mutateNativeScopedConfig(callJson, operation, targets, payload = {}) {
  return callJson('orc_mutate_native_scoped_config', ['string'], [JSON.stringify({
    version: 1, operation, targets, ...payload,
  })]);
}

export function setNativeScopedConfig(callJson, scope, id, key, value) {
  const target = id === undefined || id === null || id === '' ? { scope } : { scope, id: String(id) };
  return mutateNativeScopedConfig(callJson, 'set', [target], { key, value: String(value) });
}

export function resetNativeScopedConfig(callJson, scope, id, key) {
  const target = id === undefined || id === null || id === '' ? { scope } : { scope, id: String(id) };
  return mutateNativeScopedConfig(callJson, 'reset', [target], { key });
}
