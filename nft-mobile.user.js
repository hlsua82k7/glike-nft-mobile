// ==UserScript==
// @name         NFT 手機版
// @namespace    http://tampermonkey.net/
// @version      1.3.0
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
      body: JSON.stringify({ key, device_id: localStorage.getItem('uni_site_account') || getDeviceId(), domain: location.hostname })
    });
    const result = await r.json();
    if (result.ok && result.user) {
      localStorage.setItem('uni_account', result.user);
    }
    return result;
  }

  const cached = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); } catch { return null; } })();
  const cacheValid = cached && cached.ok && (Date.now() - cached.ts < CACHE_MAX_AGE);

  // 功能開關（從 cache 讀取，驗證後更新）
  let FEATURES = cached?.features || { mobile_deposit:true, mobile_snipe:true, mobile_stats:true };
  const feat = (k) => FEATURES[k] !== false;

  async function boot() {
    // 必須先登入網站取得帳號，才能進行授權驗證
    let siteAccount = localStorage.getItem('uni_site_account');
    if (!siteAccount && IS_HOME) {
      // 在首頁時先嘗試抓帳號（tryDetectAccount 會在成功後再次呼叫 boot）
      tryDetectAccount();
      return;
    }
    if (!siteAccount) {
      // 非首頁且沒有帳號，靜默等待
      return;
    }

    // 每次重新讀 cache（不用常數，避免帳號切換後 cache 被清卻仍判為有效）
    const nowCache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); } catch { return null; } })();
    const nowCacheValid = nowCache && nowCache.ok && (Date.now() - nowCache.ts < CACHE_MAX_AGE);

    if (nowCacheValid) { init(); refreshLicense(); return; }
    try {
      const res = await verifyLicense(LICENSE_KEY);
      if (res.ok) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({...res, ts: Date.now()}));
        if (res.features) FEATURES = res.features;
        init();
      } else {
        showLicensePrompt(res.reason || '授權無效');
      }
    } catch {
      if (LICENSE_KEY && nowCacheValid) init();
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
    return entries.map(([b,a],i) => `${i+1}. ${b}  ${a.toLocaleString()}元`).join('\n')
      + `\n─────────────\n合計：${total.toLocaleString()}元`;
  }

  async function syncStatsFromList() {
    const today = todayKey();
    const btn = document.getElementById('m-stat-sync');
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    try {
      const res = await fetch('https://nft.glike.info/DepositList/', { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const table = doc.querySelector('table');
      if (!table) throw new Error('找不到表格');

      const headers = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
      let iAmt = 4, iBank = 6, iTime = 0;
      headers.forEach((h, i) => {
        if (/完成金[額额]/.test(h)) iAmt = i;
        if (/存[款帳帐戶户]/.test(h)) iBank = i;
        if (/時間|时间/.test(h)) iTime = i;
      });

      const dayStats = {};
      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
        if (cells.length < 5) continue;
        if ((cells[iTime] || '').slice(0, 10) !== today) continue;
        const amt = parseFloat((cells[iAmt] || '').replace(/,/g, '')) || 0;
        if (amt <= 0) continue;
        const bankRaw = cells[iBank] || '';
        const bank = bankRaw.split(/[\n\r\s　]+/).find(s => s && !/^\d{6,}$/.test(s)) || '未知銀行';
        dayStats[bank] = (dayStats[bank] || 0) + amt;
      }

      const all = loadStats(); all[today] = dayStats; saveStats(all);
      document.getElementById('m-stat-text').textContent = buildStatText();
    } catch(e) {
      document.getElementById('m-stat-text').textContent = '同步失敗：' + e.message;
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔄 同步'; }
  }

  // ── TG 發送 ───────────────────────────────────────────
  async function tgSend(text) {
    const token = localStorage.getItem('uni_tg_token');
    const chat  = localStorage.getItem('uni_tg_chat');
    if (!token || !chat) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' })
      });
    } catch {}
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

  function showOrderAlert(serial, amount, bank, isReminder = false) {
    // 移除舊彈窗
    document.getElementById('m-order-alert')?.remove();
    const d = document.createElement('div');
    d.id = 'm-order-alert';
    d.style.cssText = 'position:fixed;inset:0;z-index:9999998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;';
    d.innerHTML = `
      <div style="background:#1a1a2e;border:2px solid ${isReminder ? '#ff6b6b' : '#ffd700'};border-radius:16px;padding:28px 24px;width:300px;text-align:center;color:#fff;">
        <div style="font-size:36px;margin-bottom:8px;">${isReminder ? '⏰' : '🚨'}</div>
        <div style="font-size:20px;font-weight:700;color:${isReminder ? '#ff6b6b' : '#ffd700'};margin-bottom:16px;">${isReminder ? '未回報提醒' : '新銷貨訂單'}</div>
        <div style="background:#111;border-radius:10px;padding:14px;margin-bottom:20px;text-align:left;line-height:2;">
          <div style="font-size:13px;color:#aaa;">回報號碼</div>
          <div style="font-size:16px;font-weight:600;">${serial}</div>
          <div style="font-size:13px;color:#aaa;margin-top:8px;">金額</div>
          <div style="font-size:16px;font-weight:600;color:#4ec97a;">${amount}</div>
          <div style="font-size:13px;color:#aaa;margin-top:8px;">銀行</div>
          <div style="font-size:14px;">${bank}</div>
        </div>
        <button id="m-alert-close" style="width:100%;padding:13px;border:none;border-radius:10px;background:#5865f2;color:#fff;font-size:16px;font-weight:600;cursor:pointer;">確認知道了</button>
      </div>`;
    document.body.appendChild(d);
    document.getElementById('m-alert-close').onclick = () => d.remove();
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
      const stored = localStorage.getItem('uni_site_account') || localStorage.getItem('uni_account');
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
        <div style="font-size:11px;color:#f0c040;margin:4px 0 6px;line-height:1.4;">⚠️ 請保持此頁面開著，縮小後通知將停止</div>
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
        <div class="m-sec-t">📨 TG 通知設定</div>
        <input id="m-tg-token" type="text" placeholder="Bot Token" style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:12px;margin-bottom:6px;" value="${localStorage.getItem('uni_tg_token')||''}">
        <input id="m-tg-chat" type="text" placeholder="Chat ID" style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:12px;margin-bottom:8px;" value="${localStorage.getItem('uni_tg_chat')||''}">
        <div class="m-row">
          <button class="m-btn blue" id="m-tg-save">💾 儲存</button>
          <button class="m-btn" id="m-tg-detect">🔍 偵測 ID</button>
        </div>
        <div id="m-tg-st" style="font-size:11px;color:#aaa;margin-top:4px;"></div>
        <div class="m-row" style="margin-top:6px;">
          <button class="m-btn" id="m-tg-test">🧪 測試</button>
        </div>
      </div>

      <div class="m-sec">
        <div class="m-sec-t">📊 今日統計</div>
        <div class="m-st" id="m-stat-text" style="white-space:pre-wrap;">${buildStatText()}</div>
        <div class="m-row">
          <button class="m-btn blue" id="m-stat-sync">🔄 同步</button>
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
    document.getElementById('m-tg-detect')?.addEventListener('click', async () => {
      const token = document.getElementById('m-tg-token').value.trim() || localStorage.getItem('uni_tg_token');
      const st = document.getElementById('m-tg-st');
      const btn = document.getElementById('m-tg-detect');
      if (!token) { if (st) { st.textContent = '⚠️ 請先填入 Token'; st.style.color = '#f0c040'; } return; }
      if (st) { st.textContent = '🔍 偵測中...'; st.style.color = '#aaa'; }
      if (btn) btn.disabled = true;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&offset=-20`);
        const data = await r.json();
        if (!data.ok) { if (st) { st.textContent = '❌ Token 無效'; st.style.color = '#f55'; } return; }
        const updates = data.result || [];
        let chatId = '';
        for (let i = updates.length - 1; i >= 0; i--) {
          const u = updates[i];
          const id = u.message?.chat?.id || u.callback_query?.message?.chat?.id || u.channel_post?.chat?.id;
          if (id) { chatId = String(id); break; }
        }
        if (!chatId) { if (st) { st.textContent = '⚠️ 找不到訊息，請先對 Bot 傳一則訊息再試'; st.style.color = '#f0c040'; } return; }
        document.getElementById('m-tg-chat').value = chatId;
        if (st) { st.textContent = `✅ 偵測到：${chatId}，請按儲存`; st.style.color = '#4ec97a'; }
      } catch { if (st) { st.textContent = '❌ 網路錯誤'; st.style.color = '#f55'; } }
      if (btn) btn.disabled = false;
    });
    document.getElementById('m-tg-save')?.addEventListener('click', () => {
      const token = document.getElementById('m-tg-token').value.trim();
      const chat  = document.getElementById('m-tg-chat').value.trim();
      if (token) localStorage.setItem('uni_tg_token', token);
      if (chat)  localStorage.setItem('uni_tg_chat', chat);
      showToast('TG 設定已儲存');
    });
    document.getElementById('m-tg-test')?.addEventListener('click', async () => {
      const btn = document.getElementById('m-tg-test');
      if (btn) { btn.disabled = true; btn.textContent = '發送中…'; }
      await tgSend('✅ 手機版 TG 通知測試成功');
      if (btn) { btn.disabled = false; btn.textContent = '🧪 測試'; }
      showToast('測試訊息已發送');
    });
    document.getElementById('m-stat-sync')?.addEventListener('click', syncStatsFromList);
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
        const isNew = !entry;
        if (entry && now - entry.notifiedAt < RENOTIFY_MS) continue;

        const amount = tds[3]?.textContent?.trim() || '';
        const bank   = tds[6]?.textContent?.trim() || '';

        const firstNotifiedAt = entry?.firstNotifiedAt || now;
        st[serial] = { notifiedAt: now, firstNotifiedAt };
        saveDepState(st);

        // 記錄統計（只在第一次）
        if (isNew) {
          const amtNum = parseFloat((amount || '0').replace(/,/g, '')) || 0;
          if (amtNum > 0) recordDepositStat(bank, amtNum);
        }

        const isReminder = !isNew;
        const title = isReminder ? '⏰ 未回報提醒' : '🚨 新銷貨訂單';
        playBeep();
        showOrderAlert(serial, amount, bank, isReminder);
        setDepSt(`⚠️ ${isReminder ? '未回報！' : '有新訂單！'}${serial}`, '#ffd700');
        if (HAS_NOTIF && notifPerm === 'granted') {
          try { new Notification(title, { body: `回報號碼：${serial}\n金額：${amount}`, icon: '/favicon.ico' }); } catch {}
        }
        tgSend(`${title}\n回報號碼：${serial}\n金額：${amount}\n${bank}`);
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

  // ── 登入頁 ────────────────────────────────────────────
  function initLogin() {
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
    const stored = localStorage.getItem('uni_site_account') || localStorage.getItem('uni_account');

    // 從首頁 "Hey, 劉正鴻" 段落抓帳號
    let found = null;
    const heyEl = document.querySelector('.area_title_box .title p');
    if (heyEl) {
      const raw = heyEl.textContent.trim();
      found = raw.replace(/^Hey[,，]\s*/i, '').trim();
    }
    // 備用：側欄顯示名
    if (!found) {
      const sideEl = document.querySelector('.slider_header .info_box .text');
      if (sideEl) found = sideEl.textContent.trim();
    }

    if (found) {
      const prev = localStorage.getItem('uni_site_account');
      localStorage.setItem('uni_site_account', found);
      setAccountDisplay(found);
      // 帳號不同（換人登入）或第一次：清 cache 重新驗證
      if (prev !== found) {
        localStorage.removeItem(CACHE_KEY);
        boot();
      }
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

  boot();
})();
