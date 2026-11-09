/** Loopback U1 protocol fixture shared by host transport acceptance. No hardware claims. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
export async function startSnapmakerFixture(filament?: { vendor: string; type: string; subtype: string }) {
  const scripts: string[] = []; let queries = 0, autoRefill = false;
  let cameraFrame: Buffer | undefined, cameraFailed = false, cameraRequests = 0;
  const filamentColors = ['FF0000FF', '00FF00FF', '0000FFFF', 'FFFFFFFF'];
  const objects = ['gcode', 'print_task_config', 'print_stats', 'virtual_sdcard', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed', 'purifier', 'configfile', 'filament_feed left', 'filament_feed right'];
  const commands = ['SET_PRINT_PREFERENCES', 'SET_PRINT_EXTRUDER_MAP', 'SET_PRINT_USED_EXTRUDERS', 'SET_PRINT_FILAMENT_CONFIG', 'FEED_AUTO', 'SET_HEATER_TEMPERATURE', 'SET_PURIFIER'];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key'); response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let value: unknown;
    if (path === '/server/files/camera/monitor.jpg') {
      cameraRequests++;
      response.writeHead(cameraFailed || !cameraFrame ? 503 : 200, { 'content-type': 'image/jpeg' });
      response.end(cameraFrame); return;
    }
    if (path === '/printer/objects/list') value = { result: { objects } };
    else if (path === '/printer/objects/query') {
      queries++;
      value = { result: { status: { gcode: { commands: Object.fromEntries(commands.map(c => [c, {}])) }, print_stats: { state: 'printing', filename: 'external.gcode' }, virtual_sdcard: { progress: .4 },
        print_task_config: { filament_exist: [true, true, true, true], filament_type: filament ? Array(4).fill(filament.type) : ['PLA', 'PLA', 'PETG', 'ABS'],
          filament_vendor: filament ? Array(4).fill(filament.vendor) : undefined, filament_sub_type: filament ? Array(4).fill(filament.subtype) : undefined,
          filament_color_rgba: filamentColors, auto_replenish_filament: autoRefill, replenish_ignore_color: false, end_led_turn_off: false },
        ...Object.fromEntries([0, 1, 2, 3].map(i => [i ? `extruder${i}` : 'extruder', { nozzle_diameter: .4, nozzle_volume_type: 'standard', temperature: 210 + queries / 10, target: 215 }])),
        heater_bed: { temperature: 60, target: 60 }, purifier: { power_detected: true, mode: 1, inner_fan: { speed: .2 }, exhaust_fan: { speed: .4 } },
        configfile: { settings: { extruder: { max_temp: 300 }, heater_bed: { max_temp: 100 } } },
      } } };
    } else if (path === '/server/files/metadata') value = { result: { job_id: '000001', print_start_time: 1234, uuid: 'fixture',
      thumbnails: [{ width: 1, height: 1, relative_path: '.thumbs/external.png' }] } };
    else if (path === '/server/files/gcodes/.thumbs/external.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
      return;
    } else if (path === '/printer/gcode/script') {
      const parts = []; for await (const part of request) parts.push(Buffer.from(part));
      const script = JSON.parse(Buffer.concat(parts).toString()).script as string; scripts.push(script);
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
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'camera.start_monitor'
      ? { state: 'success', url: '/files/camera/monitor.jpg', pw: 'unused-fixture', salt: 'unused-fixture', iterations: 654 }
      : { state: 'success' } }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, scripts, cameraCommands, queryCount: () => queries,
    setCameraFrame: (frame: Buffer) => { cameraFrame = frame; },
    setCameraFailed: (failed: boolean) => { cameraFailed = failed; },
    cameraRequests: () => cameraRequests,
    setFilamentColor: (head: number, rgba: string) => { filamentColors[head] = rgba; },
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of websocket.clients) client.terminate(); websocket.close();
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }) };
}
