/* Stack — personal silver & gold tracker. All holdings live on this device (localStorage),
   with optional private GitHub Gist backup. Rates come from data/*.json, refreshed by a
   GitHub Action from FENEGOSIDA. */
(function () {
  'use strict';

  const TOLA = 11.6638038;          // grams in one tola
  const OZT = 31.1034768;           // grams in one troy ounce
  const KEY = 'stack.v1';
  const MKEY = 'stack.market.v1';
  const GIST_FILE = 'stack-backup.json';
  const GIST_DESC = 'Stack — silver & gold tracker backup';

  const DEFAULT_SETTINGS = {
    unit: 'g',                      // 'g' | 'tola'
    hideValues: false,
    chargeBasis: 'total',           // 'total': % of the price paid · 'ontop': added on top of metal value
    silver: { makingPct: 4, makingThreshold: 500, sdfPct: 0.5, buybackPct: 0, goal: 1000, alertBelow: null, alertAbove: null },
    gold:   { makingPct: 4, makingThreshold: 500, sdfPct: 0.5, buybackPct: 0, goal: TOLA * 5, alertBelow: null, alertAbove: null },
    gist: { token: '', id: '', lastSync: null },
    lastExport: null,
    ignoreDupes: [],                // txnKeys the user confirmed are separate purchases
  };

  const FORMS = { bar: 'Bar', coin: 'Coin', granules: 'Granules', jewellery: 'Jewellery', utensil: 'Utensil', other: 'Other' };
  const METALS = ['silver', 'gold'];
  const NAME = { silver: 'Silver', gold: 'Gold' };

  // ------------------------------------------------------------------ state
  let state = load();
  let market = loadMarketCache();
  let currentView = 'home';
  const ui = { range: { silver: '3M', gold: '3M', ratio: '1Y', insights: 'ALL' } };

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    }
    return out;
  }

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    const s = { version: 1, txns: [], settings: DEFAULT_SETTINGS, updatedAt: 0 };
    if (raw && typeof raw === 'object') {
      s.txns = Array.isArray(raw.txns) ? raw.txns : [];
      s.settings = deepMerge(DEFAULT_SETTINGS, raw.settings || {});
      s.updatedAt = raw.updatedAt || 0;
    }
    return s;
  }

  function save(opts = {}) {
    if (!opts.keepStamp) state.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save on this device'); }
    requestPersistence();
    if (!opts.noSync) { scheduleGistPush(); scheduleCloudPush(); }
  }

  let persistAsked = false;
  function requestPersistence() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  function loadMarketCache() {
    try { return JSON.parse(localStorage.getItem(MKEY)) || { prices: null, history: null }; }
    catch (_) { return { prices: null, history: null }; }
  }
  function saveMarketCache() {
    try { localStorage.setItem(MKEY, JSON.stringify(market)); } catch (_) {}
  }

  // ------------------------------------------------------------------ utils
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };

  function money(v, o = {}) {
    if (v == null || !isFinite(v)) return '—';
    const sign = v < 0 ? '−' : (o.sign && v > 0 ? '+' : '');
    const body = (o.dec ? nf2 : nf0).format(Math.abs(v));
    const txt = `${sign}Rs ${body}`;
    return o.raw ? txt : `<span class="sensitive">${txt}</span>`;
  }
  function compactMoney(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v < 0 ? '−' : '') + 'Rs ' + Charts.compact(Math.abs(v));
  }
  function pct(v, dec = 2) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(dec) + '%';
  }
  const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const arrow = v => (v > 0 ? '▲' : v < 0 ? '▼' : '');

  function weight(g, o = {}) {
    const unit = o.unit || state.settings.unit;
    if (unit === 'tola') return `${(g / TOLA).toLocaleString('en-IN', { maximumFractionDigits: 2 })} tola`;
    if (Math.abs(g) >= 1000 && !o.noKg) return `${(g / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`;
    return `${g.toLocaleString('en-IN', { maximumFractionDigits: 2 })} g`;
  }
  const weightBoth = g => `${weight(g, { unit: 'g' })} · ${weight(g, { unit: 'tola' })}`;

  function todayNPT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' }); }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
  function fmtDate(s, o = {}) {
    if (!s) return '—';
    const d = new Date(parseDate(s));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(o.noYear ? {} : { year: 'numeric' }) });
  }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 864e5); }
  function ago(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function color(name) { return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const haptic = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (_) {} };

  // ------------------------------------------------------------------ calculations
  /** Making + SDF breakdown of a purchase, from the total price paid. */
  function breakdown(amount, makingPct, sdfPct, basis) {
    const m = (makingPct || 0) / 100, s = (sdfPct || 0) / 100;
    if (basis === 'ontop') {
      const metal = amount / ((1 + m) * (1 + s));
      const making = metal * m;
      return { metal, making, sdf: amount - metal - making };
    }
    const making = amount * m, sdf = amount * s;
    return { metal: amount - making - sdf, making, sdf };
  }

  function txnBreakdown(t) {
    if (t.type !== 'buy') return { metal: t.amount, making: 0, sdf: 0 };
    return breakdown(t.amount, t.makingPct, t.sdfPct, t.basis || state.settings.chargeBasis);
  }

  function rate(metal) {                       // Rs per tola, today
    return market.prices?.[metal]?.tola || null;
  }
  function prevRate(metal) { return market.prices?.[metal]?.prevTola || null; }
  function perGram(metal) { const r = rate(metal); return r ? r / TOLA : null; }

  function sortedTxns(metal) {
    return state.txns.filter(t => !metal || t.metal === metal)
      .slice().sort((a, b) => a.date.localeCompare(b.date) || (a.created || 0) - (b.created || 0));
  }

  /** Average-cost position for one metal. */
  function position(metal, asOf) {
    const p = { metal, grams: 0, cost: 0, metalCost: 0, making: 0, sdf: 0, realized: 0, invested: 0, received: 0,
      lifetimeMaking: 0, lifetimeSdf: 0, buys: 0, sells: 0, boughtGrams: 0, soldGrams: 0, first: null, flows: [] };
    for (const t of sortedTxns(metal)) {
      if (asOf && t.date > asOf) break;
      if (t.type === 'buy') {
        const b = txnBreakdown(t);
        p.grams += t.grams; p.cost += t.amount; p.metalCost += b.metal; p.making += b.making; p.sdf += b.sdf;
        p.lifetimeMaking += b.making; p.lifetimeSdf += b.sdf;
        p.invested += t.amount; p.buys++; p.boughtGrams += t.grams;
        p.first = p.first || t.date;
        p.flows.push([t.date, -t.amount]);
      } else {
        const g = Math.min(t.grams, p.grams);
        const frac = p.grams > 0 ? g / p.grams : 0;
        const out = p.cost * frac;
        p.realized += t.amount - out;
        p.cost -= out; p.metalCost -= p.metalCost * frac; p.making -= p.making * frac; p.sdf -= p.sdf * frac;
        p.grams -= g; p.received += t.amount; p.sells++; p.soldGrams += t.grams;
        p.flows.push([t.date, t.amount]);
      }
    }
    if (p.grams < 1e-9) { p.grams = 0; p.cost = 0; p.metalCost = 0; p.making = 0; p.sdf = 0; }
    const pg = perGram(metal);
    p.value = pg != null ? p.grams * pg : null;
    const bb = state.settings[metal].buybackPct || 0;
    p.buybackValue = p.value != null ? p.value * (1 - bb / 100) : null;
    p.unrealized = p.value != null ? p.value - p.cost : null;
    p.unrealizedPct = p.cost > 0 && p.unrealized != null ? p.unrealized / p.cost : null;
    p.avgTola = p.grams > 0 ? (p.cost / p.grams) * TOLA : null;
    p.avgMetalTola = p.grams > 0 ? (p.metalCost / p.grams) * TOLA : null;
    const r = rate(metal), pr = prevRate(metal);
    p.dayChange = r && pr ? p.grams * (r - pr) / TOLA : null;
    p.totalReturn = p.value != null ? p.value + p.received - p.invested : null;
    return p;
  }

  function portfolio() {
    const s = position('silver'), g = position('gold');
    const sum = k => (s[k] || 0) + (g[k] || 0);
    const has = s.grams > 0 || g.grams > 0;
    const value = (s.value ?? 0) + (g.value ?? 0);
    const cost = sum('cost');
    const flows = [...s.flows, ...g.flows];
    return {
      silver: s, gold: g, has, any: state.txns.length > 0,
      value, cost, unrealized: value - cost, unrealizedPct: cost > 0 ? (value - cost) / cost : null,
      realized: sum('realized'), invested: sum('invested'), received: sum('received'),
      dayChange: (s.dayChange || 0) + (g.dayChange || 0),
      making: sum('lifetimeMaking'), sdf: sum('lifetimeSdf'),
      xirr: xirr(flows, value),
      first: [s.first, g.first].filter(Boolean).sort()[0] || null,
      buybackValue: (s.buybackValue ?? 0) + (g.buybackValue ?? 0),
    };
  }

  /** Annualised money-weighted return. flows: [[date, amount]]; terminal value counted today. */
  function xirr(flows, terminal) {
    if (!flows.length || !terminal) return null;
    const today = todayNPT();
    const cf = [...flows.map(([d, a]) => [daysBetween(flows[0][0], d) / 365, a]), [daysBetween(flows[0][0], today) / 365, terminal]];
    if (cf[cf.length - 1][0] < 30 / 365) return null; // too short to annualise meaningfully
    const f = r => cf.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
    let lo = -0.99, hi = 10;
    if (f(lo) * f(hi) > 0) return null;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ market data
  const RANGES = { '1W': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366, 'ALL': 1e6 };

  function hist(metal) { return (market.history?.[metal] || []).filter(r => r[1] > 0); }

  function series(metal, range) {
    const rows = hist(metal);
    if (!rows.length) return [];
    const last = parseDate(rows[rows.length - 1][0]);
    const from = last - RANGES[range] * 864e5;
    return rows.map(([d, v]) => [parseDate(d), v]).filter(([t]) => t >= from);
  }

  function ratioSeries(range) {
    const g = new Map(hist('gold')), out = [];
    for (const [d, s] of hist('silver')) if (g.has(d)) out.push([parseDate(d), g.get(d) / s]);
    if (!out.length) return out;
    const from = out[out.length - 1][0] - RANGES[range] * 864e5;
    return out.filter(([t]) => t >= from);
  }

  function stats(metal) {
    const rows = hist(metal);
    if (rows.length < 2) return null;
    const lastDate = rows[rows.length - 1][0];
    const yr = rows.filter(([d]) => daysBetween(d, lastDate) <= 365).map(r => r[1]);
    const cur = rate(metal) || rows[rows.length - 1][1];
    const hi = Math.max(...yr), lo = Math.min(...yr);
    const m30 = rows.filter(([d]) => daysBetween(d, lastDate) <= 31);
    const rets = [];
    for (let i = 1; i < m30.length; i++) rets.push(Math.log(m30[i][1] / m30[i - 1][1]));
    const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const change = days => {
      const target = parseDate(lastDate) - days * 864e5;
      const past = [...rows].reverse().find(([d]) => parseDate(d) <= target);
      return past ? cur / past[1] - 1 : null;
    };
    return {
      hi, lo, fromHi: cur / hi - 1, fromLo: cur / lo - 1, spanDays: daysBetween(rows[0][0], lastDate),
      vol: rets.length > 5 ? sd * Math.sqrt(300) : null,
      w1: change(7), m1: change(30), m3: change(91), y1: change(365),
    };
  }

  function intlImplied(metal) {
    const i = market.prices?.intl;
    if (!i || !i.usdnpr) return null;
    const usd = metal === 'gold' ? i.xau : i.xag;
    if (!usd) return null;
    const npr = usd * i.usdnpr / OZT * TOLA;
    const local = rate(metal);
    return { usd, usdnpr: i.usdnpr, implied: npr, premium: local ? local / npr - 1 : null };
  }

  function repoRaw(path) {
    const host = location.hostname;
    if (!host.endsWith('github.io')) return null;
    const owner = host.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    const repo = seg && !seg.includes('.') ? seg : `${owner}.github.io`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
  }

  async function getJSON(url, ms = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function refreshMarket(manual) {
    const bust = '?t=' + Math.floor(Date.now() / 60000);
    const pick = async path => {
      const urls = [path + bust];
      const raw = repoRaw(path);
      if (raw) urls.push(raw + bust);
      const res = await Promise.allSettled(urls.map(u => getJSON(u)));
      const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!ok.length) return null;
      // Prefer the freshest copy (raw.githubusercontent updates before Pages redeploys)
      return ok.sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')))[0];
    };
    const [prices, history] = await Promise.all([pick('data/prices.json'), pick('data/history.json')]);
    let changed = false;
    if (prices && prices.silver) { market.prices = prices; changed = true; }
    if (history && history.silver) { market.history = history; changed = true; }

    // Try FENEGOSIDA directly too — works if their API allows cross-origin reads.
    const live = await fetchFenegosidaLive().catch(() => null);
    if (live && (!market.prices || live.date >= market.prices.date)) {
      const intl = market.prices?.intl;
      market.prices = { ...(market.prices || {}), ...live, intl, live: true };
      for (const m of METALS) {
        const h = market.history?.[m];
        if (h) {
          const i = h.findIndex(r => r[0] === live.date);
          if (i >= 0) h[i][1] = live[m].tola; else h.push([live.date, live[m].tola]);
        }
      }
      changed = true;
    }
    if (changed) { market.loadedAt = new Date().toISOString(); saveMarketCache(); render(); }
    if (manual) toast(changed ? 'Rates updated' : 'Could not reach rate server');
  }

  async function fetchFenegosidaLive() {
    const rows = await getJSON('https://api.fenegosida.org/api/website/v1/Dashboard/today', 5000);
    const find = (metal, unit) => rows.find(r => (r.rateType || '').includes(metal) && r.rateType.includes(unit));
    const gt = find('सुन', 'तोला'), st = find('चाँदी', 'तोला'), gg = find('सुन', 'ग्राम'), sg = find('चाँदी', 'ग्राम');
    if (!gt || !st || gt.todayBaseRatePerGram < 10000 || st.todayBaseRatePerGram < 100) return null;
    const date = new Date(gt.todayDate.endsWith('Z') || /[+-]\d\d:\d\d$/.test(gt.todayDate) ? gt.todayDate : gt.todayDate + '+05:45')
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });
    return {
      source: 'FENEGOSIDA', date, fetchedAt: new Date().toISOString(),
      gold: { tola: gt.todayBaseRatePerGram, g10: gg?.todayBaseRatePerGram, prevTola: gt.yestardayBaseRatePerGram || null },
      silver: { tola: st.todayBaseRatePerGram, g10: sg?.todayBaseRatePerGram, prevTola: st.yestardayBaseRatePerGram || null },
    };
  }

  // ------------------------------------------------------------------ GitHub Gist backup
  let gistTimer = null, gistBusy = false;
  function gistHeaders() {
    return { Authorization: `Bearer ${state.settings.gist.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  }
  function backupPayload() {
    const settings = { ...state.settings, gist: { id: state.settings.gist.id } }; // never upload the token
    return { app: 'stack', version: 1, updatedAt: state.updatedAt, txns: state.txns, settings };
  }
  function scheduleGistPush() {
    if (!state.settings.gist.token) return;
    clearTimeout(gistTimer);
    gistTimer = setTimeout(() => gistPush().catch(e => console.warn('gist push', e)), 1500);
  }
  async function gistFind() {
    const r = await fetch('https://api.github.com/gists?per_page=100', { headers: gistHeaders() });
    if (!r.ok) throw new Error(r.status === 401 ? 'Token rejected' : 'GitHub error ' + r.status);
    const list = await r.json();
    const g = list.find(g => g.files && g.files[GIST_FILE]);
    return g ? g.id : null;
  }
  async function gistRead(id) {
    const r = await fetch(`https://api.github.com/gists/${id}`, { headers: gistHeaders(), cache: 'no-store' });
    if (!r.ok) throw new Error('GitHub error ' + r.status);
    const g = await r.json();
    const f = g.files[GIST_FILE];
    if (!f) return null;
    const content = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    return JSON.parse(content);
  }
  async function gistPush() {
    const gs = state.settings.gist;
    if (!gs.token || gistBusy) return;
    gistBusy = true;
    try {
      const body = { description: GIST_DESC, files: { [GIST_FILE]: { content: JSON.stringify(backupPayload(), null, 1) } } };
      let r;
      if (gs.id) r = await fetch(`https://api.github.com/gists/${gs.id}`, { method: 'PATCH', headers: gistHeaders(), body: JSON.stringify(body) });
      if (!gs.id || r.status === 404) r = await fetch('https://api.github.com/gists', { method: 'POST', headers: gistHeaders(), body: JSON.stringify({ ...body, public: false }) });
      if (!r.ok) throw new Error(r.status === 401 ? 'Token rejected' : 'GitHub error ' + r.status);
      const g = await r.json();
      gs.id = g.id; gs.lastSync = new Date().toISOString(); gs.error = null;
      save({ keepStamp: true, noSync: true });
    } catch (e) {
      gs.error = e.message; save({ keepStamp: true, noSync: true });
      throw e;
    } finally { gistBusy = false; }
  }
  /** Pull remote; adopt it if newer than local. Returns 'pulled' | 'pushed' | 'same'. */
  async function gistSync() {
    const gs = state.settings.gist;
    if (!gs.token) return null;
    if (!gs.id) gs.id = await gistFind();
    const remote = gs.id ? await gistRead(gs.id) : null;
    if (remote && remote.updatedAt > state.updatedAt) {
      adopt(remote);
      gs.lastSync = new Date().toISOString(); gs.error = null;
      save({ keepStamp: true, noSync: true });
      return 'pulled';
    }
    if (!remote || remote.updatedAt < state.updatedAt) { await gistPush(); return 'pushed'; }
    gs.lastSync = new Date().toISOString(); save({ keepStamp: true, noSync: true });
    return 'same';
  }
  function adopt(data) {
    const keepGist = state.settings.gist;
    state.txns = Array.isArray(data.txns) ? data.txns : [];
    state.settings = deepMerge(DEFAULT_SETTINGS, data.settings || {});
    state.settings.gist = { ...keepGist, id: keepGist.id || data.settings?.gist?.id || '' };
    state.updatedAt = data.updatedAt || Date.now();
  }

  // ------------------------------------------------------------------ Google sign-in + Firestore sync
  // js/cloud.js (a module) exposes window.StackCloud. Whole-document sync: newest wins, and the
  // first sync on a device merges transactions by id so signing in can never lose a purchase.
  let cloud = null, cloudUser = null, cloudReady = false, cloudUnwatch = null, cloudTimer = null;
  const cloudStatus = { lastSync: null, error: null, busy: false };

  function initCloud() {
    cloud = window.StackCloud;
    if (!cloud || !cloud.enabled) return;
    cloud.onUser(async user => {
      cloudUser = user; cloudReady = true;
      if (cloudUnwatch) { cloudUnwatch(); cloudUnwatch = null; }
      if (user) {
        try {
          const r = await cloudInitialSync();
          if (r) toast(r);
          cloudUnwatch = cloud.watch(remote => {
            if (remote && remote.updatedAt > state.updatedAt) {
              adopt(remote);
              save({ keepStamp: true, noSync: true });
              cloudStatus.lastSync = new Date().toISOString();
              render();
              toast('Updated from your other device');
            }
          });
        } catch (e) { cloudStatus.error = e.message; }
      }
      render();
      refreshAccountSection();
    });
  }

  async function cloudInitialSync() {
    cloudStatus.busy = true;
    try {
      const remote = await cloud.load();
      const local = state.txns, rtx = remote && Array.isArray(remote.txns) ? remote.txns : [];
      let msg = null;
      if (!remote || (!rtx.length && local.length)) {
        if (local.length || state.updatedAt) await cloud.save(backupPayload());
        if (local.length) msg = 'Your stack is now saved to your Google account';
      } else if (!local.length) {
        adopt(remote); save({ keepStamp: true, noSync: true });
        msg = `Loaded ${rtx.length} transactions from your Google account`;
      } else {
        const byId = new Map(rtx.map(t => [t.id, t]));
        // Also match by content: the same purchase typed on two devices before signing in
        // has two different ids, and must not be counted twice.
        const unmatched = new Map();
        for (const t of rtx) unmatched.set(txnKey(t), (unmatched.get(txnKey(t)) || 0) + 1);
        for (const t of local) if (byId.has(t.id)) unmatched.set(txnKey(byId.get(t.id)), unmatched.get(txnKey(byId.get(t.id))) - 1);
        const added = local.filter(t => {
          if (byId.has(t.id)) return false;
          const k = txnKey(t), n = unmatched.get(k) || 0;
          if (n > 0) { unmatched.set(k, n - 1); return false; }
          return true;
        });
        const newer = remote.updatedAt > state.updatedAt ? remote : backupPayload();
        if (remote.updatedAt > state.updatedAt) adopt(remote);
        if (added.length) {
          for (const t of added) byId.set(t.id, t);
          state.txns = [...byId.values()];
          state.settings = deepMerge(state.settings, { ...newer.settings, gist: state.settings.gist });
          save({ noSync: true });
          await cloud.save(backupPayload());
          msg = `Merged this device's ${added.length} new transaction${added.length > 1 ? 's' : ''} into your account`;
        } else if (remote.updatedAt < state.updatedAt) {
          await cloud.save(backupPayload());
        } else {
          save({ keepStamp: true, noSync: true });
        }
      }
      cloudStatus.lastSync = new Date().toISOString(); cloudStatus.error = null;
      return msg;
    } finally { cloudStatus.busy = false; }
  }

  function scheduleCloudPush() {
    if (!cloud || !cloud.enabled || !cloudUser) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(async () => {
      try {
        await cloud.save(backupPayload());
        cloudStatus.lastSync = new Date().toISOString(); cloudStatus.error = null;
      } catch (e) { cloudStatus.error = e.message; }
      refreshAccountSection();
    }, 800);
  }

  const G_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3zM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zm-5.6-8a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9zM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"/></svg>';

  function accountHtml() {
    if (!cloud) return `<div class="form-group"><div class="field"><label>Google sync</label><span class="small muted" style="margin-left:auto">Loading…</span></div></div>`;
    if (!cloud.enabled) {
      return cloud.reason === 'offline'
        ? `<div class="form-group"><div class="field"><label>Google sync</label><span class="small muted" style="margin-left:auto">Unavailable offline</span></div></div>`
        : `<div class="form-group"><div class="field"><label>Google sync</label><span class="small muted" style="margin-left:auto">Not set up yet</span></div></div>
           <div class="form-caption">Add your Firebase project's settings to <b>js/firebase-config.js</b> to turn on Sign in with Google. The steps are in the README.</div>`;
    }
    if (!cloudUser) {
      return `<button class="btn secondary block" id="sGoogle">${G_ICON} Sign in with Google</button>
        <div class="form-caption">Sign in with the same Google account on your phone and laptop, and every change syncs automatically. Your stack also keeps working offline.</div>`;
    }
    const u = cloudUser;
    const status = cloudStatus.error ? '⚠️ ' + esc(cloudStatus.error) : cloudStatus.busy ? 'Syncing…' : cloudStatus.lastSync ? 'Synced ' + ago(cloudStatus.lastSync) : 'Connected';
    return `<div class="form-group">
        <div class="field" style="padding-top:14px;padding-bottom:14px">
          ${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" style="width:40px;height:40px;border-radius:50%;flex:none">` : ''}
          <div class="li-main"><div class="li-title">${esc(u.displayName || 'Signed in')}</div><div class="li-sub">${esc(u.email || '')}</div></div>
        </div>
        <div class="field"><label>Sync</label><span class="small muted" style="margin-left:auto;text-align:right">${status}</span></div>
        <button class="field action" id="sSignOut">Sign out</button>
      </div>
      <div class="form-caption">Changes you make on any device signed in to this account appear everywhere within seconds.</div>`;
  }

  async function signInFlow() {
    if (!cloud || !cloud.enabled) return openSettings();
    try { await cloud.signIn(); }
    catch (e) { toast(e.code === 'auth/unauthorized-domain' ? 'Add this site to Firebase → Authentication → Authorized domains' : 'Sign-in failed: ' + (e.code || e.message)); }
  }

  function renderNav() {
    const box = $('#navUser');
    if (!box) return;
    if (cloudUser) {
      box.innerHTML = `<button class="nav-user-btn" id="navUserBtn">${avatar(34)}<span class="li-main"><span class="li-title">${esc(cloudUser.displayName || 'Account')}</span><span class="li-sub">${cloudStatus.error ? 'Sync issue' : 'Synced with Google'}</span></span></button>`;
      $('#navUserBtn').onclick = () => openSettings();
    } else if (cloud && cloud.enabled && cloudReady) {
      box.innerHTML = `<button class="btn gbtn small block" id="navSignin">${G_ICON}<span>Sign in with Google</span></button>`;
      $('#navSignin').onclick = signInFlow;
    } else {
      box.innerHTML = '';
    }
  }

  function bindAccount(root) {
    const g = $('#sGoogle', root);
    if (g) g.onclick = signInFlow;
    const o = $('#sSignOut', root);
    if (o) o.onclick = async () => {
      if (!confirm('Sign out? Your stack stays on this device, but stops syncing.')) return;
      await cloud.signOut(); toast('Signed out');
    };
  }

  function refreshAccountSection() {
    const box = $('#sAccount');
    if (box) { box.innerHTML = accountHtml(); bindAccount(box); }
  }

  // ------------------------------------------------------------------ rendering helpers
  const ICON = {
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  };

  function head(title, sub, actions = '') {
    return `<div class="page-head"><div><div class="sub">${sub}</div><h1>${title}</h1></div><div class="head-actions">${actions}</div></div>`;
  }

  function rangeSeg(key, opts = ['1W', '1M', '3M', '6M', '1Y', 'ALL']) {
    return `<div class="seg full" data-range="${key}">${opts.map(o => `<button class="${ui.range[key] === o ? 'on' : ''}" data-v="${o}">${o === 'ALL' ? 'All' : o}</button>`).join('')}</div>`;
  }

  function sourceLine() {
    const p = market.prices;
    if (!p) return 'Waiting for the first rate update…';
    return `${esc(p.source || 'FENEGOSIDA')} rate for ${fmtDate(p.date)} · checked ${ago(p.fetchedAt)}${p.stale ? ' · <b>stale</b>' : ''}`;
  }

  function txnRow(t) {
    const b = txnBreakdown(t);
    const isBuy = t.type === 'buy';
    const perTola = t.amount / t.grams * TOLA;
    const r = perGram(t.metal);
    let right = '';
    if (isBuy && r) {
      const pl = t.grams * r - t.amount;
      right = `<div class="s ${cls(pl)}">${money(pl, { sign: true })}</div>`;
    } else if (!isBuy) {
      right = '<div class="s muted">Sold</div>';
    }
    return `<button class="list-item" data-txn="${t.id}">
      <div class="li-icon ${isBuy ? t.metal : 'sell'}">${isBuy ? (t.metal === 'gold' ? 'Au' : 'Ag') : '↗'}</div>
      <div class="li-main">
        <div class="li-title">${weight(t.grams)} ${isBuy ? '' : 'sold'} ${t.form && FORMS[t.form] && isBuy ? '· ' + FORMS[t.form] : ''}</div>
        <div class="li-sub">${fmtDate(t.date)} · ${money(perTola, { raw: true })}/tola${isBuy && b.making > 0 ? ' · incl. making' : ''}</div>
      </div>
      <div class="li-right"><div class="t num">${money(t.amount)}</div>${right}</div>
    </button>`;
  }

  function bindTxnRows(root) {
    $$('[data-txn]', root).forEach(el => el.addEventListener('click', () => {
      const t = state.txns.find(x => x.id === el.dataset.txn);
      if (t) openTxnSheet(t);
    }));
  }

  function bindRange(root, key, rerender) {
    $$(`[data-range="${key}"] button`, root).forEach(b => b.addEventListener('click', () => {
      ui.range[key] = b.dataset.v; haptic(); rerender();
    }));
  }

  // ------------------------------------------------------------------ HOME
  /** Two-column page layout. Blocks are [order, html]; on phones they interleave by order. */
  function layout(main, side) {
    const blk = ([o, h]) => h ? `<section class="blk" style="order:${o}">${h}</section>` : '';
    return `<div class="layout"><div class="col main">${main.map(blk).join('')}</div><div class="col side">${side.map(blk).join('')}</div></div>`;
  }

  function greeting() {
    const h = +new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kathmandu' });
    return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  const firstName = () => (cloudUser?.displayName || '').trim().split(/\s+/)[0] || '';
  function avatar(size = 40) {
    const u = cloudUser;
    if (!u) return '';
    const initial = esc((firstName() || u.email || '?')[0].toUpperCase());
    return u.photoURL
      ? `<img class="avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" style="width:${size}px;height:${size}px">`
      : `<span class="avatar" style="width:${size}px;height:${size}px">${initial}</span>`;
  }

  function dailyLede(P) {
    const parts = [];
    for (const m of METALS) {
      const r = rate(m), pr = prevRate(m);
      if (r && pr && r !== pr) parts.push(`${NAME[m]} ${r > pr ? 'up' : 'down'} <span class="${cls(r - pr)}">${(Math.abs(r / pr - 1) * 100).toFixed(2)}%</span>`);
    }
    let s = parts.length ? parts.join(', ') + ' since the last rate.' : (market.prices ? 'Rates are unchanged from the last update.' : 'Fetching today\'s rates…');
    if (P.has && P.unrealized != null) s += ` Your stack is ${P.unrealized >= 0 ? 'up' : 'down'} <span class="${cls(P.unrealized)}">${money(Math.abs(P.unrealized))}</span> overall.`;
    return s;
  }

  function signinBanner() {
    if (!cloud || !cloud.enabled || !cloudReady || cloudUser) return '';
    let snoozed = 0;
    try { snoozed = +localStorage.getItem('stack.signinSnooze') || 0; } catch (_) {}
    if (Date.now() < snoozed) return '';
    return `<div class="card signin fade-in">
      <div class="signin-art" aria-hidden="true">${G_ICON}</div>
      <div class="signin-text">
        <h2>Keep your stack in sync</h2>
        <p>Sign in with Google to back up your holdings and see them on your phone and laptop, updated live.</p>
      </div>
      <div class="signin-actions">
        <button class="btn gbtn" id="homeGoogle">${G_ICON}<span>Sign in with Google</span></button>
        <button class="text-btn muted-link" id="homeSnooze">Not now</button>
      </div>
    </div>`;
  }

  function glanceHtml(P) {
    if (!P.any) return '';
    const sv = P.silver.value || 0, gv = P.gold.value || 0;
    return `<div class="card">
      <h3>At a glance</h3>
      <div class="row mt" style="align-items:center">
        ${Charts.ring([{ value: sv, color: color('silver') }, { value: gv, color: color('gold') }], { size: 104, stroke: 12, label: P.value ? Math.round(sv / P.value * 100) + '%' : '—', sub: 'silver' })}
        <div class="stack-v" style="flex:1;min-width:0">
          <div class="kv"><span class="k"><span class="metal-dot silver"></span> Silver</span><span class="v num">${weight(P.silver.grams)}</span></div>
          <div class="kv"><span class="k"><span class="metal-dot gold"></span> Gold</span><span class="v num">${weight(P.gold.grams)}</span></div>
        </div>
      </div>
      <div class="kv mt-s"><span class="k">Making charge + SDF paid</span><span class="v num">${money(P.making + P.sdf)}</span></div>
      <div class="kv"><span class="k">Annualised return</span><span class="v num ${cls(P.xirr)}">${P.xirr != null ? pct(P.xirr, 1) : '—'}</span></div>
      ${P.realized ? `<div class="kv"><span class="k">Realised P&amp;L</span><span class="v num ${cls(P.realized)}">${money(P.realized, { sign: true })}</span></div>` : ''}
    </div>`;
  }

  function snapshotHtml() {
    if (!market.prices) return '';
    const rows = METALS.map(m => {
      const st = stats(m), r = rate(m), pr = prevRate(m);
      const d1 = r && pr ? r / pr - 1 : null;
      const range = st ? Math.max(0, Math.min(1, (r - st.lo) / ((st.hi - st.lo) || 1))) : null;
      return `<div class="snap-row">
        <div class="snap-head"><span class="metal-dot ${m}"></span><b>${NAME[m]}</b><span class="muted small num">${r ? money(r, { raw: true }) : '—'}</span></div>
        <div class="snap-cells">
          ${[['1D', d1], ['1M', st?.m1], ['3M', st?.m3], ['1Y', st?.y1]].map(([k, v]) => `<div><span class="label">${k}</span><span class="num ${cls(v)}">${v == null ? '—' : pct(v, 1)}</span></div>`).join('')}
        </div>
        ${range != null ? `<div class="range"><span class="small muted num">${Charts.compact(st.lo)}</span><div class="range-track"><i style="left:${(range * 100).toFixed(1)}%"></i></div><span class="small muted num">${Charts.compact(st.hi)}</span></div>
        <div class="small muted" style="margin-top:6px">${st.spanDays >= 360 ? '52-week' : st.spanDays + '-day'} range · ${pct(st.fromHi, 1)} from high</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="section-title"><span>Market snapshot</span></div><div class="card snapshot">${rows}</div>`;
  }

  function goalsHtml(P) {
    if (!P.any) return '';
    const rows = METALS.map(m => {
      const goal = state.settings[m].goal, g = P[m].grams;
      if (!goal) return '';
      const prog = Math.min(1, g / goal);
      return `<div class="goal-row">
        <div class="row small"><span><span class="metal-dot ${m}"></span> ${NAME[m]} · ${weight(g)} of ${weight(goal)}</span><b class="num">${Math.round(prog * 100)}%</b></div>
        <div class="bar-track mt-s"><i style="width:${prog * 100}%;background:${m === 'gold' ? 'var(--accent)' : 'var(--text)'}"></i></div>
        <div class="small muted" style="margin-top:6px">${g >= goal ? 'Goal reached 🎉' : `${weight(goal - g)} to go${rate(m) ? ' · about ' + money((goal - g) / TOLA * rate(m), { raw: true }) : ''}`}</div>
      </div>`;
    }).join('');
    return rows ? `<div class="section-title"><span>Goals</span><button class="link" id="homeGoals">Edit</button></div><div class="card goals">${rows}</div>` : '';
  }

  function renderHome() {
    const el = $('#view-home');
    const P = portfolio();
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const name = firstName();
    const actions = `
      <button class="icon-btn" id="btnHide" aria-label="Hide values">${state.settings.hideValues ? ICON.eyeOff : ICON.eye}</button>
      ${cloudUser ? `<button class="avatar-btn" id="btnSettings" aria-label="Account and settings">${avatar(40)}</button>` : `<button class="icon-btn" id="btnSettings" aria-label="Settings">${ICON.gear}</button>`}`;

    let html = `<div class="page-head home-head"><div><div class="sub">${today}</div><h1>${greeting()}${name ? `, ${esc(name)}` : ''}</h1><p class="lede">${dailyLede(P)}</p></div><div class="head-actions">${actions}</div></div>`;
    html += signinBanner();
    html += alertsHtml();
    html += dupesHtml();

    let hero;
    if (!P.any) {
      hero = `<div class="card empty fade-in">
        <svg class="art" viewBox="0 0 84 84" aria-hidden="true">
          <defs><linearGradient id="ag" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#45413C" stop-opacity=".35"/><stop offset="1" stop-color="#45413C" stop-opacity=".8"/></linearGradient>
          <linearGradient id="au" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E2A77A" stop-opacity=".7"/><stop offset="1" stop-color="#E2A77A"/></linearGradient></defs>
          <path d="M14 58h40l-6-14H20z" fill="url(#ag)"/><path d="M30 44h40l-6-14H36z" fill="url(#au)"/><path d="M8 72h44l-6-14H14z" fill="url(#ag)" opacity=".85"/>
        </svg>
        <h2>Start your stack</h2>
        <p>Add your first silver or gold purchase. Making charge and SDF are worked out for you.</p>
        <button class="btn" id="btnFirst">Add a purchase</button>
      </div>`;
    } else {
      const dayPct = P.value - P.dayChange > 0 ? P.dayChange / (P.value - P.dayChange) : 0;
      hero = `<div class="card hero fade-in">
        <div class="hero-grid">
          <div>
            <div class="label">Stack value</div>
            <div class="big num">${money(P.value)}</div>
            <div class="hero-meta">
              <span class="pill ${cls(P.unrealized)}"><span class="sensitive">${arrow(P.unrealized)} ${money(P.unrealized, { sign: true, raw: true })}</span>&nbsp;${pct(P.unrealizedPct)}</span>
              ${P.dayChange ? `<span class="small ${cls(P.dayChange)}">${money(P.dayChange, { sign: true })} today (${pct(dayPct)})</span>` : ''}
            </div>
          </div>
          <div class="hero-chart-wrap"><div class="small muted" id="heroReadout">Value over the last 3 months</div><div class="chart hero-chart" id="heroChart"></div></div>
        </div>
        <div class="hero-split">
          <div class="mini"><div class="label">Cost basis</div><div class="v num">${money(P.cost)}</div></div>
          <div class="mini"><div class="label">If sold today</div><div class="v num">${money(P.buybackValue)}</div></div>
          <div class="mini"><div class="label">Total weight</div><div class="v num">${weight(P.silver.grams + P.gold.grams)}</div></div>
          <div class="mini"><div class="label">Purchases</div><div class="v num">${state.txns.filter(t => t.type === 'buy').length}</div></div>
        </div>
      </div>`;
    }

    const rates = `<div class="section-title"><span>Today's rates</span><button class="link" id="btnRefresh">Refresh</button></div>
      <div class="grid two">${METALS.map(priceTile).join('')}</div>
      <p class="footer-note" style="margin-top:14px">${sourceLine()}</p>`;

    const ratio = rate('gold') && rate('silver') ? rate('gold') / rate('silver') : null;
    let ratioCard = '';
    if (ratio) {
      const ii = market.prices?.intl;
      const sig = ii?.xau && ii?.xag ? ii.xau / ii.xag : ratio;
      const zone = ratioZone(sig);
      const gp = Math.max(0, Math.min(1, (sig - 30) / 90));
      ratioCard = `<div class="card price-tile" data-go="ratio">
        <div class="row"><div><div class="label">Gold ÷ Silver ratio</div><div class="mid num">${ratio.toFixed(1)}</div></div>
        <div class="row" style="gap:6px"><span class="pill">${zone.short}</span><span class="chev">${ICON.chev}</span></div></div>
        <div class="gauge" style="margin:18px 0 8px"><div class="needle" style="left:${(gp * 100).toFixed(1)}%"></div></div>
        <div class="gauge-labels"><span>Gold cheap</span><span>Silver cheap</span></div>
      </div>`;
    }

    let holdings = '', recent = '';
    if (P.any) {
      holdings = `<div class="section-title"><span>Holdings</span></div><div class="list">${METALS.filter(m => P[m].buys).map(m => {
        const p = P[m];
        return `<button class="list-item" data-go="${m}">
          <div class="li-icon ${m}">${m === 'gold' ? 'Au' : 'Ag'}</div>
          <div class="li-main"><div class="li-title">${NAME[m]}</div><div class="li-sub">${weight(p.grams)} · avg ${money(p.avgTola, { raw: true })}/tola</div></div>
          <div class="li-right"><div class="t num">${money(p.value)}</div><div class="s ${cls(p.unrealized)}">${pct(p.unrealizedPct)}</div></div>
        </button>`;
      }).join('')}</div>`;
      recent = `<div class="section-title"><span>Recent activity</span><button class="link" data-go="insights">Insights</button></div><div class="list">${sortedTxns().reverse().slice(0, 6).map(txnRow).join('')}</div>`;
    }

    html += layout(
      [[1, hero], [2, rates], [5, holdings], [6, recent]],
      [[3, ratioCard], [4, glanceHtml(P)], [7, snapshotHtml()], [8, goalsHtml(P)]],
    );

    html += backupNudge();
    html += `<p class="footer-note">${cloudUser ? `Synced with your Google account (${esc(cloudUser.email || '')}).` : `Your holdings are stored only on this device${state.settings.gist.token ? ' and in your private GitHub Gist' : ''}.`}<br>Rates: Federation of Nepal Gold &amp; Silver Dealers' Association.</p>`;

    el.innerHTML = html;
    METALS.forEach(m => { const s = $(`#spark-${m}`, el); if (s) Charts.spark(s, series(m, '1M').map(r => r[1]), color(m)); });

    const hc = $('#heroChart', el);
    if (hc) {
      const vh = valueHistory();
      const from = vh.value.length ? vh.value[vh.value.length - 1][0] - 92 * 864e5 : 0;
      const val = vh.value.filter(r => r[0] >= from), cost = vh.cost.filter(r => r[0] >= from);
      const ro = $('#heroReadout', el);
      Charts.line(hc, {
        series: [{ data: val, color: color('accent'), fill: true }, { data: cost, color: color('text-3'), width: 1.4, dash: '4 3' }],
        xAxis: false, yAxis: false, empty: 'Your value chart fills in as daily rates arrive',
        onScrub: pts => {
          if (!pts) { ro.textContent = 'Value over the last 3 months'; return; }
          ro.innerHTML = `${new Date(pts[0][0]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${money(pts[0][1])}`;
        },
      });
    }

    $('#btnSettings', el).onclick = () => openSettings();
    $('#btnHide', el).onclick = () => { state.settings.hideValues = !state.settings.hideValues; save(); applyPrefs(); renderHome(); };
    $('#btnRefresh', el).onclick = () => refreshMarket(true);
    const first = $('#btnFirst', el); if (first) first.onclick = () => openTxnSheet();
    $$('[data-go]', el).forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    bindTxnRows(el);
    const nb = $('#nudgeExport', el); if (nb) nb.onclick = () => (cloud && cloud.enabled ? signInFlow() : openSettings());
    const hg = $('#homeGoogle', el); if (hg) hg.onclick = signInFlow;
    const hs = $('#homeSnooze', el); if (hs) hs.onclick = () => { try { localStorage.setItem('stack.signinSnooze', Date.now() + 7 * 864e5); } catch (_) {} renderHome(); };
    const gl = $('#homeGoals', el); if (gl) gl.onclick = () => openSettings('goals');
    bindDupes(el);
  }

  function priceTile(m) {
    const r = rate(m), pr = prevRate(m);
    const ch = r && pr ? r - pr : null;
    return `<div class="card tight price-tile" data-go="${m}">
      <div class="name"><span class="metal-dot ${m}"></span>${NAME[m]} <span class="faint small" style="font-weight:500">per tola</span><span class="chev">${ICON.chev}</span></div>
      <div class="mid num ${r ? '' : 'skeleton'}">${r ? money(r, { raw: true }) : 'Rs 000,000'}</div>
      <div class="small ${cls(ch)}">${ch != null ? `${arrow(ch)} ${money(Math.abs(ch), { raw: true })} (${pct(ch / pr)})` : '&nbsp;'}</div>
      <div class="spark" id="spark-${m}"></div>
    </div>`;
  }

  /** Identity of a transaction by its details, independent of the random id. */
  function txnKey(t) {
    return [t.type, t.metal, t.date, (+t.grams).toFixed(2), Math.round(t.amount)].join('|');
  }

  function duplicateGroups() {
    const ignore = new Set(state.settings.ignoreDupes || []);
    const groups = new Map();
    for (const t of sortedTxns()) {
      const k = txnKey(t);
      if (ignore.has(k)) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    return [...groups.values()].filter(g => g.length > 1);
  }

  function dupesHtml() {
    const groups = duplicateGroups();
    if (!groups.length) return '';
    const extra = groups.reduce((n, g) => n + g.length - 1, 0);
    const items = groups.map(g => {
      const t = g[0];
      return `<li>${weight(t.grams)} ${t.metal} ${t.type === 'sell' ? 'sold' : ''} · ${fmtDate(t.date)} · ${money(t.amount)} <b>×${g.length}</b></li>`;
    }).join('');
    return `<div class="notice dupes fade-in"><span>⚠️</span><div style="flex:1">
      <b>${extra === 1 ? 'One entry looks' : `${extra} entries look`} like ${extra === 1 ? 'a duplicate' : 'duplicates'}.</b>
      This usually happens when the same purchase was added on two devices before signing in.
      <ul>${items}</ul>
      <div class="dupe-actions"><button class="btn small" id="dupesRemove">Remove duplicates</button><button class="text-btn" id="dupesKeep">They're separate purchases</button></div>
    </div></div>`;
  }

  function bindDupes(root) {
    const rm = $('#dupesRemove', root), keep = $('#dupesKeep', root);
    if (rm) rm.onclick = () => {
      const drop = new Set();
      for (const g of duplicateGroups()) for (const t of g.slice(1)) drop.add(t.id);
      state.txns = state.txns.filter(t => !drop.has(t.id));
      save(); render();
      toast(`Removed ${drop.size} duplicate${drop.size > 1 ? 's' : ''}`);
    };
    if (keep) keep.onclick = () => {
      state.settings.ignoreDupes = [...new Set([...(state.settings.ignoreDupes || []), ...duplicateGroups().map(g => txnKey(g[0]))])];
      save(); render();
    };
  }

  function alertsHtml() {
    let out = '';
    for (const m of METALS) {
      const r = rate(m), a = state.settings[m];
      if (!r) continue;
      if (a.alertBelow && r <= a.alertBelow) out += `<div class="notice info fade-in mt-s"><span>🔔</span><div><b>${NAME[m]} is at ${money(r, { raw: true })}</b> — at or below your buy target of ${money(a.alertBelow, { raw: true })}/tola.</div></div>`;
      if (a.alertAbove && r >= a.alertAbove) out += `<div class="notice fade-in mt-s"><span>🔔</span><div><b>${NAME[m]} is at ${money(r, { raw: true })}</b> — at or above your target of ${money(a.alertAbove, { raw: true })}/tola.</div></div>`;
    }
    return out ? `<div style="margin-bottom:14px">${out}</div>` : '';
  }

  function backupNudge() {
    if (!state.txns.length || state.settings.gist.token || cloudUser || (cloud && cloud.enabled)) return '';
    const last = state.settings.lastExport;
    if (last && Date.now() - new Date(last).getTime() < 30 * 864e5) return '';
    return `<div class="notice info mt"><span>☁️</span><div>Your stack lives only in this browser. <button class="text-btn" id="nudgeExport">Sign in with Google</button> to back it up and sync it across your devices.</div></div>`;
  }

  // ------------------------------------------------------------------ METAL VIEW
  function renderMetal(m) {
    const el = $(`#view-${m}`);
    const p = position(m);
    const r = rate(m), pr = prevRate(m);
    const st = stats(m);
    const ch = r && pr ? r - pr : null;
    const color_ = color(m);

    let html = head(NAME[m], 'FENEGOSIDA · per tola', `<button class="icon-btn" id="btnRef-${m}" aria-label="Refresh">${ICON.refresh}</button>`);

    const chartB = `<div class="card fade-in">
      <div class="chart-readout" id="readout-${m}"></div>
      <div class="chart" id="chart-${m}"></div>
      <div class="mt-s">${rangeSeg(m)}</div>
      ${p.buys ? `<div class="legend"><span><i style="background:${color_}"></i>Market</span><span><i style="background:${m === 'gold' ? 'var(--text)' : 'var(--accent)'}"></i>Your purchases</span>${p.avgTola ? '<span><i style="background:var(--text-3)"></i>Break-even</span>' : ''}</div>` : ''}
    </div>`;

    // Rates grid
    const g10 = market.prices?.[m]?.g10 || (r ? r / TOLA * 10 : null);
    const ratesB = `<div class="section-title"><span>Rates</span></div>
      <div class="stat-grid four">
        <div class="stat"><div class="label">Per tola</div><div class="v num">${r ? money(r, { raw: true }) : '—'}</div><div class="s ${cls(ch)}">${ch != null ? pct(ch / pr) + ' today' : '&nbsp;'}</div></div>
        <div class="stat"><div class="label">Per 10 g</div><div class="v num">${g10 ? money(g10, { raw: true }) : '—'}</div><div class="s muted">${r ? money(r / TOLA, { raw: true, dec: true }) + ' / g' : '&nbsp;'}</div></div>
        <div class="stat"><div class="label">${m === 'silver' ? 'Per kg' : 'Per 100 g'}</div><div class="v num">${r ? compactMoney(r / TOLA * (m === 'silver' ? 1000 : 100)) : '—'}</div><div class="s muted">&nbsp;</div></div>
        <div class="stat"><div class="label">Yesterday</div><div class="v num">${pr ? money(pr, { raw: true }) : '—'}</div><div class="s muted">${ch != null ? money(ch, { sign: true, raw: true }) : '&nbsp;'}</div></div>
      </div>`;

    let perfB = '';
    if (st) {
      perfB = `<div class="section-title"><span>Performance</span></div>
      <div class="card tight">
        <div class="stat-grid four" style="gap:0">
          ${[['1 week', st.w1], ['1 month', st.m1], ['3 months', st.m3], ['1 year', st.y1]].map(([k, v]) => `<div style="padding:6px 0"><div class="label">${k}</div><div class="v num ${cls(v)}" style="font-weight:650;font-size:17px">${v == null ? '—' : pct(v)}</div></div>`).join('')}
        </div>
        <div class="kv mt-s"><span class="k">${st.spanDays >= 360 ? '52-week' : st.spanDays + '-day'} high</span><span class="v num">${money(st.hi, { raw: true })} <span class="muted small">${pct(st.fromHi)}</span></span></div>
        <div class="kv"><span class="k">${st.spanDays >= 360 ? '52-week' : st.spanDays + '-day'} low</span><span class="v num">${money(st.lo, { raw: true })} <span class="muted small">${pct(st.fromLo)}</span></span></div>
        ${st.vol != null ? `<div class="kv"><span class="k">Volatility (30-day, annualised)</span><span class="v num">${(st.vol * 100).toFixed(1)}%</span></div>` : ''}
      </div>`;
    }

    const ii = intlImplied(m);
    let intlB = '';
    if (ii) {
      intlB = `<div class="section-title"><span>International</span></div>
      <div class="card tight">
        <div class="kv"><span class="k">Spot (${m === 'gold' ? 'XAU' : 'XAG'})</span><span class="v num">$${ii.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} / oz</span></div>
        <div class="kv"><span class="k">USD → NPR</span><span class="v num">${ii.usdnpr.toFixed(2)}</span></div>
        <div class="kv"><span class="k">Spot in NPR per tola</span><span class="v num">${money(ii.implied, { raw: true })}</span></div>
        ${ii.premium != null ? `<div class="kv"><span class="k">Nepal premium over spot</span><span class="v num">${pct(ii.premium, 1)}</span></div>` : ''}
        <div class="hint mt-s">The premium is mostly customs duty and local costs. When it widens, Nepal prices are rich relative to the world market.</div>
      </div>`;
    }

    // Position
    let posB = `<div class="section-title"><span>Your ${NAME[m].toLowerCase()}</span></div>`, txnB = '';
    if (!p.buys) {
      posB += `<div class="card empty"><h2>No ${NAME[m].toLowerCase()} yet</h2><p>Log a purchase to see your position, break-even and profit.</p><button class="btn" data-add="${m}">Add ${NAME[m].toLowerCase()}</button></div>`;
    } else {
      const goal = state.settings[m].goal;
      const prog = goal ? Math.min(1, p.grams / goal) : 0;
      posB += `<div class="card">
        <div class="row" style="align-items:center">
          <div class="stack-v">
            <div class="label">Holding</div>
            <div class="mid num">${weight(p.grams)}</div>
            <div class="small muted">${weightBoth(p.grams)}</div>
          </div>
          ${goal ? Charts.ring([{ value: prog, color: color_ }, { value: 1 - prog, color: 'transparent' }], { size: 96, stroke: 9, label: Math.round(prog * 100) + '%', sub: 'of goal', labelSize: 18 }) : ''}
        </div>
        <div class="mt">
          <div class="kv"><span class="k">Market value</span><span class="v num">${money(p.value)}</span></div>
          <div class="kv"><span class="k">Cost basis (incl. charges)</span><span class="v num">${money(p.cost)}</span></div>
          <div class="kv"><span class="k">Unrealised P&amp;L</span><span class="v num ${cls(p.unrealized)}">${money(p.unrealized, { sign: true })} · ${pct(p.unrealizedPct)}</span></div>
          ${p.dayChange != null ? `<div class="kv"><span class="k">Today</span><span class="v num ${cls(p.dayChange)}">${money(p.dayChange, { sign: true })}</span></div>` : ''}
          <div class="kv"><span class="k">Average cost / tola</span><span class="v num">${money(p.avgTola, { raw: true })}</span></div>
          <div class="kv"><span class="k">Average metal-only cost / tola</span><span class="v num">${money(p.avgMetalTola, { raw: true })}</span></div>
          <div class="kv"><span class="k">Break-even rate</span><span class="v num">${money(p.avgTola, { raw: true })} ${r ? `<span class="small ${cls(r - p.avgTola)}">${pct(r / p.avgTola - 1)}</span>` : ''}</span></div>
          ${state.settings[m].buybackPct ? `<div class="kv"><span class="k">If sold today (−${state.settings[m].buybackPct}% dealer cut)</span><span class="v num">${money(p.buybackValue)}</span></div>` : ''}
          <div class="kv"><span class="k">Making charge paid</span><span class="v num">${money(p.lifetimeMaking)}</span></div>
          <div class="kv"><span class="k">SDF paid</span><span class="v num">${money(p.lifetimeSdf)}</span></div>
          ${p.sells ? `<div class="kv"><span class="k">Realised P&amp;L</span><span class="v num ${cls(p.realized)}">${money(p.realized, { sign: true })}</span></div>` : ''}
        </div>
      </div>`;

      txnB = `<div class="section-title"><span>Transactions</span><button class="link" data-add="${m}">Add</button></div>
        <div class="list">${sortedTxns(m).reverse().map(txnRow).join('')}</div>`;
    }

    html += layout([[1, chartB], [5, posB], [6, txnB]], [[2, ratesB], [3, perfB], [4, intlB]]);
    html += `<p class="footer-note">${sourceLine()}</p>`;
    el.innerHTML = html;

    // Chart
    const draw = () => {
      const data = series(m, ui.range[m]);
      const from = data.length ? data[0][0] : 0;
      const markers = sortedTxns(m).filter(t => t.type === 'buy' && parseDate(t.date) >= from && data.length)
        .map(t => ({ t: parseDate(t.date), y: t.amount / t.grams * TOLA, color: color(m === 'gold' ? 'text' : 'accent'), r: 4 }));
      const refLines = p.avgTola && data.length ? [{ y: p.avgTola, color: color('text-2'), label: 'Break-even' }] : [];
      const readout = $(`#readout-${m}`, el);
      const setDefault = () => {
        if (!data.length) { readout.innerHTML = `<div class="v num">${r ? money(r, { raw: true }) : '—'}</div><div class="d">History builds up as rates are collected each day</div>`; return; }
        const first = data[0][1], last = data[data.length - 1][1];
        readout.innerHTML = `<div class="v num">${money(last, { raw: true })}</div><div class="d"><span class="${cls(last - first)}">${money(last - first, { sign: true, raw: true })} (${pct(last / first - 1)})</span> · ${ui.range[m] === 'ALL' ? 'all time' : 'past ' + ui.range[m]}</div>`;
      };
      setDefault();
      Charts.line($(`#chart-${m}`, el), {
        series: [{ data, color: color_, fill: true }], markers, refLines,
        empty: 'Price history will appear after a couple of daily updates',
        onScrub: pts => {
          if (!pts) return setDefault();
          const [t, v] = pts[0];
          const first = data[0][1];
          readout.innerHTML = `<div class="v num">${money(v, { raw: true })}</div><div class="d">${new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · <span class="${cls(v - first)}">${pct(v / first - 1)}</span></div>`;
        },
      });
    };
    draw();
    bindRange(el, m, () => { renderMetal(m); });
    $(`#btnRef-${m}`, el).onclick = () => refreshMarket(true);
    $$('[data-add]', el).forEach(b => b.onclick = () => openTxnSheet(null, { metal: b.dataset.add }));
    bindTxnRows(el);
  }

  // ------------------------------------------------------------------ RATIO
  function ratioZone(r) {
    if (r >= 90) return { short: 'Silver very cheap', text: 'Silver is historically very cheap relative to gold. Ratio stackers favour adding silver here.', pos: 'silver' };
    if (r >= 75) return { short: 'Silver cheap', text: 'Silver is cheap relative to gold by long-run standards. A good zone to accumulate silver.', pos: 'silver' };
    if (r >= 55) return { short: 'Neutral', text: 'The ratio is in its long-run normal band. Neither metal is clearly cheap against the other.', pos: 'neutral' };
    if (r >= 40) return { short: 'Gold cheap', text: 'Gold is cheap relative to silver. Ratio traders consider swapping some silver into gold.', pos: 'gold' };
    return { short: 'Gold very cheap', text: 'Silver is unusually expensive relative to gold. Historically this has not lasted long.', pos: 'gold' };
  }

  function renderRatio() {
    const el = $('#view-ratio');
    const g = rate('gold'), s = rate('silver');
    const ratio = g && s ? g / s : null;
    const i = market.prices?.intl;
    const intlRatio = i?.xau && i?.xag ? i.xau / i.xag : null;
    const all = ratioSeries('ALL');
    const vals = all.map(r => r[1]);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const pctile = ratio && vals.length > 5 ? vals.filter(v => v <= ratio).length / vals.length : null;
    const P = portfolio();

    let html = head('Ratio', 'Gold ÷ Silver');
    if (!ratio) {
      el.innerHTML = html + '<div class="card empty"><h2>Waiting for rates</h2><p>The ratio appears once today\'s gold and silver rates load.</p></div>';
      return;
    }
    // Zones are calibrated on the long-run global ratio; Nepal's is skewed by differing duties.
    const signal = intlRatio || ratio;
    const zone = ratioZone(signal);
    const gaugePos = Math.max(0, Math.min(1, (signal - 30) / (120 - 30)));
    const heroB = `<div class="card fade-in">
      <div class="label">Nepal ratio (FENEGOSIDA)</div>
      <div class="big num">${ratio.toFixed(2)}</div>
      <div class="small muted">1 tola of gold buys ${ratio.toFixed(1)} tola of silver</div>
      <div class="label mt">${intlRatio ? `Global signal · ${intlRatio.toFixed(1)}` : 'Signal'}</div>
      <div class="gauge" style="margin-top:12px"><div class="needle" style="left:${(gaugePos * 100).toFixed(1)}%"></div></div>
      <div class="gauge-labels"><span>30 · gold cheap</span><span>75</span><span>silver cheap · 120</span></div>
      <div class="notice ${zone.pos === 'neutral' ? 'info' : ''} mt"><div><b>${zone.short}.</b> ${zone.text}</div></div>
    </div>`;

    const statsB = `<div class="stat-grid four">
      <div class="stat"><div class="label">International</div><div class="v num">${intlRatio ? intlRatio.toFixed(2) : '—'}</div><div class="s muted">XAU ÷ XAG spot</div></div>
      <div class="stat"><div class="label">Your history avg</div><div class="v num">${avg ? avg.toFixed(2) : '—'}</div><div class="s muted">${all.length} days tracked</div></div>
      <div class="stat"><div class="label">Percentile</div><div class="v num">${pctile != null ? Math.round(pctile * 100) + 'th' : '—'}</div><div class="s muted">vs tracked history</div></div>
      <div class="stat"><div class="label">Long-run normal</div><div class="v num">55–80</div><div class="s muted">modern-era range</div></div>
    </div>`;

    const chartB = `<div class="card">
      <div class="chart-readout" id="readout-ratio"></div>
      <div class="chart" id="chart-ratio"></div>
      <div class="mt-s">${rangeSeg('ratio')}</div>
    </div>`;

    // Swap calculator
    const swapB = `<div class="section-title"><span>Swap calculator</span></div>
    <div class="card">
      <div class="seg full" id="swapDir"><button class="on" data-v="s2g">Silver → Gold</button><button data-v="g2s">Gold → Silver</button></div>
      <div class="form-group mt">
        <div class="field"><label for="swapAmt">Weight</label><input id="swapAmt" inputmode="decimal" placeholder="0" value="${P.silver.grams ? +P.silver.grams.toFixed(2) : 1000}"><span class="unit">g</span></div>
      </div>
      <div class="mid num mt" id="swapOut"></div>
      <div class="hint" id="swapHint"></div>
    </div>`;

    let otherB = '';
    if (P.silver.grams || P.gold.grams) {
      otherB = `<div class="section-title"><span>Your stack, in the other metal</span></div>
      <div class="card tight">
        ${P.silver.grams ? `<div class="kv"><span class="k">Your ${weight(P.silver.grams)} silver</span><span class="v num">= ${weight(P.silver.grams / ratio, { unit: 'g', noKg: true })} gold</span></div>` : ''}
        ${P.gold.grams ? `<div class="kv"><span class="k">Your ${weight(P.gold.grams)} gold</span><span class="v num">= ${weight(P.gold.grams * ratio, { unit: 'g' })} silver</span></div>` : ''}
        <div class="kv"><span class="k">Silver share of stack value</span><span class="v num">${P.value ? Math.round((P.silver.value || 0) / P.value * 100) : 0}%</span></div>
      </div>`;
    }

    const explainB = `<div class="card tight"><div class="hint">
      <b>How stackers use the ratio.</b> When the ratio is high, silver is cheap relative to gold, so you get more metal by buying silver. When it falls, swapping silver into gold locks in the gain in ounces, not just rupees.
      Over the last century the global ratio has mostly sat between 40 and 100. Nepal's ratio differs from the international one because import duties differ for each metal. Remember that every swap costs making charges, SDF and dealer spreads.
    </div></div>`;

    html += layout([[1, heroB], [3, chartB], [6, explainB]], [[2, statsB], [4, swapB], [5, otherB]]);
    el.innerHTML = html;

    const data = ratioSeries(ui.range.ratio);
    const readout = $('#readout-ratio', el);
    const setDefault = () => {
      if (data.length < 2) { readout.innerHTML = `<div class="v num">${ratio.toFixed(2)}</div><div class="d">History builds up daily</div>`; return; }
      const lo = Math.min(...data.map(d => d[1])), hi = Math.max(...data.map(d => d[1]));
      readout.innerHTML = `<div class="v num">${ratio.toFixed(2)}</div><div class="d">Range ${lo.toFixed(1)} – ${hi.toFixed(1)} · ${ui.range.ratio === 'ALL' ? 'all time' : 'past ' + ui.range.ratio}</div>`;
    };
    setDefault();
    Charts.line($('#chart-ratio', el), {
      series: [{ data, color: color('text'), fill: true }],
      refLines: avg && data.length > 1 ? [{ y: avg, color: color('accent'), label: 'Average ' + avg.toFixed(1) }] : [],
      yTick: v => v.toFixed(0),
      empty: 'Ratio history appears as daily rates are collected',
      onScrub: pts => {
        if (!pts) return setDefault();
        readout.innerHTML = `<div class="v num">${pts[0][1].toFixed(2)}</div><div class="d">${new Date(pts[0][0]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>`;
      },
    });
    bindRange(el, 'ratio', renderRatio);

    let dir = 's2g';
    const calc = () => {
      const w = num($('#swapAmt', el).value);
      const out = dir === 's2g' ? w / ratio : w * ratio;
      const from = dir === 's2g' ? 'silver' : 'gold', to = dir === 's2g' ? 'gold' : 'silver';
      $('#swapOut', el).innerHTML = `${weight(w, { unit: 'g', noKg: true })} ${from} ≈ ${weight(out, { unit: 'g', noKg: to === 'gold' })} ${to}`;
      $('#swapHint', el).textContent = `${(out / TOLA).toFixed(2)} tola ${to} · worth ${money(w * perGram(from), { raw: true })} at today's rates, before charges.`;
    };
    $$('#swapDir button', el).forEach(b => b.onclick = () => {
      dir = b.dataset.v; $$('#swapDir button', el).forEach(x => x.classList.toggle('on', x === b)); calc();
    });
    $('#swapAmt', el).oninput = calc;
    calc();
  }

  // ------------------------------------------------------------------ INSIGHTS
  function valueHistory() {
    // Daily stack value vs. cost basis since the first purchase, forward-filling missing rates.
    const P = portfolio();
    if (!P.first) return { value: [], cost: [] };
    const maps = { silver: new Map(hist('silver')), gold: new Map(hist('gold')) };
    const dates = new Set();
    for (const m of METALS) for (const [d] of hist(m)) if (d >= P.first) dates.add(d);
    const today = market.prices?.date;
    if (today) dates.add(today);
    const sorted = [...dates].sort();
    const last = { silver: null, gold: null };
    for (const m of METALS) { const h = hist(m).filter(([d]) => d < P.first); if (h.length) last[m] = h[h.length - 1][1]; }
    const txns = sortedTxns();
    const value = [], cost = [];
    let ti = 0;
    const pos = { silver: position('silver', '0000'), gold: position('gold', '0000') };
    for (const d of sorted) {
      let moved = false;
      while (ti < txns.length && txns[ti].date <= d) { ti++; moved = true; }
      if (moved) for (const m of METALS) pos[m] = position(m, d);
      for (const m of METALS) if (maps[m].has(d)) last[m] = maps[m].get(d);
      const fallback = m => last[m] || (pos[m].grams ? pos[m].avgMetalTola : 0);
      const v = METALS.reduce((s, m) => s + pos[m].grams / TOLA * fallback(m), 0);
      const c = pos.silver.cost + pos.gold.cost;
      value.push([parseDate(d), v]); cost.push([parseDate(d), c]);
    }
    return { value, cost };
  }

  function renderInsights() {
    const el = $('#view-insights');
    const P = portfolio();
    let html = head('Insights', 'Your stacking journey');
    if (!P.any) {
      el.innerHTML = html + '<div class="card empty"><h2>Nothing to analyse yet</h2><p>Insights appear after your first purchase.</p><button class="btn" id="btnFirstI">Add a purchase</button></div>';
      $('#btnFirstI', el).onclick = () => openTxnSheet();
      return;
    }
    const totalReturn = P.value + P.received - P.invested;
    const days = P.first ? daysBetween(P.first, todayNPT()) : 0;
    const premiums = P.making + P.sdf;

    html += `<div class="stat-grid four fade-in top-row">
      <div class="stat"><div class="label">Total invested</div><div class="v num">${money(P.invested)}</div><div class="s muted">${state.txns.filter(t => t.type === 'buy').length} purchases</div></div>
      <div class="stat"><div class="label">Total return</div><div class="v num ${cls(totalReturn)}">${money(totalReturn, { sign: true })}</div><div class="s ${cls(totalReturn)}">${pct(P.invested ? totalReturn / P.invested : null)}</div></div>
      <div class="stat"><div class="label">Annualised (XIRR)</div><div class="v num ${cls(P.xirr)}">${P.xirr != null ? pct(P.xirr, 1) : '—'}</div><div class="s muted">${P.xirr != null ? 'money-weighted' : 'needs 30+ days'}</div></div>
      <div class="stat"><div class="label">Stacking for</div><div class="v num">${days >= 365 ? (days / 365).toFixed(1) + ' yrs' : days + ' days'}</div><div class="s muted">since ${fmtDate(P.first)}</div></div>
    </div>`;

    const valueB = `<div class="section-title"><span>Stack value vs. invested</span></div>
      <div class="card"><div class="chart-readout" id="readout-ins"></div><div class="chart" id="chart-ins"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Value</span><span><i style="background:var(--text-3)"></i>Invested</span></div></div>`;

    // Allocation + premiums
    const sv = P.silver.value || 0, gv = P.gold.value || 0;
    const allocB = `<div class="grid two">
      <div class="card">
        <h3>Allocation</h3>
        <div class="row mt">
          ${Charts.ring([{ value: sv, color: color('silver') }, { value: gv, color: color('gold') }], { size: 116, stroke: 14, label: P.value ? Math.round(sv / P.value * 100) + '%' : '—', sub: 'silver' })}
          <div class="stack-v" style="flex:1">
            <div class="kv"><span class="k"><span class="metal-dot silver"></span> Silver</span><span class="v num">${money(sv)}</span></div>
            <div class="kv"><span class="k"><span class="metal-dot gold"></span> Gold</span><span class="v num">${money(gv)}</span></div>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>Making charge &amp; SDF</h3>
        <div class="mid num mt-s">${money(premiums)}</div>
        <div class="small muted">${pct(P.invested ? premiums / P.invested : 0)} of everything you've invested</div>
        <div class="bar-track mt"><i style="width:${premiums ? P.making / premiums * 100 : 0}%;background:var(--accent)"></i><i style="width:${premiums ? P.sdf / premiums * 100 : 0}%;background:var(--text)"></i></div>
        <div class="kv mt-s"><span class="k">Making charge</span><span class="v num">${money(P.making)}</span></div>
        <div class="kv"><span class="k">SDF</span><span class="v num">${money(P.sdf)}</span></div>
        ${P.making > 0 ? `<div class="hint mt-s">Buying silver in lots of ${state.settings.silver.makingThreshold} g or more skips the making charge.</div>` : ''}
      </div>
    </div>`;

    // Monthly investing
    const monthlyB = `<div class="section-title"><span>Monthly buying</span></div>
      <div class="card"><div class="chart short" id="chart-monthly"></div><div class="hint mt-s" id="monthlyHint"></div></div>`;

    // Lots
    const lots = state.txns.filter(t => t.type === 'buy' && perGram(t.metal)).map(t => ({ t, ret: (t.grams * perGram(t.metal)) / t.amount - 1 }));
    let lotsB = '';
    if (lots.length) {
      lots.sort((a, b) => b.ret - a.ret);
      const best = lots[0], worst = lots[lots.length - 1];
      const cheapest = lots.slice().sort((a, b) => a.t.amount / a.t.grams - b.t.amount / b.t.grams)[0];
      lotsB = `<div class="section-title"><span>Your purchases</span></div>
      <div class="list plain">
        <div class="list-item"><div class="li-main"><div class="li-sub">Best purchase</div><div class="li-title">${weight(best.t.grams)} ${best.t.metal} · ${fmtDate(best.t.date)}</div></div><div class="li-right"><div class="t ${cls(best.ret)}">${pct(best.ret)}</div></div></div>
        ${lots.length > 1 ? `<div class="list-item"><div class="li-main"><div class="li-sub">Weakest purchase</div><div class="li-title">${weight(worst.t.grams)} ${worst.t.metal} · ${fmtDate(worst.t.date)}</div></div><div class="li-right"><div class="t ${cls(worst.ret)}">${pct(worst.ret)}</div></div></div>` : ''}
        <div class="list-item"><div class="li-main"><div class="li-sub">Cheapest price paid</div><div class="li-title">${money(cheapest.t.amount / cheapest.t.grams * TOLA, { raw: true })}/tola ${cheapest.t.metal}</div></div><div class="li-right"><div class="t muted">${fmtDate(cheapest.t.date, { noYear: true })}</div></div></div>
        <div class="list-item"><div class="li-main"><div class="li-sub">Lots in profit</div><div class="li-title">${lots.filter(l => l.ret > 0).length} of ${lots.length}</div></div></div>
      </div>`;
    }

    // What-if
    const whatifB = `<div class="section-title"><span>What if…</span></div>
      <div class="card">
        <div class="seg full" id="wiMetal"><button class="on" data-v="silver">Silver</button><button data-v="gold">Gold</button></div>
        <div class="form-group mt"><div class="field"><label for="wiPrice">Rate per tola</label><input id="wiPrice" inputmode="numeric"><span class="unit">Rs</span></div></div>
        <input type="range" id="wiSlider" min="-50" max="200" value="25" style="width:100%" aria-label="Price change percent">
        <div class="row small muted"><span>−50%</span><span id="wiPct">+25%</span><span>+200%</span></div>
        <div class="mt" id="wiOut"></div>
      </div>`;

    // Goals & badges
    let goalsB = `<div class="section-title"><span>Goals</span><button class="link" id="editGoals">Edit</button></div><div class="grid two">`;
    for (const m of METALS) {
      const goal = state.settings[m].goal, g = P[m].grams;
      const prog = goal ? Math.min(1, g / goal) : 0;
      goalsB += `<div class="card"><div class="row">
        <div class="stack-v"><h3>${NAME[m]} goal</h3><div class="mid num">${weight(goal || 0)}</div><div class="small muted">${goal && g < goal ? weight(goal - g) + ' to go' + (rate(m) ? ' · ≈ ' + money((goal - g) / TOLA * rate(m), { raw: true }) : '') : goal ? 'Reached 🎉' : 'No goal set'}</div></div>
        ${Charts.ring([{ value: prog, color: color(m) }, { value: 1 - prog, color: 'transparent' }], { size: 92, stroke: 9, label: Math.round(prog * 100) + '%', labelSize: 17 })}
      </div></div>`;
    }
    goalsB += `</div>`;

    html += layout([[2, valueB], [4, monthlyB], [6, whatifB]], [[3, allocB], [5, lotsB], [7, goalsB]]);

    html += `<div class="section-title"><span>Milestones</span></div><div class="badges">${badges(P).map(b => `
      <div class="badge ${b.got ? '' : 'locked'}"><div class="medal" style="background:${b.bg}">${b.icon}</div><div class="t">${b.t}</div><div class="s">${b.s}</div></div>`).join('')}</div>`;

    el.innerHTML = html;

    // value chart
    const vh = valueHistory();
    const ro = $('#readout-ins', el);
    const def = () => { ro.innerHTML = `<div class="v num">${money(P.value)}</div><div class="d"><span class="${cls(P.unrealized)}">${money(P.unrealized, { sign: true })}</span> unrealised on ${money(P.cost)} cost</div>`; };
    def();
    Charts.line($('#chart-ins', el), {
      series: [{ data: vh.value, color: color('accent'), fill: true }, { data: vh.cost, color: color('text-3'), width: 1.6, dash: '4 3' }],
      empty: 'Your value history appears as daily rates come in',
      onScrub: pts => {
        if (!pts) return def();
        const [t, v] = pts[0], c = pts[1] ? pts[1][1] : 0;
        ro.innerHTML = `<div class="v num">${money(v)}</div><div class="d">${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · <span class="${cls(v - c)}">${money(v - c, { sign: true })}</span> vs ${money(c)} invested</div>`;
      },
    });

    // monthly bars (last 12 months with activity window)
    const months = [];
    const now = new Date();
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-GB', { month: 'narrow' }), value: 0 });
    }
    for (const t of state.txns) if (t.type === 'buy') { const mo = months.find(x => x.key === t.date.slice(0, 7)); if (mo) mo.value += t.amount; }
    Charts.bars($('#chart-monthly', el), months.map(x => ({ ...x, color: x.value ? color('accent') : color('sep') })), { fmt: v => v ? Charts.compact(v) : '' });
    const active = months.filter(x => x.value);
    $('#monthlyHint', el).innerHTML = active.length
      ? `Bought in ${active.length} of the last 12 months · average ${money(active.reduce((a, b) => a + b.value, 0) / active.length, { raw: true })} per active month. Regular buying (rupee-cost averaging) smooths out price swings.`
      : 'No purchases in the last 12 months.';

    // what-if
    let wm = P.silver.grams ? 'silver' : (P.gold.grams ? 'gold' : 'silver');
    $$('#wiMetal button', el).forEach(b => b.classList.toggle('on', b.dataset.v === wm));
    const slider = $('#wiSlider', el), input = $('#wiPrice', el);
    const wiCalc = (fromInput) => {
      const base = rate(wm) || 0;
      let price;
      if (fromInput) { price = num(input.value); slider.value = base ? Math.round((price / base - 1) * 100) : 0; }
      else { price = base * (1 + slider.value / 100); input.value = Math.round(price); }
      $('#wiPct', el).textContent = pct(base ? price / base - 1 : 0, 0);
      const p = P[wm];
      const v = p.grams / TOLA * price;
      const otherV = wm === 'silver' ? (P.gold.value || 0) : (P.silver.value || 0);
      $('#wiOut', el).innerHTML = p.grams
        ? `<div class="kv"><span class="k">Your ${wm} would be worth</span><span class="v num">${money(v)}</span></div>
           <div class="kv"><span class="k">Profit on ${wm}</span><span class="v num ${cls(v - p.cost)}">${money(v - p.cost, { sign: true })} · ${pct(p.cost ? v / p.cost - 1 : 0)}</span></div>
           <div class="kv"><span class="k">Whole stack</span><span class="v num">${money(v + otherV)}</span></div>`
        : `<div class="hint">You don't hold any ${wm} yet.</div>`;
    };
    slider.oninput = () => wiCalc(false);
    input.oninput = () => wiCalc(true);
    $$('#wiMetal button', el).forEach(b => b.onclick = () => { wm = b.dataset.v; $$('#wiMetal button', el).forEach(x => x.classList.toggle('on', x === b)); wiCalc(false); });
    wiCalc(false);
    $('#editGoals', el).onclick = () => openSettings('goals');
  }

  function badges(P) {
    const s = P.silver.grams, g = P.gold.grams, buys = state.txns.filter(t => t.type === 'buy').length;
    const days = P.first ? daysBetween(P.first, todayNPT()) : 0;
    const months = new Set(state.txns.filter(t => t.type === 'buy').map(t => t.date.slice(0, 7))).size;
    const AG = 'var(--bg)', AU = 'var(--accent)', BL = 'var(--bg)', GR = 'var(--accent-soft)';
    return [
      { t: 'First stack', s: 'Log a purchase', got: buys >= 1, icon: '1', bg: BL },
      { t: '1 tola silver', s: '11.66 g', got: s >= TOLA, icon: 'Ag', bg: AG },
      { t: '100 g silver', s: 'Getting started', got: s >= 100, icon: '100', bg: AG },
      { t: 'Half kilo', s: '500 g silver', got: s >= 500, icon: '½', bg: AG },
      { t: 'Kilo club', s: '1 kg silver', got: s >= 1000, icon: '1kg', bg: AG },
      { t: '5 kg vault', s: '5 kg silver', got: s >= 5000, icon: '5kg', bg: AG },
      { t: '10 kg legend', s: '10 kg silver', got: s >= 10000, icon: '10', bg: AG },
      { t: 'First gold', s: 'Any gold', got: g > 0, icon: 'Au', bg: AU },
      { t: '1 tola gold', s: '11.66 g', got: g >= TOLA, icon: '1T', bg: AU },
      { t: '10 tola gold', s: 'Serious gold', got: g >= TOLA * 10, icon: '10T', bg: AU },
      { t: 'Habit', s: '5 purchases', got: buys >= 5, icon: '5×', bg: BL },
      { t: 'Consistent', s: 'Bought in 6 months', got: months >= 6, icon: '6M', bg: BL },
      { t: 'One year in', s: '365 days stacking', got: days >= 365, icon: '1Y', bg: BL },
      { t: 'In the green', s: 'Stack in profit', got: P.unrealized > 0 && P.has, icon: '↑', bg: GR },
      { t: 'Up 25%', s: 'Unrealised gain', got: (P.unrealizedPct || 0) >= 0.25, icon: '25', bg: GR },
      { t: 'Doubled', s: 'Up 100%', got: (P.unrealizedPct || 0) >= 1, icon: '2×', bg: GR },
    ];
  }

  // ------------------------------------------------------------------ SHEET
  let sheetOnClose = null;
  function openSheet(html, mount) {
    const sheet = $('#sheet'), bd = $('#backdrop');
    $('#sheetBody').innerHTML = html;
    sheet.hidden = false; bd.hidden = false;
    $('#sheetBody').scrollTop = 0;
    requestAnimationFrame(() => { sheet.classList.add('open'); bd.classList.add('open'); });
    document.body.style.overflow = 'hidden';
    mount && mount($('#sheetBody'));
  }
  function closeSheet() {
    const sheet = $('#sheet'), bd = $('#backdrop');
    sheet.classList.remove('open'); bd.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { sheet.hidden = true; bd.hidden = true; $('#sheetBody').innerHTML = ''; }, 320);
    if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
  }

  // swipe-down to dismiss (from the grabber / header area)
  (function () {
    const sheet = $('#sheet');
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', e => {
      const body = $('#sheetBody');
      if (body.scrollTop > 0 && !e.target.closest('.sheet-grabber,.sheet-head')) return;
      if (e.target.closest('input,textarea,select,.seg')) return;
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      sheet.style.transition = ''; sheet.style.transform = '';
      if (dy > 110) closeSheet();
      y0 = null;
    });
  })();

  // ------------------------------------------------------------------ ADD / EDIT TRANSACTION
  function openTxnSheet(txn, preset = {}) {
    const editing = !!txn;
    const S = state.settings;
    const t = txn ? { ...txn } : {
      id: uid(), type: preset.type || 'buy', metal: preset.metal || (currentView === 'gold' ? 'gold' : 'silver'),
      date: todayNPT(), grams: '', amount: '', form: 'bar', dealer: '', note: '',
    };
    let unit = 'g';
    let makingOn = t.makingPct == null ? null : t.makingPct > 0;   // null = automatic by weight
    let makingPct = t.makingPct > 0 ? t.makingPct : S[t.metal].makingPct;
    let sdfPct = t.sdfPct != null ? t.sdfPct : S[t.metal].sdfPct;
    let basis = t.basis || S.chargeBasis;

    const html = `
      <div class="sheet-head"><button class="text-btn l" id="tCancel">Cancel</button><h2>${editing ? 'Edit' : 'New'} ${t.type === 'sell' ? 'sale' : 'purchase'}</h2><button class="text-btn r" id="tSave">Save</button></div>
      <div class="seg full" id="tType"><button data-v="buy">Buy</button><button data-v="sell">Sell</button></div>
      <div class="seg full mt-s" id="tMetal"><button data-v="silver">Silver</button><button data-v="gold">Gold</button></div>

      <div class="form-label">Details</div>
      <div class="form-group">
        <div class="field"><label for="tDate">Date</label><input type="date" id="tDate" value="${t.date}" max="${todayNPT()}"></div>
        <div class="field"><label for="tWeight">Weight</label><input id="tWeight" inputmode="decimal" placeholder="0" value="${t.grams ? +(+t.grams).toFixed(3) : ''}">
          <div class="seg" id="tUnit" style="flex:none"><button data-v="g" class="on">g</button><button data-v="tola">tola</button></div></div>
        <div class="field"><label for="tAmount" id="tAmountLabel">Total paid</label><input id="tAmount" inputmode="decimal" placeholder="0" value="${t.amount || ''}"><span class="unit">Rs</span></div>
      </div>
      <div class="form-caption" id="tAmountCap"></div>

      <div id="buyOnly">
        <div class="form-label">Charges</div>
        <div class="form-group">
          <div class="field"><label>Making charge</label><span class="small muted" id="tMakingAuto"></span>
            <label class="switch" style="min-width:0"><input type="checkbox" id="tMakingOn"><span></span></label></div>
          <div class="field" id="tMakingRow"><label for="tMakingPct">Making %</label><input id="tMakingPct" inputmode="decimal" value="${makingPct}"><span class="unit">%</span></div>
          <div class="field"><label for="tSdfPct">SDF %</label><input id="tSdfPct" inputmode="decimal" value="${sdfPct}"><span class="unit">%</span></div>
        </div>
        <div class="form-caption">Charges are worked out as a percentage ${basis === 'ontop' ? 'added on top of the metal value' : 'of the total price paid'}. You can change this in Settings.</div>
        <div class="breakdown" id="tBreak"></div>

        <div class="form-label">More</div>
        <div class="form-group">
          <div class="field"><label for="tForm">Form</label><select id="tForm">${Object.entries(FORMS).map(([k, v]) => `<option value="${k}" ${t.form === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label for="tDealer">Dealer</label><input id="tDealer" placeholder="Optional" value="${esc(t.dealer)}"></div>
        </div>
      </div>
      <div class="form-group mt-s"><div class="field col"><label for="tNote" class="small muted">Note</label><textarea id="tNote" placeholder="Optional">${esc(t.note)}</textarea></div></div>
      ${editing ? '<button class="btn danger block mt" id="tDelete">Delete</button>' : ''}
      <div style="height:20px"></div>`;

    openSheet(html, root => {
      const set = (sel, v) => $$(sel + ' button', root).forEach(b => b.classList.toggle('on', b.dataset.v === v));
      set('#tType', t.type); set('#tMetal', t.metal);

      const grams = () => { const w = num($('#tWeight', root).value); return unit === 'tola' ? w * TOLA : w; };
      const autoMaking = () => grams() > 0 && grams() < S[t.metal].makingThreshold;
      const update = () => {
        const isBuy = t.type === 'buy';
        $('#buyOnly', root).hidden = !isBuy;
        $('h2', root).textContent = `${editing ? 'Edit' : 'New'} ${isBuy ? 'purchase' : 'sale'}`;
        $('#tAmountLabel', root).textContent = isBuy ? 'Total paid' : 'Received';
        const g = grams(), amt = num($('#tAmount', root).value);
        const r = perGram(t.metal);
        const on = makingOn == null ? autoMaking() : makingOn;
        $('#tMakingOn', root).checked = on;
        $('#tMakingRow', root).hidden = !on;
        $('#tMakingAuto', root).textContent = makingOn == null ? (g ? (on ? `auto · under ${S[t.metal].makingThreshold} g` : `auto · ${S[t.metal].makingThreshold} g or more`) : 'auto') : 'manual';
        const cap = $('#tAmountCap', root);
        if (isBuy) {
          cap.innerHTML = g && r ? `Today's market value of ${weight(g, { unit: 'g', noKg: true })} is ${money(g * r, { raw: true })}. Enter the full bill, including making charge and SDF.` : 'Enter the full bill, including making charge and SDF.';
          const b = breakdown(amt, on ? num($('#tMakingPct', root).value) : 0, num($('#tSdfPct', root).value), basis);
          const perTola = g ? amt / g * TOLA : 0;
          const metalTola = g ? b.metal / g * TOLA : 0;
          $('#tBreak', root).innerHTML = `
            <div class="kv"><span class="k">Metal value</span><span class="v num">${money(b.metal, { raw: true, dec: true })}</span></div>
            <div class="kv"><span class="k">Making charge${on ? ` (${num($('#tMakingPct', root).value)}%)` : ''}</span><span class="v num">${money(b.making, { raw: true, dec: true })}</span></div>
            <div class="kv"><span class="k">SDF (${num($('#tSdfPct', root).value)}%)</span><span class="v num">${money(b.sdf, { raw: true, dec: true })}</span></div>
            <div class="kv total"><span class="k">Total paid</span><span class="v num">${money(amt, { raw: true, dec: true })}</span></div>
            ${g ? `<div class="kv"><span class="k">Effective rate</span><span class="v num">${money(perTola, { raw: true })}/tola</span></div>
            <div class="kv"><span class="k">Metal-only rate</span><span class="v num">${money(metalTola, { raw: true })}/tola${rate(t.metal) ? ` <span class="small muted">vs ${money(rate(t.metal), { raw: true })} today</span>` : ''}</span></div>` : ''}`;
        } else {
          const p = position(t.metal);
          cap.innerHTML = p.grams ? `You hold ${weight(p.grams)} of ${t.metal}. ${g && amt && p.avgTola ? `Estimated realised P&L: <b class="${cls(amt - g / TOLA * p.avgTola)}">${money(amt - g / TOLA * p.avgTola, { sign: true, raw: true })}</b>.` : ''}` : `You don't hold any ${t.metal} to sell.`;
        }
      };

      $$('#tType button', root).forEach(b => b.onclick = () => { t.type = b.dataset.v; set('#tType', t.type); update(); });
      $$('#tMetal button', root).forEach(b => b.onclick = () => {
        t.metal = b.dataset.v; set('#tMetal', t.metal);
        if (!editing) { $('#tMakingPct', root).value = S[t.metal].makingPct; $('#tSdfPct', root).value = S[t.metal].sdfPct; }
        update();
      });
      $$('#tUnit button', root).forEach(b => b.onclick = () => {
        const g = grams(); unit = b.dataset.v; set('#tUnit', unit);
        if (g) $('#tWeight', root).value = +(unit === 'tola' ? g / TOLA : g).toFixed(unit === 'tola' ? 4 : 3);
        update();
      });
      $('#tMakingOn', root).onchange = e => { makingOn = e.target.checked; update(); };
      ['#tWeight', '#tAmount', '#tMakingPct', '#tSdfPct'].forEach(s => $(s, root).addEventListener('input', update));
      $('#tCancel', root).onclick = closeSheet;
      $('#tSave', root).onclick = () => {
        const g = grams(), amt = num($('#tAmount', root).value), date = $('#tDate', root).value;
        if (!g || g <= 0) return toast('Enter the weight');
        if (!amt || amt <= 0) return toast(t.type === 'buy' ? 'Enter the total paid' : 'Enter the amount received');
        if (!date) return toast('Pick a date');
        const on = makingOn == null ? autoMaking() : makingOn;
        const rec = {
          id: t.id, type: t.type, metal: t.metal, date, grams: g, amount: amt,
          note: $('#tNote', root).value.trim(), created: txn?.created || Date.now(),
        };
        if (t.type === 'buy') Object.assign(rec, {
          makingPct: on ? num($('#tMakingPct', root).value) : 0,
          sdfPct: num($('#tSdfPct', root).value), basis,
          form: $('#tForm', root).value, dealer: $('#tDealer', root).value.trim(),
        });
        if (t.type === 'sell') {
          const p = position(t.metal);
          const already = editing && txn.type === 'sell' ? txn.grams : 0;
          if (g > p.grams + already + 1e-6) return toast(`You only hold ${weight(p.grams + already)}`);
        }
        const i = state.txns.findIndex(x => x.id === rec.id);
        if (i >= 0) state.txns[i] = rec; else state.txns.push(rec);
        save(); haptic(); closeSheet(); render();
        toast(editing ? 'Saved' : (rec.type === 'buy' ? `Added ${weight(g)} ${rec.metal}` : 'Sale recorded'));
      };
      const del = $('#tDelete', root);
      if (del) del.onclick = () => {
        if (!confirm('Delete this transaction?')) return;
        state.txns = state.txns.filter(x => x.id !== t.id);
        save(); closeSheet(); render(); toast('Deleted');
      };
      update();
      if (!editing) setTimeout(() => $('#tWeight', root).focus({ preventScroll: true }), 380);
    });
  }

  // ------------------------------------------------------------------ SETTINGS
  function openSettings(focus) {
    const S = state.settings;
    const metalBlock = m => `
      <div class="form-label">${NAME[m]}</div>
      <div class="form-group">
        <div class="field"><label>Making charge</label><input data-k="${m}.makingPct" inputmode="decimal" value="${S[m].makingPct}"><span class="unit">%</span></div>
        <div class="field"><label>Applies under</label><input data-k="${m}.makingThreshold" inputmode="decimal" value="${S[m].makingThreshold}"><span class="unit">g</span></div>
        <div class="field"><label>SDF</label><input data-k="${m}.sdfPct" inputmode="decimal" value="${S[m].sdfPct}"><span class="unit">%</span></div>
        <div class="field"><label>Dealer buyback cut</label><input data-k="${m}.buybackPct" inputmode="decimal" value="${S[m].buybackPct}"><span class="unit">%</span></div>
      </div>`;
    const gs = S.gist;
    const html = `
      <div class="sheet-head"><span></span><h2>Settings</h2><button class="text-btn r" id="sDone">Done</button></div>

      <div class="form-label">Account</div>
      <div id="sAccount">${accountHtml()}</div>

      <div class="form-label">Display</div>
      <div class="form-group">
        <div class="field"><label>Weight unit</label><div class="seg" id="sUnit" style="margin-left:auto"><button data-v="g">Grams</button><button data-v="tola">Tola</button></div></div>
      </div>

      <div class="form-label">How charges are counted</div>
      <div class="form-group"><div class="field col">
        <div class="seg full" id="sBasis"><button data-v="total">% of total paid</button><button data-v="ontop">Added on top</button></div>
      </div></div>
      <div class="form-caption">"% of total paid": 4% of the bill is making charge and 0.5% is SDF. "Added on top": making is 4% over the metal value, and SDF is 0.5% over that. Purchases you already logged keep the rules they were saved with.</div>
      ${metalBlock('silver')}
      ${metalBlock('gold')}
      <div class="form-caption">Buyback cut is the deduction a dealer takes when you sell back. It's used for the "If sold today" value.</div>

      <div class="form-label" id="goals">Goals</div>
      <div class="form-group">
        <div class="field"><label>Silver goal</label><input data-k="silver.goal" data-unit="g" inputmode="decimal" value="${+S.silver.goal.toFixed(2)}"><span class="unit">g</span></div>
        <div class="field"><label>Gold goal</label><input data-k="gold.goal" data-unit="tola" inputmode="decimal" value="${+(S.gold.goal / TOLA).toFixed(2)}"><span class="unit">tola</span></div>
      </div>

      <div class="form-label">Price alerts (per tola)</div>
      <div class="form-group">
        <div class="field"><label>Silver at or below</label><input data-k="silver.alertBelow" inputmode="numeric" placeholder="Off" value="${S.silver.alertBelow || ''}"><span class="unit">Rs</span></div>
        <div class="field"><label>Silver at or above</label><input data-k="silver.alertAbove" inputmode="numeric" placeholder="Off" value="${S.silver.alertAbove || ''}"><span class="unit">Rs</span></div>
        <div class="field"><label>Gold at or below</label><input data-k="gold.alertBelow" inputmode="numeric" placeholder="Off" value="${S.gold.alertBelow || ''}"><span class="unit">Rs</span></div>
        <div class="field"><label>Gold at or above</label><input data-k="gold.alertAbove" inputmode="numeric" placeholder="Off" value="${S.gold.alertAbove || ''}"><span class="unit">Rs</span></div>
      </div>
      <div class="form-caption">You'll see a banner on the Stack page when a rate crosses your target.</div>

      <div class="form-label">Cloud backup · GitHub Gist</div>
      <div class="form-group">
        <div class="field"><label>Token</label><input type="password" id="sToken" placeholder="ghp_… (gist scope)" value="${esc(gs.token)}" autocomplete="off"></div>
        <div class="field"><label>Status</label><span class="small muted" style="margin-left:auto;text-align:right" id="sGistStatus">${gs.token ? (gs.error ? '⚠️ ' + esc(gs.error) : gs.lastSync ? 'Synced ' + ago(gs.lastSync) : 'Not synced yet') : 'Off'}</span></div>
      </div>
      <div class="row mt-s" style="gap:8px"><button class="btn secondary small" id="sConnect" style="flex:1">${gs.token ? 'Sync now' : 'Connect'}</button>${gs.token ? '<button class="btn danger small" id="sDisconnect" style="flex:1">Disconnect</button>' : ''}</div>
      <div class="form-caption">Saves your stack to a private (secret) Gist on your GitHub account, and syncs it across your phone and laptop. Create a token at github.com → Settings → Developer settings → Personal access tokens with only the <b>gist</b> scope. The token stays on this device.</div>

      <div class="form-label">Backup file</div>
      <div class="form-group">
        <button class="field action" id="sExport">Export backup (.json)</button>
        <label class="field action" style="cursor:pointer">Import backup…<input type="file" id="sImport" accept="application/json,.json" hidden></label>
        <button class="field action" id="sExportCsv">Export transactions (.csv)</button>
      </div>
      <div class="form-caption" id="sStorage">${S.lastExport ? 'Last exported ' + ago(S.lastExport) + '. ' : ''}Tip: add this site to your Home Screen (Share → Add to Home Screen) so your device keeps its data safely.</div>

      <div class="form-group mt"><button class="field action danger" id="sErase">Erase all data on this device</button></div>
      <p class="footer-note">Stack · rates from FENEGOSIDA via a scheduled GitHub Action.<br>1 tola = 11.6638 g · 1 troy oz = 31.1035 g</p>`;

    openSheet(html, root => {
      const set = (sel, v) => $$(sel + ' button', root).forEach(b => b.classList.toggle('on', b.dataset.v === v));
      bindAccount(root);
      set('#sUnit', S.unit); set('#sBasis', S.chargeBasis);
      $$('#sUnit button', root).forEach(b => b.onclick = () => { S.unit = b.dataset.v; set('#sUnit', S.unit); save(); });
      $$('#sBasis button', root).forEach(b => b.onclick = () => { S.chargeBasis = b.dataset.v; set('#sBasis', S.chargeBasis); save(); });
      $$('[data-k]', root).forEach(inp => inp.addEventListener('change', () => {
        const [m, k] = inp.dataset.k.split('.');
        let v = inp.value.trim() === '' ? null : num(inp.value);
        if (inp.dataset.unit === 'tola' && v != null) v *= TOLA;
        if (k.startsWith('alert')) S[m][k] = v || null;
        else S[m][k] = v == null ? DEFAULT_SETTINGS[m][k] : v;
        save();
      }));
      $('#sDone', root).onclick = closeSheet;

      $('#sConnect', root).onclick = async () => {
        const tok = $('#sToken', root).value.trim();
        if (!tok) return toast('Paste a GitHub token first');
        S.gist.token = tok; save({ keepStamp: true, noSync: true });
        $('#sGistStatus', root).textContent = 'Syncing…';
        try {
          const r = await gistSync();
          $('#sGistStatus', root).textContent = 'Synced just now';
          toast(r === 'pulled' ? 'Restored your stack from GitHub' : 'Backed up to GitHub');
          render();
        } catch (e) { $('#sGistStatus', root).textContent = '⚠️ ' + e.message; toast(e.message); }
      };
      const dis = $('#sDisconnect', root);
      if (dis) dis.onclick = () => { S.gist = { token: '', id: '', lastSync: null }; save({ keepStamp: true, noSync: true }); closeSheet(); toast('Backup disconnected'); };

      $('#sExport', root).onclick = () => {
        download(`stack-backup-${todayNPT()}.json`, JSON.stringify(backupPayload(), null, 1), 'application/json');
        S.lastExport = new Date().toISOString(); save({ noSync: true });
      };
      $('#sExportCsv', root).onclick = () => {
        const rows = [['date', 'type', 'metal', 'grams', 'tola', 'amount', 'making_pct', 'making_rs', 'sdf_pct', 'sdf_rs', 'metal_value', 'form', 'dealer', 'note']];
        for (const t of sortedTxns()) {
          const b = txnBreakdown(t);
          rows.push([t.date, t.type, t.metal, t.grams.toFixed(3), (t.grams / TOLA).toFixed(4), t.amount, t.makingPct ?? '', b.making.toFixed(2), t.sdfPct ?? '', b.sdf.toFixed(2), b.metal.toFixed(2), t.form || '', t.dealer || '', t.note || '']);
        }
        download(`stack-transactions-${todayNPT()}.csv`, rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n'), 'text/csv');
      };
      $('#sImport', root).onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (!Array.isArray(data.txns)) throw new Error('Not a Stack backup');
          if (!confirm(`Replace this device's data with ${data.txns.length} transactions from the backup?`)) return;
          adopt(data); save(); closeSheet(); render(); toast('Backup restored');
        } catch (err) { toast('Import failed: ' + err.message); }
      };
      $('#sErase', root).onclick = () => {
        if (!confirm('Erase all transactions and settings on this device? Your GitHub backup, if any, is not touched.')) return;
        if (!confirm('Are you sure? This cannot be undone.')) return;
        state = { version: 1, txns: [], settings: deepMerge(DEFAULT_SETTINGS, {}), updatedAt: Date.now() };
        state.settings.gist = { token: '', id: '', lastSync: null };
        save({ noSync: true }); closeSheet(); render(); toast('Erased');
      };
      if (focus) { const t = $('#' + focus, root); if (t) setTimeout(() => t.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350); }
    });
    sheetOnClose = () => { applyPrefs(); render(); };
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ NAV & RENDER
  const RENDER = { home: renderHome, silver: () => renderMetal('silver'), gold: () => renderMetal('gold'), ratio: renderRatio, insights: renderInsights };

  function go(view, opts = {}) {
    if (!RENDER[view]) view = 'home';
    currentView = view;
    $$('.view').forEach(v => v.hidden = v.id !== 'view-' + view);
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    $('#topbarTitle').textContent = $('#view-' + view).dataset.title;
    RENDER[view]();
    renderNav();
    if (!opts.keepScroll) window.scrollTo(0, 0);
    if (!opts.noHash) history.replaceState(null, '', view === 'home' ? location.pathname : '#' + view);
    onScroll();
  }
  function render() { RENDER[currentView](); renderNav(); }

  function applyPrefs() {
    document.body.classList.toggle('blur-values', !!state.settings.hideValues);
  }

  function onScroll() { $('#topbar').classList.toggle('show', window.scrollY > 48); }

  // ------------------------------------------------------------------ boot
  $$('.tab').forEach(t => t.addEventListener('click', () => { haptic(); go(t.dataset.view); }));
  $('#fab').addEventListener('click', () => openTxnSheet(null, {}));
  $('#navAdd').addEventListener('click', () => openTxnSheet(null, {}));
  $('#backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const age = market.loadedAt ? Date.now() - new Date(market.loadedAt).getTime() : Infinity;
      if (age > 10 * 60 * 1000) refreshMarket();
      if (state.settings.gist.token) gistSync().then(r => r === 'pulled' && render()).catch(() => {});
    }
  });
  window.addEventListener('storage', e => { if (e.key === KEY) { state = load(); render(); } });

  applyPrefs();
  go((location.hash || '').slice(1) || 'home', { noHash: true });
  refreshMarket();
  if (state.settings.gist.token) gistSync().then(r => { if (r === 'pulled') { render(); toast('Synced from GitHub'); } }).catch(() => {});

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (window.StackCloud) initCloud();
  else window.addEventListener('stackcloud', initCloud, { once: true });

  // debug hook for tests
  window.__stack = { state: () => state, market: () => market, portfolio };
})();
