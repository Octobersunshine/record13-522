const fs = require('fs');
const path = require('path');

class ActivePagesManager {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, 'data');
    this.pagesFile = path.join(this.dataDir, 'active-pages.json');
    this.historyFile = path.join(this.dataDir, 'job-history.json');
    this.ensureDataDir();
    this.ensurePagesFile();
    this.ensureHistoryFile();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  ensurePagesFile() {
    if (!fs.existsSync(this.pagesFile)) {
      const defaultPages = [
        { id: 'page_1', route: '/', name: '首页', enabled: true, useHash: true, createdAt: new Date().toISOString() },
        { id: 'page_2', route: '/about', name: '关于我们', enabled: true, useHash: true, createdAt: new Date().toISOString() },
        { id: 'page_3', route: '/products', name: '产品列表', enabled: true, useHash: true, createdAt: new Date().toISOString() },
        { id: 'page_4', route: '/contact', name: '联系方式', enabled: true, useHash: true, createdAt: new Date().toISOString() }
      ];
      this.savePages(defaultPages);
    }
  }

  ensureHistoryFile() {
    if (!fs.existsSync(this.historyFile)) {
      this.saveHistory([]);
    }
  }

  loadPages() {
    try {
      const content = fs.readFileSync(this.pagesFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[活动页面] 读取配置失败:', error.message);
      return [];
    }
  }

  savePages(pages) {
    try {
      fs.writeFileSync(this.pagesFile, JSON.stringify(pages, null, 2), 'utf-8');
      return true;
    } catch (error) {
      console.error('[活动页面] 保存配置失败:', error.message);
      return false;
    }
  }

  getAllPages(enabledOnly = false) {
    const pages = this.loadPages();
    if (enabledOnly) {
      return pages.filter(p => p.enabled);
    }
    return pages;
  }

  getActiveRoutes() {
    return this.getAllPages(true).map(p => ({
      route: p.route,
      useHash: p.useHash !== false,
      removeScripts: p.removeScripts || false
    }));
  }

  getPageById(id) {
    return this.getAllPages().find(p => p.id === id);
  }

  addPage(pageData) {
    const pages = this.loadPages();
    const newPage = {
      id: `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      route: pageData.route,
      name: pageData.name || pageData.route,
      enabled: pageData.enabled !== false,
      useHash: pageData.useHash !== false,
      removeScripts: pageData.removeScripts === true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    pages.push(newPage);
    this.savePages(pages);
    return newPage;
  }

  updatePage(id, updates) {
    const pages = this.loadPages();
    const index = pages.findIndex(p => p.id === id);
    if (index === -1) return null;

    pages[index] = {
      ...pages[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.savePages(pages);
    return pages[index];
  }

  deletePage(id) {
    const pages = this.loadPages();
    const filtered = pages.filter(p => p.id !== id);
    if (filtered.length === pages.length) return false;
    this.savePages(filtered);
    return true;
  }

  togglePage(id, enabled) {
    const page = this.getPageById(id);
    if (!page) return null;
    return this.updatePage(id, { enabled });
  }

  loadHistory() {
    try {
      const content = fs.readFileSync(this.historyFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[任务历史] 读取失败:', error.message);
      return [];
    }
  }

  saveHistory(history) {
    try {
      const recent = history.slice(-200);
      fs.writeFileSync(this.historyFile, JSON.stringify(recent, null, 2), 'utf-8');
      return true;
    } catch (error) {
      console.error('[任务历史] 保存失败:', error.message);
      return false;
    }
  }

  addHistoryRecord(record) {
    const history = this.loadHistory();
    const newRecord = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...record,
      createdAt: new Date().toISOString()
    };
    history.push(newRecord);
    this.saveHistory(history);
    return newRecord;
  }

  updateHistoryRecord(id, updates) {
    const history = this.loadHistory();
    const index = history.findIndex(h => h.id === id);
    if (index === -1) return null;
    history[index] = { ...history[index], ...updates };
    this.saveHistory(history);
    return history[index];
  }

  getHistory(limit = 50) {
    const history = this.loadHistory();
    return history.slice(-limit).reverse();
  }

  getLastSuccessfulRun() {
    const history = this.loadHistory();
    return history
      .filter(h => h.status === 'completed' && h.type === 'scheduled')
      .slice(-1)[0] || null;
  }

  clearOldHistory(days = 30) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const history = this.loadHistory();
    const filtered = history.filter(h => new Date(h.createdAt).getTime() > cutoff);
    this.saveHistory(filtered);
    return history.length - filtered.length;
  }
}

module.exports = ActivePagesManager;
