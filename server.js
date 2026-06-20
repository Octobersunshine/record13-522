const express = require('express');
const path = require('path');
const PrerenderService = require('./prerender');

const app = express();
const PORT = process.env.PORT || 3000;
const SPA_BASE_URL = process.env.SPA_BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const prerenderService = new PrerenderService();

app.use('/static', express.static(path.join(__dirname, 'public')));

app.use('/prerendered', express.static(prerenderService.getOutputDir()));

app.get('/api/prerender', async (req, res) => {
  try {
    const {
      route,
      baseUrl,
      waitUntil,
      timeout,
      waitForSelector,
      removeScripts,
      inlineStyles,
      useHash
    } = req.query;

    if (!route) {
      return res.status(400).json({
        success: false,
        error: '缺少必需参数: route'
      });
    }

    const options = {};
    if (waitUntil) options.waitUntil = waitUntil;
    if (timeout) options.timeout = parseInt(timeout, 10);
    if (waitForSelector) options.waitForSelector = waitForSelector;
    if (removeScripts) options.removeScripts = removeScripts === 'true';
    if (inlineStyles) options.inlineStyles = inlineStyles === 'true';
    if (useHash) options.useHash = useHash === 'true';

    const result = await prerenderService.renderPage(
      baseUrl || SPA_BASE_URL,
      route,
      options
    );

    res.json({
      success: true,
      data: {
        route: result.route,
        url: result.url,
        outputPath: result.outputPath,
        accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), result.outputPath).replace(/\\/g, '/')}`,
        timestamp: result.timestamp,
        htmlLength: result.html.length
      }
    });
  } catch (error) {
    console.error('[预渲染错误]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/prerender', async (req, res) => {
  try {
    const {
      route,
      routes,
      baseUrl,
      waitUntil,
      timeout,
      waitForSelector,
      removeScripts,
      inlineStyles,
      useHash
    } = req.body;

    const options = {};
    if (waitUntil) options.waitUntil = waitUntil;
    if (timeout) options.timeout = parseInt(timeout, 10);
    if (waitForSelector) options.waitForSelector = waitForSelector;
    if (removeScripts) options.removeScripts = removeScripts === true;
    if (inlineStyles) options.inlineStyles = inlineStyles === true;
    if (useHash) options.useHash = useHash === true;

    const effectiveBaseUrl = baseUrl || SPA_BASE_URL;

    if (routes && Array.isArray(routes) && routes.length > 0) {
      const results = await prerenderService.renderMultiple(
        effectiveBaseUrl,
        routes,
        options
      );

      return res.json({
        success: true,
        data: results.map(r => ({
          route: r.route,
          url: r.url,
          outputPath: r.outputPath,
          accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), r.outputPath).replace(/\\/g, '/')}`,
          timestamp: r.timestamp,
          htmlLength: r.html.length
        }))
      });
    }

    if (!route) {
      return res.status(400).json({
        success: false,
        error: '缺少必需参数: route 或 routes'
      });
    }

    const result = await prerenderService.renderPage(
      effectiveBaseUrl,
      route,
      options
    );

    res.json({
      success: true,
      data: {
        route: result.route,
        url: result.url,
        outputPath: result.outputPath,
        accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), result.outputPath).replace(/\\/g, '/')}`,
        timestamp: result.timestamp,
        htmlLength: result.html.length
      }
    });
  } catch (error) {
    console.error('[预渲染错误]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/prerender/view', async (req, res) => {
  try {
    const {
      route,
      baseUrl,
      waitUntil,
      timeout,
      waitForSelector,
      useHash
    } = req.query;

    if (!route) {
      return res.status(400).send('缺少必需参数: route');
    }

    const options = {};
    if (waitUntil) options.waitUntil = waitUntil;
    if (timeout) options.timeout = parseInt(timeout, 10);
    if (waitForSelector) options.waitForSelector = waitForSelector;
    if (useHash) options.useHash = useHash === 'true';

    const result = await prerenderService.renderPage(
      baseUrl || SPA_BASE_URL,
      route,
      options
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result.html);
  } catch (error) {
    console.error('[预渲染错误]', error);
    res.status(500).send(`预渲染失败: ${error.message}`);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SPA Prerender Service',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'SPA 预渲染服务',
    version: '1.0.0',
    endpoints: {
      renderAndGetJson: {
        method: 'GET',
        path: '/api/prerender',
        description: '预渲染单个页面并返回 JSON 信息',
        params: {
          route: '必填 - 页面路由路径 (如 /, /about, /users/123)',
          baseUrl: '可选 - SPA 应用基础 URL',
          useHash: '可选 - 是否使用 hash 路由模式 (true|false)，适用于 #/ 路由的 SPA',
          waitUntil: '可选 - 页面等待时机 (load|domcontentloaded|networkidle0|networkidle2)',
          timeout: '可选 - 超时时间（毫秒）',
          waitForSelector: '可选 - 等待指定 DOM 选择器出现',
          removeScripts: '可选 - 是否移除 script 标签 (true|false)'
        }
      },
      renderBatch: {
        method: 'POST',
        path: '/api/prerender',
        description: '批量预渲染多个路由',
        body: {
          routes: '路由数组 (如 ["/", "/about", "/contact"])',
          route: '单个路由（与 routes 二选一）',
          baseUrl: 'SPA 应用基础 URL',
          useHash: '是否使用 hash 路由模式',
          options: '其他渲染选项'
        }
      },
      renderAndView: {
        method: 'GET',
        path: '/api/prerender/view',
        description: '预渲染页面并直接返回渲染后的 HTML',
        params: '同 GET /api/prerender'
      },
      viewPrerendered: {
        method: 'GET',
        path: '/prerendered/*',
        description: '访问已生成的静态 HTML 文件'
      }
    },
    examples: [
      'GET /api/prerender?route=/&useHash=true&baseUrl=http://localhost:3000/static/index.html',
      'GET /api/prerender?route=/about&removeScripts=true',
      'POST /api/prerender  Body: {"routes": ["/", "/about", "/products"], "useHash": true}',
      'GET /api/prerender/view?route=/users&useHash=true'
    ]
  });
});

const server = app.listen(PORT, () => {
  console.log('========================================');
  console.log('  SPA 预渲染服务已启动');
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  示例 SPA: http://localhost:${PORT}/static/index.html`);
  console.log(`  健康检查: http://localhost:${PORT}/health`);
  console.log('========================================');
  console.log('');
  console.log('使用示例:');
  console.log(`  curl "http://localhost:${PORT}/api/prerender?route=/"`);
  console.log(`  curl "http://localhost:${PORT}/api/prerender/view?route=/"`);
  console.log('');
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭服务...');
  await prerenderService.closeBrowser();
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n正在关闭服务...');
  await prerenderService.closeBrowser();
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});

module.exports = app;
