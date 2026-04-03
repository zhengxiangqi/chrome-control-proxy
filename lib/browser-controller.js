const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const log = require('./logger');

const CHROME_PORT = process.env.CHROME_PORT || 9222;
const CHROME_PROFILE_DIR =
  process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), '.chrome-control-proxy', 'chrome-cdp');
const CHROME_BINARY =
  process.env.CHROME_BINARY ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function runCommand(command) {
  return new Promise((resolve) => {
    log.debug('browser', `exec: ${command.slice(0, 200)}${command.length > 200 ? '…' : ''}`);
    exec(command, { shell: '/bin/bash' }, (error, stdout, stderr) => {
      const out = {
        ok: !error,
        code: error ? error.code : 0,
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
      };
      if (!out.ok) {
        log.debug('browser', `exec exit ${out.code}`, out.stderr || error?.message);
      }
      resolve(out);
    });
  });
}

async function getChromeStatus() {
  const checkPortCmd = `lsof -nP -iTCP:${CHROME_PORT} -sTCP:LISTEN`;
  const result = await runCommand(checkPortCmd);

  if (!result.ok || !result.stdout) {
    return {
      running: false,
      port: Number(CHROME_PORT),
      pid: null,
      raw: result.stdout || '',
    };
  }

  const lines = result.stdout.split('\n').filter(Boolean);
  const chromeLine = lines.find((line) => line.includes('Google Chrome') || line.includes('Chrome'));

  if (!chromeLine) {
    return {
      running: true,
      port: Number(CHROME_PORT),
      pid: null,
      raw: result.stdout,
    };
  }

  const parts = chromeLine.trim().split(/\s+/);
  const pid = parts[1] ? Number(parts[1]) : null;

  return {
    running: true,
    port: Number(CHROME_PORT),
    pid,
    raw: chromeLine,
  };
}

function buildStartChromeCommand() {
  return [
    'nohup',
    `"${CHROME_BINARY}"`,
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir="${CHROME_PROFILE_DIR}"`,
    '--lang=zh-CN',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '>/tmp/chrome-cdp.log 2>&1 &',
  ].join(' ');
}

async function startChrome() {
  log.info('browser', 'startChrome requested');
  const status = await getChromeStatus();
  if (status.running) {
    log.info('browser', 'Chrome already running', { port: CHROME_PORT });
    return {
      changed: false,
      message: 'Chrome is already running',
      status,
    };
  }

  await runCommand(`mkdir -p "${CHROME_PROFILE_DIR}"`);
  const cmd = buildStartChromeCommand();
  log.info('browser', 'launching Chrome', { port: CHROME_PORT, profile: CHROME_PROFILE_DIR });
  const result = await runCommand(cmd);

  await new Promise((r) => setTimeout(r, 15000));
  const nextStatus = await getChromeStatus();
  log.info('browser', 'startChrome done', { running: nextStatus.running, commandOk: result.ok });

  return {
    changed: true,
    message: nextStatus.running
      ? 'Chrome started successfully'
      : 'Chrome start command executed, but browser is not confirmed running yet',
    commandOk: result.ok,
    status: nextStatus,
    stderr: result.stderr,
  };
}

function resetPlaywrightConnectionLazy() {
  log.info('browser', 'reset Playwright CDP connection (Chrome stopped)');
  require('./playwright-controller').resetPlaywrightConnection();
}

async function stopChrome() {
  log.info('browser', 'stopChrome requested');
  const status = await getChromeStatus();
  if (!status.running) {
    log.info('browser', 'Chrome not running, skip stop');
    return {
      changed: false,
      message: 'Chrome is not running',
      status,
    };
  }

  let result;
  if (status.pid) {
    log.info('browser', `sending SIGTERM to Chrome pid ${status.pid}`);
    result = await runCommand(`kill ${status.pid}`);
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    log.info('browser', 'no pid, using pkill pattern for Chrome');
    result = await runCommand(`pkill -f "Google Chrome.*--remote-debugging-port=${CHROME_PORT}"`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const nextStatus = await getChromeStatus();
  log.info('browser', 'stopChrome done', { stillRunning: nextStatus.running });

  if (!nextStatus.running) {
    resetPlaywrightConnectionLazy();
  }

  return {
    changed: true,
    message: nextStatus.running
      ? 'Chrome stop command executed, but browser still appears to be running'
      : 'Chrome stopped successfully',
    commandOk: result.ok,
    status: nextStatus,
    stderr: result.stderr,
  };
}

async function restartChrome() {
  log.info('browser', 'restartChrome requested');
  const stopResult = await stopChrome();
  await new Promise((r) => setTimeout(r, 1200));
  const startResult = await startChrome();
  log.info('browser', 'restartChrome completed');

  return {
    changed: true,
    message: 'Chrome restart completed',
    stop: stopResult,
    start: startResult,
  };
}

module.exports = {
  CHROME_PORT,
  CHROME_PROFILE_DIR,
  CHROME_BINARY,
  getChromeStatus,
  startChrome,
  stopChrome,
  restartChrome,
};
