const express = require('express');
const path = require('path');
const PrerenderService = require('./prerender');
const ScheduledPrerenderService = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const SPA_BASE_URL = process.env.SPA_BASE_URL || `http://localhost:${PORT}`;
const STATIC_SPA_URL = `${SPA_BASE_URL}/static/index.html`;

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

const scheduledService = new ScheduledPrerenderService(prerenderService, {
  spaBaseUrl: STATIC_SPA_URL,
  cronExpression: process.env.CRON_SCHEDULE || '0 0 2 * * *',
  timezone: process.env.CRON_TIMEZONE || 'Asia/Shanghai',
  concurrency: process.env.CRON_CONCURRENCY
    ? parseInt(process.env.CRON_CONCURRENCY, 10)
    : 2
});

const pagesManager = scheduledService.getActivePagesManager();

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

scheduledService.on('scheduler:started', ({ cronExpression, timezone, nextRuns }) => {
  console.log(`[定时调度] 已启动，Cron: ${cronExpression}，时区: ${timezone}`);
});

scheduledService.on('scheduler:stopped', () => {
  console.log('[定时调度] 已停止');
});

scheduledService.on('scheduler:error', ({ error }) => {
  console.error('[定时调度] 错误:', error);
});

scheduledService.on('job:start', ({ type, totalPages, jobId }) => {
  console.log(`[定时任务] 开始 - 类型:${type} 页面数:${totalPages} ID:${jobId}`);
});

scheduledService.on('job:progress', ({ jobId, total, completed, failed, progress }) => {
  console.log(`[定时任务] 进度 - ${jobId}: ${progress}% (${completed}/${total} 失败:${failed})`);
});

scheduledService.on('job:complete', ({ jobId, total, completed, failed, durationMs }) => {
  console.log(`[定时任务] 完成 - ${jobId}: ${completed}/${total} 成功 失败:${failed} 耗时:${durationMs}ms`);
});

scheduledService.on('job:error', ({ jobId, error }) => {
  console.error(`[定时任务] 失败 - ${jobId}: ${error}`);
});

app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/prerendered', express.static(prerenderService.getOutputDir()));

app.get('/health', (req, res) => {
  const status = prerenderService.getQueueStatus();
  const schedStatus = scheduledService.getStatus();
  const healthy = !status.queue.isOverloaded && !status.memory.isHigh;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'SPA Prerender Service',
    timestamp: new Date().toISOString(),
    healthy,
    checks: {
      memoryOk: !status.memory.isHigh,
      queueOk: !status.queue.isOverloaded,
      schedulerOk: schedStatus.enabled,
      schedulerRunning: !schedStatus.isRunning
    }
  });
});

app.get('/api/status', (req, res) => {
  const prStatus = prerenderService.getQueueStatus();
  const schedStatus = scheduledService.getStatus();
  res.json({
    success: true,
    data: {
      prerender: prStatus,
      scheduler: schedStatus
    }
  });
});

app.get('/api/scheduler/status', (req, res) => {
  const status = scheduledService.getStatus();
  res.json({
    success: true,
    data: status
  });
});

app.post('/api/scheduler/run', async (req, res) => {
  const { force } = req.body;
  const result = await scheduledService.triggerManualRun(force === true);
  res.json({
    success: result.success,
    requestId: req.requestId,
    data: result.success ? {
      jobId: result.jobId,
      total: result.total,
      completed: result.completed,
      failed: result.failed,
      durationMs: result.durationMs,
      allSucceeded: result.allSucceeded
    } : null,
    error: result.error || null
  });
});

app.get('/api/scheduler/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const history = scheduledService.getHistory(limit);
  res.json({
    success: true,
    data: {
      total: history.length,
      items: history
    }
  });
});

app.post('/api/scheduler/stop', (req, res) => {
  const stopped = scheduledService.stop();
  res.json({
    success: true,
    data: {
      stopped,
      message: stopped ? '定时任务调度已停止' : '调度器未运行'
    }
  });
});

app.post('/api/scheduler/start', (req, res) => {
  const started = scheduledService.start();
  res.json({
    success: true,
    data: {
      started,
      nextRuns: started ? scheduledService.getNextRunTimes(3) : null,
      message: started ? '定时任务调度已启动' : '调度器已在运行或被禁用'
    }
  });
});

app.get('/api/pages', (req, res) => {
  const { enabledOnly } = req.query;
  const pages = pagesManager.getAllPages(enabledOnly === 'true');
  res.json({
    success: true,
    data: {
      total: pages.length,
      items: pages
    }
  });
});

app.get('/api/pages/:id', (req, res) => {
  const page = pagesManager.getPageById(req.params.id);
  if (!page) {
    return res.status(404).json({
      success: false,
      error: '页面不存在',
      code: 'NOT_FOUND'
    });
  }
  res.json({
    success: true,
    data: page
  });
});

