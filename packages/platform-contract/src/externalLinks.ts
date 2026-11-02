/** Host trust-boundary validation for user-invoked documentation links. */
export function externalHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid external HTTPS URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid external HTTPS URL');
  return url.href;
}
