/** Electron host-only boundary. Raw plugin payloads never belong in renderer IPC. */
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface NativeHttpResult { result: number; httpCode: number; body: string }
export type NativeEvent =
  | { type: 'ssdp' | 'printer-connected' | 'subscribe-failure'; args: [string] }
  | { type: 'message' | 'user-message' | 'local-message'; args: [string, string] }
  | { type: 'server-connected'; args: [number, number] }
  | { type: 'http-error'; args: [number, string] }
  | { type: 'local-connect'; args: [number, string, string] }
  | { type: 'server-error'; args: [string, number] };
interface Binding {
  invoke(method: string, args: readonly unknown[]): Promise<unknown>;
  drain(): Promise<void>;
  dispose(): void;
}

export interface BambuNative {
  getVersion(): Promise<string>;
  createAgent(logDirectory: string): Promise<number>;
  setConfigDirectory(path: string): Promise<number>;
  initLog(): Promise<number>;
  setCertificate(folder: string, filename: string): Promise<number>;
  installCallbacks(): Promise<number>;
  installDiscoveryCallbacks(): Promise<number>;
  setCountryCode(country: string): Promise<number>;
  setExtraHttpHeaders(headers: Readonly<Record<string, string>>): Promise<number>;
  start(): Promise<number>;
  trackEnable(enable: boolean): Promise<number>;
  trackRemoveFiles(): Promise<number>;
  connectServer(): Promise<number>;
  isServerConnected(): Promise<boolean>;
  refreshConnection(): Promise<number>;
  changeUser(loginPayload: string): Promise<number>;
  isUserLoggedIn(): Promise<boolean>;
  logout(request: boolean): Promise<number>;
  getUserId(): Promise<string>;
  getUserName(): Promise<string>;
  getUserAvatar(): Promise<string>;
  getUserNickname(): Promise<string>;
  buildLoginCommand(): Promise<string>;
  buildLogoutCommand(): Promise<string>;
  buildLoginInfo(): Promise<string>;
  getBambuLabHost(): Promise<string>;
  getMyToken(ticket: string): Promise<NativeHttpResult>;
  getMyProfile(token: string): Promise<NativeHttpResult>;
  getSubtaskInfo(subtaskId: string): Promise<NativeHttpResult>;
  getUserPrintInfo(): Promise<NativeHttpResult>;
  startDiscovery(start: boolean, sending: boolean): Promise<boolean>;
  connectPrinter(deviceId: string, ip: string, username: string, password: string, ssl: boolean): Promise<number>;
  startSubscribe(module: string): Promise<number>;
  stopSubscribe(module: string): Promise<number>;
  sendMessage(deviceId: string, payload: string, qos: number, flag: number): Promise<number>;
  sendMessageToPrinter(deviceId: string, payload: string, qos: number, flag: number): Promise<number>;
  installDeviceCertificate(deviceId: string, lanOnly: boolean): Promise<void>;
  disconnectPrinter(): Promise<number>;
  getSelectedMachine(): Promise<string>;
  setSelectedMachine(deviceId: string): Promise<number>;
  /** Clear callbacks, drain scheduled native work, destroy the agent, then unload. Never logs out. */
  close(): Promise<void>;
}