app.post('/api/pages', (req, res) => {
  const { route, name, enabled, useHash, removeScripts } = req.body;

  if (!route) {
    return res.status(400).json({
      success: false,
      error: '缺少必需参数: route',
      code: 'MISSING_PARAM'
    });
  }

  const newPage = pagesManager.addPage({
    route,
    name,
    enabled,
    useHash,
    removeScripts
  });

  res.status(201).json({
    success: true,
    data: newPage
  });
});

app.put('/api/pages/:id', (req, res) => {
  const { name, route, enabled, useHash, removeScripts } = req.body;

  const updated = pagesManager.updatePage(req.params.id, {
    name,
    route,
    enabled,
    useHash,
    removeScripts
  });

  if (!updated) {
    return res.status(404).json({
      success: false,
      error: '页面不存在',
      code: 'NOT_FOUND'
    });
  }

  res.json({
    success: true,
    data: updated
  });
});

app.delete('/api/pages/:id', (req, res) => {
  const deleted = pagesManager.deletePage(req.params.id);
  if (!deleted) {
    return res.status(404).json({
      success: false,
      error: '页面不存在',
      code: 'NOT_FOUND'
    });
  }
  res.json({
    success: true,
    data: {
      message: '页面已删除'
    }
  });
});

app.patch('/api/pages/:id/toggle', (req, res) => {
  const { enabled } = req.body;
  const updated = pagesManager.togglePage(req.params.id, enabled === true);
  if (!updated) {
    return res.status(404).json({
      success: false,
      error: '页面不存在',
      code: 'NOT_FOUND'
    });
  }
  res.json({
    success: true,
    data: updated
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
  const ss = scheduledService.getStatus();
  const activePages = pagesManager.getActiveRoutes();
  res.json({
    name: 'SPA 预渲染服务',
    version: '1.2.0',
    description: '带并发控制、资源保护和定时任务的 SPA 预渲染服务',
    features: [
      '信号量并发控制（限制最大渲染任务数）',
      'Page Pool 页面池复用（减少 Chromium 进程开销）',
      '任务队列排队（避免瞬间压垮系统）',
      '内存监控 + 自动清理（防止 OOM）',
      '过载保护中间件（队列/内存超限返回 503）',
      '批量任务并发度可配置',
      '每日定时预渲染（默认凌晨 2:00 执行）',
      '活动页面管理（增删改查、启用/禁用）',
      '任务执行历史记录和状态监控',
      '请求追踪 ID + 全链路事件日志'
    ],
    endpoints: {
      status: {
        method: 'GET',
        path: '/api/status',
        description: '查看服务状态（含调度器状态）'
      },
      health: {
        method: 'GET',
        path: '/health',
        description: '健康检查'
      },
      schedulerStatus: {
        method: 'GET',
        path: '/api/scheduler/status',
        description: '定时任务状态（下次执行时间、当前运行状态）'
      },
      schedulerRun: {
        method: 'POST',
        path: '/api/scheduler/run',
        description: '立即手动触发一次预渲染（force=true 可强制执行）',
        body: { force: '可选 - 强制执行，即使有任务在运行' }
      },
      schedulerHistory: {
        method: 'GET',
        path: '/api/scheduler/history',
        description: '获取定时任务执行历史记录',
        params: { limit: '可选 - 返回记录数，默认 50' }
      },
      schedulerStart: {
        method: 'POST',
        path: '/api/scheduler/start',
        description: '启动定时任务调度器'
      },
      schedulerStop: {
        method: 'POST',
        path: '/api/scheduler/stop',
        description: '停止定时任务调度器'
      },
      pagesList: {
        method: 'GET',
        path: '/api/pages',
        description: '活动页面列表',
        params: { enabledOnly: '可选 - true 只返回启用的页面' }
      },
      pagesCreate: {
        method: 'POST',
        path: '/api/pages',
        description: '新增活动页面',
        body: {
          route: '页面路由路径（必填）',
          name: '页面名称',
          enabled: '是否启用（默认 true）',
          useHash: '是否 Hash 路由（默认 true）',
          removeScripts: '是否移除 script 标签'
        }
      },
      pagesUpdate: {
        method: 'PUT',
        path: '/api/pages/:id',
        description: '更新活动页面'
      },
      pagesDelete: {
        method: 'DELETE',
        path: '/api/pages/:id',
        description: '删除活动页面'
      },
      pagesToggle: {
        method: 'PATCH',
        path: '/api/pages/:id/toggle',
        description: '切换页面启用/禁用状态',
        body: { enabled: 'true|false' }
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
          concurrency: '批量并发度',
          stopOnError: '遇错是否中断',
          removeScripts: '移除 script 标签'
        }
      },
      renderView: {
        method: 'GET',
        path: '/api/prerender/view',
        description: '直接返回渲染后的 HTML 响应'
      }
    },
    currentStatus: {
      concurrency: `${qs.semaphore.active}/${qs.semaphore.maxConcurrency} 活跃任务`,
      queue: `${qs.semaphore.waiting} 任务排队中`,
      memory: `${qs.memory.heapUsedMB}MB / ${qs.memory.thresholdMB}MB`,
      completed: `${qs.stats.totalCompleted} 个任务已完成`,
      avgTime: `${qs.stats.avgTimeMs}ms 平均耗时`,
      scheduler: ss.enabled ? '已启用' : '已禁用',
      nextScheduledRun: ss.enabled && ss.nextRunTimes && ss.nextRunTimes[0]
        ? ss.nextRunTimes[0].toLocaleString('zh-CN', { timeZone: ss.timezone })
        : null,
      activePagesCount: activePages.length
    },
    examples: [
      '状态监控: GET /api/status',
      '调度状态: GET /api/scheduler/status',
      '立即执行: POST /api/scheduler/run',
      '页面列表: GET /api/pages',
      '新增页面: POST /api/pages  BODY: {"route":"/new-page","name":"新页面","useHash":true}',
      '手动单页: GET /api/prerender?route=/&useHash=true&baseUrl=http://localhost:3000/static/index.html',
      '批量渲染: POST /api/prerender  BODY: {"routes":["/","/about","/products"],"useHash":true,"concurrency":2}'
    ],
    envConfig: {
      PORT: `默认 3000，当前: ${PORT}`,
      MAX_CONCURRENCY: `默认 = CPU核心数-1，上限 4，当前: ${process.env.MAX_CONCURRENCY || '(默认)'}`,
      CRON_SCHEDULE: `默认 "0 0 2 * * *" (每天凌晨2点)，当前: ${process.env.CRON_SCHEDULE || '(默认)'}`,
      CRON_TIMEZONE: `默认 "Asia/Shanghai"，当前: ${process.env.CRON_TIMEZONE || '(默认)'}`,
      CRON_ENABLED: `默认 true，当前: ${process.env.CRON_ENABLED !== 'false' ? 'true' : 'false'}`,
      CRON_CONCURRENCY: `定时任务并发度，默认 2，当前: ${process.env.CRON_CONCURRENCY || '(默认)'}`,
      MEMORY_THRESHOLD_MB: `默认 2048，当前: ${process.env.MEMORY_THRESHOLD_MB || '(默认)'}`
    }
  });
});

const server = app.listen(PORT, () => {
  const qs = prerenderService.getQueueStatus();
  const ss = scheduledService.getStatus();
  console.log('========================================');
  console.log('  SPA 预渲染服务已启动');
  console.log(`  服务地址:   http://localhost:${PORT}`);
  console.log(`  状态监控:   http://localhost:${PORT}/api/status`);
  console.log(`  调度状态:   http://localhost:${PORT}/api/scheduler/status`);
  console.log(`  健康检查:   http://localhost:${PORT}/health`);
  console.log(`  示例 SPA:   http://localhost:${PORT}/static/index.html`);
  console.log('----------------------------------------');
  console.log(`  最大并发:   ${qs.semaphore.maxConcurrency} 个任务`);
  console.log(`  最大页面:   ${prerenderService.maxPagesPerBrowser} 个页面实例`);
  console.log(`  队列上限:   ${qs.queue.maxSize} 个任务`);
  console.log(`  内存阈值:   ${qs.memory.thresholdMB} MB`);
  console.log('----------------------------------------');
  if (ss.enabled) {
    console.log(`  定时任务:   已启用`);
    console.log(`  Cron 表达式: ${ss.cronExpression}`);
    console.log(`  时区:       ${ss.timezone}`);
    if (ss.nextRunTimes && ss.nextRunTimes.length > 0) {
      console.log(`  下次执行:   ${ss.nextRunTimes[0].toLocaleString('zh-CN', { timeZone: ss.timezone })}`);
    }
    console.log(`  活动页面:   ${ss.activePagesCount} 个`);
  } else {
    console.log(`  定时任务:   已禁用 (CRON_ENABLED=false)`);
  }
  console.log('========================================');
  console.log('');
  console.log('API 使用示例:');
  console.log(`  # 手动触发一次预渲染`);
  console.log(`  curl -X POST "http://localhost:${PORT}/api/scheduler/run"`);
  console.log('');
  console.log(`  # 查看定时任务执行历史`);
  console.log(`  curl "http://localhost:${PORT}/api/scheduler/history?limit=10"`);
  console.log('');
  console.log(`  # 管理活动页面`);
  console.log(`  curl "http://localhost:${PORT}/api/pages"`);
  console.log('');
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭服务...');
  scheduledService.destroy();
  await prerenderService.closeBrowser();
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n正在关闭服务...');
  scheduledService.destroy();
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
