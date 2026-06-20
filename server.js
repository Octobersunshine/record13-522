const express = require('express');
const path = require('path');
const PrerenderService = require('./prerender');

const app = express();
const PORT = process.env.PORT || 3000;
const SPA_BASE_URL = process.env.SPA_BASE_URL || `http://localhost:${PORT}`;

const MAX_QUEUE_BEFORE_REJECT = process.env.MAX_QUEUE_BEFORE_REJECT
  ? parseInt(process.env.MAX_QUEUE_BEFORE_REJECT, 10)
  : 80;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  req.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

const prerenderService = new PrerenderService({
  maxConcurrency: process.env.MAX_CONCURRENCY
    ? parseInt(process.env.MAX_CONCURRENCY, 10)
    : undefined,
  maxQueueSize: process.env.MAX_QUEUE_SIZE
    ? parseInt(process.env.MAX_QUEUE_SIZE, 10)
    : 100,
  memoryThresholdMB: process.env.MEMORY_THRESHOLD_MB
    ? parseInt(process.env.MEMORY_THRESHOLD_MB, 10)
    : 2048
});

function overloadProtection(req, res, next) {
  const status = prerenderService.getQueueStatus();
  const isHighMemory = status.memory.isHigh;
  const queueNearlyFull = status.queue.currentWaiting >= MAX_QUEUE_BEFORE_REJECT;

  if (isHighMemory) {
    return res.status(503).json({
      success: false,
      error: '服务内存压力过大，暂时无法处理请求，请稍后重试',
      retryAfter: 30,
      code: 'MEMORY_OVERLOAD',
      status: {
        memory: status.memory,
        queue: status.queue
      }
    });
  }

  if (queueNearlyFull) {
    return res.status(503).json({
      success: false,
      error: '任务队列即将满载，暂时拒绝新请求，请稍后重试',
      retryAfter: Math.ceil(status.queue.currentWaiting * 2),
      code: 'QUEUE_FULL',
      status: {
        queue: status.queue
      }
    });
  }

  next();
}

prerenderService.on('memory-warning', ({ heapUsedMB, threshold }) => {
  console.warn(`[内存警告] 堆内存使用: ${heapUsedMB}MB / 阈值: ${threshold}MB，已触发资源清理`);
});

prerenderService.on('task:queued', (task) => {
  console.log(`[任务排队] ${task.id} 路由:${task.route}`);
});

prerenderService.on('task:running', (task) => {
  console.log(`[任务执行] ${task.id} 路由:${task.route}`);
});

prerenderService.on('task:completed', (task) => {
  const duration = task.completedAt - task.startedAt;
  console.log(`[任务完成] ${task.id} 路由:${task.route} 耗时:${duration}ms`);
});

prerenderService.on('task:failed', (task) => {
  console.error(`[任务失败] ${task.id} 路由:${task.route} 错误:${task.error}`);
});

prerenderService.on('batch:start', ({ batchId, totalRoutes, concurrency }) => {
  console.log(`[批量开始] ${batchId} 总数:${totalRoutes} 并发度:${concurrency}`);
});

prerenderService.on('batch:complete', ({ batchId, totalRoutes, completedCount, failedCount }) => {
  console.log(`[批量完成] ${batchId} 总数:${totalRoutes} 成功:${completedCount} 失败:${failedCount}`);
});

prerenderService.on('browser-disconnected', () => {
  console.warn('[浏览器断开] Puppeteer 浏览器实例意外断开，将在下次请求时自动重建');
});

app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/prerendered', express.static(prerenderService.getOutputDir()));

app.get('/health', (req, res) => {
  const status = prerenderService.getQueueStatus();
  const healthy = !status.queue.isOverloaded && !status.memory.isHigh;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'SPA Prerender Service',
    timestamp: new Date().toISOString(),
    healthy,
    checks: {
      memoryOk: !status.memory.isHigh,
      queueOk: !status.queue.isOverloaded
    }
  });
});

app.get('/api/status', (req, res) => {
  const status = prerenderService.getQueueStatus();
  res.json({
    success: true,
    data: status
  });
});

