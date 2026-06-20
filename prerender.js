const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

class PrerenderService {
  constructor() {
    this.browser = null;
    this.outputDir = path.join(__dirname, 'dist', 'prerendered');
    this.ensureOutputDir();
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
          '--disable-gpu'
        ]
      });
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async renderPage(baseUrl, route, options = {}) {
    const browser = await this.launchBrowser();
    const page = await browser.newPage();

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

      await page.goto(fullUrl, {
        waitUntil,
        timeout
      });

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout });
      } else {
        await this.waitForRenderComplete(page, timeout);
      }

      let html = await page.content();

      if (removeScripts) {
        html = this.removeScriptTags(html);
      }

      const outputPath = this.getOutputPath(route);
      this.saveHtml(html, outputPath);

      await page.close();

      return {
        html,
        route,
        outputPath,
        url: fullUrl,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      await page.close().catch(() => {});
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
      });
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
    const results = [];
    for (const route of routes) {
      const result = await this.renderPage(baseUrl, route, options);
      results.push(result);
    }
    return results;
  }

  getOutputDir() {
    return this.outputDir;
  }
}

module.exports = PrerenderService;
