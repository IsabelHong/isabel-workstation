/* ============================================================================
 * Isabel 工作台 · 云同步模块 (iw-sync.js)  v62
 * 功能：把工作台数据用「密码 AES-256-GCM 加密」后备份到 GitHub 私有仓库，
 *      并在其他端（公司/家里/手机）打开时自动拉取合并，实现跨端保密同步。
 * 设计原则：
 *   - 零外部依赖（Web Crypto 原生 API），单文件即可运行。
 *   - 数据在本地加密后才上传，GitHub 上只存密文，仓库管理员无密码也读不到。
 *   - 密码仅用于加解密，从不上传；Token 仅用于读写你自己的私有仓库。
 *   - 非侵入式：通过 window.IWApp 桥接访问主程序状态，不改动主程序逻辑。
 *
 * v62 修复（界面可信度）：
 *   1. 【重要】"连接成功"与"网络连接失败"同屏出现 —— 失败信息被持久化后从不清除，
 *      即使之后每次操作都成功，状态栏仍挂着那条历史错误，让人误判没修好。
 *      改为：错误带时间戳，任何一次成功（测试连接/备份/拉取）都会清掉它；
 *      后台自动同步的偶发失败单独标注，不吓人。
 *   2. 测试连接成功时会额外显示云端备份的版本号，便于确认「确实备份上去了」。
 *
 * v61 修复（真实故障复盘）：
 *   1. 【致命】仓库名里的斜杠被 encodeURIComponent 编成 %2F，GitHub API 必返 404。
 *      改为 owner/repo 分段编码，保留斜杠。
 *   2. 桌面版直连 api.github.com 会被网络中间设备重置（Failed to fetch）。
 *      改为优先走桌面程序主进程的本机通道 /api/gh（Node 网络栈，实测稳定），
 *      浏览器/手机端仍走直连。
 *   3. Token 粘贴常带隐藏空格/换行/零宽字符，会让请求整包失败。统一清洗 + 格式校验。
 *   4. 写入分支改为仓库「默认分支」，并兼容空仓库（409），不再假设存在 backup 分支。
 *   5. 报错不再被吞掉：显示真实原因（401/404/超时/DNS…），便于对症处理。
 *   6. 新增「网络自检」：四步逐项检查通道、连通性、令牌、云端文件。
 *   7. 自动备份加「内容指纹 + 最小间隔」，避免心跳把仓库刷成上千次提交。
 *   8. 桌面版本地端口会变化（每个端口=一个独立网站），导致配置像被清空。
 *      改为：主进程优先复用上次端口 + 配置在本机数据目录留一份自动补回。
 * ==========================================================================*/
