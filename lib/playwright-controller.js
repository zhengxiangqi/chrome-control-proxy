const vm = require('vm');
const { chromium } = require('playwright');
const { getChromeStatus, CHROME_PORT } = require('./browser-controller');
const log = require('./logger');

const CDP_URL = process.env.CDP_URL || `http://127.0.0.1:${CHROME_PORT}`;

const PLAYWRIGHT_RUN_MAX_SCRIPT_CHARS =
  Number(process.env.PLAYWRIGHT_RUN_MAX_SCRIPT_CHARS) || 524288;
const PLAYWRIGHT_RUN_DEFAULT_MS = Number(process.env.PLAYWRIGHT_RUN_DEFAULT_MS) || 120000;
const PLAYWRIGHT_PAGE_DOM_MAX_CHARS =
  Number(process.env.PLAYWRIGHT_PAGE_DOM_MAX_CHARS) || 2000000;
const PLAYWRIGHT_SNAPSHOT_MAX_ITEMS = Number(process.env.PLAYWRIGHT_SNAPSHOT_MAX_ITEMS) || 300;

function parsePositiveMs(envVal, fallback) {
  const n = Number(envVal);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return fallback;
}

function applyPageDefaultTimeouts(page) {
  const actionMs = parsePositiveMs(process.env.PLAYWRIGHT_PAGE_DEFAULT_TIMEOUT_MS, 60000);
  const navMs = parsePositiveMs(
    process.env.PLAYWRIGHT_NAVIGATION_DEFAULT_TIMEOUT_MS,
    Math.max(actionMs, 90000),
  );
  page.setDefaultTimeout(actionMs);
  page.setDefaultNavigationTimeout(navMs);
  log.debug('playwright', 'setDefaultTimeout', { actionMs, navigationMs: navMs });
}

let playwrightBrowserPromise = null;
let queueJobSeq = 0;

function createAsyncQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const id = ++queueJobSeq;
    const run = tail.then(async () => {
      const t0 = Date.now();
      log.info('queue', `playwright job #${id} start`);
      try {
        const r = await fn();
        log.info('queue', `playwright job #${id} ok ${Date.now() - t0}ms`);
        return r;
      } catch (e) {
        log.error('queue', `playwright job #${id} failed ${Date.now() - t0}ms`, e);
        throw e;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
}

const enqueuePlaywright = createAsyncQueue();

function tryPageUrl(page) {
  try {
    if (!page || typeof page.url !== 'function') {
      return undefined;
    }
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      return undefined;
    }
    return page.url();
  } catch (_) {
    return undefined;
  }
}

function truncateStr(s, max) {
  if (typeof s !== 'string') {
    return { text: '', truncated: false };
  }
  const n = Math.min(Number(max) || PLAYWRIGHT_PAGE_DOM_MAX_CHARS, PLAYWRIGHT_PAGE_DOM_MAX_CHARS);
  if (s.length <= n) {
    return { text: s, truncated: false };
  }
  return { text: s.slice(0, n), truncated: true };
}

function truncateJsonValue(obj, maxChars) {
  const raw = JSON.stringify(obj);
  if (raw === undefined) {
    return { value: obj, truncated: false, jsonLength: 0 };
  }
  const t = truncateStr(raw, maxChars);
  if (!t.truncated) {
    return { value: obj, truncated: false, jsonLength: raw.length };
  }
  return {
    value: null,
    truncated: true,
    jsonLength: raw.length,
    preview: t.text,
  };
}

function getSnapshotMode(mode) {
  return mode === 'compact' ? 'compact' : 'full';
}

async function collectPlaywrightInteractiveSnapshot(page, options) {
  const { selector, maxItems, mode } = options;
  const maxN = Math.min(
    Math.max(1, Number(maxItems) || PLAYWRIGHT_SNAPSHOT_MAX_ITEMS),
    2000,
  );
  const snapshotMode = getSnapshotMode(mode);

  return page.evaluate(
    ({ rootSelector, maxCount, snapshotMode }) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document.body;
      if (!root) {
        return {
          error: 'selector did not match any element',
          targets: [],
          visibleTotal: 0,
          listTruncated: false,
          mode: snapshotMode,
        };
      }

      const query = [
        'input:not([type="hidden"])',
        'button',
        'a[href]',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="combobox"]',
        '[role="searchbox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[contenteditable="true"]',
      ].join(',');

      function isVisible(el) {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) {
          return false;
        }
        return true;
      }

      function suggestLocator(el) {
        const tag = el.tagName.toLowerCase();
        const tid =
          el.getAttribute('data-testid') ||
          el.getAttribute('data-test-id') ||
          el.getAttribute('data-cy');
        if (tid) {
          return `page.getByTestId(${JSON.stringify(tid)})`;
        }
        const name = el.getAttribute('name');
        const id = el.id;
        if (id) {
          const safe = '#' + CSS.escape(id);
          return `page.locator(${JSON.stringify(safe)})`;
        }
        if (name) {
          if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            return `page.locator(${JSON.stringify(`input[type="${t}"][name="${name}"]`)})`;
          }
          return `page.locator(${JSON.stringify(`[name="${name}"]`)})`;
        }
        const ph = el.getAttribute('placeholder');
        if (ph && (tag === 'input' || tag === 'textarea')) {
          return `page.getByPlaceholder(${JSON.stringify(ph)})`;
        }
        const al = el.getAttribute('aria-label');
        if (al) {
          return `page.getByLabel(${JSON.stringify(al)})`;
        }
        if (tag === 'a') {
          const href = el.getAttribute('href') || '';
          const txt = (el.textContent || '').trim().slice(0, 80);
          if (txt) {
            return `page.getByRole('link', { name: ${JSON.stringify(txt)} })`;
          }
          if (href) {
            return `page.locator(${JSON.stringify(`a[href="${href}"]`)})`;
          }
        }
        const r = el.getAttribute('role');
        const bt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (tag === 'button' || r === 'button') {
          if (bt) {
            return `page.getByRole('button', { name: ${JSON.stringify(bt)} })`;
          }
        }
        if (tag === 'select') {
          return `page.locator('select')`;
        }
        if (tag === 'textarea') {
          return `page.locator('textarea')`;
        }
        return `page.locator(${JSON.stringify(tag)})`;
      }

      const nodes = Array.from(root.querySelectorAll(query));
      const visibleEls = nodes.filter(isVisible);
      const listTruncated = visibleEls.length > maxCount;
      const slice = visibleEls.slice(0, maxCount);

      const targets = slice.map((el) => {
        const tag = el.tagName.toLowerCase();
        const typeAttr = el.getAttribute('type');
        const base = {
          tag,
          text: (el.innerText || el.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 160),
          placeholder: el.getAttribute('placeholder'),
          role: el.getAttribute('role'),
          suggestedLocator: suggestLocator(el),
        };
        if (snapshotMode === 'compact') {
          return base;
        }
        return {
          ...base,
          type: typeAttr ? typeAttr.toLowerCase() : null,
          name: el.getAttribute('name'),
          id: el.id || null,
          testId:
            el.getAttribute('data-testid') ||
            el.getAttribute('data-test-id') ||
            el.getAttribute('data-cy') ||
            null,
          ariaLabel: el.getAttribute('aria-label'),
          href: el.getAttribute('href') ? el.getAttribute('href').slice(0, 400) : null,
          disabled:
            el.disabled === true || String(el.getAttribute('aria-disabled')).toLowerCase() === 'true',
        };
      });

      return {
        targets,
        visibleTotal: visibleEls.length,
        listTruncated,
        maxCount,
        mode: snapshotMode,
      };
    },
    { rootSelector: selector || null, maxCount: maxN, snapshotMode },
  );
}

function resetPlaywrightConnection() {
  log.warn('playwright', 'CDP browser handle cache cleared');
  playwrightBrowserPromise = null;
}