app.get('/api/prerender', overloadProtection, async (req, res) => {
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
        error: '缺少必需参数: route',
        code: 'MISSING_PARAM'
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
      requestId: req.requestId,
      data: {
        taskId: result.taskId,
        route: result.route,
        url: result.url,
        outputPath: result.outputPath,
        accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), result.outputPath).replace(/\\/g, '/')}`,
        timestamp: result.timestamp,
        durationMs: result.durationMs,
        htmlLength: result.html.length
      }
    });
  } catch (error) {
    console.error('[预渲染错误]', error.message);
    const statusCode = error.message.includes('队列已满') ? 503 : 500;
    res.status(statusCode).json({
      success: false,
      requestId: req.requestId,
      error: error.message,
      code: statusCode === 503 ? 'QUEUE_FULL' : 'RENDER_ERROR'
    });
  }
});

app.post('/api/prerender', overloadProtection, async (req, res) => {
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
      useHash,
      concurrency,
      stopOnError
    } = req.body;

    const options = {};
    if (waitUntil) options.waitUntil = waitUntil;
    if (timeout) options.timeout = parseInt(timeout, 10);
    if (waitForSelector) options.waitForSelector = waitForSelector;
    if (removeScripts) options.removeScripts = removeScripts === true;
    if (inlineStyles) options.inlineStyles = inlineStyles === true;
    if (useHash) options.useHash = useHash === true;
    if (concurrency) options.concurrency = parseInt(concurrency, 10);
    if (stopOnError !== undefined) options.stopOnError = stopOnError === true;

    const effectiveBaseUrl = baseUrl || SPA_BASE_URL;

    if (routes && Array.isArray(routes) && routes.length > 0) {
      if (routes.length > 500) {
        return res.status(400).json({
          success: false,
          requestId: req.requestId,
          error: `单次批量任务最多 500 个路由，当前提交: ${routes.length}`,
          code: 'BATCH_TOO_LARGE'
        });
      }

      const batchResult = await prerenderService.renderMultiple(
        effectiveBaseUrl,
        routes,
        options
      );

      return res.json({
        success: true,
        requestId: req.requestId,
        data: {
          batchId: batchResult.batchId,
          total: batchResult.total,
          completed: batchResult.completed,
          failed: batchResult.failed,
          allSucceeded: batchResult.failed === 0,
          results: batchResult.results.map(r => {
            if (!r.success) {
              return {
                success: false,
                route: r.route,
                error: r.error
              };
            }
            return {
              success: true,
              taskId: r.taskId,
              route: r.route,
              url: r.url,
              outputPath: r.outputPath,
              accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), r.outputPath).replace(/\\/g, '/')}`,
              timestamp: r.timestamp,
              durationMs: r.durationMs,
              htmlLength: r.html.length
            };
          })
        }
      });
    }

    if (!route) {
      return res.status(400).json({
        success: false,
        requestId: req.requestId,
        error: '缺少必需参数: route 或 routes',
        code: 'MISSING_PARAM'
      });
    }

    const result = await prerenderService.renderPage(
      effectiveBaseUrl,
      route,
      options
    );

    res.json({
      success: true,
      requestId: req.requestId,
      data: {
        taskId: result.taskId,
        route: result.route,
        url: result.url,
        outputPath: result.outputPath,
        accessUrl: `/prerendered/${path.relative(prerenderService.getOutputDir(), result.outputPath).replace(/\\/g, '/')}`,
        timestamp: result.timestamp,
        durationMs: result.durationMs,
        htmlLength: result.html.length
      }
    });
  } catch (error) {
    console.error('[预渲染错误]', error.message);
    const statusCode = error.message.includes('队列已满') ? 503 : 500;
    res.status(statusCode).json({
      success: false,
      requestId: req.requestId,
      error: error.message,
      code: statusCode === 503 ? 'QUEUE_FULL' : 'RENDER_ERROR'
    });
  }
});

app.get('/api/prerender/view', overloadProtection, async (req, res) => {
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
    res.setHeader('X-Task-Id', result.taskId);
    res.setHeader('X-Render-Duration-Ms', result.durationMs);
    res.send(result.html);
  } catch (error) {
    console.error('[预渲染错误]', error.message);
    const statusCode = error.message.includes('队列已满') ? 503 : 500;
    res.status(statusCode).send(`预渲染失败 (${statusCode}): ${error.message}`);
  }
});

