// scripts/stop-port.mjs — kill the process listening on a TCP port.
// Used by the VSCode `postDebugTask` so the Vite dev server dies when the
// web debug session (browser) ends. Usage: node scripts/stop-port.mjs [port]
import { spawnSync } from 'node:child_process';

const port = process.argv[2] ?? '5173';
const isWin = process.platform === 'win32';

let pids = [];
if (isWin) {
  const { stdout } = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/.test(line) || !line.includes(`:${port}`)) continue;
    const pid = line.trim().split(/\s+/).at(-1);
    if (pid && !pids.includes(pid)) pids.push(pid);
  }
} else {
  const { stdout, status } = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  if (status === 0) pids = stdout.trim().split(/\r?\n/).filter(Boolean);
}

if (pids.length === 0) {
  console.log(`[stop-port] nothing listening on ${port}`);
  process.exit(0);
}

for (const pid of pids) {
  if (isWin) spawnSync('taskkill', ['/F', '/PID', pid]);
  else spawnSync('kill', [pid]);
  console.log(`[stop-port] killed pid ${pid}`);
}
