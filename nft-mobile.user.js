// ==UserScript==
// @name         NFT 手機版
// @namespace    http://tampermonkey.net/
// @version      1.1.3
// @description  手機版：銷貨監控 / 搶單 / 統計（無TG）
// @author       gigig i
// @match        https://nft.glike.info/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── 授權驗證 ──────────────────────────────────────────
  const LICENSE_URL  = 'https://nft-license-worker.hlsua82k7.workers.dev';
  const LICENSE_KEY  = localStorage.getItem('uni_license') || '';
  const CACHE_KEY    = 'uni_license_cache';
  const CACHE_MAX_AGE= 99 * 24 * 60 * 60 * 1000;

  // 裝置 ID：第一次產生後永久存在 localStorage
  function getDeviceId() {
    let id = localStorage.getItem('uni_device_id');
    if (!id) {
      id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem('uni_device_id', id);
    }
    return id;
  }

  async function verifyLicense(key) {
    const r = await fetch(`${LICENSE_URL}/verify`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key, device_id: getDeviceId(), domain: location.hostname })
    });
    return await r.json();
  }

  const cached = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); } catch { return null; } })();
  const cacheValid = cached && cached.ok && (Date.now() - cached.ts < CACHE_MAX_AGE);

  // 功能開關（從 cache 讀取，驗證後更新）
  let FEATURES = cached?.features || { mobile_deposit:true, mobile_snipe:true, mobile_stats:true };
  const feat = (k) => FEATURES[k] !== false;

  async function boot() {
    // 先嘗試呼叫 Worker（即使沒有 key，bypass 模式下也會放行）
    if (cacheValid) { init(); refreshLicense(); return; }
    try {
      const res = await verifyLicense(LICENSE_KEY);
      if (res.ok) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({...res, ts: Date.now()}));
        if (res.features) FEATURES = res.features;
        init();
      } else {
        // Worker 拒絕：沒有 key 或 key 無效
        showLicensePrompt(res.reason || '授權無效');
      }
    } catch {
      // 網路失敗：有 key 且有 cache 就放行，否則顯示輸入框
      if (LICENSE_KEY && cacheValid) init();
      else if (!LICENSE_KEY) showLicensePrompt();
      else showLicensePrompt('驗證失敗，請檢查網路');
    }
  }

  async function refreshLicense() {
    try {
      const res = await verifyLicense(LICENSE_KEY);
      if (res.ok) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({...res, ts: Date.now()}));
        if (res.features) FEATURES = res.features;
      }
    } catch {}
  }

  function showLicensePrompt(msg) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;';
    d.innerHTML = `
      <div style="background:#1a1a2e;border-radius:16px;padding:24px;width:280px;color:#fff;text-align:center;">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px;">🔐 授權驗證</div>
        ${msg ? `<div style="color:#f0c040;font-size:12px;margin-bottom:12px;">${msg}</div>` : ''}
        <input id="m-lic-inp" type="text" placeholder="輸入授權碼" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:14px;margin-bottom:12px;">
        <button id="m-lic-ok" style="width:100%;padding:11px;border:none;border-radius:8px;background:#5865f2;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">驗證</button>
      </div>`;
    document.body.appendChild(d);
    document.getElementById('m-lic-ok').onclick = async () => {
      const key = document.getElementById('m-lic-inp').value.trim();
      if (!key) return;
      localStorage.setItem('uni_license', key);
      location.reload();
    };
  }

  // ── 頁面偵測 ──────────────────────────────────────────
  const PATH = location.pathname;
  const IS_LOGIN    = /^\/$|^\/Login\b/i.test(PATH) || PATH === '';
  const IS_HOME     = /\/Home\b/i.test(PATH);
  const IS_DEPOSIT  = /\/PaddingDeposit\b/i.test(PATH);
  const IS_PURCHASE = /\/PaddingPurchase\b|\/PaddingOrder\b|\/PaddingWithdraw\b/i.test(PATH);

  // ── 統計 ──────────────────────────────────────────────
  const STATS_KEY = 'uni_dep_stats';
  const todayKey  = () => new Date().toISOString().slice(0,10);
  const loadStats = () => { try { return JSON.parse(localStorage.getItem(STATS_KEY)||'{}'); } catch { return {}; } };
  const saveStats = s => localStorage.setItem(STATS_KEY, JSON.stringify(s));

  function recordDepositStat(bankName, amount) {
    const day = todayKey(), s = loadStats();
    if (!s[day]) s[day] = {};
    const key = bankName || '未知銀行';
    s[day][key] = (s[day][key] || 0) + amount;
    saveStats(s);
  }

  function buildStatText() {
    const stats = (loadStats()[todayKey()] || {});
    const entries = Object.entries(stats).sort((a,b) => b[1]-a[1]);
    if (!entries.length) return '今日尚無紀錄';
    const total = entries.reduce((s,[,v]) => s+v, 0);
    return entries.map(([b,a],i) => `${i+1}. ${b} ${a.toLocaleString()}元`).join('\n')
      + `\n合計：${total.toLocaleString()}元`;
  }

  // ── 通知 ──────────────────────────────────────────────
  const HAS_NOTIF = typeof Notification !== 'undefined';
  let notifPerm = HAS_NOTIF ? Notification.permission : 'denied';
  async function requestNotifPerm() {
    if (!HAS_NOTIF) return false;
    if (notifPerm === 'granted') return true;
    notifPerm = await Notification.requestPermission();
    return notifPerm === 'granted';
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.3, 0.6].forEach(t => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.5, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.25);
      });
    } catch {}
  }

  function pushNotif(title, body) {
    showToast(`${title}\n${body}`);
    playBeep();
    if (HAS_NOTIF && notifPerm === 'granted') {
      try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
    }
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999999;background:#1e1e3a;color:#fff;border:1px solid #5865f2;border-radius:12px;padding:12px 18px;font-size:13px;max-width:85vw;white-space:pre-wrap;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:-apple-system,sans-serif;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  // ── 主要初始化 ─────────────────────────────────────────
  function init() {
    buildPanel();
    if (IS_LOGIN)                              initLogin();
    if (feat('mobile_deposit'))                initDeposit();
    if (IS_PURCHASE && feat('mobile_snipe'))   initPurchase();
    if (IS_HOME)                               initHome();
    else {
      // 非首頁也嘗試顯示已存的帳號
      const stored = localStorage.getItem('uni_account');
      if (stored) setAccountDisplay(stored);
    }
    requestNotifPerm();
  }

  // ── 面板 ──────────────────────────────────────────────
  let panelOpen = false;

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #m-fab{position:fixed;bottom:20px;right:16px;z-index:999999;width:48px;height:48px;border-radius:50%;background:#5865f2;color:#fff;font-size:22px;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;}
      #m-panel{position:fixed;bottom:0;left:0;right:0;z-index:999998;background:#1a1a2e;border-top:2px solid #5865f2;border-radius:16px 16px 0 0;padding:16px;font-family:-apple-system,sans-serif;color:#fff;font-size:13px;transform:translateY(100%);transition:transform .3s ease;max-height:60vh;overflow-y:auto;}
      #m-panel.open{transform:translateY(0);}
      .m-sec{margin-bottom:14px;}
      .m-sec-t{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
      .m-row{display:flex;gap:8px;margin-bottom:6px;align-items:center;}
      .m-btn{flex:1;padding:10px 8px;border:none;border-radius:8px;background:#2a2a4a;color:#fff;font-size:13px;cursor:pointer;font-weight:600;}
      .m-btn.green{background:#1a4a2a;color:#4ec97a;}
      .m-btn.orange{background:#4a2a0a;color:#f0a040;}
      .m-btn.blue{background:#1a2a4a;color:#5b9cf6;}
      .m-st{font-size:12px;color:#888;padding:6px 0;min-height:20px;}
      .m-inp{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;font-size:14px;}
      .m-lbl{font-size:12px;color:#888;white-space:nowrap;width:60px;flex-shrink:0;}
      #m-dot{width:8px;height:8px;border-radius:50%;background:#555;display:inline-block;margin-right:6px;}
    `;
    document.head.appendChild(style);

    // FAB 按鈕
    const fab = document.createElement('button');
    fab.id = 'm-fab';
    fab.textContent = '☰';
    fab.onclick = togglePanel;
    document.body.appendChild(fab);

    // 面板
    const panel = document.createElement('div');
    panel.id = 'm-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);

    bindPanelEvents();
  }

  function buildPanelHTML() {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-weight:700;font-size:15px;"><span id="m-dot"></span>NFT 手機版</span>
        <button onclick="document.getElementById('m-panel').classList.remove('open')" style="border:none;background:none;color:#888;font-size:20px;cursor:pointer;">✕</button>
      </div>

      ${feat('mobile_deposit') ? `
      <div class="m-sec">
        <div class="m-sec-t">📦 銷貨監控</div>
        <div class="m-st" id="m-dep-st">● 監控中</div>
        <div class="m-row">
          <button class="m-btn orange" id="m-dep-pause">⏸ 暫停</button>
        </div>
      </div>` : ''}

      ${IS_PURCHASE && feat('mobile_snipe') ? `
      <div class="m-sec">
        <div class="m-sec-t">⚡ 搶單設定</div>
        <div class="m-row">
          <span class="m-lbl">最小金額</span>
          <input class="m-inp" id="m-s-min" type="number" value="10000" style="width:90px;">
        </div>
        <div class="m-row">
          <span class="m-lbl">最大金額</span>
          <input class="m-inp" id="m-s-max" type="number" value="60000" style="width:90px;">
        </div>
        <div class="m-row">
          <span class="m-lbl">輪詢(秒)</span>
          <input class="m-inp" id="m-s-sec" type="number" value="3" min="1" style="width:60px;">
        </div>
        <div class="m-row">
          <select id="m-s-acc" class="m-inp" style="flex:1;"></select>
          <button class="m-btn blue" id="m-s-import" style="flex:none;padding:8px 10px;white-space:nowrap;">匯入</button>
        </div>
        <div class="m-row" style="justify-content:space-between;font-size:12px;color:#888;padding:4px 0;">
          <span>查詢 <b id="m-s-checks" style="color:#fff">0</b></span>
          <span>搶到 <b id="m-s-hits" style="color:#4ec97a">0</b></span>
          <span>跳過 <b id="m-s-skip" style="color:#f0c040">0</b></span>
        </div>
        <div class="m-st" id="m-snipe-st" style="max-height:60px;overflow-y:auto;font-size:11px;">● 待機中</div>
        <div class="m-row">
          <button class="m-btn green" id="m-snipe-start">▶ 開始搶單</button>
          <button class="m-btn orange" id="m-snipe-stop" disabled>■ 停止</button>
        </div>
      </div>` : ''}

      <div class="m-sec">
        <div class="m-sec-t">📊 今日統計</div>
        <div class="m-st" id="m-stat-text" style="white-space:pre-wrap;">${buildStatText()}</div>
        <div class="m-row">
          <button class="m-btn blue" id="m-stat-refresh">🔄 更新</button>
        </div>
      </div>
    `;
  }

  function togglePanel() {
    const panel = document.getElementById('m-panel');
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
  }

  function bindPanelEvents() {
    document.getElementById('m-stat-refresh')?.addEventListener('click', () => {
      document.getElementById('m-stat-text').textContent = buildStatText();
    });
    // 搶單帳戶匯入
    document.getElementById('m-s-import')?.addEventListener('click', importSnipeAccs);
    // 搶單開始/停止
    document.getElementById('m-snipe-start')?.addEventListener('click', startSnipe);
    document.getElementById('m-snipe-stop')?.addEventListener('click', stopSnipe);
  }

  function setDepSt(msg, color) {
    const el = document.getElementById('m-dep-st');
    if (el) { el.textContent = msg; el.style.color = color || '#888'; }
    const dot = document.getElementById('m-dot');
    if (dot) dot.style.background = color || '#555';
  }

  // ── 銷貨監控 ──────────────────────────────────────────
  const CHECKIN_URL  = 'https://nft.glike.info/DepositList/checkInAjax';
  const RENOTIFY_MS  = 180000;
  const LS_DEP_STATE = 'uni_ogm_state';

  let depPaused = false;
  let depNotified = new Set();

  function loadDepState() { try { return JSON.parse(localStorage.getItem(LS_DEP_STATE)||'{}'); } catch { return {}; } }
  function saveDepState(m) { localStorage.setItem(LS_DEP_STATE, JSON.stringify(m)); }

  function initDeposit() {
    setDepSt('● 監控中', '#0f3');

    document.getElementById('m-dep-pause')?.addEventListener('click', () => {
      depPaused = !depPaused;
      const btn = document.getElementById('m-dep-pause');
      if (btn) { btn.textContent = depPaused ? '▶ 繼續' : '⏸ 暫停'; btn.className = `m-btn ${depPaused ? 'green' : 'orange'}`; }
      setDepSt(depPaused ? '● 已暫停' : '● 監控中', depPaused ? '#f90' : '#0f3');
    });

    setInterval(pollDeposit, 3000);
  }

  async function pollDeposit() {
    if (depPaused) return;
    try {
      const res = await fetch(CHECKIN_URL, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.IsSuccess || !data.cnt) return;

      // 有新單，抓 DepositList 明細
      const r2 = await fetch('https://nft.glike.info/DepositList/', { credentials: 'include' });
      if (!r2.ok) return;
      const doc = new DOMParser().parseFromString(await r2.text(), 'text/html');
      const rows = [...doc.querySelectorAll('table tr')].filter(r => r.querySelectorAll('td').length >= 8);
      const now = Date.now();
      const st = loadDepState();

      for (const row of rows) {
        const tds = [...row.querySelectorAll('td')];
        const serial = tds[2]?.textContent?.trim() || '';
        const done   = tds[4]?.textContent?.trim() || '0';
        if (!serial || (done !== '0' && done !== '')) continue;

        const entry = st[serial];
        if (entry && now - entry.notifiedAt < RENOTIFY_MS) continue;
        if (depNotified.has(serial)) continue;

        const amount = tds[3]?.textContent?.trim() || '';
        const bank   = tds[6]?.textContent?.trim() || '';

        depNotified.add(serial);
        st[serial] = { notifiedAt: now };
        saveDepState(st);

        pushNotif('🚨 新銷貨訂單', `回報號碼：${serial}\n金額：${amount}\n${bank}`);
        setDepSt(`⚠️ 有新訂單！${serial}`, '#ffd700');

        // 自動開啟面板
        const panel = document.getElementById('m-panel');
        if (panel && !panelOpen) { panelOpen = true; panel.classList.add('open'); }
      }
    } catch {}
  }

  // ── 搶單 ──────────────────────────────────────────────
  const SNIPE_ACCS_KEY = 'uni_snipe_accounts';
  let snipeRunning = false, snipeTimer = null, _snipeBusy = false;
  let snipeChecks = 0, snipeHits = 0, snipeSkip = 0;

  function loadSnipeAccs() { try { return JSON.parse(localStorage.getItem(SNIPE_ACCS_KEY)||'[]'); } catch { return []; } }
  function saveSnipeAccs(a) { localStorage.setItem(SNIPE_ACCS_KEY, JSON.stringify(a)); }

  function renderSnipeAccSel() {
    const sel = document.getElementById('m-s-acc'); if (!sel) return;
    const accs = loadSnipeAccs();
    sel.innerHTML = accs.length ? accs.map(a => `<option value="${a}">${a}</option>`).join('') : '<option value="">— 請先匯入帳戶 —</option>';
  }

  function snipeLog(msg) {
    const el = document.getElementById('m-snipe-st'); if (!el) return;
    const ts = new Date().toTimeString().slice(0,8);
    el.textContent = `[${ts}] ${msg}`;
  }

  function snipeStatsUpdate() {
    const g = id => document.getElementById(id);
    if (g('m-s-checks')) g('m-s-checks').textContent = snipeChecks;
    if (g('m-s-hits'))   g('m-s-hits').textContent   = snipeHits;
    if (g('m-s-skip'))   g('m-s-skip').textContent   = snipeSkip;
  }

  function snipePanelUpdate() {
    const s = document.getElementById('m-snipe-start');
    const p = document.getElementById('m-snipe-stop');
    if (s) s.disabled = snipeRunning;
    if (p) p.disabled = !snipeRunning;
    const dot = document.getElementById('m-dot');
    if (dot) dot.style.background = snipeRunning ? '#2d8a4e' : '#555';
  }

  const getSnipeMin = () => parseInt(document.getElementById('m-s-min')?.value) || 10000;
  const getSnipeMax = () => parseInt(document.getElementById('m-s-max')?.value) || 60000;
  const getSnipeSec = () => Math.max(1, parseInt(document.getElementById('m-s-sec')?.value) || 3) * 1000;
  const getSnipeAcc = () => document.getElementById('m-s-acc')?.value || '';

  async function importSnipeAccs() {
    snipeLog('匯入帳戶中...');
    try {
      const res = await fetch('https://nft.glike.info/BankAccList/', { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const seen = new Set(), accs = [];
      for (const el of doc.querySelectorAll('*')) {
        if (el.children.length > 8) continue;
        const ownText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
        const m = ownText.match(/([0-9]{6,20})/);
        if (!m) continue;
        const fullText = el.closest?.('[class]')?.textContent || el.textContent || '';
        if (!/银行卡|帳戶|帐户|卡號|卡号|收款/.test(fullText)) continue;
        const cardNo = m[1].trim();
        if (seen.has(cardNo)) continue;
        seen.add(cardNo);
        const card = el.closest?.('[class*="card"],[class*="item"],[class*="row"],[class*="col"],[class*="list"]') || el.parentElement;
        const nameEl = card?.querySelector('h1,h2,h3,h4,h5,b,strong,[class*="title"],[class*="name"],[class*="bank"]');
        let name = (nameEl?.textContent || '').trim().replace(/\s+/g, '').slice(0, 12);
        if (!name || /^\d+$/.test(name)) name = '';
        const entry = name ? `(${name})${cardNo}` : cardNo;
        if (!accs.includes(entry)) accs.push(entry);
      }
      if (!accs.length) { snipeLog('未找到銀行帳戶'); return; }
      saveSnipeAccs(accs); renderSnipeAccSel(); snipeLog(`已匯入 ${accs.length} 個帳戶`);
    } catch(e) { snipeLog('匯入失敗：' + e.message); }
  }

  async function doSnipe() {
    if (!snipeRunning || _snipeBusy) return;
    _snipeBusy = true;
    const acc = getSnipeAcc();
    if (!acc) { snipeLog('請先選擇帳戶'); _snipeBusy = false; return; }
    snipeChecks++; snipeStatsUpdate();
    try {
      const qRes = await fetch('https://nft.glike.info/PaddingWithdraw/grabOrderAjax', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: ''
      });
      const qJson = await qRes.json();
      if (!qJson.IsSuccess || !qJson.List?.length) { snipeLog('目前無單'); _snipeBusy = false; return; }
      const accDigits = (acc.match(/\d{6,}/) || [])[0] || '';
      let order = null, matched = null, amount = 0;
      for (const o of qJson.List) {
        const amt = Math.round(parseFloat(o.to_money) || 0);
        if (amt < getSnipeMin() || amt > getSnipeMax()) { snipeSkip++; snipeStatsUpdate(); snipeLog(`${amt.toLocaleString()}元 金額不符跳過`); continue; }
        const canAcc = o.can_acc || [];
        const m = canAcc.find(a => acc.includes(a.account_id) || accDigits === a.account_id) || canAcc[0];
        if (!m) { snipeLog('找不到符合帳戶'); continue; }
        order = o; matched = m; amount = amt; break;
      }
      if (!order) { _snipeBusy = false; return; }
      snipeLog(`搶單中 ${amount.toLocaleString()}元...`);
      const gRes = await fetch('https://nft.glike.info/PaddingWithdraw/grabAjax', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: `oid=${encodeURIComponent(order.oid)}&acc_sn=${encodeURIComponent(matched.acc_sn)}`
      });
      const gJson = await gRes.json();
      if (!gJson.IsSuccess) { snipeLog('搶單失敗：' + (gJson.Message || '')); _snipeBusy = false; return; }
      snipeHits++; snipeStatsUpdate();
      snipeLog(`搶到！${amount.toLocaleString()}元`);
      pushNotif('搶到進貨訂單', `${amount.toLocaleString()} 元`);
      stopSnipe();
      setTimeout(() => location.reload(), 500);
    } catch(e) { snipeLog('API 錯誤：' + e.message); }
    _snipeBusy = false;
  }

  function startSnipe() {
    if (snipeRunning) return;
    if (!getSnipeAcc()) { snipeLog('請先選擇帳戶'); return; }
    snipeRunning = true; snipeChecks = snipeHits = snipeSkip = 0;
    snipeStatsUpdate(); snipePanelUpdate(); snipeLog('開始搶單');
    doSnipe(); snipeTimer = setInterval(doSnipe, getSnipeSec());
  }

  function stopSnipe() {
    clearInterval(snipeTimer); snipeTimer = null; snipeRunning = false; _snipeBusy = false;
    snipePanelUpdate(); snipeLog('已停止');
  }

  function initPurchase() {
    renderSnipeAccSel();
  }

  // ── API 攔截器（偵測登入回應）────────────────────────────
  function installApiInterceptor() {
    // 攔截 fetch
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('json')) {
          clone.json().then(data => {
            const str = JSON.stringify(data).slice(0, 300);
            showToast(`[fetch] ${url.split('/').slice(-2).join('/')}\n${str}`);
          }).catch(() => {});
        }
      } catch {}
      return res;
    };

    // 攔截 XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._url = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          const str = JSON.stringify(data).slice(0, 300);
          showToast(`[xhr] ${(this._url||'').split('/').slice(-2).join('/')}\n${str}`);
        } catch {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // ── 登入頁 ────────────────────────────────────────────
  function initLogin() {
    installApiInterceptor();
    // 自動填入上次帳號（如果有）
    const savedAcc = localStorage.getItem('uni_last_account');
    if (savedAcc) {
      const accInput = document.querySelector('input[type="text"],input[name*="account"],input[name*="user"]');
      if (accInput && !accInput.value) accInput.value = savedAcc;
    }

    // 偵測登入表單送出，抓取帳號
    document.addEventListener('submit', e => {
      const form = e.target;
      const accInput = form.querySelector('input[type="text"],input[name*="account"],input[name*="user"],input[name*="Account"]');
      if (accInput && accInput.value.trim()) {
        const acc = accInput.value.trim();
        localStorage.setItem('uni_last_account', acc);
        localStorage.setItem('uni_account', acc);
        showToast(`偵測帳號：${acc}`);
      }
    }, true);
  }

  // ── 首頁 ──────────────────────────────────────────────
  function initHome() {
    setDepSt('● 首頁', '#5b9cf6');
    // 嘗試從頁面抓帳號
    tryDetectAccount();
  }

  function tryDetectAccount() {
    // 先看 localStorage 有沒有已存的帳號
    const stored = localStorage.getItem('uni_account');

    // 嘗試從頁面元素抓（常見的顯示位置）
    const selectors = [
      '.user-name', '.username', '.account', '#username', '#account',
      '[class*="user"]', '[class*="account"]', '[class*="member"]',
      'nav .name', 'header .name', '.profile-name'
    ];
    let found = null;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) { found = el.textContent.trim(); break; }
      } catch {}
    }

    // 也嘗試抓 API
    fetchAccountFromApi();

    const acc = found || stored;
    if (acc) {
      if (found) localStorage.setItem('uni_account', found);
      showToast(`登入帳號：${acc}`);
      setAccountDisplay(acc);
    } else if (stored) {
      setAccountDisplay(stored);
    }
  }

  function setAccountDisplay(acc) {
    let accEl = document.getElementById('m-account-info');
    if (!accEl) {
      accEl = document.createElement('div');
      accEl.id = 'm-account-info';
      accEl.style.cssText = 'font-size:11px;color:#aaa;padding:2px 0 6px;border-bottom:1px solid #333;margin-bottom:8px;';
      // 插到面板第一個子元素後面（標題列之後）
      const panel = document.getElementById('m-panel');
      if (panel) {
        const firstChild = panel.firstElementChild;
        if (firstChild) firstChild.after(accEl);
        else panel.prepend(accEl);
      }
    }
    accEl.textContent = '帳號：' + acc;
  }

  async function fetchAccountFromApi() {
    try {
      // 嘗試常見的 user info API
      const urls = ['/api/user', '/api/me', '/User/Info', '/Account/Info', '/Home/GetUserInfo'];
      for (const u of urls) {
        try {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) continue;
          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('json')) continue;
          const data = await r.json();
          // 嘗試常見欄位
          const acc = data.account || data.Account || data.username || data.UserName || data.name || data.Name || data.loginName;
          if (acc) {
            localStorage.setItem('uni_account', acc);
            showToast(`偵測帳號（API）：${acc}`);
            return;
          }
        } catch {}
      }
    } catch {}
  }

  boot();
})();