async function getPlaywrightBrowser() {
  if (playwrightBrowserPromise) {
    try {
      const browser = await playwrightBrowserPromise;
      if (browser.isConnected()) {
        log.debug('playwright', 'reuse CDP connection', { cdpUrl: CDP_URL });
        return browser;
      }
    } catch (_) {
      /* reconnect */
    }
    playwrightBrowserPromise = null;
    log.warn('playwright', 'previous CDP connection invalid, reconnecting');
  }

  const status = await getChromeStatus();
  if (!status.running) {
    log.error('playwright', 'Chrome not listening, cannot connect CDP', { cdpUrl: CDP_URL });
    const err = new Error('Chrome is not running; start browser first');
    err.code = 'CHROME_DOWN';
    throw err;
  }

  log.info('playwright', 'connecting CDP', { cdpUrl: CDP_URL });
  playwrightBrowserPromise = chromium.connectOverCDP(CDP_URL);
  try {
    const b = await playwrightBrowserPromise;
    log.info('playwright', 'CDP connected', { connected: b.isConnected() });
    return b;
  } catch (err) {
    playwrightBrowserPromise = null;
    log.error('playwright', 'CDP connect failed', err);
    throw err;
  }
}

async function resolveBrowserContextPage(options) {
  const {
    url,
    waitUntil = 'load',
    timeout = 30000,
    target = 'first',
  } = options;

  const browser = await getPlaywrightBrowser();
  let context = browser.contexts()[0];
  if (!context) {
    log.info('playwright', 'no browser context, creating new context');
    context = await browser.newContext();
  }

  let page;
  if (target === 'new') {
    page = await context.newPage();
    log.debug('playwright', 'new page', { target });
  } else {
    const pages = context.pages();
    if (pages.length === 0) {
      page = await context.newPage();
      log.debug('playwright', 'no pages, new page', { target });
    } else if (target === 'last') {
      page = pages[pages.length - 1];
      log.debug('playwright', 'using last page', { index: pages.length - 1 });
    } else {
      page = pages[0];
      log.debug('playwright', 'using first page', { pageCount: pages.length });
    }
  }

  if (url) {
    log.info('playwright', 'page.goto', { url, waitUntil, timeout, target });
    await page.goto(url, { waitUntil, timeout });
    log.debug('playwright', 'after goto', { currentUrl: page.url() });
  }

  applyPageDefaultTimeouts(page);

  return { browser, context, page };
}

async function resolvePage(options) {
  const { page } = await resolveBrowserContextPage(options);
  return page;
}

