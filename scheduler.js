const cron = require('node-cron');
const { EventEmitter } = require('events');
const ActivePagesManager = require('./active-pages');

function parseCronField(field, min, max) {
  const values = [];
  const parts = field.split(',');
  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.includes('/')) {
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      let start = min;
      let end = max;
      if (range !== '*') {
        const [s, e] = range.split('-');
        start = parseInt(s, 10);
        end = e ? parseInt(e, 10) : max;
      }
      for (let i = start; i <= end; i += stepNum) values.push(i);
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n, 10));
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function getNextCronRun(expression, timezone = 'Asia/Shanghai', fromDate = null) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`Cron 表达式格式错误: ${expression}`);
  }

  let secondField, minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField;
  if (parts.length === 6) {
    [secondField, minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  } else {
    secondField = '0';
    [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  }

  const seconds = parseCronField(secondField, 0, 59);
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const daysOfMonth = parseCronField(dayOfMonthField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const daysOfWeek = parseCronField(dayOfWeekField, 0, 6);

  const tzOffset = getTimezoneOffset(timezone);
  const start = fromDate ? new Date(fromDate.getTime() + tzOffset) : new Date(new Date().getTime() + tzOffset);
  start.setSeconds(start.getSeconds() + 1);

  for (let y = start.getFullYear(); y <= start.getFullYear() + 5; y++) {
    for (const month of months) {
      if (y === start.getFullYear() && month < start.getMonth() + 1) continue;
      for (const day of daysOfMonth) {
        const date = new Date(Date.UTC(y, month - 1, day));
        if (date.getUTCMonth() !== month - 1) continue;
        const dow = date.getUTCDay();
        if (!daysOfWeek.includes(dow)) continue;
        if (y === start.getFullYear() && month === start.getMonth() + 1 && day < start.getDate()) continue;

        const isSameDay = y === start.getFullYear() && month === start.getMonth() + 1 && day === start.getDate();

        for (const hour of hours) {
          if (isSameDay && hour < start.getHours()) continue;
          for (const minute of minutes) {
            if (isSameDay && hour === start.getHours() && minute < start.getMinutes()) continue;
            for (const second of seconds) {
              if (isSameDay && hour === start.getHours() && minute === start.getMinutes() && second <= start.getSeconds()) continue;

              const result = new Date(Date.UTC(y, month - 1, day, hour, minute, second));
              return new Date(result.getTime() - tzOffset);
            }
          }
        }
      }
    }
  }
  return null;
}

function getTimezoneOffset(timezone) {
  const now = new Date();
  const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  return utcDate.getTime() - tzDate.getTime();
}

class ScheduledPrerenderService extends EventEmitter {
  constructor(prerenderService, options = {}) {
    super();
    this.prerenderService = prerenderService;
    this.activePagesManager = new ActivePagesManager(options.dataDir);

    this.cronExpression = options.cronExpression || process.env.CRON_SCHEDULE || '0 0 2 * * *';
    this.enabled = options.enabled !== false && process.env.CRON_ENABLED !== 'false';
    this.spaBaseUrl = options.spaBaseUrl || 'http://localhost:3000/static/index.html';
    this.concurrency = options.concurrency || 2;
    this.timezone = options.timezone || process.env.CRON_TIMEZONE || 'Asia/Shanghai';

    this.scheduledTask = null;
    this.currentJob = null;
    this.isRunning = false;

    this._setupScheduledTask();
  }

  _setupScheduledTask() {
    if (!this.enabled) {
      console.log('[定时任务] 已禁用（CRON_ENABLED=false）');
      return;
    }

    try {
      this.scheduledTask = cron.schedule(
        this.cronExpression,
        () => this._executeScheduledJob(),
        {
          scheduled: true,
          timezone: this.timezone
        }
      );

      const nextDates = this.getNextRunTimes(3);
      console.log(`[定时任务] 已启动，Cron 表达式: ${this.cronExpression}`);
      console.log(`[定时任务] 时区: ${this.timezone}`);
      console.log(`[定时任务] 下次执行时间:`);
      nextDates.forEach((date, i) => {
        console.log(`  ${i + 1}. ${date.toLocaleString('zh-CN', { timeZone: this.timezone })}`);
      });

      this.emit('scheduler:started', {
        cronExpression: this.cronExpression,
        timezone: this.timezone,
        nextRuns: nextDates
      });

      this.scheduledTask.on('error', (error) => {
        console.error('[定时任务] 调度器错误:', error.message);
        this.emit('scheduler:error', { error: error.message });
      });

    } catch (error) {
      console.error('[定时任务] 启动失败:', error.message);
      this.emit('scheduler:error', { error: error.message });
    }
  }

  async _executeScheduledJob() {
    if (this.isRunning) {
      console.log('[定时任务] 已有任务在执行中，跳过本次调度');
      return;
    }

    const activePages = this.activePagesManager.getActiveRoutes();
    if (activePages.length === 0) {
      console.log('[定时任务] 没有启用的活动页面，跳过执行');
      this.activePagesManager.addHistoryRecord({
        type: 'scheduled',
        status: 'skipped',
        totalPages: 0,
        message: '没有启用的活动页面'
      });
      return;
    }

    console.log(`[定时任务] 开始执行，共 ${activePages.length} 个页面`);
    this.emit('job:start', { type: 'scheduled', totalPages: activePages.length });

    this.isRunning = true;
    const startTime = Date.now();

    const historyRecord = this.activePagesManager.addHistoryRecord({
      type: 'scheduled',
      status: 'running',
      totalPages: activePages.length,
      startedAt: new Date().toISOString()
    });

    this.currentJob = {
      id: historyRecord.id,
      type: 'scheduled',
      startTime,
      totalPages: activePages.length,
      pages: activePages,
      completed: 0,
      failed: 0,
      results: []
    };

    try {
      const routes = activePages.map(p => p.route);
      const firstPage = activePages[0];

      const batchResult = await this.prerenderService.renderMultiple(
        this.spaBaseUrl,
        routes,
        {
          concurrency: this.concurrency,
          useHash: firstPage.useHash,
          removeScripts: firstPage.removeScripts,
          onProgress: (progress) => {
            this.currentJob.completed = progress.completed;
            this.currentJob.failed = progress.failed;
            this.emit('job:progress', {
              jobId: this.currentJob.id,
              ...progress
            });
          }
        }
      );

      const durationMs = Date.now() - startTime;

      this.activePagesManager.updateHistoryRecord(historyRecord.id, {
        status: batchResult.failed > 0 ? 'completed_with_errors' : 'completed',
        completed: batchResult.completed,
        failed: batchResult.failed,
        durationMs,
        finishedAt: new Date().toISOString(),
        results: batchResult.results
      });

      console.log(`[定时任务] 执行完成: 成功=${batchResult.completed} 失败=${batchResult.failed} 耗时=${durationMs}ms`);

      this.emit('job:complete', {
        jobId: this.currentJob.id,
        total: batchResult.total,
        completed: batchResult.completed,
        failed: batchResult.failed,
        durationMs
      });

    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error('[定时任务] 执行失败:', error.message);

      this.activePagesManager.updateHistoryRecord(historyRecord.id, {
        status: 'failed',
        error: error.message,
        durationMs,
        finishedAt: new Date().toISOString()
      });

      this.emit('job:error', {
        jobId: this.currentJob.id,
        error: error.message
      });
    } finally {
      this.isRunning = false;
      this.currentJob = null;
    }
  }

  async triggerManualRun(force = false) {
    if (this.isRunning && !force) {
      return {
        success: false,
        error: '已有任务正在执行中，请等待完成或使用 force=true 强制执行',
        currentJob: this.currentJob
      };
    }

    const activePages = this.activePagesManager.getActiveRoutes();
    if (activePages.length === 0) {
      return {
        success: false,
        error: '没有启用的活动页面'
      };
    }

    console.log(`[手动触发] 立即执行预渲染任务，共 ${activePages.length} 个页面`);

    const historyRecord = this.activePagesManager.addHistoryRecord({
      type: 'manual',
      status: 'running',
      totalPages: activePages.length,
      startedAt: new Date().toISOString()
    });

    this.emit('job:start', { type: 'manual', totalPages: activePages.length, jobId: historyRecord.id });

    const startTime = Date.now();
    const routes = activePages.map(p => p.route);
    const firstPage = activePages[0];

    try {
      const batchResult = await this.prerenderService.renderMultiple(
        this.spaBaseUrl,
        routes,
        {
          concurrency: this.concurrency,
          useHash: firstPage.useHash,
          removeScripts: firstPage.removeScripts,
          onProgress: (progress) => {
            this.emit('job:progress', {
              jobId: historyRecord.id,
              ...progress
            });
          }
        }
      );

      const durationMs = Date.now() - startTime;

      this.activePagesManager.updateHistoryRecord(historyRecord.id, {
        status: batchResult.failed > 0 ? 'completed_with_errors' : 'completed',
        completed: batchResult.completed,
        failed: batchResult.failed,
        durationMs,
        finishedAt: new Date().toISOString(),
        results: batchResult.results
      });

      this.emit('job:complete', {
        jobId: historyRecord.id,
        type: 'manual',
        total: batchResult.total,
        completed: batchResult.completed,
        failed: batchResult.failed,
        durationMs
      });

      return {
        success: true,
        jobId: historyRecord.id,
        total: batchResult.total,
        completed: batchResult.completed,
        failed: batchResult.failed,
        durationMs,
        allSucceeded: batchResult.failed === 0
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      this.activePagesManager.updateHistoryRecord(historyRecord.id, {
        status: 'failed',
        error: error.message,
        durationMs,
        finishedAt: new Date().toISOString()
      });

      this.emit('job:error', {
        jobId: historyRecord.id,
        type: 'manual',
        error: error.message
      });

      return {
        success: false,
        jobId: historyRecord.id,
        error: error.message,
        durationMs
      };
    }
  }

  getStatus() {
    const lastRun = this.activePagesManager.getLastSuccessfulRun();
    return {
      enabled: this.enabled,
      cronExpression: this.cronExpression,
      timezone: this.timezone,
      isRunning: this.isRunning,
      nextRunTimes: this.enabled ? this.getNextRunTimes(3) : null,
      activePagesCount: this.activePagesManager.getActiveRoutes().length,
      lastSuccessfulRun: lastRun ? {
        id: lastRun.id,
        completedAt: lastRun.finishedAt || lastRun.createdAt,
        completed: lastRun.completed,
        failed: lastRun.failed,
        durationMs: lastRun.durationMs
      } : null,
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        type: this.currentJob.type,
        startTime: new Date(this.currentJob.startTime).toISOString(),
        totalPages: this.currentJob.totalPages,
        completed: this.currentJob.completed,
        failed: this.currentJob.failed,
        progress: this.currentJob.totalPages > 0
          ? Math.round(((this.currentJob.completed + this.currentJob.failed) / this.currentJob.totalPages) * 100)
          : 0
      } : null
    };
  }

  getNextRunTimes(count = 3) {
    if (!this.scheduledTask || !this.enabled) return [];

    try {
      const dates = [];
      let lastDate = null;
      for (let i = 0; i < count; i++) {
        const next = getNextCronRun(this.cronExpression, this.timezone, lastDate);
        if (next) {
          dates.push(next);
          lastDate = next;
        }
      }
      return dates;
    } catch (error) {
      console.error('[定时任务] 解析 cron 表达式失败:', error.message);
      return [];
    }
  }

  getHistory(limit = 50) {
    return this.activePagesManager.getHistory(limit);
  }

  getActivePagesManager() {
    return this.activePagesManager;
  }

  start() {
    if (!this.scheduledTask && this.enabled) {
      this._setupScheduledTask();
      return true;
    }
    return false;
  }

  stop() {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
      console.log('[定时任务] 已停止');
      this.emit('scheduler:stopped');
      return true;
    }
    return false;
  }

  destroy() {
    this.stop();
    this.removeAllListeners();
  }
}

module.exports = ScheduledPrerenderService;
