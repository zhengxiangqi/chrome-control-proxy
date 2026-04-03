'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : 2;

const PREFIX = '[chrome-control-proxy]';
const LOG_DIR = process.env.LOG_DIR || '';
const LOG_CONSOLE = !/^(0|false|no)$/i.test(String(process.env.LOG_CONSOLE ?? 'true'));
const LOG_MAX_FILE_MB = Math.max(0, Number(process.env.LOG_MAX_FILE_MB) || 0);
const LOG_MAX_BYTES = LOG_MAX_FILE_MB > 0 ? Math.floor(LOG_MAX_FILE_MB * 1024 * 1024) : 0;

let fileStream = null;
let streamDateKey = null;
let streamPart = 0;
let bytesInCurrentFile = 0;

function ts() {
  return new Date().toISOString();
}

function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

function formatErr(e) {
  if (e === undefined || e === null) {
    return '';
  }
  if (e instanceof Error) {
    return `${e.message}\n${e.stack || ''}`;
  }
  if (typeof e === 'object') {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

function fmtMeta(meta) {
  if (meta === undefined || meta === null) {
    return '';
  }
  if (typeof meta === 'object' && !(meta instanceof Error)) {
    try {
      return JSON.stringify(meta);
    } catch {
      return String(meta);
    }
  }
  return String(meta);
}

function buildFileText(level, ns, msg, extra) {
  let text = `${PREFIX} ${ts()} [${level}] [${ns}] ${msg}`;
  if (extra !== undefined && extra !== '') {
    if (level === 'error') {
      text += `\n${formatErr(extra)}`;
    } else {
      text += ` ${fmtMeta(extra)}`;
    }
  }
  return `${text}\n`;
}

function fileNameForPart(dk, part) {
  return part === 0
    ? `ccp-${dk}.log`
    : `ccp-${dk}.${part}.log`;
}

function openNewStream(dk, part) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fullPath = path.join(LOG_DIR, fileNameForPart(dk, part));
  return fs.createWriteStream(fullPath, { flags: 'a' });
}

function closeFileStreamSync() {
  if (!fileStream) {
    return;
  }
  try {
    fileStream.end();
  } catch (_) {
    /* */
  }
  fileStream = null;
}

function closeFileStream() {
  return new Promise((resolve) => {
    if (!fileStream) {
      resolve();
      return;
    }
    const s = fileStream;
    fileStream = null;
    streamDateKey = null;
    streamPart = 0;
    bytesInCurrentFile = 0;
    s.end(() => resolve());
  });
}

function ensureFileStreamBeforeWrite(chunkByteLength) {
  const dk = dateKey();

  if (!fileStream) {
    streamDateKey = dk;
    streamPart = 0;
    bytesInCurrentFile = 0;
    fileStream = openNewStream(streamDateKey, streamPart);
    return;
  }

  if (streamDateKey !== dk) {
    closeFileStreamSync();
    streamDateKey = dk;
    streamPart = 0;
    bytesInCurrentFile = 0;
    fileStream = openNewStream(streamDateKey, streamPart);
    return;
  }

  if (
    LOG_MAX_BYTES > 0 &&
    bytesInCurrentFile + chunkByteLength > LOG_MAX_BYTES &&
    bytesInCurrentFile > 0
  ) {
    closeFileStreamSync();
    streamPart += 1;
    bytesInCurrentFile = 0;
    fileStream = openNewStream(streamDateKey, streamPart);
  }
}

function writeFileLog(level, ns, msg, extra) {
  if (!LOG_DIR) {
    return;
  }
  const chunk = buildFileText(level, ns, msg, extra);
  const bufLen = Buffer.byteLength(chunk, 'utf8');

  try {
    ensureFileStreamBeforeWrite(bufLen);
    if (fileStream) {
      fileStream.write(chunk);
      bytesInCurrentFile += bufLen;
    }
  } catch (e) {
    console.error(`${PREFIX} logger file sink error`, e);
  }
}

function emit(level, ns, msg, extra) {
  if (LEVELS[level] > threshold) {
    return;
  }
  const line = `${PREFIX} ${ts()} [${level}] [${ns}] ${msg}`;
  if (LOG_CONSOLE) {
    if (level === 'error') {
      console.error(line, extra !== undefined && extra !== '' ? formatErr(extra) : '');
    } else if (level === 'warn') {
      console.warn(line, extra !== undefined ? fmtMeta(extra) : '');
    } else {
      console.log(line, extra !== undefined ? fmtMeta(extra) : '');
    }
  }
  writeFileLog(level, ns, msg, extra);
}

module.exports = {
  error(ns, msg, err) {
    emit('error', ns, msg, err);
  },
  warn(ns, msg, meta) {
    emit('warn', ns, msg, meta);
  },
  info(ns, msg, meta) {
    emit('info', ns, msg, meta);
  },
  debug(ns, msg, meta) {
    emit('debug', ns, msg, meta);
  },
  closeFileSink: closeFileStream,
};
