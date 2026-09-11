/* ============================================================================
 * Isabel 工作台 · 云同步模块 (iw-sync.js)
 * 功能：把工作台数据用「密码 AES-256-GCM 加密」后备份到 GitHub 私有仓库，
 *      并在其他端（公司/家里/手机）打开时自动拉取合并，实现跨端保密同步。
 * 设计原则：
 *   - 零外部依赖（Web Crypto 原生 API），单文件即可运行。
 *   - 数据在浏览器/本地落盘前已加密，GitHub 上只存密文，仓库管理员无密码也读不到。
 *   - 密码仅用于加解密，从不上传；Token 仅用于写入你的私有仓库。
 *   - 非侵入式：通过 window.IWApp 桥接访问主程序状态，不改动主程序逻辑。
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
    lastPull: 'iw_sync_lastpull', lastErr: 'iw_sync_lasterr'
  };
  var DEFAULT_PATH = 'isabel-backup.json';
  var BACKUP_BRANCH = 'backup';
  function cfg() {
    return {
      repo: (localStorage.getItem(LS.repo) || '').trim(),
      token: (localStorage.getItem(LS.token) || '').trim(),
      path: (localStorage.getItem(LS.path) || DEFAULT_PATH).trim(),
      pwd: (localStorage.getItem(LS.pwd) || ''),
      auto: localStorage.getItem(LS.auto) === '1'
    };
  }
  function setCfg(k, v) { try { if (v === null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- 工具：base64 ---------------- */
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
    var parts = pkg.split('.');
    if (parts.length !== 3) throw new Error('备份格式不正确');
    var salt = new Uint8Array(b64ToBuf(parts[0]));
    var iv = new Uint8Array(b64ToBuf(parts[1]));
    var ct = b64ToBuf(parts[2]);
    return deriveKey(password, salt).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (pt) {
      return JSON.parse(bufToStr(pt));
    });
  }
  // 把任意字符串安全转 base64（应对非 ASCII）
  function b64enc(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64dec(b64) { return decodeURIResult(escape(atob(b64))); }
  function decodeURIResult(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /* ---------------- GitHub Contents API ---------------- */
  function apiUrl(c) {
    return 'https://api.github.com/repos/' + encodeURIComponent(c.repo) +
      '/contents/' + encodeURIComponent(c.path);
  }
  function ghHeaders(extra) {
    var c = cfg();
    var h = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + c.token };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  function ghGet() {
    var c = cfg();
    var url = apiUrl(c) + '?ref=' + BACKUP_BRANCH;
    return fetch(url, { headers: ghHeaders() }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) return res.text().then(function (t) { throw new Error('读取失败 ' + res.status + ' ' + t); });
      return res.json();
    });
  }
  function ghPut(contentB64, sha) {
    var c = cfg();
    var body = {
      message: 'Isabel 工作台加密备份 ' + new Date().toISOString(),
      content: contentB64,
      branch: BACKUP_BRANCH
    };
    if (sha) body.sha = sha;
    return fetch(apiUrl(c), {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('写入失败 ' + res.status + ' ' + t); });
      return res.json();
    });
  }

  /* ---------------- 备份（推送） ---------------- */
  var pushTimer = null;
  function doPush(manual) {
    var c = cfg();
    if (!c.repo || !c.token || !c.pwd) {
      if (manual) toast('请先填写：GitHub 仓库、访问令牌(Token)、加密密码');
      return Promise.resolve(false);
    }
    var data = getData();
    if (!data) { if (manual) toast('数据尚未加载完成，请稍候'); return Promise.resolve(false); }
    return encryptJSON(data, c.pwd).then(function (pkg) {
      var contentB64 = b64enc(pkg);
      return ghGet().then(function (existing) {
        var sha = existing ? existing.sha : null;
        return ghPut(contentB64, sha);
      }).then(function () {
        localStorage.setItem(LS.lastPush, String(Date.now()));
        localStorage.removeItem(LS.lastErr);
        if (manual) toast('✅ 已加密备份到 GitHub');
        refreshStatus();
        return true;
      });
    }).catch(function (e) {
      localStorage.setItem(LS.lastErr, String(e && e.message ? e.message : e));
      if (manual) toast('❌ 备份失败：' + (e && e.message ? e.message : e));
      refreshStatus();
      return false;
    });
  }
  function scheduleBackup() {
    if (!cfg().auto) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { doPush(false); }, 1500);
  }

  /* ---------------- 拉取（合并，最后写入获胜） ---------------- */
  function doPull(manual) {
    var c = cfg();
    if (!c.repo || !c.token || !c.pwd) {
      if (manual) toast('请先填写配置');
      return Promise.resolve(false);
    }
    return ghGet().then(function (existing) {
      if (!existing) { if (manual) toast('云端暂无备份（请先在某端「立即备份」）'); return false; }
      var pkg = b64dec(existing.content.replace(/\s+/g, ''));
      return decryptJSON(pkg, c.pwd).then(function (remote) {
        var local = getData();
        var remoteTs = remote.lastSavedTs || 0;
        var localTs = local ? (local.lastSavedTs || 0) : 0;
        if (remoteTs > localTs) {
          var cur = getData();
          if (cur) { for (var k in remote) { if (Object.prototype.hasOwnProperty.call(remote, k)) cur[k] = remote[k]; } }
          doSave();
          localStorage.setItem(LS.lastPull, String(Date.now()));
          if (manual) toast('✅ 已从云端拉取并合并最新数据');
          try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
          refreshStatus();
          return true;
        } else {
          if (manual) toast('本地已是最新，无需拉取');
          return false;
        }
      });
    }).catch(function (e) {
      if (manual) toast('❌ 拉取失败：' + (e && e.message ? e.message : e) + '（密码错误？）');
      return false;
    });
  }

  /* ---------------- 连接测试 ---------------- */
  function testConn() {
    var c = cfg();
    if (!c.repo || !c.token) { toast('请先填写仓库与 Token'); return; }
    toast('正在测试连接…');
    fetch('https://api.github.com/repos/' + encodeURIComponent(c.repo), { headers: ghHeaders() })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('仓库不可访问 ' + res.status + ' ' + t); });
        return res.json();
      })
      .then(function (j) {
        if (j.private) toast('✅ 连接成功，仓库「' + j.full_name + '」是私有仓库，安全');
        else toast('⚠️ 连接成功，但仓库是「公开」的！请改为私有仓库，否则数据可能被他人看到');
      })
      .catch(function (e) { toast('❌ 连接失败：' + (e && e.message ? e.message : e)); });
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
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 3200);
  }

  /* ---------------- UI 注入 ---------------- */
  var myTab = null, myPanel = null;
  function fmtTime(ts) {
    if (!ts) return '从未';
    var d = new Date(Number(ts));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function refreshStatus() {
    if (!myPanel) return;
    var c = cfg();
    var ok = c.repo && c.token && c.pwd;
    var s = '配置：' + (ok ? '✅ 已填写' : '⚠️ 未填全') +
      '　|　上次备份：' + fmtTime(localStorage.getItem(LS.lastPush)) +
      '　|　上次拉取：' + fmtTime(localStorage.getItem(LS.lastPull));
    if (localStorage.getItem(LS.lastErr)) s += '　|　⚠️ ' + localStorage.getItem(LS.lastErr);
    var st = document.getElementById('iwStatus');
    if (st) st.textContent = s;
  }

  function buildUI() {
    var modal = document.getElementById('syncModal');
    if (!modal) return;
    var tabsRow = modal.querySelector('.sync-tabs');
    if (!tabsRow) return;

    // 新增 Tab 按钮
    myTab = document.createElement('div');
    myTab.className = 'sync-tab';
    myTab.id = 'syncTabGithub';
    myTab.textContent = '☁️ GitHub 加密备份';
    myTab.addEventListener('click', showMyTab);
    tabsRow.appendChild(myTab);

    // 新增 Panel
    myPanel = document.createElement('div');
    myPanel.className = 'sync-panel';
    myPanel.id = 'syncPanelGithub';
    myPanel.innerHTML =
      '<div class="sync-info">把加密后的数据备份到你的 <b>GitHub 私有仓库</b>。' +
      '即使仓库被别人看到，没有密码也解不开。多端打开自动同步。</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin:8px 0">' +
      '  <label style="font-size:13px">① GitHub 仓库（格式 <code>用户名/仓库名</code>）' +
      '    <input id="iwRepo" class="iw-input" placeholder="isabel/isabel-backup" style="width:100%;padding:7px 9px;border:1px solid #d9cfe6;border-radius:8px;font-size:13px"></label>' +
      '  <label style="font-size:13px">② 访问令牌 Token（fine-grained，仅该仓库 Contents 读写）' +
      '    <input id="iwToken" type="password" class="iw-input" placeholder="github_pat_xxx" style="width:100%;padding:7px 9px;border:1px solid #d9cfe6;border-radius:8px;font-size:13px"></label>' +
      '  <label style="font-size:13px">③ 加密密码（务必牢记！遗忘无法找回）' +
      '    <input id="iwPwd" type="password" class="iw-input" placeholder="设置一个强密码" style="width:100%;padding:7px 9px;border:1px solid #d9cfe6;border-radius:8px;font-size:13px"></label>' +
      '  <label style="font-size:13px">备份文件路径（一般不用改）<input id="iwPath" class="iw-input" value="' + DEFAULT_PATH + '" style="width:100%;padding:7px 9px;border:1px solid #d9cfe6;border-radius:8px;font-size:13px"></label>' +
      '  <label style="font-size:13px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="iwAuto"> 记住密码并自动同步（本机保存密码，打开即自动拉取/保存即自动备份）</label>' +
      '</div>' +
      '<div class="sync-btn-row">' +
      '  <button class="btn btn-outline" id="iwTestBtn">🔌 测试连接</button>' +
      '  <button class="btn btn-primary" id="iwBackupBtn">☁️ 立即备份</button>' +
      '  <button class="btn btn-outline" id="iwPullBtn">📥 立即拉取</button>' +
      '  <button class="btn btn-outline" onclick="closeSyncModal()">关闭</button>' +
      '</div>' +
      '<div id="iwStatus" style="font-size:12px;color:#6b5a7e;margin-top:8px;line-height:1.6"></div>' +
      '<div class="sync-steps">' +
      '<b>安全说明：</b><br>' +
      '· 数据用你的密码 AES-256 加密后才上传，GitHub 只存密文；仓库设为私有后连 GitHub 员工也看不到明文。<br>' +
      '· 密码只在本机用于加解密，从不上传到 GitHub。<br>' +
      '· Token 仅用于写入你自己的私有仓库，建议用「Fine-grained token」并只授权这一个仓库。<br>' +
      '· 加密密码一旦遗忘，任何人都无法恢复数据，请务必牢记或写在安全的地方。' +
      '</div>';
    modal.querySelector('.modal').appendChild(myPanel);

    // 绑定
    var c = cfg();
    document.getElementById('iwRepo').value = c.repo;
    document.getElementById('iwToken').value = c.token;
    document.getElementById('iwPwd').value = c.pwd;
    document.getElementById('iwPath').value = c.path;
    document.getElementById('iwAuto').checked = c.auto;

    function saveField(id, key) {
      document.getElementById(id).addEventListener('change', function () { setCfg(key, this.value.trim()); refreshStatus(); });
    }
    saveField('iwRepo', LS.repo); saveField('iwToken', LS.token);
    saveField('iwPwd', LS.pwd); saveField('iwPath', LS.path);
    document.getElementById('iwAuto').addEventListener('change', function () {
      setCfg(LS.auto, this.checked ? '1' : ''); refreshStatus();
    });
    document.getElementById('iwTestBtn').addEventListener('click', testConn);
    document.getElementById('iwBackupBtn').addEventListener('click', function () { doPush(true); });
    document.getElementById('iwPullBtn').addEventListener('click', function () { doPull(true); });

    // 原切换函数需同时收起我的面板
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
    if (!cryptoReady()) {
      // 极老旧环境：不启用云同步，避免报错
      return;
    }
    try { hookSave(); } catch (e) {}
    try { buildUI(); } catch (e) {}
    var c = cfg();
    if (c.auto && c.repo && c.token && c.pwd) {
      waitForData(function () { if (cfg().auto) doPull(false); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
