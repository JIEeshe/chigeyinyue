const { app, BrowserWindow, ipcMain, session, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 修复 GPU 进程异常：禁用硬件加速
app.disableHardwareAcceleration();

// 最近附加的 webview WebContents（用于保留会话触发下载）
let lastWebviewWC = null;
  // URL -> 友好文件名猜测 映射（来自渲染进程或页面文本）
  const urlNameGuess = new Map();
  // 允许的（用户显式触发的）下载 URL 集合
  const allowedDownloadURLs = new Set();
  // 允许的主机名（处理重定向到同源或 CDN 的情况）
  const allowedHostnames = new Set();
  // 下一次下载许可（跨 session/global 一次性令牌，解决重定向导致 webContents 不一致）
  let allowNextDownloadCount = 0;
 // 每次显式触发允许的 webContents 下载许可（一次性）
 const allowedNextWCIds = new Set();
 // 活动下载去重集合（以最终 URL 为键，避免重复提示/重复任务）
 const activeDownloadKeys = new Set();

// 创建下载目录
const downloadPath = path.join(os.homedir(), '驰哥音乐');
if (!fs.existsSync(downloadPath)) {
  fs.mkdirSync(downloadPath, { recursive: true });
}

// 下载历史文件路径
const downloadHistoryPath = path.join(app.getPath('userData'), 'downloads.json');

// 读取下载历史
function loadDownloadHistory() {
  try {
    if (fs.existsSync(downloadHistoryPath)) {
      const data = fs.readFileSync(downloadHistoryPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('加载下载历史失败:', error);
  }
  return [];
}

// 保存下载历史
function saveDownloadHistory(history) {
  try {
    fs.writeFileSync(downloadHistoryPath, JSON.stringify(history, null, 2), 'utf8');
  } catch (error) {
    console.error('保存下载历史失败:', error);
  }
}

// 注册IPC处理函数
function registerIpcHandlers(mainWindow) {
  // 获取下载历史
  ipcMain.handle('get-download-history', () => {
    return loadDownloadHistory();
  });

  // 打开文件所在文件夹
  ipcMain.handle('open-download-folder', () => {
    shell.openPath(downloadPath);
  });

  // 打开特定文件
  ipcMain.handle('open-file', (event, filePath) => {
    shell.openPath(filePath);
  });

  // 删除下载记录
  ipcMain.handle('delete-download', (event, id) => {
    const history = loadDownloadHistory();
    const newHistory = history.filter(item => item.id !== id);
    saveDownloadHistory(newHistory);
    return newHistory;
  });

  // 清空下载记录
  ipcMain.handle('clear-downloads', () => {
    const empty = [];
    saveDownloadHistory(empty);
    return empty;
  });

  // 手动下载文件：优先走最近附加的 webview 以保留站点会话，其次回退到主窗口
  ipcMain.handle('download-file', async (event, url, nameGuess) => {
    console.log('收到下载请求:', url);
    try {
      if (nameGuess && typeof nameGuess === 'string') {
        urlNameGuess.set(url, nameGuess);
      }
      // 标记该 URL 为用户显式触发的下载
      allowedDownloadURLs.add(url);
      // 标记允许的主机名（处理重定向/CDN）
      try {
        const u = new URL(url);
        allowedHostnames.add(u.hostname);
      } catch (_) {}
      // 开启一次性全局许可，兼容跨 session/重定向
      allowNextDownloadCount++;
      if (lastWebviewWC && !lastWebviewWC.isDestroyed()) {
        // 允许该 webContents 的下一次下载事件
        allowedNextWCIds.add(lastWebviewWC.id);
        lastWebviewWC.downloadURL(url);
      } else {
        // 允许主窗口 webContents 的下一次下载事件
        allowedNextWCIds.add(mainWindow.webContents.id);
        mainWindow.webContents.downloadURL(url);
      }
      return { status: 'started', url, nameGuess: nameGuess || null };
    } catch (error) {
      console.error('下载出错:', error);
      throw error;
    }
  });

  // 监听主窗口会话的下载事件（用于回退场景）
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // 若来源是 webview，则让 webview 会话的监听器处理，避免同一个 session 上的重复处理/重复提示
    try {
      if (webContents && typeof webContents.getType === 'function' && webContents.getType() === 'webview') {
        return;
      }
    } catch (_) {}
    const itemUrl = item.getURL();
    const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
    const lastUrl = chain && chain.length ? chain[chain.length - 1] : itemUrl;

    // 组合 URL 与主机名集合
    const urls = Array.isArray(chain) ? [itemUrl, ...chain] : [itemUrl];
    const hostnames = [];
    urls.forEach(u => { try { hostnames.push(new URL(u).hostname); } catch (_) {} });

    // 许可判断：一次性 webContents 许可 / 全局一次性许可 / URL 白名单 / Host 白名单
    let permitted = false;
    if (allowedNextWCIds.has(webContents.id)) {
      permitted = true;
      allowedNextWCIds.delete(webContents.id);
    } else if (allowNextDownloadCount > 0) {
      permitted = true;
      allowNextDownloadCount--;
    } else if (urls.some(u => allowedDownloadURLs.has(u))) {
      permitted = true;
    } else if (hostnames.some(h => allowedHostnames.has(h))) {
      permitted = true;
    }

    // 若不是用户显式触发的下载，则阻止
    if (!permitted) {
      console.log('阻止非用户触发下载:', itemUrl);
      item.cancel();
      return;
    }

    // 重复下载去重：以最终 URL 作为键，优先允许第一个，后续重复直接取消
    const dupeKey = String(lastUrl || itemUrl || '').toLowerCase();
    if (activeDownloadKeys.has(dupeKey)) {
      console.log('检测到重复 will-download，取消重复:', dupeKey);
      item.cancel();
      return;
    }
    activeDownloadKeys.add(dupeKey);



    // 清理授权列表，避免膨胀
    urls.forEach(u => allowedDownloadURLs.delete(u));
    hostnames.forEach(h => allowedHostnames.delete(h));


    const fileName = item.getFilename();
    const filePath = path.join(downloadPath, fileName);
    
    // 设置保存路径
    item.setSavePath(filePath);
    
    // 下载开始
    const downloadItem = {
      id: Date.now().toString(),
      fileName: fileName,
      filePath: filePath,
      url: item.getURL(),
      startTime: new Date().toISOString(),
      size: item.getTotalBytes(),
      status: 'downloading'
    };
    
    // 通知渲染进程下载开始
   mainWindow.webContents.send('download-started', downloadItem);
    
    // 监听下载进度
    item.on('updated', (event, state) => {
      if (state === 'interrupted') {
        downloadItem.status = 'interrupted';
        mainWindow.webContents.send('download-progress', {
          id: downloadItem.id,
          status: 'interrupted'
        });
      } else if (state === 'progressing') {
        if (item.isPaused()) {
          downloadItem.status = 'paused';
        } else {
          const progress = item.getReceivedBytes() / item.getTotalBytes() * 100;
          mainWindow.webContents.send('download-progress', {
            id: downloadItem.id,
            progress: progress.toFixed(2),
            status: 'downloading'
          });
        }
      }
    });
    
    // 下载完成
    item.once('done', (event, state) => {
      // 完成后移除去重键
      try { activeDownloadKeys.delete(dupeKey); } catch (_) {}
      if (state === 'completed') {
        downloadItem.status = 'completed';
        downloadItem.endTime = new Date().toISOString();
        
        // 保存到历史记录
        const history = loadDownloadHistory();
        history.unshift(downloadItem);
        saveDownloadHistory(history);
        
        // 通知渲染进程下载完成
        mainWindow.webContents.send('download-completed', downloadItem);
      } else {
        downloadItem.status = 'failed';
        mainWindow.webContents.send('download-failed', downloadItem);
      }
    });
  });
}

function createWindow() {
  // 创建浏览器窗口
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    frame: false, // 隐藏默认标题栏和边框
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false // 允许webview下载
    },
    icon: path.join(__dirname, 'icon.png') // 可选：添加应用图标
  });

  // 配置session以支持webview下载
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'download') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // 监听webview附加事件，为webview配置下载支持
  mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
    // 记录最近的 webview WebContents
    lastWebviewWC = webContents;

    // 防重复：同一 session 只注册一次下载相关事件，避免重复提示
    if (webContents.session._cg_handlersAttached) {
      return;
    }
    webContents.session._cg_handlersAttached = true;

    // 基于响应头 Content-Disposition 提取文件名的缓存与工具方法
    const nameCache = new Map();

    function sanitizeFilename(name) {
      return String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim();
    }

    function parseContentDisposition(cd) {
      try {
        const v = Array.isArray(cd) ? cd.join(' ') : cd;
        if (!v) return null;
        // RFC 5987 filename* 支持
        const star = v.match(/filename\\*\\s*=\\s*([^']*)''([^;]+)/i);
        if (star) {
          try { return decodeURIComponent(star[2]); } catch (_) { return star[2]; }
        }
        // 常规 filename=
        const m = v.match(/filename\\s*=\\s*"?([^";]+)"?/i);
        if (m) return m[1];
      } catch (_) {}
      return null;
    }

    // 解析响应头以捕获服务端提供的文件名
    webContents.session.webRequest.onHeadersReceived((details, callback) => {
      try {
        if (details && details.responseHeaders) {
          const headers = details.responseHeaders;
          const cdKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-disposition');
          if (cdKey) {
            const rawName = parseContentDisposition(headers[cdKey]);
            if (rawName) {
              nameCache.set(details.url, sanitizeFilename(rawName));
            }
          }
        }
      } catch (e) {
        console.error('onHeadersReceived 错误:', e);
      }
      callback({ responseHeaders: details.responseHeaders });
    });

    // 拦截 webview 会话中的音频直链 XHR/fetch 请求，改为走下载管线以绕过 CORS
    const audioRegex = /\.(mp3|flac|wav|m4a|aac|ogg|wma|ape|ncm)(\?.*)?$/i;
    const allowList = new Set();
    let autoIntercept = false; // 默认关闭自动拦截，避免应用启动后自动下载
    webContents.session.webRequest.onBeforeRequest((details, callback) => {
      try {
        // 若未开启自动拦截，则直接放行所有请求
        if (!autoIntercept) {
          return callback({ cancel: false });
        }
        if (audioRegex.test(details.url)) {
          // 拦截站点的 XHR/fetch，对音频直链改为触发下载
          if (details.resourceType === 'xhr' || details.resourceType === 'media' || details.resourceType === 'other') {
            if (!allowList.has(details.url)) {
              allowList.add(details.url);
              setImmediate(() => {
                try {
                  // 标记为用户触发的下载
                  allowedDownloadURLs.add(details.url);
                  webContents.downloadURL(details.url);
                } catch (e) {
                  console.error('downloadURL 触发失败:', e);
                }
              });
              return callback({ cancel: true });
            }
          }
        }
      } catch (e) {
        console.error('onBeforeRequest 错误:', e);
      }
      // 允许其他请求
      callback({ cancel: false });
    });

    // 为webview的session配置下载监听
    webContents.session.on('will-download', (event, item, webContents) => {
      const itemUrl = item.getURL();
      const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
      const lastUrl = chain && chain.length ? chain[chain.length - 1] : itemUrl;

      // 组合 URL 与主机名集合
      const urls = Array.isArray(chain) ? [itemUrl, ...chain] : [itemUrl];
      const hostnames = [];
      urls.forEach(u => { try { hostnames.push(new URL(u).hostname); } catch (_) {} });

      // 许可判断：一次性 webContents 许可 / 全局一次性许可 / URL 白名单 / Host 白名单
      let permitted = false;
      if (allowedNextWCIds.has(webContents.id)) {
        permitted = true;
        allowedNextWCIds.delete(webContents.id);
      } else if (allowNextDownloadCount > 0) {
        permitted = true;
        allowNextDownloadCount--;
      } else if (urls.some(u => allowedDownloadURLs.has(u))) {
        permitted = true;
      } else if (hostnames.some(h => allowedHostnames.has(h))) {
        permitted = true;
      }

      // 若不是用户显式触发的下载，则阻止
      if (!permitted) {
        console.log('阻止非用户触发下载:', itemUrl);
        item.cancel();
        return;
      }

      // 重复下载去重：以最终 URL 作为键，优先允许第一个，后续重复直接取消
      const dupeKey = String(lastUrl || itemUrl || '').toLowerCase();
      if (activeDownloadKeys.has(dupeKey)) {
        console.log('检测到重复 will-download，取消重复:', dupeKey);
        item.cancel();
        return;
      }
      activeDownloadKeys.add(dupeKey);


      // 清理授权列表
      urls.forEach(u => allowedDownloadURLs.delete(u));
      hostnames.forEach(h => allowedHostnames.delete(h));

      let fileName = item.getFilename();
      const chainUrls = typeof item.getURLChain === 'function' ? item.getURLChain() : [];

      // 1) 优先使用来自渲染进程的名称猜测（如果有）
      const guess = urlNameGuess.get(itemUrl) || (chainUrls && chainUrls.length ? urlNameGuess.get(chainUrls[chainUrls.length - 1]) : null);
      if (guess) {
        try {
          const u = new URL(itemUrl);
          const extMatch = u.pathname.match(/\.(mp3|flac|wav|m4a|aac|ogg|wma|ape|ncm)$/i);
          let ext = extMatch ? extMatch[0].toLowerCase() : '';
          fileName = sanitizeFilename(guess);
          if (ext && !fileName.toLowerCase().endsWith(ext)) {
            fileName += ext;
          }
        } catch (_) {
          fileName = sanitizeFilename(guess);
        }
        // 清理名称猜测，避免映射无限增长
        urlNameGuess.delete(itemUrl);
        if (chainUrls && chainUrls.length) urlNameGuess.delete(chainUrls[chainUrls.length - 1]);
      } else {
        // 2) 其次使用响应头 Content-Disposition 缓存的文件名
        const cached = nameCache.get(itemUrl) || (chainUrls && chainUrls.length ? nameCache.get(chainUrls[chainUrls.length - 1]) : null);
        if (cached) {
          try {
            const u = new URL(itemUrl);
            const extMatch = u.pathname.match(/\.(mp3|flac|wav|m4a|aac|ogg|wma|ape|ncm)$/i);
            let ext = extMatch ? extMatch[0].toLowerCase() : '';
            fileName = sanitizeFilename(cached);
            if (ext && !fileName.toLowerCase().endsWith(ext)) {
              fileName += ext;
            }
          } catch (_) {
            fileName = sanitizeFilename(cached);
          }
        }
      }

      // 最终安全化
      fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
      const filePath = path.join(downloadPath, fileName);

      // 设置保存路径
      item.setSavePath(filePath);

      console.log('开始下载:', fileName, '到:', filePath);
      
      // 下载开始
      const downloadItem = {
        id: Date.now().toString(),
        fileName: fileName,
        filePath: filePath,
        url: item.getURL(),
        startTime: new Date().toISOString(),
        size: item.getTotalBytes(),
        status: 'downloading'
      };
      
      // 通知渲染进程下载开始
      mainWindow.webContents.send('download-started', downloadItem);
      
      // 监听下载进度
      item.on('updated', (event, state) => {
        if (state === 'interrupted') {
          downloadItem.status = 'interrupted';
          console.log('下载中断:', fileName);
          mainWindow.webContents.send('download-progress', {
            id: downloadItem.id,
            status: 'interrupted'
          });
        } else if (state === 'progressing') {
          if (item.isPaused()) {
            downloadItem.status = 'paused';
          } else {
            const progress = item.getReceivedBytes() / item.getTotalBytes() * 100;
            console.log('下载进度:', fileName, progress.toFixed(2) + '%');
            mainWindow.webContents.send('download-progress', {
              id: downloadItem.id,
              progress: progress.toFixed(2),
              status: 'downloading'
            });
          }
        }
      });
      
      // 下载完成
      item.once('done', (event, state) => {
        // 完成后移除去重键
        try { activeDownloadKeys.delete(dupeKey); } catch (_) {}
        if (state === 'completed') {
          downloadItem.status = 'completed';
          downloadItem.endTime = new Date().toISOString();
          
          console.log('下载完成:', fileName);
          
          // 保存到历史记录
          const history = loadDownloadHistory();
          history.unshift(downloadItem);
          saveDownloadHistory(history);
          
          // 通知渲染进程下载完成
          mainWindow.webContents.send('download-completed', downloadItem);
        } else {
          downloadItem.status = 'failed';
          console.log('下载失败:', fileName, state);
          mainWindow.webContents.send('download-failed', downloadItem);
        }
      });
    });
  });

  // 加载 index.html
  mainWindow.loadFile('index.html');

  // 窗口控制IPC处理
  ipcMain.on('window-minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow.close();
  });

  // 注册IPC处理函数和下载监听
  registerIpcHandlers(mainWindow);

  // 打开开发工具（可选，调试时使用）
  // mainWindow.webContents.openDevTools();
}

// 当 Electron 完成初始化时创建窗口
app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    // 在 macOS 上，当点击 dock 图标且没有其他窗口打开时，
    // 通常会重新创建一个窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 当所有窗口关闭时退出应用（除了 macOS）
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});