app.get('/', (req, res) => {
  const qs = prerenderService.getQueueStatus();
  res.json({
    name: 'SPA 预渲染服务',
    version: '1.1.0',
    description: '带并发控制和资源保护的 SPA 预渲染服务',
    features: [
      '信号量并发控制（限制最大渲染任务数）',
      'Page Pool 页面池复用（减少 Chromium 进程开销）',
      '任务队列排队（避免瞬间压垮系统）',
      '内存监控 + 自动清理（防止 OOM）',
      '过载保护中间件（队列/内存超限返回 503）',
      '批量任务并发度可配置',
      '请求追踪 ID + 全链路事件日志'
    ],
    endpoints: {
      status: {
        method: 'GET',
        path: '/api/status',
        description: '查看服务状态、队列情况、内存使用、并发统计'
      },
      health: {
        method: 'GET',
        path: '/health',
        description: '健康检查，返回 200 或 503'
      },
      renderSingle: {
        method: 'GET',
        path: '/api/prerender',
        params: {
          route: '必填 - 页面路由路径',
          baseUrl: '可选 - SPA 应用基础 URL',
          useHash: '可选 - 是否使用 hash 路由 (true|false)',
          waitUntil: '可选 - 等待时机 (networkidle0|domcontentloaded|load)',
          timeout: '可选 - 超时毫秒数',
          waitForSelector: '可选 - 等待的 DOM 选择器',
          removeScripts: '可选 - 移除 script 标签 (true|false)'
        }
      },
      renderBatch: {
        method: 'POST',
        path: '/api/prerender',
        body: {
          routes: '路由数组（最大 500 条）',
          route: '单条路由（与 routes 二选一）',
          baseUrl: 'SPA 基础 URL',
          useHash: '是否 hash 路由',
          concurrency: '批量并发度（默认 = 全局最大并发）',
          stopOnError: '遇到错误是否中断批量任务 (true|false)',
          removeScripts: '移除 script 标签'
        }
      },
      renderView: {
        method: 'GET',
        path: '/api/prerender/view',
        description: '直接返回渲染后的 HTML 响应'
      },
      prerenderedFiles: {
        method: 'GET',
        path: '/prerendered/*',
        description: '访问已生成的静态 HTML 文件'
      },
      spaDemo: {
        method: 'GET',
        path: '/static/index.html',
        description: '内置示例 SPA（Hash 路由）'
      }
    },
    currentStatus: {
      concurrency: `${qs.semaphore.active}/${qs.semaphore.maxConcurrency} 活跃任务`,
      queue: `${qs.semaphore.waiting} 任务排队中`,
      memory: `${qs.memory.heapUsedMB}MB / ${qs.memory.thresholdMB}MB`,
      completed: `${qs.stats.totalCompleted} 个任务已完成`,
      avgTime: `${qs.stats.avgTimeMs}ms 平均耗时`
    },
    examples: [
      '状态监控: GET /api/status',
      '单页渲染: GET /api/prerender?route=/&useHash=true&baseUrl=http://localhost:3000/static/index.html',
      `批量渲染 (并发度=2): POST /api/prerender  BODY: {"routes":["/","/about","/products","/contact"],"useHash":true,"concurrency":2}`,
      '查看渲染结果: GET /api/prerender/view?route=/products&useHash=true&baseUrl=http://localhost:3000/static/index.html',
      '访问静态HTML: GET /prerendered/products.html'
    ],
    envConfig: {
      PORT: `默认 3000，当前: ${PORT}`,
      MAX_CONCURRENCY: `默认 = CPU核心数-1，上限 4，当前配置值: ${process.env.MAX_CONCURRENCY || '(默认)'}`,
      MAX_QUEUE_SIZE: `默认 100，当前配置值: ${process.env.MAX_QUEUE_SIZE || '(默认)'}`,
      MEMORY_THRESHOLD_MB: `默认 2048，当前配置值: ${process.env.MEMORY_THRESHOLD_MB || '(默认)'}`
    }
  });
});

const server = app.listen(PORT, () => {
  const qs = prerenderService.getQueueStatus();
  console.log('========================================');
  console.log('  SPA 预渲染服务已启动');
  console.log(`  服务地址:   http://localhost:${PORT}`);
  console.log(`  状态监控:   http://localhost:${PORT}/api/status`);
  console.log(`  健康检查:   http://localhost:${PORT}/health`);
  console.log(`  示例 SPA:   http://localhost:${PORT}/static/index.html`);
  console.log('----------------------------------------');
  console.log(`  最大并发:   ${qs.semaphore.maxConcurrency} 个任务`);
  console.log(`  最大页面:   ${prerenderService.maxPagesPerBrowser} 个页面实例`);
  console.log(`  队列上限:   ${qs.queue.maxSize} 个任务`);
  console.log(`  内存阈值:   ${qs.memory.thresholdMB} MB`);
  console.log('========================================');
  console.log('');
  console.log('调用示例:');
  console.log(`  # 单页渲染`);
  console.log(`  curl "http://localhost:${PORT}/api/prerender?route=/&useHash=true&baseUrl=http://localhost:${PORT}/static/index.html"`);
  console.log('');
  console.log(`  # 查看状态（并发/队列/内存）`);
  console.log(`  curl "http://localhost:${PORT}/api/status"`);
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

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理Promise拒绝]', reason);
});

module.exports = app;
