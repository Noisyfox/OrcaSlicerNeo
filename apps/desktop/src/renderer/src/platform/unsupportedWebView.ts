import type {
  WebViewHost,
  WebViewPanelCapabilities,
  WebViewPanelState,
} from '@orca/platform-contract';

const UNSUPPORTED_CAPABILITIES: WebViewPanelCapabilities = {
  canInjectBuiltInScripts: false,
  canExposeHostApi: false,
  canExecuteJavaScript: false,
};

/**
 * Temporary Electron boundary for this step. The real webview guest is a
 * later, separately verified host implementation; no Electron webview is
 * created here.
 */
export function createUnsupportedWebViewHost(): WebViewHost {
  return {
    capabilities: UNSUPPORTED_CAPABILITIES,
    mount() {
      const state: WebViewPanelState = { status: 'idle', url: null, error: null };
      return {
        capabilities: UNSUPPORTED_CAPABILITIES,
        state,
        load(url) { state.status = 'loading'; state.url = url; state.error = null; },
        registerBuiltInScript() { return { status: 'unsupported', reason: 'capability-unavailable' as const }; },
        exposeHostApi() { return { status: 'unsupported', reason: 'capability-unavailable' as const }; },
        async executeJavaScript<T = unknown>() {
          return { status: 'unsupported', reason: 'capability-unavailable' as const } as const;
        },
        dispose() {},
      };
    },
  };
}
