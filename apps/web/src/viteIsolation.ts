export function isolationHeaders(env: Record<string, string | undefined>): Record<string, string> {
  return env.ORCA_WEB_NO_ISOLATION === '1' ? {} : {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}
