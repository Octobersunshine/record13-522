const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.currentCount = 0;
    this.waitingQueue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (this.currentCount < this.maxConcurrency) {
        this.currentCount++;
        resolve();
      } else {
        this.waitingQueue.push(resolve);
      }
    });
  }

  release() {
    if (this.waitingQueue.length > 0) {
      const nextResolve = this.waitingQueue.shift();
      nextResolve();
    } else {
      this.currentCount = Math.max(0, this.currentCount - 1);
    }
  }

  getActiveCount() {
    return this.currentCount;
  }

  getWaitingCount() {
    return this.waitingQueue.length;
  }
}

class PagePool {
  constructor(browser, maxPages) {
    this.browser = browser;
    this.maxPages = maxPages;
    this.availablePages = [];
    this.activePages = new Set();
    this.waitingQueue = [];
    this.lock = Promise.resolve();
  }

  async acquire() {
    return this._withLock(async () => {
      if (this.availablePages.length > 0) {
        const page = this.availablePages.pop();
        this.activePages.add(page);
        return page;
      }

      if (this.activePages.size < this.maxPages) {
        const page = await this.browser.newPage();
        this._setupPageEventHandlers(page);
        this.activePages.add(page);
        return page;
      }

      return new Promise((resolve) => {
        this.waitingQueue.push(resolve);
      });
    });
  }

  async release(page) {
    await this._withLock(async () => {
      if (!this.activePages.has(page)) return;

      try {
        await page.goto('about:blank');
        await page.evaluate(() => {
          if (window.gc) window.gc();
        });
      } catch (_) {}

      this.activePages.delete(page);

      if (this.waitingQueue.length > 0) {
        const nextResolve = this.waitingQueue.shift();
        this.activePages.add(page);
        nextResolve(page);
      } else {
        if (this.availablePages.length < Math.ceil(this.maxPages / 2)) {
          this.availablePages.push(page);
        } else {
          await page.close().catch(() => {});
        }
      }
    });
  }

  _setupPageEventHandlers(page) {
    page.on('error', async () => {
      await this._removePage(page);
    });
    page.on('pageerror', async () => {});
    page.on('requestfailed', () => {});
  }

  async _removePage(page) {
    await this._withLock(async () => {
      this.activePages.delete(page);
      const idx = this.availablePages.indexOf(page);
      if (idx > -1) this.availablePages.splice(idx, 1);
      await page.close().catch(() => {});
    });
  }

  async _withLock(fn) {
    const result = this.lock.then(fn);
    this.lock = result.catch(() => {});
    return result;
  }

  getActiveCount() {
    return this.activePages.size;
  }

  getAvailableCount() {
    return this.availablePages.length;
  }

  getWaitingCount() {
    return this.waitingQueue.length;
  }

  async close() {
    for (const page of this.availablePages) {
      await page.close().catch(() => {});
    }
    for (const page of this.activePages) {
      await page.close().catch(() => {});
    }
    this.availablePages = [];
    this.activePages.clear();
  }
}

