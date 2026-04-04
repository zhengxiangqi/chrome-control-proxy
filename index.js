const express = require('express');
const log = require('./lib/logger');
const {
  getChromeStatus,
  startChrome,
  stopChrome,
  restartChrome,
} = require('./lib/browser-controller');
const {
  CDP_URL,
  PLAYWRIGHT_RUN_DEFAULT_MS,
  getPlaywrightBrowser,
  enqueuePlaywright,
  getPageDomPayload,
  runPlaywrightUserScript,
  runPlaywrightPipeline,
  packScriptReturnValue,
} = require('./lib/playwright-controller');

process.on('uncaughtException', (e) => {
  log.error('process', 'uncaughtException', e);
  process.exit(1);
});
process.on('unhandledRejection', (r) => {
  log.error('process', 'unhandledRejection', r);
});

function shutdown(signal) {
  log.info('server', `shutdown ${signal}`);
  const { closeFileSink } = require('./lib/logger');
  closeFileSink()
    .catch(() => {})
    .finally(() => {
      process.exit(0);
    });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const app = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '16mb';
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    log.info('http', `${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3333;

function sendPlaywrightError(res, err) {
  log.error('http', `response error ${err.code || 500}`, err);
  const currentUrl = err.currentUrl;
  const base = {
    ok: false,
    error: err.message || String(err),
    ...(currentUrl && { currentUrl }),
    ...(err.name && err.name !== 'Error' && { errorName: err.name }),
  };
  if (err.code === 'CHROME_DOWN') {
    return res.status(503).json({ ...base, code: err.code });
  }
  return res.status(500).json(base);
}

app.get('/health', async (_req, res) => {
  const status = await getChromeStatus();
  res.json({
    ok: true,
    service: 'chrome-control',
    browser: status,
  });
});

app.get('/browser/status', async (_req, res) => {
  const status = await getChromeStatus();
  res.json({
    ok: true,
    ...status,
  });
});

app.post('/browser/start', async (_req, res) => {
  log.info('http', 'POST /browser/start');
  const result = await startChrome();
  res.json({
    ok: true,
    ...result,
  });
});

app.post('/browser/stop', async (_req, res) => {
  log.info('http', 'POST /browser/stop');
  const result = await stopChrome();
  res.json({
    ok: true,
    ...result,
  });
});

app.post('/browser/restart', async (_req, res) => {
  log.info('http', 'POST /browser/restart');
  const result = await restartChrome();
  res.json({
    ok: true,
    ...result,
  });
});

app.get('/playwright/status', async (_req, res) => {
  try {
    const browser = await getPlaywrightBrowser();
    res.json({
      ok: true,
      connected: browser.isConnected(),
      cdpUrl: CDP_URL,
      contextCount: browser.contexts().length,
    });
  } catch (err) {
    sendPlaywrightError(res, err);
  }
});

app.post('/playwright/page-dom', async (req, res) => {
  try {
    const b = req.body || {};
    log.info('http', 'POST /playwright/page-dom');
    const payload = await enqueuePlaywright(() =>
      getPageDomPayload({
        url: b.url,
        waitUntil: b.waitUntil || 'domcontentloaded',
        timeout: b.timeout ?? 30000,
        target: b.target || 'first',
        maxHtmlChars: b.maxHtmlChars,
        maxTextChars: b.maxTextChars,
        maxA11yChars: b.maxA11yChars,
        maxPlaywrightJsonChars: b.maxPlaywrightJsonChars,
        selector: b.selector,
        includeHtml: b.includeHtml !== false,
        includeInnerText: Boolean(b.includeInnerText),
        includeAccessibility: Boolean(b.includeAccessibility),
        includePlaywrightSnapshot: Boolean(b.includePlaywrightSnapshot),
        maxPlaywrightTargets: b.maxPlaywrightTargets,
        playwrightSnapshotMode: b.playwrightSnapshotMode,
      }),
    );
    res.json({
      ok: true,
      step: 'page-dom',
      ...payload,
    });
  } catch (err) {
    sendPlaywrightError(res, err);
  }
});

app.post('/playwright/pipeline', async (req, res) => {
  try {
    const b = req.body || {};
    const hasScript = typeof b.script === 'string' && b.script !== '';
    const hasBefore = Boolean(b.beforePageDom);
    const hasAfter = Boolean(b.afterPageDom);
    if (!hasScript && !hasBefore && !hasAfter) {
      log.warn('http', 'POST /playwright/pipeline rejected: empty pipeline');
      return res.status(400).json({
        ok: false,
        error: 'pipeline requires at least one of beforePageDom, script, afterPageDom',
      });
    }
    log.info('http', 'POST /playwright/pipeline', {
      hasScript,
      hasBefore,
      hasAfter,
    });
    const payload = await enqueuePlaywright(() =>
      runPlaywrightPipeline({
        url: b.url,
        waitUntil: b.waitUntil || 'domcontentloaded',
        timeout: b.timeout ?? 30000,
        target: b.target || 'first',
        script: hasScript ? String(b.script) : undefined,
        scriptTimeout: b.scriptTimeout ?? PLAYWRIGHT_RUN_DEFAULT_MS,
        beforePageDom: hasBefore
          ? {
              ...b.beforePageDom,
              waitUntil: undefined,
              url: undefined,
              timeout: b.beforePageDom.timeout ?? b.timeout ?? 30000,
              includeHtml: b.beforePageDom.includeHtml !== false,
              includeInnerText: Boolean(b.beforePageDom.includeInnerText),
              includeAccessibility: Boolean(b.beforePageDom.includeAccessibility),
              includePlaywrightSnapshot: Boolean(b.beforePageDom.includePlaywrightSnapshot),
            }
          : null,
        afterPageDom: hasAfter
          ? {
              ...b.afterPageDom,
              waitUntil: undefined,
              url: undefined,
              timeout: b.afterPageDom.timeout ?? b.timeout ?? 30000,
              includeHtml: b.afterPageDom.includeHtml !== false,
              includeInnerText: Boolean(b.afterPageDom.includeInnerText),
              includeAccessibility: Boolean(b.afterPageDom.includeAccessibility),
              includePlaywrightSnapshot: Boolean(b.afterPageDom.includePlaywrightSnapshot),
            }
          : null,
      }),
    );
    res.json({
      ok: true,
      step: 'pipeline',
      ...payload,
    });
  } catch (err) {
    if (err.code === 'BAD_SCRIPT' || err.code === 'SCRIPT_TOO_LARGE') {
      log.warn('http', `playwright/pipeline client error ${err.code}`, err.message);
      return res.status(400).json({
        ok: false,
        error: err.message,
        code: err.code,
        ...(err.currentUrl && { currentUrl: err.currentUrl }),
      });
    }
    sendPlaywrightError(res, err);
  }
});

app.post('/playwright/run', async (req, res) => {
  try {
    const { script, url, waitUntil, timeout, target, scriptTimeout } = req.body || {};
    if (script === undefined || script === null || script === '') {
      log.warn('http', 'POST /playwright/run rejected: empty script');
      return res.status(400).json({ ok: false, error: 'script is required' });
    }
    log.info('http', 'POST /playwright/run', { scriptLen: String(script).length });
    const { page, result } = await enqueuePlaywright(() =>
      runPlaywrightUserScript(String(script), {
        url,
        waitUntil,
        timeout,
        target,
        scriptTimeout: scriptTimeout ?? PLAYWRIGHT_RUN_DEFAULT_MS,
      }),
    );
    res.json({
      ok: true,
      step: 'run',
      currentUrl: page.url(),
      ...packScriptReturnValue(result),
    });
  } catch (err) {
    if (err.code === 'BAD_SCRIPT' || err.code === 'SCRIPT_TOO_LARGE') {
      log.warn('http', `playwright/run client error ${err.code}`, err.message);
      return res.status(400).json({
        ok: false,
        error: err.message,
        code: err.code,
        ...(err.currentUrl && { currentUrl: err.currentUrl }),
      });
    }
    sendPlaywrightError(res, err);
  }
});

app.listen(PORT, HOST, () => {
  log.info('server', `listening http://${HOST}:${PORT}`, { cdpUrl: CDP_URL });
});