function sleepRace(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function packScriptReturnValue(value) {
  if (value === undefined) {
    return { finished: true, hasReturnValue: false };
  }
  try {
    const serialized = JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    return { finished: true, hasReturnValue: true, result: serialized };
  } catch {
    return { finished: true, hasReturnValue: true, resultText: String(value) };
  }
}

function assertValidUserScript(userScript) {
  if (typeof userScript !== 'string') {
    const err = new Error('script must be a string');
    err.code = 'BAD_SCRIPT';
    throw err;
  }
  if (userScript.length > PLAYWRIGHT_RUN_MAX_SCRIPT_CHARS) {
    const err = new Error(`script exceeds ${PLAYWRIGHT_RUN_MAX_SCRIPT_CHARS} characters`);
    err.code = 'SCRIPT_TOO_LARGE';
    throw err;
  }
}

async function collectHtmlPayload(page, locator, maxHtmlChars, includeHtml) {
  if (!includeHtml) {
    return {
      html: null,
      htmlLength: null,
      truncated: null,
    };
  }

  const htmlFull = locator
    ? await locator.evaluate((el) => el.outerHTML)
    : await page.content();
  const maxH = Math.min(
    Number(maxHtmlChars) || PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
  );
  const truncatedHtml = truncateStr(htmlFull, maxH);
  return {
    html: truncatedHtml.text,
    htmlLength: htmlFull.length,
    truncated: truncatedHtml.truncated,
  };
}

async function collectInnerTextPayload(page, locator, maxTextChars, includeInnerText) {
  if (!includeInnerText) {
    return {};
  }

  const textFull = locator ? await locator.innerText() : await page.innerText('body');
  const maxT = Math.min(
    Number(maxTextChars) || PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
  );
  const truncatedText = truncateStr(textFull, maxT);
  return {
    innerText: truncatedText.text,
    innerTextLength: textFull.length,
    innerTextTruncated: truncatedText.truncated,
  };
}

async function collectAccessibilityPayload(page, locator, maxA11yChars, includeAccessibility) {
  if (!includeAccessibility) {
    return {};
  }

  const rootHandle = locator ? await locator.elementHandle() : null;
  const snap = await page.accessibility.snapshot({ root: rootHandle || undefined });
  const maxA = Math.min(
    Number(maxA11yChars) || PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
  );
  const packed = truncateJsonValue(snap, maxA);
  if (packed.truncated) {
    return {
      accessibility: null,
      accessibilityTruncated: true,
      accessibilityJsonLength: packed.jsonLength,
      accessibilityPreview: packed.preview,
    };
  }
  return {
    accessibility: packed.value,
    accessibilityTruncated: false,
    accessibilityJsonLength: packed.jsonLength,
  };
}

async function collectPlaywrightSnapshotPayload(page, options) {
  const {
    selector,
    maxPlaywrightTargets,
    maxPlaywrightJsonChars,
    includePlaywrightSnapshot,
    playwrightSnapshotMode,
  } = options;

  if (!includePlaywrightSnapshot) {
    return {};
  }

  const snapshot = await collectPlaywrightInteractiveSnapshot(page, {
    selector,
    maxItems: maxPlaywrightTargets,
    mode: playwrightSnapshotMode,
  });
  const maxP = Math.min(
    Number(maxPlaywrightJsonChars) || PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
  );
  const packed = truncateJsonValue(snapshot, maxP);
  if (packed.truncated) {
    return {
      playwright: null,
      playwrightTruncated: true,
      playwrightJsonLength: packed.jsonLength,
      playwrightPreview: packed.preview,
    };
  }
  return {
    playwright: packed.value,
    playwrightTruncated: false,
    playwrightJsonLength: packed.jsonLength,
  };
}

async function buildPageDomPayloadFromPage(page, options) {
  const {
    timeout = 30000,
    maxHtmlChars = PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    maxTextChars = PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    maxA11yChars = PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    maxPlaywrightJsonChars = PLAYWRIGHT_PAGE_DOM_MAX_CHARS,
    selector,
    includeHtml = true,
    includeInnerText = false,
    includeAccessibility = false,
    includePlaywrightSnapshot = false,
    maxPlaywrightTargets,
    playwrightSnapshotMode = 'full',
  } = options;

  const locator = selector ? page.locator(selector).first() : null;
  if (locator) {
    await locator.waitFor({ state: 'attached', timeout });
  }

  const currentUrl = page.url();
  const [title, htmlPayload, innerTextPayload, accessibilityPayload, snapshotPayload] = await Promise.all([
    page.title(),
    collectHtmlPayload(page, locator, maxHtmlChars, includeHtml),
    collectInnerTextPayload(page, locator, maxTextChars, includeInnerText),
    collectAccessibilityPayload(page, locator, maxA11yChars, includeAccessibility),
    collectPlaywrightSnapshotPayload(page, {
      selector,
      maxPlaywrightTargets,
      maxPlaywrightJsonChars,
      includePlaywrightSnapshot,
      playwrightSnapshotMode,
    }),
  ]);

  return {
    currentUrl,
    title,
    selector: selector || null,
    ...htmlPayload,
    ...innerTextPayload,
    ...accessibilityPayload,
    ...snapshotPayload,
  };
}

async function getPageDomPayload(options) {
  let page;
  const tStart = Date.now();
  try {
    const {
      url,
      waitUntil = 'load',
      timeout = 30000,
      target = 'first',
      selector,
      includeHtml = true,
      includeInnerText = false,
      includeAccessibility = false,
      includePlaywrightSnapshot = false,
      playwrightSnapshotMode = 'full',
    } = options;

    log.info('playwright', 'page-dom start', {
      url: url || null,
      target,
      waitUntil,
      includeHtml,
      includeInnerText,
      includeAccessibility,
      includePlaywrightSnapshot,
      playwrightSnapshotMode: getSnapshotMode(playwrightSnapshotMode),
      selector: selector || null,
    });

    page = await resolvePage({
      url,
      waitUntil,
      timeout,
      target,
    });

    const payload = await buildPageDomPayloadFromPage(page, options);
    log.info('playwright', `page-dom done ${Date.now() - tStart}ms`, {
      title: payload.title,
      currentUrl: payload.currentUrl,
    });
    return payload;
  } catch (err) {
    err.currentUrl = err.currentUrl || tryPageUrl(page);
    log.error('playwright', `page-dom failed ${Date.now() - tStart}ms`, err);
    throw err;
  }
}

async function executePlaywrightUserScript(browser, context, page, userScript, scriptTimeout) {
  const sandbox = vm.createContext({
    browser,
    context,
    page,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  const wrapped = `(async () => {\n${userScript}\n})()`;
  const scriptVm = new vm.Script(wrapped, { filename: 'playwright-run-user.js' });
  const completion = scriptVm.runInContext(sandbox, { displayErrors: true });
  const run = async () => {
    if (completion && typeof completion.then === 'function') {
      return completion;
    }
    return completion;
  };
  return sleepRace(run(), scriptTimeout, 'playwright script');
}

async function runPlaywrightUserScript(userScript, options) {
  let page;
  const tStart = Date.now();
  try {
    const {
      url,
      waitUntil,
      timeout,
      target,
      scriptTimeout = PLAYWRIGHT_RUN_DEFAULT_MS,
    } = options;

    assertValidUserScript(userScript);

    log.info('playwright', 'run script start', {
      scriptChars: userScript.length,
      outerUrl: url || null,
      waitUntil: waitUntil || 'load',
      target: target || 'first',
      scriptTimeout,
    });

    const { browser, context, page: resolvedPage } = await resolveBrowserContextPage({
      url,
      waitUntil: waitUntil || 'load',
      timeout: timeout ?? 30000,
      target: target || 'first',
    });
    page = resolvedPage;
    const scriptReturn = await executePlaywrightUserScript(browser, context, page, userScript, scriptTimeout);

    log.info('playwright', `run script done ${Date.now() - tStart}ms`, {
      currentUrl: page.url(),
      hasReturn: scriptReturn !== undefined,
    });
    return { browser, context, page, result: scriptReturn };
  } catch (err) {
    err.currentUrl = err.currentUrl || tryPageUrl(page);
    log.error('playwright', `run script failed ${Date.now() - tStart}ms`, err);
    throw err;
  }
}

async function runPlaywrightPipeline(options) {
  let page;
  const tStart = Date.now();
  try {
    const {
      url,
      waitUntil,
      timeout,
      target,
      beforePageDom,
      afterPageDom,
      script,
      scriptTimeout = PLAYWRIGHT_RUN_DEFAULT_MS,
    } = options;

    log.info('playwright', 'pipeline start', {
      outerUrl: url || null,
      waitUntil: waitUntil || 'load',
      target: target || 'first',
      hasBeforePageDom: Boolean(beforePageDom),
      hasScript: typeof script === 'string' && script !== '',
      hasAfterPageDom: Boolean(afterPageDom),
    });

    const { browser, context, page: resolvedPage } = await resolveBrowserContextPage({
      url,
      waitUntil: waitUntil || 'load',
      timeout: timeout ?? 30000,
      target: target || 'first',
    });
    page = resolvedPage;

    const response = {
      currentUrl: page.url(),
    };

    if (beforePageDom) {
      response.before = await buildPageDomPayloadFromPage(page, beforePageDom);
      response.currentUrl = page.url();
    }

    if (typeof script === 'string' && script !== '') {
      assertValidUserScript(script);
      const scriptResult = await executePlaywrightUserScript(browser, context, page, script, scriptTimeout);
      Object.assign(response, packScriptReturnValue(scriptResult));
      response.currentUrl = page.url();
    }

    if (afterPageDom) {
      response.after = await buildPageDomPayloadFromPage(page, afterPageDom);
      response.currentUrl = page.url();
    }

    log.info('playwright', `pipeline done ${Date.now() - tStart}ms`, {
      currentUrl: response.currentUrl,
      hasBefore: Boolean(response.before),
      hasAfter: Boolean(response.after),
      hasReturnValue: Boolean(response.hasReturnValue),
    });
    return response;
  } catch (err) {
    err.currentUrl = err.currentUrl || tryPageUrl(page);
    log.error('playwright', `pipeline failed ${Date.now() - tStart}ms`, err);
    throw err;
  }
}

module.exports = {
  CDP_URL,
  PLAYWRIGHT_RUN_DEFAULT_MS,
  resetPlaywrightConnection,
  getPlaywrightBrowser,
  enqueuePlaywright,
  getPageDomPayload,
  runPlaywrightUserScript,
  runPlaywrightPipeline,
  packScriptReturnValue,
};