(function () {
  'use strict';

  var APP = (typeof window !== 'undefined' && window.IWApp) ? window.IWApp : null;
  function getData() {
    if (APP && typeof APP.getData === 'function') return APP.getData();
    try { return (typeof data !== 'undefined') ? data : null; } catch (e) { return null; }
  }
  function doSave() {
    if (APP && typeof APP.saveData === 'function') { APP.saveData(); return; }
    try { if (typeof saveData === 'function') saveData(); } catch (e) {}
  }

  /* ---------------- 本地配置存取（仅本机，不上传） ---------------- */
  var LS = {
    repo: 'iw_sync_repo', token: 'iw_sync_token', path: 'iw_sync_path',
    pwd: 'iw_sync_pwd', auto: 'iw_sync_auto', lastPush: 'iw_sync_lastpush',
    lastPull: 'iw_sync_lastpull', lastErr: 'iw_sync_lasterr',
    lastHash: 'iw_sync_lasthash',
    /* v62 新增（只增不改，旧键保持原样）：给错误打上时间戳与来源，
     * 一旦之后有任何一次成功，就不再显示这条历史错误 —— 避免"成功与失败同屏"。 */
    lastErrTs: 'iw_sync_lasterr_ts', lastErrManual: 'iw_sync_lasterr_manual'
  };
  var DEFAULT_PATH = 'isabel-backup.json';
  var API_BASE = 'https://api.github.com';

  /* 自动备份节流：内容没变不推，且自动推送最快 5 分钟一次 */
  var AUTO_PUSH_DEBOUNCE = 10000;
  var AUTO_PUSH_MIN_INTERVAL = 5 * 60 * 1000;
  var AUTO_PULL_INTERVAL = 90000;   // 每 90 秒拉取一次对方的改动

  /* ---------------- 环境判定 ---------------- */
  /* 桌面版由本地 HTTP 服务托管（127.0.0.1），额外提供主进程本机通道 /api/gh */
  var IS_DESKTOP = (function () {
    try {
      var h = location.hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch (e) { return false; }
  })();
  var bridgeState = 'unknown'; // unknown | ok | off
  var lastVia = '—';

  /* ---------------- 配置读写 + 清洗 ---------------- */
  /* 去除所有空白字符与零宽字符：粘贴 Token 时最常见的隐形杀手 */
  function sanitize(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[\s\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]/g, '');
  }
  function cfg() {
    return {
      repo: sanitize(localStorage.getItem(LS.repo)),
      token: sanitize(localStorage.getItem(LS.token)),
      path: (localStorage.getItem(LS.path) || DEFAULT_PATH).replace(/^\/+/, '').trim() || DEFAULT_PATH,
      pwd: localStorage.getItem(LS.pwd) || '',
      auto: localStorage.getItem(LS.auto) === '1'
    };
  }
  function setCfg(k, v) {
    try { if (v === null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    mirrorRemote();
  }

  /* ---------------- 桌面版：配置落盘双保险 ----------------
   * 桌面程序每次启动的本地端口若发生变化，浏览器会把它当成另一个网站，
   * localStorage 就"凭空清空"。所以桌面版把配置同步存进本机数据目录，
   * 页面发现配置为空时自动补回来。仅本机读写，不上传。 */
  var cfgTimer = null;
  function mirrorRemote() {
    if (!IS_DESKTOP) return;
    if (cfgTimer) clearTimeout(cfgTimer);
    cfgTimer = setTimeout(function () {
      try {
        fetch('/api/cfg', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg()), cache: 'no-store'
        }).catch(function () {});
      } catch (e) {}
    }, 800);
  }
  function hydrateFromDisk(done) {
    if (!IS_DESKTOP) { done(); return; }
    fetch('/api/cfg', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || typeof j !== 'object') return;
        var cur = cfg();
        if (!cur.repo && j.repo) setCfg(LS.repo, j.repo);
        if (!cur.token && j.token) setCfg(LS.token, j.token);
        if (!cur.pwd && j.pwd) setCfg(LS.pwd, j.pwd);
        if (!cur.path && j.path) setCfg(LS.path, j.path);
        if (localStorage.getItem(LS.auto) === null && j.auto) setCfg(LS.auto, '1');
      })
      .catch(function () {})
      .then(function () { done(); });
  }

  var TOKEN_RE = /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/;
  var REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  /* 规范化仓库名：容忍粘贴整条网址、结尾 .git、首尾斜杠与空格 */
  function normRepo() {
    return sanitize(localStorage.getItem(LS.repo))
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
  }
  function repoOk() { return REPO_RE.test(normRepo()); }
  /* owner/repo → owner/repo（保留斜杠，只编码各段） */
  function repoPath() {
    var r = normRepo();
    var segs = r.split('/').filter(function (s) { return s; });
    if (segs.length < 2) return r;
    return segs.slice(0, 2).map(encodeURIComponent).join('/');
  }
  function apiUrl(suffix) { return API_BASE + '/repos/' + repoPath() + suffix; }
  function fileUrl() { return apiUrl('/contents/' + encodeURIComponent(cfg().path)); }

  /* ---------------- 工具 ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function brief(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  }
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function strToBuf(str) { return new TextEncoder().encode(str); }
  function bufToStr(buf) { return new TextDecoder().decode(buf); }
  function b64enc(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64dec(b64) {
    var s = atob(b64);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  /* 轻量指纹：内容没变就不重复提交，避免仓库被刷爆 */
  function fingerprint(str) {
    var h = 2166136261, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return String(h) + ':' + str.length;
  }

  /* ---------------- 加密：PBKDF2 派生密钥 + AES-GCM ---------------- */
  function subtle() {
    var c = (typeof window !== 'undefined') ? window.crypto : null;
    if (!c) return null;
    return c.subtle || c.webkitSubtle || null;
  }
  function cryptoReady() { return !!subtle(); }
  function deriveKey(password, salt) {
    var s = subtle();
    return s.importKey('raw', strToBuf(password), 'PBKDF2', false, ['deriveKey']).then(function (baseKey) {
      return s.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: 200000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    });
  }
  // 输出： b64(salt) + "." + b64(iv) + "." + b64(ciphertext)
  function encryptJSON(obj, password) {
    var s = subtle();
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt).then(function (key) {
      return s.encrypt({ name: 'AES-GCM', iv: iv }, key, strToBuf(JSON.stringify(obj)));
    }).then(function (ct) {
      return bufToB64(salt) + '.' + bufToB64(iv) + '.' + bufToB64(ct);
    });
  }
  function decryptJSON(pkg, password) {
    var parts = String(pkg).split('.');
    if (parts.length !== 3) throw new Error('备份格式不正确');
    var salt = new Uint8Array(b64ToBuf(parts[0]));
    var iv = new Uint8Array(b64ToBuf(parts[1]));
    var ct = b64ToBuf(parts[2]);
    return deriveKey(password, salt).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (pt) { return JSON.parse(bufToStr(pt)); });
  }

  /* ============================================================================
   * 传输层：桌面版优先走主进程本机通道，其余走浏览器直连
   * ==========================================================================*/
  function reqDirect(method, url, headers, body) {
    var opt = { method: method, headers: headers, cache: 'no-store', credentials: 'omit' };
    if (body !== undefined && body !== null) opt.body = body;
    var ctrl = null, timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        opt.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 25000);
      }
    } catch (e) {}
    return fetch(url, opt).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (t) { return { status: res.status, text: t, via: '直连' }; });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      var err = new Error(e && e.message ? e.message : String(e));
      if (e && e.name) err.name = e.name;
      err.transport = true;
      throw err;
    });
  }
  function reqBridge(method, url, headers, body) {
    var payload = { method: method, url: url, headers: headers };
    if (body !== undefined && body !== null) payload.body = body;
    return fetch('/api/gh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 404 || res.status === 405) {
        var e = new Error('本机通道不存在'); e.noBridge = true; throw e;
      }
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e2) {}
        if (!j || j.ok !== true) {
          var e3 = new Error(j && j.error ? ('本机通道报错：' + j.error) : '本机通道无响应');
          e3.transport = true; throw e3;
        }
        return { status: j.status, text: j.body, via: '本机通道' };
      });
    });
  }
  function request(method, url, headers, body) {
    if (IS_DESKTOP && bridgeState !== 'off') {
      return reqBridge(method, url, headers, body).then(function (r) {
        bridgeState = 'ok';
        return r;
      }).catch(function (e) {
        if (e && e.noBridge) bridgeState = 'off';       // 旧版桌面程序：退回直连
        else if (e && e.transport) bridgeState = 'off';  // 本机通道也失败：退回直连再试
        else bridgeState = 'off';
        return reqDirect(method, url, headers, body);
      });
    }
    return reqDirect(method, url, headers, body);
  }

  /* 带自动重试：网络抖动、5xx、超时都重试 4 次 */
  function ghRequest(method, path, bodyObj, onRetry) {
    var c = cfg();
    var url = path.indexOf('http') === 0 ? path : (API_BASE + path);
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (c.token) headers['Authorization'] = 'Bearer ' + c.token;
    var payload = null;
    if (bodyObj !== undefined && bodyObj !== null) {
      payload = JSON.stringify(bodyObj);
      headers['Content-Type'] = 'application/json';
    }
    var delays = [600, 1500, 3000];
    var attempt = 0;
    function once() {
      attempt++;
      return request(method, url, headers, payload).then(function (r) {
        lastVia = r.via || lastVia;
        if (r.status >= 500 && attempt <= delays.length) {
          return sleep(delays[attempt - 1]).then(once);
        }
        return r;
      }).catch(function (e) {
        if (attempt <= delays.length) {
          if (onRetry) onRetry(attempt, e);
          return sleep(delays[attempt - 1]).then(once);
        }
        var msg = (e && e.message) ? e.message : String(e);
        var kind = (e && e.transport) ? '网络不通' : '请求失败';
        if (/abort/i.test(msg)) kind = '连接超时（25 秒无响应）';
        else if (/Failed to fetch/i.test(msg)) kind = '连接被中断（常见于直连 api.github.com 被重置）';
        var err = new Error(kind + '：' + msg + '（已重试 ' + attempt + ' 次，通道：' + lastVia + '）');
        err.transport = true;
        throw err;
      });
    }
    return once();
  }

  /* ---------------- GitHub 仓库/文件操作 ---------------- */
  var metaCache = { ts: 0, data: null };
  function repoMeta(force) {
    if (!force && metaCache.data && Date.now() - metaCache.ts < 600000) {
      return Promise.resolve(metaCache.data);
    }
    if (!repoOk()) {
      return Promise.reject(new Error('仓库名格式不对：请填成「用户名/仓库名」，例如 IsabelHong/isabel-backup（当前识别为「' + normRepo() + '」）'));
    }
    return ghRequest('GET', '/repos/' + repoPath(), null, null).then(function (r) {
      if (r.status === 401) throw new Error('令牌无效或已过期（401 Bad credentials）。请重新生成 Token 再粘贴');
      if (r.status === 403) throw new Error('令牌权限不足或被限流（403）。请确认 Token 勾选了该仓库的 Contents 读写权限');
      if (r.status === 404) throw new Error('找不到仓库或令牌未授权它（404）。请核对仓库名拼写，并把该仓库加入 Token 的授权范围');
      if (r.status !== 200) throw new Error('仓库信息读取失败 ' + r.status + '：' + brief(r.text));
      var j = {};
      try { j = JSON.parse(r.text); } catch (e) {}
      metaCache = { ts: Date.now(), data: j };
      return j;
    });
  }
  function currentBranch() {
    return repoMeta().then(function (m) { return (m && m.default_branch) || 'main'; });
  }
  function getFile(branch) {
    var url = fileUrl() + (branch ? ('?ref=' + encodeURIComponent(branch)) : '');
    return ghRequest('GET', url, null, null).then(function (r) {
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error('读取云端备份失败 ' + r.status + '：' + brief(r.text));
      var j = {};
      try { j = JSON.parse(r.text); } catch (e) {}
      return { sha: j.sha, content: j.content || '' };
    });
  }
  function putFile(contentB64, sha, branch) {
    var body = { message: 'Isabel 工作台加密备份 ' + new Date().toISOString(), content: contentB64 };
    if (branch) body.branch = branch;
    if (sha) body.sha = sha;
    return ghRequest('PUT', fileUrl(), body, null);
  }

  /* ---------------- 备份（推送） ---------------- */
  var pushTimer = null, pullTimer = null, busySync = false;
  function doPush(manual) {
    if (busySync) { if (manual) toast('同步进行中，请稍候'); return Promise.resolve(false); }
    var c = cfg();
    if (!c.repo || !c.token || !c.pwd) {
      if (manual) toast('请先填写：GitHub 仓库、访问令牌(Token)、加密密码');
      return Promise.resolve(false);
    }
    var data = getData();
    if (!data) { if (manual) toast('数据尚未加载完成，请稍候'); return Promise.resolve(false); }
    var plain;
    try { plain = JSON.stringify(data); } catch (e) { plain = ''; }
    var fp = fingerprint(plain);
    if (!manual && localStorage.getItem(LS.lastHash) === fp) return Promise.resolve(false);

    busySync = true;
    if (manual) report('正在加密并上传…', 'run');
    return encryptJSON(data, c.pwd).then(function (pkg) {
      var contentB64 = b64enc(pkg);
      return currentBranch().then(function (branch) {
        return getFile(branch).then(function (existing) {
          return putFile(contentB64, existing ? existing.sha : null, branch).then(function (r) {
            if (r.status === 200 || r.status === 201) return branch;
            /* 空仓库 / 分支不存在 / 路径冲突：退回不带 branch 再试一次 */
            if (r.status === 409 || r.status === 422 || r.status === 404) {
              if (manual) report('正在重试（首次提交）…', 'run');
              return putFile(contentB64, null, null).then(function (r2) {
                if (r2.status === 200 || r2.status === 201) return '默认分支';
                throw new Error('写入失败 ' + r2.status + '：' + brief(r2.text));
              });
            }
            throw new Error('写入失败 ' + r.status + '：' + brief(r.text));
          });
        });
      });
    }).then(function (branch) {
      localStorage.setItem(LS.lastPush, String(Date.now()));
      localStorage.setItem(LS.lastHash, fp);
      clearErr();
      if (manual) {
        toast('✅ 已加密备份到 GitHub');
        report('✅ 备份成功\n   仓库：' + cfg().repo + '\n   分支：' + branch + '\n   通道：' + lastVia +
          '\n   时间：' + new Date().toLocaleString(), 'ok');
      }
      refreshStatus();
      return true;
    }).catch(function (e) {
      var m = (e && e.message) ? e.message : String(e);
      noteErr(m, manual);
      if (manual) { toast('❌ 备份失败：' + m); report('❌ 备份失败\n   ' + m + '\n   通道：' + lastVia, 'err'); }
      refreshStatus();
      return false;
    }).finally(function () { busySync = false; });
  }
  function scheduleBackup() {
    var c = cfg();
    if (!c.auto) return;
    var last = Number(localStorage.getItem(LS.lastPush) || 0);
    if (Date.now() - last < AUTO_PUSH_MIN_INTERVAL) return;   // 自动备份最快 5 分钟一次
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { doPush(false); }, AUTO_PUSH_DEBOUNCE);
  }

  /* ---------------- 拉取（合并，最后写入获胜） ---------------- */
  function doPull(manual) {
    if (!getData()) { if (manual) toast('数据尚未加载完成，请稍候'); return Promise.resolve(false); }
    if (busySync) { if (manual) toast('同步进行中，请稍候'); return Promise.resolve(false); }
    var c = cfg();
    if (!c.repo || !c.token || !c.pwd) {
      if (manual) toast('请先填写配置');
      return Promise.resolve(false);
    }
    busySync = true;
    if (manual) report('正在从云端拉取…', 'run');
    return currentBranch().then(function (branch) {
      return getFile(branch).then(function (existing) {
        if (!existing) {
          if (manual) { toast('云端暂无备份（请先在某端「立即备份」）'); report('云端暂无备份文件。请先点「立即备份」。', 'run'); }
          clearErr();          /* 能读到仓库本身，说明通道正常 */
          refreshStatus();
          return false;
        }
        var pkg = b64dec(String(existing.content).replace(/\s+/g, ''));
        return decryptJSON(pkg, c.pwd).then(function (remote) {
          var local = getData();
          var remoteTs = remote.lastSavedTs || 0;
          var localTs = local ? (local.lastSavedTs || 0) : 0;
          if (remoteTs > localTs) {
            var cur = getData();
            if (cur) {
              for (var k in remote) {
                if (Object.prototype.hasOwnProperty.call(remote, k)) cur[k] = remote[k];
              }
            }
            doSave();
            localStorage.setItem(LS.lastPull, String(Date.now()));
            clearErr();
            if (manual) {
              toast('✅ 已从云端拉取并合并最新数据');
              report('✅ 已拉取云端最新数据\n   云端时间戳：' + new Date(remoteTs).toLocaleString() +
                '\n   通道：' + lastVia, 'ok');
            }
            try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
            refreshStatus();
            return true;
          }
          if (manual) {
            toast('本地已是最新，无需拉取');
            report('本地已是最新，无需拉取。\n   本地时间戳：' + new Date(localTs).toLocaleString() +
              '\n   云端时间戳：' + new Date(remoteTs).toLocaleString(), 'run');
          }
          clearErr();          /* 能读到并比对成功，说明通道正常 */
          refreshStatus();
          return false;
        });
      });
    }).catch(function (e) {
      var m = (e && e.message) ? e.message : String(e);
      noteErr(m, manual);
      if (manual) { toast('❌ 拉取失败：' + m); report('❌ 拉取失败\n   ' + m + '\n   （若提示解密失败，多为密码不一致）', 'err'); }
      refreshStatus();
      return false;
    }).finally(function () { busySync = false; });
  }

  /* ---------------- 连接测试 ---------------- */
  function testConn() {
    var c = cfg();
    if (!c.repo || !c.token) { toast('请先填写仓库与 Token'); return Promise.resolve(false); }
    report('正在测试连接…', 'run');
    var t0 = Date.now();
    var lines = [];
    return repoMeta(true).then(function (meta) {
      var ms = Date.now() - t0;
      lines.push('✅ 连接成功（' + ms + 'ms）　通道：' + lastVia);
      lines.push('   仓库：' + (meta.full_name || c.repo) + (meta.private ? '（私有 ✅ 安全）' : '（⚠️ 公开仓库，请改私有！）'));
      lines.push('   默认分支：' + (meta.default_branch || 'main'));
      if (!TOKEN_RE.test(c.token)) lines.push('   ⚠️ Token 格式不像标准格式（一般以 github_pat_ 开头），但仍尝试了连接');
      return getFile(meta.default_branch).then(function (f) {
        lines.push(f ? '   云端备份文件：已存在，可以拉取' : '   云端备份文件：暂无（点「立即备份」创建）');
        if (f && f.sha) lines.push('   云端版本号：' + String(f.sha).slice(0, 7));
        clearErr();                 /* 关键：测通即清掉历史错误，避免"成功"与"失败"同屏 */
        report(lines.join('\n'), 'ok');
        refreshStatus();
        toast('✅ 连接成功' + (meta.private ? '（私有仓库，安全）' : '，但仓库是公开的！'));
      });
    }).catch(function (e) {
      var m = (e && e.message) ? e.message : String(e);
      lines.push('❌ 连接失败：' + m);
      if (IS_DESKTOP) lines.push('   通道：' + lastVia + (bridgeState === 'off' ? '（本机通道不可用，已退回直连）' : ''));
      noteErr(m, true);
      report(lines.join('\n'), 'err');
      refreshStatus();
      toast('❌ 连接失败：' + m);
    });
  }

  /* ---------------- 网络自检 ---------------- */
  function runDiag() {
    var out = ['🔍 网络自检 ' + new Date().toLocaleString(), ''];
    function say(s) { out.push(s); report(out.join('\n'), 'run'); }
    say('① 运行环境：' + (IS_DESKTOP ? '桌面版（127.0.0.1）' : '浏览器 / 手机版'));
    say('   navigator.onLine = ' + navigator.onLine);

    var chain = Promise.resolve();
    if (IS_DESKTOP) {
      chain = chain.then(function () {
        var t = Date.now();
        return reqBridge('GET', API_BASE + '/', {}).then(function (r) {
          bridgeState = 'ok';
          say('② 本机通道 /api/gh：✅ 可用（' + r.status + '，' + (Date.now() - t) + 'ms）');
        }).catch(function (e) {
          bridgeState = 'off';
          say('② 本机通道 /api/gh：❌ 不可用 → ' + (e && e.message ? e.message : e));
          say('   说明：桌面程序可能是旧版本，请关闭后重新打开 Isabel 工作台。');
        });
      });
    } else {
      chain = chain.then(function () { say('② 本机通道 /api/gh：不适用（非桌面版）'); });
    }

    chain = chain.then(function () {
      var t = Date.now();
      return reqDirect('GET', API_BASE + '/', {}).then(function (r) {
        say('③ 直连 api.github.com：✅ 可用（' + r.status + '，' + (Date.now() - t) + 'ms）');
      }).catch(function (e) {
        say('③ 直连 api.github.com：❌ 失败 → ' + (e && e.message ? e.message : e));
        say('   这是网络侧对 GitHub 接口的干扰，手机热点通常也无法绕开。');
      });
    });

    chain = chain.then(function () {
      var c = cfg();
      say('④ 仓库 / 令牌：');
      if (!c.repo) { say('   ❌ 未填写仓库名'); return; }
      if (!c.token) { say('   ❌ 未填写 Token'); return; }
      if (!TOKEN_RE.test(c.token)) say('   ⚠️ Token 格式不标准（正常以 github_pat_ 开头），长度 ' + c.token.length);
      else say('   Token 格式正常，长度 ' + c.token.length);
      say('   识别为仓库：' + repoPath() + (repoOk() ? '' : '　❌ 格式不对，应为 用户名/仓库名'));
      if (!repoOk()) return;
      return ghRequest('GET', '/repos/' + repoPath(), null, null).then(function (r) {
        if (r.status === 200) {
          var j = {}; try { j = JSON.parse(r.text); } catch (e) {}
          say('   ✅ 仓库可访问：' + (j.full_name || c.repo) + (j.private ? '（私有）' : '（⚠️ 公开）') +
            '，默认分支 ' + (j.default_branch || 'main'));
          return getFile(j.default_branch).then(function (f) {
            say('   ' + (f ? '✅ 云端备份文件已存在' : 'ℹ️ 云端备份文件还没有（先点「立即备份」）'));
          });
        }
        if (r.status === 401) { say('   ❌ 令牌无效或已过期（401）。请重新生成 Token。'); return; }
        if (r.status === 403) { say('   ❌ 令牌权限不足（403）。请确认已勾选该仓库的 Contents 读写权限。'); return; }
        if (r.status === 404) { say('   ❌ 找不到仓库（404）。请核对仓库名，并把该仓库加入 Token 授权范围。'); return; }
        say('   ❌ 异常状态 ' + r.status + '：' + brief(r.text));
      }).catch(function (e) {
        say('   ❌ 请求失败：' + (e && e.message ? e.message : e));
      });
    });

    return chain.then(function () {
      say('');
      say('（把这段文字截图发我即可定位问题）');
    });
  }

  /* ---------------- 轻量 Toast ---------------- */
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99998;' +
        'background:rgba(40,30,55,.94);color:#fff;font-size:13px;padding:10px 16px;border-radius:10px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:88vw;line-height:1.5';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 4200);
  }

  /* ---------------- UI 注入 ---------------- */
  var myTab = null, myPanel = null;
  function report(text, kind) {
    var el = document.getElementById('iwDiag');
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
    el.style.borderLeftColor = kind === 'ok' ? '#2e9e5b' : (kind === 'err' ? '#d64545' : '#c3a4d8');
  }
  function fmtTime(ts) {
    if (!ts) return '从未';
    var d = new Date(Number(ts));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* 记录一次失败：带时间戳，便于判断它是否已经过时。
   * 来源标记取「或」：用户主动操作失败后，紧接着的后台失败不应
   * 把这条降级成"可忽略"，否则会掩盖她刚遇到的真实问题。 */
  function noteErr(m, manual) {
    try {
      var prevManual = localStorage.getItem(LS.lastErrManual) === '1';
      localStorage.setItem(LS.lastErr, m);
      localStorage.setItem(LS.lastErrTs, String(Date.now()));
      localStorage.setItem(LS.lastErrManual, (manual || prevManual) ? '1' : '0');
    } catch (e) {}
  }
  /* 任何一次成功都清掉历史错误：报错栏不该压着已经解决的问题 */
  function clearErr() {
    try {
      localStorage.removeItem(LS.lastErr);
      localStorage.removeItem(LS.lastErrTs);
      localStorage.removeItem(LS.lastErrManual);
    } catch (e) {}
  }

  /* 纯函数：这条"上次错误"是否已被之后的成功覆盖（抽出来便于单测） */
  function isStaleErr(errTs, lastOk) {
    if (!errTs) return true;                 /* 无时间戳的老数据：一律视为过时，不再显示 */
    return lastOk > 0 && lastOk >= errTs;
  }

  function refreshStatus() {
    if (!myPanel) return;
    var c = cfg();
    var missing = [];
    if (!c.repo) missing.push('仓库');
    if (!c.token) missing.push('Token');
    if (!c.pwd) missing.push('密码');
    var ok = missing.length === 0;
    var s = '配置：' + (ok ? '✅ 已填写' : '⚠️ 缺少 ' + missing.join('/')) +
      '　|　通道：' + (IS_DESKTOP ? (bridgeState === 'off' ? '直连（本机通道不可用）' : '本机（稳）') : '直连') +
      '　|　上次备份：' + fmtTime(localStorage.getItem(LS.lastPush)) +
      '　|　上次拉取：' + fmtTime(localStorage.getItem(LS.lastPull));
    if (c.repo && !repoOk()) s += '　|　⚠️ 仓库名格式应为 用户名/仓库名';
    if (c.token && !TOKEN_RE.test(c.token)) s += '　|　⚠️ Token 格式可疑';
    /* 只展示"还没被任何成功覆盖"的失败；已经成功过就不再吓人 */
    var err = localStorage.getItem(LS.lastErr);
    if (err) {
      var errTs = Number(localStorage.getItem(LS.lastErrTs) || 0);
      var lastOk = Math.max(
        Number(localStorage.getItem(LS.lastPush) || 0),
        Number(localStorage.getItem(LS.lastPull) || 0)
      );
      if (isStaleErr(errTs, lastOk)) {
        /* 已有成功操作在它之后：这条是历史残留，清掉 */
        clearErr();
      } else {
        var isManual = localStorage.getItem(LS.lastErrManual) !== '0';
        s += '　|　' + (isManual ? '⚠️ 上次失败：' : 'ⓘ 后台同步偶发失败（可忽略）：') +
          (err.length > 70 ? err.slice(0, 70) + '…' : err);
      }
    }
    var st = document.getElementById('iwStatus');
    if (st) st.textContent = s;
  }

  function buildUI() {
    var modal = document.getElementById('syncModal');
    if (!modal) return;
    var tabsRow = modal.querySelector('.sync-tabs');
    if (!tabsRow) return;

    myTab = document.createElement('div');
    myTab.className = 'sync-tab';
    myTab.id = 'syncTabGithub';
    myTab.textContent = '☁️ GitHub 加密备份';
    myTab.addEventListener('click', showMyTab);
    tabsRow.appendChild(myTab);

    myPanel = document.createElement('div');
    myPanel.className = 'sync-panel';
    myPanel.id = 'syncPanelGithub';
    var IN = 'width:100%;padding:7px 9px;border:1px solid #d9cfe6;border-radius:8px;font-size:13px';
    myPanel.innerHTML =
      '<div class="sync-info">把加密后的数据备份到你的 <b>GitHub 私有仓库</b>。' +
      '即使仓库被别人看到，没有密码也解不开。多端打开自动同步。' +
      (IS_DESKTOP ? '　<b>桌面版会走本机通道</b>，不受浏览器直连限制。' : '') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin:8px 0">' +
      '  <label style="font-size:13px">① GitHub 仓库（格式 <code>用户名/仓库名</code>）' +
      '    <input id="iwRepo" class="iw-input" placeholder="IsabelHong/isabel-backup" style="' + IN + '"></label>' +
      '  <label style="font-size:13px">② 访问令牌 Token（fine-grained，仅该仓库 Contents 读写）' +
      '    <input id="iwToken" type="password" class="iw-input" placeholder="github_pat_xxx" style="' + IN + '"></label>' +
      '  <label style="font-size:13px">③ 加密密码（务必牢记！遗忘无法找回）' +
      '    <input id="iwPwd" type="password" class="iw-input" placeholder="设置一个强密码" style="' + IN + '"></label>' +
      '  <label style="font-size:13px">备份文件路径（一般不用改）<input id="iwPath" class="iw-input" value="' + DEFAULT_PATH + '" style="' + IN + '"></label>' +
      '  <label style="font-size:13px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="iwAuto"> 记住密码并自动同步（本机保存密码，打开即自动拉取/保存即自动备份）</label>' +
      '</div>' +
      '<div class="sync-btn-row">' +
      '  <button class="btn btn-outline" id="iwTestBtn">🔌 测试连接</button>' +
      '  <button class="btn btn-primary" id="iwBackupBtn">☁️ 立即备份</button>' +
      '  <button class="btn btn-outline" id="iwPullBtn">📥 立即拉取</button>' +
      '  <button class="btn btn-outline" id="iwDiagBtn">🩺 网络自检</button>' +
      '  <button class="btn btn-outline" onclick="closeSyncModal()">关闭</button>' +
      '</div>' +
      '<div id="iwStatus" style="font-size:12px;color:#6b5a7e;margin-top:8px;line-height:1.6"></div>' +
      '<pre id="iwDiag" style="display:none;white-space:pre-wrap;font-size:12px;line-height:1.65;' +
      'color:#4a3d5c;background:#faf7fd;border:1px solid #ece2f5;border-left:4px solid #c3a4d8;' +
      'border-radius:8px;padding:8px 10px;margin:8px 0 0;max-height:220px;overflow:auto;font-family:inherit"></pre>' +
      '<div class="sync-steps">' +
      '<b>安全说明：</b><br>' +
      '· 数据用你的密码 AES-256 加密后才上传，GitHub 只存密文；仓库设为私有后连 GitHub 员工也看不到明文。<br>' +
      '· 密码只在本机用于加解密，从不上传到 GitHub。<br>' +
      '· Token 仅用于读写你自己的私有仓库，建议用「Fine-grained token」并只授权这一个仓库。<br>' +
      '· 加密密码一旦遗忘，任何人都无法恢复数据，请务必牢记或写在安全的地方。' +
      '</div>';
    modal.querySelector('.modal').appendChild(myPanel);

    var c = cfg();
    document.getElementById('iwRepo').value = c.repo;
    document.getElementById('iwToken').value = c.token;
    document.getElementById('iwPwd').value = c.pwd;
    document.getElementById('iwPath').value = c.path;
    document.getElementById('iwAuto').checked = c.auto;

    function saveField(id, key) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () { setCfg(key, this.value.trim()); refreshStatus(); });
      el.addEventListener('input', function () { setCfg(key, this.value.trim()); });
    }
    saveField('iwRepo', LS.repo); saveField('iwToken', LS.token);
    saveField('iwPwd', LS.pwd); saveField('iwPath', LS.path);
    document.getElementById('iwAuto').addEventListener('change', function () {
      setCfg(LS.auto, this.checked ? '1' : ''); refreshStatus(); if (this.checked) startAutoPull();
    });
    document.getElementById('iwTestBtn').addEventListener('click', function () { testConn(); });
    document.getElementById('iwBackupBtn').addEventListener('click', function () { doPush(true); });
    document.getElementById('iwPullBtn').addEventListener('click', function () { doPull(true); });
    document.getElementById('iwDiagBtn').addEventListener('click', function () { runDiag(); });

    var _orig = window.switchSyncTab;
    window.switchSyncTab = function (tab) {
      if (_orig) _orig(tab);
      if (myPanel) myPanel.classList.remove('active');
      if (myTab) myTab.classList.remove('active');
    };
    refreshStatus();
  }
  function showMyTab() {
    var modal = document.getElementById('syncModal');
    if (!modal) return;
    var panels = modal.querySelectorAll('.sync-panel');
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
    var tabs = modal.querySelectorAll('.sync-tab');
    for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
    if (myPanel) myPanel.classList.add('active');
    if (myTab) myTab.classList.add('active');
    refreshStatus();
  }

  /* ---------------- 接入主程序 saveData（自动备份） ---------------- */
  function hookSave() {
    if (typeof window.saveData !== 'function') return;
    var _orig = window.saveData;
    window.saveData = function () {
      var r = _orig.apply(this, arguments);
      try { scheduleBackup(); } catch (e) {}
      return r;
    };
  }

  /* ---------------- 自动定时拉取（双端实时同步） ---------------- */
  function startAutoPull() {
    if (!cfg().auto) return;
    if (pullTimer) clearInterval(pullTimer);
    pullTimer = setInterval(function () {
      var c = cfg();
      if (c.auto && c.repo && c.token && c.pwd && !busySync) doPull(false);
    }, AUTO_PULL_INTERVAL);
  }

  /* ---------------- 启动 ---------------- */
  function waitForData(cb) {
    var tries = 0;
    var iv = setInterval(function () {
      var d = getData();
      if (d || tries > 60) { clearInterval(iv); cb(!!d); }
      tries++;
    }, 250);
  }
  function init() {
    if (!cryptoReady()) return;   // 极老旧环境：不启用云同步
    try { hookSave(); } catch (e) {}
    var c0 = cfg();
    if (IS_DESKTOP && !(c0.repo && c0.token && c0.pwd)) {
      hydrateFromDisk(start);   // 端口变化导致配置"消失"时，从本机数据目录补回
    } else {
      start();
    }
  }
  function start() {
    try { buildUI(); } catch (e) {}
    mirrorRemote();   // 把本机已有配置补写一份到数据目录（含只有 localStorage 里才有的令牌）
    var c = cfg();
    if (c.auto && c.repo && c.token && c.pwd) {
      waitForData(function () { if (cfg().auto) doPull(false); });
    }
    startAutoPull();
  }

  /* 对外暴露，便于排查 */
  window.IWSync = {
    version: 'v62',
    diag: runDiag, test: testConn,
    push: function () { return doPush(true); },
    pull: function () { return doPull(true); },
    mirror: mirrorRemote, hydrate: hydrateFromDisk,
    cfg: cfg, repoPath: repoPath, desktop: IS_DESKTOP,
    isStaleErr: isStaleErr
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
