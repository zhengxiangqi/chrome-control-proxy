#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const log = require(path.join(__dirname, '..', 'lib', 'logger.js'));

const ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(ROOT, 'index.js');
const PID_FILE = process.env.CCP_PID_FILE || path.join(os.tmpdir(), 'chrome-control-proxy.pid');
const LOG_FILE = process.env.CCP_LOG_FILE || path.join(os.tmpdir(), 'chrome-control-proxy.log');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3333;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function httpJson(method, p) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path: p,
      method,
      timeout: 8000,
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
      });
      res.on('end', () => {
        try {
          resolve(d ? JSON.parse(d) : {});
        } catch {
          resolve({ raw: d });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function readPid() {
  try {
    const n = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function serviceReachable() {
  try {
    const h = await httpJson('GET', '/health');
    return Boolean(h && h.ok);
  } catch {
    return false;
  }
}

async function cmdStatus() {
  const pid = readPid();
  console.log(`ccp: pid file ${PID_FILE}`);
  if (pid) {
    console.log(`ccp: recorded pid ${pid} ${isAlive(pid) ? '(running)' : '(not running)'}`);
  }
  const up = await serviceReachable();
  console.log(`ccp: http://${HOST}:${PORT} ${up ? 'reachable' : 'unreachable'}`);
  if (!up) {
    process.exit(1);
  }
  try {
    const h = await httpJson('GET', '/health');
    console.log('health:', JSON.stringify(h, null, 2));
  } catch (e) {
    console.error('health:', e.message);
  }
  try {
    const b = await httpJson('GET', '/browser/status');
    console.log('browser:', JSON.stringify(b, null, 2));
  } catch (e) {
    console.error('browser:', e.message);
  }
  try {
    const p = await httpJson('GET', '/playwright/status');
    console.log('playwright:', JSON.stringify(p, null, 2));
  } catch (e) {
    console.error('playwright:', e.message);
  }
}

async function cmdStart() {
  log.info('ccp', 'start requested', { port: PORT, host: HOST });
  if (await serviceReachable()) {
    log.warn('ccp', 'service already responding', { port: PORT });
    console.error('ccp: service already responding on port', PORT);
    process.exit(1);
  }
  const oldPid = readPid();
  if (oldPid && isAlive(oldPid)) {
    log.warn('ccp', 'stale pid file', { pid: oldPid });
    console.error('ccp: stale pid file points to running process', oldPid);
    process.exit(1);
  }
  if (oldPid && !isAlive(oldPid)) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* */
    }
  }

  let logFd;
  try {
    logFd = fs.openSync(LOG_FILE, 'a');
  } catch {
    logFd = 'ignore';
  }

  const child = spawn(process.execPath, [INDEX_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: ROOT,
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log.info('ccp', 'spawned server process', { pid: child.pid, logFile: LOG_FILE, index: INDEX_JS });
  console.log('ccp: started pid', child.pid);
  console.log('ccp: log', LOG_FILE);

  sleepSync(400);
  if (await serviceReachable()) {
    log.info('ccp', 'service reachable');
    console.log('ccp: service is up');
  } else {
    log.error('ccp', 'service not reachable after start', new Error(`check ${LOG_FILE}`));
    console.error('ccp: service not yet reachable; check log:', LOG_FILE);
    process.exit(1);
  }
}

function killProcessTree(pid) {
  if (!isAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* */
  }
  for (let i = 0; i < 40; i++) {
    if (!isAlive(pid)) {
      return;
    }
    sleepSync(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* */
  }
}

function cmdStop() {
  log.info('ccp', 'stop requested', { pidFile: PID_FILE });
  const pid = readPid();
  if (pid && isAlive(pid)) {
    log.info('ccp', 'killing pid', { pid });
    killProcessTree(pid);
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* */
  }
  try {
    const esc = INDEX_JS.replace(/'/g, "'\\''");
    execSync(`pkill -f '${esc}'`, { stdio: 'ignore' });
  } catch {
    /* */
  }
  log.info('ccp', 'stop finished');
  console.log('ccp: stopped');
}

async function cmdRestart() {
  log.info('ccp', 'restart requested');
  cmdStop();
  sleepSync(500);
  await cmdStart();
}

function printHelp() {
  console.log(`Usage: ccp <command>

Commands:
  start    Start HTTP proxy (node index.js), write pid to ${PID_FILE}
  stop     Stop process from pid file, fallback pkill by index.js path
  restart  stop then start
  status   GET /health, /browser/status, /playwright/status

Environment:
  PORT           HTTP port (default 3333)
  HOST           Bind host (default 127.0.0.1)
  CCP_PID_FILE   Override pid file path
  CCP_LOG_FILE   Override log file path
`);
}

async function main() {
  const sub = process.argv[2] || 'help';
  switch (sub) {
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      cmdStop();
      break;
    case 'restart':
      await cmdRestart();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      break;
    default:
      console.error('ccp: unknown command:', sub);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  log.error('ccp', 'cli fatal', e);
  console.error(e);
  process.exit(1);
});
