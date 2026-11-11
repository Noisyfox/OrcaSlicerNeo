/** Loopback U1 protocol fixture shared by host transport acceptance. No hardware claims. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
export const usbGcodeName = '打印 #%.gcode';
export const fixtureGcode = '; loopback printer file\nG90\n';
export const fixtureTimelapse = 'loopback MP4 download bytes';
export const fixtureTimelapseIndex = '20261109131725';
const usbGcodePath = `.udisk/sub/${usbGcodeName}`;

export async function startSnapmakerFixture(filament?: { vendor: string; type: string; subtype: string }) {
  const scripts: string[] = []; let queries = 0, autoRefill = false;
  let listReads = 0, usbPresent = true;
  let idle = false, activeTool = 0;
  const deleted: string[] = [], downloads: { name: string; key?: string }[] = [];
  let timelapsePresent = true;
  let cameraFrame: Buffer | undefined, cameraFailed = false, cameraRequests = 0;
  const filamentColors = ['FF0000FF', '00FF00FF', '0000FFFF', 'FFFFFFFF'];
  const objects = ['gcode', 'toolhead', 'machine_state_manager', 'print_task_config', 'print_stats', 'virtual_sdcard', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed', 'purifier', 'configfile', 'filament_feed left', 'filament_feed right'];
  const commands = ['SET_PRINT_PREFERENCES', 'SET_PRINT_EXTRUDER_MAP', 'SET_PRINT_USED_EXTRUDERS', 'SET_PRINT_FILAMENT_CONFIG', 'FEED_AUTO', 'SET_HEATER_TEMPERATURE', 'SET_PURIFIER',
    'T0', 'T1', 'T2', 'T3', 'PARK_EXTRUDER', 'PARK_EXTRUDER1', 'PARK_EXTRUDER2', 'PARK_EXTRUDER3', 'SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE', 'M83', 'M220', 'M221', 'G1', 'M400'];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key'); response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const { pathname: path } = url;
    let value: unknown;
    if (path === '/server/files/camera/monitor.jpg') {
      cameraRequests++;
      response.writeHead(cameraFailed || !cameraFrame ? 503 : 200, { 'content-type': 'image/jpeg' });
      response.end(cameraFrame); return;
    }
    if (path === '/access/oneshot_token') value = { result: 'fixture-token' };
    else if (path === '/server/files/camera/fixture.mp4' && timelapsePresent) {
      downloads.push({ name: 'fixture.mp4', key: request.headers['x-api-key'] as string | undefined });
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': Buffer.byteLength(fixtureTimelapse) });
      response.end(fixtureTimelapse); return;
    } else if (path === '/printer/objects/list') value = { result: { objects } };
    else if (path === '/printer/objects/query') {
      queries++;
      value = { result: { status: { gcode: { commands: Object.fromEntries(commands.map(c => [c, {}])) }, print_stats: { state: idle ? 'standby' : 'printing', filename: 'external.gcode' }, virtual_sdcard: { progress: .4 },
        toolhead: { extruder: activeTool > 0 ? `extruder${activeTool}` : 'extruder' }, machine_state_manager: { main_state: idle ? 0 : 1, action_code: 0 },
        print_task_config: { filament_exist: [true, true, true, true], filament_type: filament ? Array(4).fill(filament.type) : ['PLA', 'PLA', 'PETG', 'ABS'],
          filament_vendor: filament ? Array(4).fill(filament.vendor) : undefined, filament_sub_type: filament ? Array(4).fill(filament.subtype) : undefined,
          filament_color_rgba: filamentColors, auto_replenish_filament: autoRefill, replenish_ignore_color: false, end_led_turn_off: false },
        ...Object.fromEntries([0, 1, 2, 3].map(i => [i ? `extruder${i}` : 'extruder', { nozzle_diameter: .4, nozzle_volume_type: 'standard', temperature: 210 + queries / 10, target: 215,
          activating_move: false, can_extrude: true, real_extruder_stats: [activeTool > 0 ? `extruder${activeTool}` : 'extruder', activeTool < 0 ? 1 : 0] }])),
        heater_bed: { temperature: 60, target: 60 }, purifier: { power_detected: true, mode: 1, inner_fan: { speed: .2 }, exhaust_fan: { speed: .4 } },
        configfile: { settings: { ...Object.fromEntries(['extruder', 'extruder1', 'extruder2', 'extruder3'].map(name => [name, { max_temp: 300, max_extrude_only_distance: 50 }])), heater_bed: { max_temp: 100 } } },
      } } };
    } else if (path === '/server/files/list' && url.searchParams.get('root') === 'gcodes') {
      listReads++;
      value = { result: ['external.gcode', 'no-preview.gcode', ...(usbPresent ? [usbGcodePath] : [])].filter(filePath => !deleted.includes(filePath))
        .map(filePath => ({ path: filePath, size: 100, modified: 1700000000, permissions: 'rw' })) };
    } else if (request.method === 'DELETE' && path.startsWith('/server/files/gcodes/')) {
      const filename = decodeURIComponent(path.slice('/server/files/gcodes/'.length));
      deleted.push(filename);
      value = { result: { action: 'delete_file', item: { root: 'gcodes', path: filename } } };
    } else if (request.method === 'GET' && path.startsWith('/server/files/gcodes/') && path.endsWith('.gcode')) {
      const name = decodeURIComponent(path.slice('/server/files/gcodes/'.length));
      if (deleted.includes(name)) { response.writeHead(404); response.end(); return; }
      downloads.push({ name, key: request.headers['x-api-key'] as string | undefined });
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(fixtureGcode) });
      response.end(fixtureGcode); return;
    } else if (path === '/server/files/metadata') {
      const filename = url.searchParams.get('filename');
      if (filename === 'no-preview.gcode') { response.writeHead(404); response.end(); return; }
      value = { result: { job_id: '000001', print_start_time: 1234, uuid: 'fixture',
        thumbnails: [{ width: 1, height: 1, relative_path: filename === usbGcodePath ? '.thumbs/usb%23 #.png' : '.thumbs/external.png' }] } };
    } else if (path === '/server/files/gcodes/.thumbs/external.png' || path === '/server/files/gcodes/.udisk/sub/.thumbs/usb%2523%20%23.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
      return;
    } else if (path === '/printer/gcode/script') {
      const parts = []; for await (const part of request) parts.push(Buffer.from(part));
      const script = JSON.parse(Buffer.concat(parts).toString()).script as string; scripts.push(script);
      if (/^T[0-3] A0$/.test(script)) activeTool = Number(script[1]);
      if (/^PARK_EXTRUDER[1-3]?$/.test(script)) activeTool = -1;
      if (script.includes('AUTO_REPLENISH_FILAMENT=1')) autoRefill = true;
      value = { result: 'ok' };
    } else if (path === '/server/info') value = { result: { moonraker_version: 'fixture' } };
    else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  const cameraCommands: { method: string; params: { clientid: string } }[] = [];
  const websocket = new WebSocketServer({ server, path: '/websocket' });
  websocket.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(String(data)); cameraCommands.push(request);
    let result: object = { state: 'success' };
    if (request.method === 'camera.start_monitor')
      result = { state: 'success', url: '/files/camera/monitor.jpg', pw: 'unused-fixture', salt: 'unused-fixture', iterations: 654 };
    if (request.method === 'camera.get_timelapse_instance') result = { state: 'success', page_index: request.params.page_index,
      total_count: timelapsePresent ? 1 : 0, instances: timelapsePresent ? [{ date_index: fixtureTimelapseIndex,
        gcode_name: 'Fixture video.gcode', video_local_url_suffix: '/files/camera/fixture.mp4', video_file_size: Buffer.byteLength(fixtureTimelapse) }] : [] };
    if (request.method === 'camera.delete_timelapse_instance') {
      if (timelapsePresent && request.params.date_index === fixtureTimelapseIndex) {
        timelapsePresent = false;
        deleted.push(fixtureTimelapseIndex);
      } else result = { state: 'failed' };
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, scripts, deleted, downloads, cameraCommands, queryCount: () => queries,
    setIdle: () => { idle = true; },
    storageListReads: () => listReads,
    setUsbStoragePresent: (present: boolean) => { usbPresent = present; },
    setCameraFrame: (frame: Buffer) => { cameraFrame = frame; },
    setCameraFailed: (failed: boolean) => { cameraFailed = failed; },
    cameraRequests: () => cameraRequests,
    setFilamentColor: (head: number, rgba: string) => { filamentColors[head] = rgba; },
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of websocket.clients) client.terminate(); websocket.close();
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }) };
}