export function loadBambuNative(addonPath: string, pluginPath: string, listener: (event: NativeEvent) => void): BambuNative {
  if (!isAbsolute(addonPath) || !isAbsolute(pluginPath)) throw new Error('Native library paths must be absolute');
  const addon = createRequire(addonPath)(addonPath) as { Agent: new (path: string, listener: (event: NativeEvent) => void) => Binding };
  const binding = new addon.Agent(pluginPath, event => {
    try { listener(event); } catch { process.emitWarning('Bambu event consumer failed'); }
  });
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  let created = false;
  // Preserve Orca call ordering while the Node event loop delivers callbacks.
  const call = <T>(method: string, ...args: unknown[]): Promise<T> => {
    if (closing) return Promise.reject(new Error('Bambu native agent closed'));
    const result = tail.then(() => binding.invoke(method, args)) as Promise<T>;
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    getVersion: () => call('get_version'),
    createAgent: async path => { const result = await call<number>('create_agent', path); created = result === 0; return result; },
    setConfigDirectory: path => call('set_config_dir', path), initLog: () => call('init_log'),
    setCertificate: (folder, filename) => call('set_cert_file', folder, filename),
    installCallbacks: () => call('install_callbacks'), installDiscoveryCallbacks: () => call('install_discovery_callbacks'), setCountryCode: country => call('set_country_code', country),
    setExtraHttpHeaders: headers => call('set_extra_http_header', headers), start: () => call('start'),
    trackEnable: enable => call('track_enable', enable), trackRemoveFiles: () => call('track_remove_files'), connectServer: () => call('connect_server'),
    isServerConnected: () => call('is_server_connected'), refreshConnection: () => call('refresh_connection'),
    changeUser: payload => call('change_user', payload), isUserLoggedIn: () => call('is_user_login'), logout: request => call('user_logout', request),
    getUserId: () => call('get_user_id'), getUserName: () => call('get_user_name'), getUserAvatar: () => call('get_user_avatar'),
    getUserNickname: () => call('get_user_nickanme'), buildLoginCommand: () => call('build_login_cmd'),
    buildLogoutCommand: () => call('build_logout_cmd'), buildLoginInfo: () => call('build_login_info'), getBambuLabHost: () => call('get_bambulab_host'),
    getMyToken: ticket => call('get_my_token', ticket), getMyProfile: token => call('get_my_profile', token), getSubtaskInfo: id => call('get_subtask_info', id), getUserPrintInfo: () => call('get_user_print_info'),
    startDiscovery: (start, sending) => call('start_discovery', start, sending),
    connectPrinter: (id, ip, username, password, ssl) => call('connect_printer', id, ip, username, password, ssl),
    startSubscribe: module => call('start_subscribe', module), stopSubscribe: module => call('stop_subscribe', module),
    sendMessage: (id, payload, qos, flag) => call('send_message', id, payload, qos, flag),
    sendMessageToPrinter: (id, payload, qos, flag) => call('send_message_to_printer', id, payload, qos, flag),
    installDeviceCertificate: async (id, lanOnly) => { await call('install_device_cert', id, lanOnly); },
    disconnectPrinter: () => call('disconnect_printer'), getSelectedMachine: () => call('get_user_selected_machine'), setSelectedMachine: id => call('set_user_selected_machine', id),
    close() {
      if (!closing) closing = tail.then(async () => {
        try {
          await binding.invoke('clear_callbacks', []);
          await binding.drain();
          if (created) {
            await binding.invoke('start_discovery', [false, false]);
            await binding.invoke('disconnect_printer', []);
            // Orca gives server disconnect up to 500 ms, polling every 50 ms.
            const deadline = performance.now() + 500;
            while (await binding.invoke('is_server_connected', [])) {
              if (performance.now() >= deadline) break;
              await delay(50);
            }
            await binding.drain();
          }
        } finally {
          try { await binding.invoke('destroy_agent', []); } finally { binding.dispose(); }
        }
      });
      return closing;
    },
  };
}


export interface NativeCameraSample { bytes: Uint8Array; time100ns: bigint; flags: number }
export interface NativeCamera {
  poll(): { ready: boolean; format: 'h264' | 'jpeg' | ''; width: number; height: number; samples: NativeCameraSample[] };
  /** Cancels and joins on a worker; resolves after tunnel close/destroy and library unload. */
  close(): Promise<void>;
}
/** Host-private LAN URL only. The independent reader never enters the account call queue. */
export function loadBambuCamera(addonPath: string, sourcePath: string, url: string): NativeCamera {
  if (!isAbsolute(addonPath) || !isAbsolute(sourcePath)) throw new Error('Native library paths must be absolute');
  const addon = createRequire(addonPath)(addonPath) as { Camera: new (path: string, url: string) => NativeCamera };
  return new addon.Camera(sourcePath, url);
}