class PrerenderService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.browser = null;
    this.pagePool = null;
    this.outputDir = options.outputDir || path.join(__dirname, 'dist', 'prerendered');

    this.maxConcurrency = options.maxConcurrency || Math.min(4, Math.max(1, require('os').cpus().length - 1));
    this.maxPagesPerBrowser = options.maxPagesPerBrowser || Math.min(8, this.maxConcurrency * 2);
    this.maxQueueSize = options.maxQueueSize || 100;
    this.memoryThresholdMB = options.memoryThresholdMB || 2048;

    this.semaphore = new Semaphore(this.maxConcurrency);
    this.taskRegistry = new Map();
    this.taskIdCounter = 0;
    this.stats = {
      totalSubmitted: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalTimeMs: 0
    };

    this.memoryMonitorTimer = null;
    this._startMemoryMonitor();
    this.ensureOutputDir();
  }

  _startMemoryMonitor() {
    this.memoryMonitorTimer = setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      if (heapUsedMB > this.memoryThresholdMB) {
        this.emit('memory-warning', { heapUsedMB, threshold: this.memoryThresholdMB });
        this._cleanupResources();
      }
    }, 10000);
    this.memoryMonitorTimer.unref();
  }

  async _cleanupResources() {
    if (this.browser) {
      const pages = await this.browser.pages().catch(() => []);
      for (let i = pages.length - 1; i >= Math.ceil(pages.length / 2); i--) {
        await pages[i].close().catch(() => {});
      }
    }
    if (global.gc) global.gc();
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async launchBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--ignore-certificate-errors',
          '--ignore-ssl-errors',
          '--ignore-certificate-errors-spki-list',
          `--memory-pressure-threshold-mb=${this.memoryThresholdMB}`
        ],
        timeout: 60000,
        protocolTimeout: 300000
      });

      this.pagePool = new PagePool(this.browser, this.maxPagesPerBrowser);

      this.browser.on('disconnected', () => {
        this.browser = null;
        this.pagePool = null;
        this.emit('browser-disconnected');
      });

      this.emit('browser-launched');
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.memoryMonitorTimer) {
      clearInterval(this.memoryMonitorTimer);
      this.memoryMonitorTimer = null;
    }
    if (this.pagePool) {
      await this.pagePool.close();
      this.pagePool = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  _generateTaskId() {
    return `task_${Date.now()}_${++this.taskIdCounter}`;
  }

  _registerTask(taskId, route, type) {
    this.taskRegistry.set(taskId, {
      id: taskId,
      route,
      type,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      error: null
    });
    this.stats.totalSubmitted++;
  }

  _updateTaskStatus(taskId, status, data = {}) {
    const task = this.taskRegistry.get(taskId);
    if (!task) return;
    task.status = status;
    if (status === 'running') task.startedAt = Date.now();
    if (status === 'completed' || status === 'failed') {
      task.completedAt = Date.now();
      if (status === 'completed') {
        this.stats.totalCompleted++;
        this.stats.totalTimeMs += (task.completedAt - task.startedAt);
      } else {
        this.stats.totalFailed++;
        task.error = data.error || null;
      }
    }
    this.emit(`task:${status}`, { ...task });
  }

  _cleanupOldTasks() {
    const cutoff = Date.now() - 3600000;
    for (const [taskId, task] of this.taskRegistry) {
      if (task.completedAt && task.completedAt < cutoff) {
        this.taskRegistry.delete(taskId);
      }
    }
  }

  getQueueStatus() {
    this._cleanupOldTasks();
    const memUsage = process.memoryUsage();
    return {
      semaphore: {
        maxConcurrency: this.maxConcurrency,
        active: this.semaphore.getActiveCount(),
        waiting: this.semaphore.getWaitingCount()
      },
      pagePool: this.pagePool ? {
        maxPages: this.maxPagesPerBrowser,
        active: this.pagePool.getActiveCount(),
        available: this.pagePool.getAvailableCount(),
        waiting: this.pagePool.getWaitingCount()
      } : null,
      queue: {
        maxSize: this.maxQueueSize,
        currentWaiting: this.semaphore.getWaitingCount(),
        isOverloaded: this.semaphore.getWaitingCount() >= this.maxQueueSize
      },
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        thresholdMB: this.memoryThresholdMB,
        isHigh: Math.round(memUsage.heapUsed / 1024 / 1024) > this.memoryThresholdMB
      },
      stats: {
        ...this.stats,
        avgTimeMs: this.stats.totalCompleted > 0
          ? Math.round(this.stats.totalTimeMs / this.stats.totalCompleted)
          : 0
      },
      tasks: {
        totalRegistered: this.taskRegistry.size,
        queued: [...this.taskRegistry.values()].filter(t => t.status === 'queued').length,
        running: [...this.taskRegistry.values()].filter(t => t.status === 'running').length,
        completed: [...this.taskRegistry.values()].filter(t => t.status === 'completed').length,
        failed: [...this.taskRegistry.values()].filter(t => t.status === 'failed').length
      }
    };
  }

  async renderPage(baseUrl, route, options = {}) {
    if (this.semaphore.getWaitingCount() >= this.maxQueueSize) {
      throw new Error(`任务队列已满（最大 ${this.maxQueueSize}），请稍后重试`);
    }

    const taskId = this._generateTaskId();
    this._registerTask(taskId, route, 'single');
    this._updateTaskStatus(taskId, 'queued');

    await this.semaphore.acquire();
    this._updateTaskStatus(taskId, 'running');

    const startTime = Date.now();

    try {
      await this.launchBrowser();
      const page = await this.pagePool.acquire();

      const result = await this._doRender(page, baseUrl, route, options);

      await this.pagePool.release(page);

      this._updateTaskStatus(taskId, 'completed');
      return { ...result, taskId, durationMs: Date.now() - startTime };

    } catch (error) {
      this._updateTaskStatus(taskId, 'failed', { error: error.message });
      throw error;
    } finally {
      this.semaphore.release();
    }
  }

  async _doRender(page, baseUrl, route, options) {
    const {
      waitUntil = 'networkidle0',
      timeout = 30000,
      waitForSelector = null,
      removeScripts = false,
      inlineStyles = false,
      useHash = false
    } = options;

    const fullUrl = this.buildUrl(baseUrl, route, useHash);

    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (compatible; PrerenderBot/1.0)');
      await page.setRequestInterception(true);

      page.on('request', (req) => {
        const resourceType = req.resourceType();
        const blockedTypes = ['image', 'media', 'font', 'websocket'];
        if (blockedTypes.includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(fullUrl, {
        waitUntil,
        timeout
      });

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout });
      } else {
        await this.waitForRenderComplete(page, timeout);
      }

      page.removeAllListeners('request');
      await page.setRequestInterception(false);

      let html = await page.content();

      if (removeScripts) {
        html = this.removeScriptTags(html);
      }

      const outputPath = this.getOutputPath(route);
      this.saveHtml(html, outputPath);

      return {
        html,
        route,
        outputPath,
        url: fullUrl,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`预渲染路由 [${route}] 失败: ${error.message}`);
    }
  }

  buildUrl(baseUrl, route, useHash = false) {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const cleanRoute = route.startsWith('/') ? route : `/${route}`;
    if (useHash) {
      return `${cleanBase}#${cleanRoute}`;
    }
    return `${cleanBase}${cleanRoute}`;
  }

  async waitForRenderComplete(page, timeout) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const isReady = await page.evaluate(() => {
        if (window.__PRERENDER_READY__) return true;
        if (document.querySelector('[data-prerender-ready]')) return true;
        const hasContent = document.body && document.body.innerHTML.length > 1000;
        return hasContent;
      }).catch(() => false);
      if (isReady) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  removeScriptTags(html) {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<script[^>]*\/>/gi, '');
  }

  getOutputPath(route) {
    const cleanRoute = route.replace(/^\/+|\/+$/g, '');
    const fileName = cleanRoute || 'index';
    const dirPath = path.join(this.outputDir, path.dirname(fileName));
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const baseName = path.basename(fileName) || 'index';
    return path.join(dirPath, `${baseName}.html`);
  }

  saveHtml(html, outputPath) {
    fs.writeFileSync(outputPath, html, 'utf-8');
  }

  async renderMultiple(baseUrl, routes, options = {}) {
    const {
      concurrency = this.maxConcurrency,
      onProgress = null,
      stopOnError = false
    } = options;

    const effectiveConcurrency = Math.min(Math.max(1, concurrency), this.maxConcurrency);
    const taskConcurrencySem = new Semaphore(effectiveConcurrency);

    const batchId = this._generateTaskId();
    const results = new Array(routes.length);
    let completedCount = 0;
    let failedCount = 0;

    this.emit('batch:start', { batchId, totalRoutes: routes.length, concurrency: effectiveConcurrency });

    const processRoute = async (route, index) => {
      await taskConcurrencySem.acquire();
      try {
        const result = await this.renderPage(baseUrl, route, options);
        results[index] = { success: true, ...result };
        completedCount++;
      } catch (error) {
        results[index] = {
          success: false,
          route,
          error: error.message
        };
        failedCount++;
        if (stopOnError) throw error;
      } finally {
        taskConcurrencySem.release();
        if (onProgress) {
          onProgress({
            batchId,
            total: routes.length,
            completed: completedCount,
            failed: failedCount,
            remaining: routes.length - completedCount - failedCount,
            progress: Math.round(((completedCount + failedCount) / routes.length) * 100)
          });
        }
      }
    };

    const promises = routes.map((route, index) => processRoute(route, index));
    await Promise.all(promises);

    this.emit('batch:complete', {
      batchId,
      totalRoutes: routes.length,
      completedCount,
      failedCount
    });

    return {
      batchId,
      total: routes.length,
      completed: completedCount,
      failed: failedCount,
      results
    };
  }

  getOutputDir() {
    return this.outputDir;
  }
}

module.exports = PrerenderService;
