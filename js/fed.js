/* Fed tab — how US Federal Reserve decisions reach the Nepal silver price.
   Loaded on demand by app.js the first time the tab opens. Everything shown here is data-driven:
   data/macro.json (Fed range, FOMC calendar, bond-market pricing, CPI, dollar, quarterly history;
   refreshed by scripts/fetch_macro.py), data/prices.json + data/history.json (FENEGOSIDA, spot, FX),
   and the user's own silver purchases from the Stack log. */
(function () {
  'use strict';

  const TOLA = 11.6638038, OZT = 31.1034768, OZ_TO_TOLA = TOLA / OZT;
  const MKEY = 'stack.macro.v1', CKEY = 'stack.fedChecklist', UKEY = 'stack.fedUi';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const rs = v => (v < 0 ? '−' : '') + 'Rs ' + nf0.format(Math.abs(Math.round(v)));
  const rsS = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + 'Rs ' + nf0.format(Math.abs(Math.round(v)));
  const usd = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v * 100).toFixed(d) + '%';
  const mag = v => Math.abs(v * 100).toFixed(1) + '%';
  const cls = v => (v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : '');
  const range = (lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}%`;
  const fmtDay = (s, o = {}) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(o.noYear ? {} : { year: 'numeric' }) });
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };

  let macro = store.get(MKEY, null);
  let loadedAt = 0;
  let ctx = null, root = null, chart = null;
  const ui = Object.assign({ scenario: null, unit: 'usd', step: 0, intensity: 1, spot: null, fx: null, markup: null }, store.get(UKEY, {}));
  const saveUi = () => store.set(UKEY, { unit: ui.unit, step: ui.step });

  async function loadMacro() {
    if (Date.now() - loadedAt < 10 * 60 * 1000 && macro) return;
    const bust = '?t=' + Math.floor(Date.now() / 60000);
    try {
      const r = await fetch('data/macro.json' + bust, { cache: 'no-cache' });
      if (r.ok) { macro = await r.json(); store.set(MKEY, macro); loadedAt = Date.now(); }
    } catch (_) { /* offline: use the cached copy */ }
  }

  /* ------------------------------------------------------------------ derived numbers */
  function live() {
    const p = ctx.prices || {}, i = p.intl || {};
    return { spot: i.xag || null, fx: i.usdnpr || null, tola: p.silver?.tola || null, date: p.date };
  }
  const premium = L => (L.spot && L.fx && L.tola ? L.tola / (L.spot * L.fx * OZ_TO_TOLA) - 1 : 0.3);

  function intlAgo(days) {
    const rows = ctx.history?.intl;
    if (!rows || rows.length < 2) return null;
    const t = new Date(rows[rows.length - 1][0]); t.setDate(t.getDate() - days);
    const iso = t.toISOString().slice(0, 10);
    let pick = null;
    for (const r of rows) if (r[0] <= iso) pick = r;
    pick = pick || rows[0];   // history shorter than asked: use the oldest point and say how many days
    const span = Math.round((new Date(rows[rows.length - 1][0]) - new Date(pick[0])) / 864e5);
    return span >= 7 ? { date: pick[0], xag: pick[2], fx: pick[3], days: span } : null;
  }

  // FOMC statements come out at 2:00 PM Washington time on the last day of the meeting.
  function decisionNPT(endIso) {
    const [y, m, d] = endIso.split('-').map(Number);
    const nthSunday = (mon, n) => { const x = new Date(Date.UTC(y, mon, 1)); const first = (7 - x.getUTCDay()) % 7 + 1; return first + 7 * (n - 1); };
    const t = Date.UTC(y, m - 1, d);
    const dst = t >= Date.UTC(y, 2, nthSunday(2, 2)) && t < Date.UTC(y, 10, nthSunday(10, 1));
    const utc = new Date(Date.UTC(y, m - 1, d, dst ? 18 : 19, 0));
    return utc.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  }
  const daysTo = iso => Math.ceil((new Date(iso + 'T23:59:59') - new Date()) / 864e5);
  const meetingName = m => new Date(m.end + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' FOMC';

  function fedOn(day) {
    const ch = macro?.fed?.changes || [];
    let cur = null, prev = null;
    for (const c of ch) { if (c[0] > day) break; prev = cur; cur = c; }
    if (!cur) return null;
    return { lo: cur[1], hi: cur[2], dir: prev ? Math.sign(cur[2] - prev[2]) : 0, since: cur[0] };
  }

  /* ------------------------------------------------------------------ scenarios
     Educational rules of thumb. What moves markets is the surprise versus what bonds already price,
     so each scenario is scored against macro.market.expectedBps. Per 25 bp of surprise:
     silver about −3%, USD/NPR about +0.35%. */
  const SCEN = {
    hold: { name: 'Hold', long: 'Fed holds steady', bps: 0, guide: 0 },
    hike25: { name: '+25 bp', long: 'Hike +25 bps', bps: 25, guide: 0 },
    hike50: { name: '+50 bp', long: 'Hike +50 bps', bps: 50, guide: 0 },
    dovish: { name: 'Dovish', long: 'Signals future cuts', bps: 0, guide: -1.5 },
  };
  const expected = () => macro?.market?.expectedBps ?? 0;
  const baseKey = () => ({ 25: 'hike25', 50: 'hike50', '-25': 'dovish' }[expected()] || 'hold');
  function effect(key) {
    const s = SCEN[key], e = expected();
    const units = (s.bps - e) / 25 + 0.15 * s.bps / 25 + s.guide;
    return { xag: -0.03 * units * ui.intensity, fx: 0.0035 * units * ui.intensity, units };
  }
  function scenarioWhy(key) {
    const e = expected();
    const priced = e > 0 ? 'a hike' : e < 0 ? 'a cut' : 'no change';
    const u = effect(key).units;
    if (key === 'dovish') return `Signalling cuts ahead pulls real yields and the dollar down. Silver tends to rally hard, but a firmer rupee trims part of the gain in Nepal.`;
    if (Math.abs(u) < 0.4) return `Bonds already price ${priced}, so this is mostly priced in. Expect small moves; the press-conference tone decides the rest.`;
    if (u < 0) return `Softer than bonds expect (they price ${priced}). The dollar eases and silver usually gets a relief bid.`;
    return `More hawkish than bonds expect (they price ${priced}). Real yields and the dollar jump; silver, with its high beta, usually falls harder than gold.`;
  }

  /* ------------------------------------------------------------------ render */
  function render(el, c) {
    root = el; ctx = c;
    if (!macro) {
      el.innerHTML = ctx.head('Fed &amp; Silver', 'US rates → Nepal price') + '<div class="card chart-empty" style="height:200px">Loading Fed data…</div>';
      loadMacro().then(() => { if (macro) render(root, ctx); else el.innerHTML = ctx.head('Fed &amp; Silver', 'US rates → Nepal price') + '<div class="card empty"><h2>Fed data unavailable</h2><p>Connect to the internet and refresh.</p></div>'; });
      return;
    }
    loadMacro().then(() => { if (root === el && ctx === c && document.body.contains(el) && !el.hidden) paintHeader(); });
    const L = live();
    if (ui.spot == null && L.spot) { ui.spot = +L.spot.toFixed(2); ui.fx = +L.fx.toFixed(2); ui.markup = +(premium(L) * 100).toFixed(1); }
    if (!ui.scenario) ui.scenario = baseKey();

    el.innerHTML = ctx.head('Fed &amp; Silver', 'US rates → Nepal price', `<button class="icon-btn" id="fedRefresh" aria-label="Refresh">${ctx.icon.refresh}</button>`) +
      `<div id="fedHeader"></div>
      <div class="section-title"><span>How a Fed decision reaches your tola</span></div>
      <div class="fed-chain"><div class="list" id="fedChain"></div><div class="card" id="fedExplain"></div></div>
      <div class="section-title"><span id="simTitle">What to expect</span></div>
      <div id="fedSim"></div>
      <div class="section-title"><span>Fed funds vs. silver since 2018</span>
        <div class="seg" id="fedUnit"><button data-u="usd">USD / oz</button><button data-u="npr">NPR / tola</button></div></div>
      <div class="card"><div class="fed-chart"><canvas id="fedChart" role="img" aria-label="Fed funds rate and silver price, quarterly"></canvas></div>
        <div class="legend" id="fedLegend"></div><div class="hint mt-s" id="fedChartNote"></div></div>
      <div class="grid three mt" id="fedLessons"></div>
      <div class="section-title"><span>Your silver buys vs. the Fed</span></div>
      <div id="fedBuys"></div>
      <div class="section-title"><span id="checkTitle">Before you buy this FOMC week</span></div>
      <div id="fedChecklist"></div>
      <p class="footer-note fed-foot" id="fedFoot"></p>`;

    $('#fedRefresh', el).onclick = async () => { loadedAt = 0; await loadMacro(); ctx.refresh && ctx.refresh(); render(root, ctx); ctx.toast && ctx.toast('Fed data refreshed'); };
    paintHeader(); paintChain(); paintSim(); paintChart(); paintBuys(); paintChecklist(); paintFoot();
  }

  function paintHeader() {
    const box = $('#fedHeader', root); if (!box) return;
    const f = macro.fed, mk = macro.market, inf = macro.inflation, ry = macro.realYield, dx = macro.dollar;
    const next = macro.meetings?.next;
    const L = live();
    const ago = intlAgo(30);
    const d = next ? daysTo(next.end) : null;
    const lc = f.lastChange;
    const lastTxt = lc.bps ? `${lc.bps > 0 ? 'raised' : 'cut'} rates by ${Math.abs(lc.bps)} bp on ${fmtDay(lc.date)}` : `last moved on ${fmtDay(lc.date)}`;
    const infTxt = inf ? `Inflation is <b>${inf.label}</b> at ${inf.cpi.toFixed(1)}% (core ${inf.core.toFixed(1)}%, ${new Date(inf.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} data)` : '';
    const mkTxt = mk ? `3-month bills yield ${mk.t3m.toFixed(2)}%, ${Math.abs(mk.spread).toFixed(2)} pts ${mk.spread >= 0 ? 'above' : 'below'} fed funds: <b>${mk.label.toLowerCase()}</b>${next ? ` at the ${meetingName(next)}` : ''}` : '';
    const nepal = mk?.bias === 'hike'
      ? 'Higher-for-longer rates raise the cost of holding silver, which pays no interest, and tend to firm the dollar: usually a headwind for spot. For you in Nepal the dollar side partly cushions it, because a stronger USD also lifts USD/NPR, so local prices tend to fall <b>less than spot</b>.'
      : mk?.bias === 'cut'
        ? 'Expected cuts lower the cost of holding silver and tend to soften the dollar: usually a tailwind for spot. In Nepal a firmer rupee trims part of that rise, so local prices tend to rise <b>less than spot</b>.'
        : 'With no move expected, guidance about future meetings matters most. A hawkish tone pressures silver; a dovish one supports it, and USD/NPR moves the other way, partly offsetting either.';
    const move = ago && L.spot ? ` Spot silver is ${pct(L.spot / ago.xag - 1)} over ${ago.days} days (${usd(ago.xag)} → ${usd(L.spot)}).` : '';
    const tone = mk?.bias === 'hike' ? 'down' : mk?.bias === 'cut' ? 'up' : '';

    box.innerHTML = `<div class="card fed-hero">
      <div class="row" style="align-items:flex-start">
        <div><div class="label">Fed funds target</div><div class="big num">${range(f.lo, f.hi)}</div></div>
        ${next ? `<div class="fed-next"><div class="label">Next decision</div><div class="mid num">${d <= 0 ? 'Today' : d === 1 ? 'Tomorrow' : d + ' days'}</div><div class="small muted">${decisionNPT(next.end)} NPT</div></div>` : ''}
      </div>
      <div class="hero-meta mt-s">
        ${mk ? `<span class="pill ${tone}">${esc(mk.label)}</span>` : ''}
        ${inf ? `<span class="pill">CPI ${inf.cpi.toFixed(1)}% · ${inf.label}</span>` : ''}
        <span class="pill">Last move: ${lc.bps > 0 ? '+' : ''}${lc.bps} bp · ${fmtDay(lc.date, { noYear: false })}</span>
      </div>
      <p class="fed-summary">The Fed ${lastTxt}, to ${range(f.lo, f.hi)}. ${infTxt}. ${mkTxt}. ${nepal}${move}</p>
      <div class="fed-minis">
        ${mini('Silver spot', L.spot ? usd(L.spot) + ' /oz' : '—', ago && L.spot ? pct(L.spot / ago.xag - 1) + ` · ${ago.days}d` : '', ago && L.spot ? cls(L.spot / ago.xag - 1) : '')}
        ${mini('USD → NPR', L.fx ? L.fx.toFixed(2) : '—', ago && L.fx ? pct(L.fx / ago.fx - 1, 2) + ` · ${ago.days}d` : '', '')}
        ${mini('FENEGOSIDA silver', L.tola ? rs(L.tola) : '—', L.date ? 'per tola · ' + fmtDay(L.date, { noYear: true }) : '', '')}
        ${mk ? mini('2-year Treasury', mk.y2.toFixed(2) + '%', mk.y2Change30 != null ? `${mk.y2Change30 >= 0 ? '+' : '−'}${Math.abs(mk.y2Change30).toFixed(2)} pts · 30d` : '', '') : ''}
        ${ry ? mini('10-yr real yield', ry.value.toFixed(2) + '%', ry.change30 != null ? `${ry.change30 >= 0 ? '+' : '−'}${Math.abs(ry.change30).toFixed(2)} pts · 30d` : '', '') : ''}
        ${dx ? mini('US dollar index', dx.value.toFixed(1), dx.change30Pct != null ? pct(dx.change30Pct / 100) + ' · 30d' : '', '') : ''}
      </div>
    </div>`;
  }
  const mini = (k, v, s, c) => `<div class="mini"><div class="label">${k}</div><div class="v num">${v}</div><div class="small ${c || 'muted'}">${s || '&nbsp;'}</div></div>`;

  /* ------------------------------------------------------------------ chain */
  function chain() {
    const L = live(), f = macro.fed, mk = macro.market, ry = macro.realYield, dx = macro.dollar;
    return [
      { t: 'US Fed rate decision', s: `Now ${range(f.lo, f.hi)}`, h: 'The Fed sets the price of money',
        p: ['Eight times a year the FOMC sets the federal funds target, the overnight rate banks charge each other. It anchors every other dollar interest rate, from Treasury bills to mortgages.',
          `Markets trade the <em>surprise</em>, not the decision. Right now ${mk ? `3-month bills at ${mk.t3m.toFixed(2)}% vs. fed funds at ${macro.fed.effr.toFixed(2)}% say ${mk.label.toLowerCase()}` : 'bond yields show what is expected'}. A hike that everyone expects is mostly already in the price; a hold when a hike was expected acts like a cut.`],
        r: 'Watch the gap between what the Fed does and what bonds price.' },
      { t: 'Treasury yields & dollar', s: `${ry ? 'Real 10y ' + ry.value.toFixed(2) + '%' : 'Yields'} · DXY ${dx ? dx.value.toFixed(0) : '—'}`, h: 'Higher rates lift yields and the dollar',
        p: ['A more hawkish Fed pushes Treasury yields up. What matters most for metals is the <em>real</em> yield, the return after inflation. When it is high, cash and bonds pay you well to wait.',
          `Higher US yields pull global money into dollars, so the dollar index usually strengthens. ${ry ? `The 10-year real yield is ${ry.value.toFixed(2)}% today (${ry.change30 >= 0 ? 'up' : 'down'} ${Math.abs(ry.change30).toFixed(2)} pts in 30 days).` : ''}`],
        r: 'Rising real yields + rising dollar = pressure on silver.' },
      { t: 'Global spot silver', s: L.spot ? `Now ${usd(L.spot)}/oz` : 'XAG/USD', h: 'Silver pays no interest, so its opportunity cost rises',
        p: ['A bar of silver earns nothing. When a Treasury bill pays 4%, holding silver means giving that up, so higher yields push money out of metal.',
          'Silver is priced in dollars, so a stronger dollar makes it dearer for everyone else and cuts demand. It is also an industrial metal (solar, electronics), so hikes that slow the economy hit it harder than gold. Silver often moves 1.5–2× as much as gold.'],
        r: 'Hawkish surprise → silver down. Dovish surprise → silver up, often sharply.' },
      { t: 'USD/NPR & import costs', s: L.fx ? `Now ${L.fx.toFixed(2)} · +${(premium(L) * 100).toFixed(0)}% local` : 'USD/NPR', h: 'The rupee converts spot, and Nepal adds its costs',
        p: ['The Nepali rupee is pegged to the Indian rupee at 1.6, so USD/NPR follows USD/INR. When the dollar strengthens after a hawkish Fed, the rupee usually weakens, and each dollar of silver costs more rupees.',
          `That is the push-and-pull for Nepal: the same Fed move that pushes spot <em>down</em> pushes USD/NPR <em>up</em>, partly cancelling out. On top sit customs duty, local charges and dealer premium, about <b>${(premium(L) * 100).toFixed(0)}%</b> over spot today.`],
        r: 'A weaker rupee cushions falls in spot and amplifies rises.' },
      { t: 'Nepal silver price', s: L.tola ? `Now ${rs(L.tola)}/tola` : 'FENEGOSIDA', h: 'What you actually pay at the counter',
        p: ['FENEGOSIDA sets the day\'s rate each morning, roughly <em>spot × USD/NPR × (11.664 ÷ 31.103) × (1 + duty and premium)</em>. Fed decisions land after midnight Nepal time, so the reaction shows up in the next morning\'s rate.',
          'Jewellers add making charges, and the buyback rate is lower than the selling rate. The round trip costs real money, so planned tranches matter more than catching the exact bottom.'],
        r: 'Decision lands after midnight NPT; the rate reacts the next morning.' },
    ];
  }
  function paintChain() {
    const C = chain();
    $('#fedChain', root).innerHTML = C.map((c, i) => `<button class="list-item${i === ui.step ? ' on' : ''}" data-i="${i}" aria-pressed="${i === ui.step}">
      <span class="li-icon silver num">${i + 1}</span><span class="li-main"><span class="li-title">${c.t}</span><span class="li-sub">${c.s}</span></span>
      <span class="li-right chev" aria-hidden="true">›</span></button>`).join('');
    const c = C[ui.step];
    $('#fedExplain', root).innerHTML = `<div class="fade-in"><h3>Step ${ui.step + 1} of 5</h3><div class="fed-h">${c.h}</div>${c.p.map(p => `<p class="hint">${p}</p>`).join('')}<div class="notice info mt-s">${c.r}</div></div>`;
    $$('#fedChain .list-item', root).forEach(b => b.onclick = () => { ui.step = +b.dataset.i; saveUi(); paintChain(); });
  }

  /* ------------------------------------------------------------------ simulator */
  function paintSim() {
    const next = macro.meetings?.next;
    $('#simTitle', root).textContent = next ? `What to expect: ${meetingName(next)}` : 'What to expect at the next FOMC';
    const base = baseKey();
    $('#fedSim', root).innerHTML = `
      <div class="seg full" id="scenSeg">${Object.entries(SCEN).map(([k, s]) => `<button data-k="${k}">${s.name}</button>`).join('')}</div>
      <p class="hint mt-s" id="scenWhy"></p>
      <div class="fed-sim mt">
        <div>
          <div class="form-group">
            <div class="field"><label for="inSpot">Silver spot</label><input id="inSpot" type="number" inputmode="decimal" step="0.01" value="${ui.spot ?? ''}"><span class="unit">$/oz</span></div>
            <div class="field"><label for="inFx">USD → NPR</label><input id="inFx" type="number" inputmode="decimal" step="0.01" value="${ui.fx ?? ''}"><span class="unit">Rs</span></div>
            <div class="field"><label for="inMk">Nepal markup</label><input id="inMk" type="number" inputmode="decimal" step="0.1" value="${ui.markup ?? ''}"><span class="unit">%</span></div>
            <div class="field col"><label for="inK" class="row"><span>Reaction strength</span><span class="num muted" id="kVal">${ui.intensity.toFixed(1)}×</span></label><input id="inK" type="range" min="0.5" max="2" step="0.1" value="${ui.intensity}"></div>
          </div>
          <p class="form-caption">Filled from today's rates. The markup is today's FENEGOSIDA rate vs. spot in rupees (duty, local costs and premium; not making charges). <button class="text-btn" id="simReset">Reset to live</button></p>
        </div>
        <div>
          <div class="stat-grid">
            <div class="stat"><div class="label">Global silver</div><div class="v num" id="oSpot"></div><div class="s" id="oSpotD"></div></div>
            <div class="stat"><div class="label">USD → NPR</div><div class="v num" id="oFx"></div><div class="s" id="oFxD"></div></div>
          </div>
          <div class="card mt-s"><div class="label">Estimated Nepal price per tola</div><div class="big num" id="oTola" style="margin:6px 0 4px"></div>
            <div class="small" id="oTolaD"></div><div class="small muted" id="o10"></div>
            <div class="fed-wf mt" id="oWf"></div></div>
        </div>
      </div>
      <div class="notice mt" id="takeaway"></div>`;
    $$('#scenSeg button', root).forEach(b => {
      if (b.dataset.k === base) b.insertAdjacentHTML('beforeend', '<small class="fed-base">base</small>');
      b.onclick = () => { ui.scenario = b.dataset.k; paintSimOut(); };
    });
    const bind = (id, k) => $(id, root).addEventListener('input', e => { ui[k] = parseFloat(e.target.value); paintSimOut(); if (k === 'markup' && ui.unit === 'npr') paintChart(); });
    bind('#inSpot', 'spot'); bind('#inFx', 'fx'); bind('#inMk', 'markup');
    $('#inK', root).addEventListener('input', e => { ui.intensity = parseFloat(e.target.value) || 1; paintSimOut(); });
    $('#simReset', root).onclick = () => { ui.spot = null; ui.intensity = 1; render(root, ctx); };
    paintSimOut();
  }

  function paintSimOut() {
    const L = live();
    $$('#scenSeg button', root).forEach(b => b.classList.toggle('on', b.dataset.k === ui.scenario));
    const s = SCEN[ui.scenario], e = effect(ui.scenario);
    $('#scenWhy', root).innerHTML = `<b>${s.long}.</b> ${scenarioWhy(ui.scenario)}`;
    $('#kVal', root).textContent = ui.intensity.toFixed(1) + '×';
    const spot0 = ui.spot > 0 ? ui.spot : L.spot, fx0 = ui.fx > 0 ? ui.fx : L.fx;
    if (!spot0 || !fx0) return;
    const mk = Math.max(0, isFinite(ui.markup) ? ui.markup : 0) / 100;
    const spot1 = spot0 * (1 + e.xag), fx1 = fx0 * (1 + e.fx);
    const t0 = spot0 * fx0 * OZ_TO_TOLA * (1 + mk), t1 = spot1 * fx1 * OZ_TO_TOLA * (1 + mk);
    const dT = t1 / t0 - 1, total = t1 - t0, spotPart = t0 * e.xag, fxPart = total - spotPart;

    $('#oSpot', root).textContent = usd(spot1);
    $('#oSpotD', root).innerHTML = `<span class="${cls(e.xag)}">${pct(e.xag)}</span> <span class="muted">likely ${pct(e.xag * 0.5)} to ${pct(e.xag * 1.6)}</span>`;
    $('#oFx', root).textContent = fx1.toFixed(2);
    $('#oFxD', root).innerHTML = `<span class="${cls(e.fx)}">${pct(e.fx, 2)}</span> <span class="muted">rupee ${e.fx > 0 ? 'weaker' : e.fx < 0 ? 'stronger' : 'flat'}</span>`;
    $('#oTola', root).textContent = rs(t1);
    $('#oTolaD', root).innerHTML = `<span class="${cls(dT)}">${rsS(total)} (${pct(dT)})</span> <span class="muted">vs. ${rs(t0)} at these inputs</span>`;
    $('#o10', root).textContent = `≈ ${rs(t1 / TOLA * 10)} per 10 g · ${rs(t1 / TOLA * 1000)} per kg`;
    const max = Math.max(Math.abs(spotPart), Math.abs(fxPart), Math.abs(total), 1);
    const row = (label, v, color, strong) => {
      const w = Math.abs(v) / max * 50;
      return `<div class="wf-row${strong ? ' total' : ''}"><span>${label}</span><div class="wf-track"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${color}"></i></div><span class="num ${cls(v)}">${rsS(v)}</span></div>`;
    };
    $('#oWf', root).innerHTML = row('From silver', spotPart, spotPart >= 0 ? 'var(--up)' : 'var(--down)') + row('From USD/NPR', fxPart, fxPart >= 0 ? 'var(--up)' : 'var(--down)') + row('Net per tola', total, 'var(--accent)', true);

    const off = Math.abs(spotPart) > 0 ? Math.abs(fxPart) / Math.abs(spotPart) : 0;
    let lead, tips, tone;
    if (dT < -0.001) {
      tone = 'good';
      lead = `<b>Likely cheaper for you.</b> Spot could fall about ${mag(e.xag)}, but a stronger dollar against the rupee claws back roughly <b>${(off * 100).toFixed(0)}%</b> of that, so the Nepal rate drops a smaller ${mag(dT)}, about <b>${rs(Math.abs(total))} per tola</b>.`;
      tips = ['Wait for the FENEGOSIDA rate the morning after the decision instead of buying the day before.', 'Sell-offs after hawkish surprises can run for days. Spread this month\'s budget over two or three tranches.', 'The dollar gain that cushions your price can reverse quickly, so don\'t over-read one meeting.'];
    } else if (dT > 0.001) {
      tone = 'bad';
      lead = `<b>Likely dearer.</b> Spot could rise about ${mag(e.xag)}. ${e.fx < 0 ? `A softer dollar firms the rupee, trimming roughly <b>${(off * 100).toFixed(0)}%</b> of the rise` : 'A weaker rupee adds to it'}, so the Nepal rate rises about ${mag(dT)}, roughly <b>${rs(total)} per tola</b>.`;
      tips = ['If you planned to buy anyway, one tranche before the decision hedges against missing a rally.', 'Avoid chasing a spike the morning after; Fed-news rallies often give back part of the move.', 'Keep the rest for later tranches so one headline never sets your whole average.'];
    } else {
      tone = '';
      lead = '<b>Roughly a wash.</b> The move in spot and the move in USD/NPR largely cancel out, so the Nepal rate barely changes.';
      tips = ['Stick to your normal buying schedule.', 'Listen for guidance about the next meeting; that is where the real move may come from.'];
    }
    const box = $('#takeaway', root);
    box.className = 'notice mt fed-take ' + tone;
    box.innerHTML = `<div><div class="label" style="margin-bottom:4px">Buyer's takeaway</div><div>${lead}</div><ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
  }

  /* ------------------------------------------------------------------ history chart */
  const MILESTONES = [
    { q: '2018 Q4', t: 'Hikes peak 2.50%' }, { q: '2020 Q1', t: 'COVID: cut to zero' }, { q: '2022 Q1', t: 'Fastest hikes in 40 years' },
    { q: '2023 Q3', t: 'Peak 5.50%, pause' }, { q: '2024 Q3', t: 'Cuts begin' }, { q: '2026 Q1', t: 'Silver record' },
  ];
  const LESSONS = [
    ['2018: hikes squeeze silver', 'Steady hikes to 2.50% and a strong dollar kept silver stuck around $14–17. Rising real yields made the non-yielding metal unattractive.'],
    ['2020: zero rates ignite a rally', 'Emergency cuts to 0–0.25% sent real yields deeply negative. Silver went from about $17 to $25 a quarter within two quarters.'],
    ['2022: hawkish Fed, cushioned rupee', 'The Fed hiked 4.25 points in a year and silver fell toward $19. USD/NPR rose from about 120 to 131, softening the hit for Nepal buyers.'],
  ];

  function quarterlyFenegosida(labels) {
    const acc = {};
    for (const [d, v] of ctx.history?.silver || []) (acc[`${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`] ||= []).push(v);
    return labels.map(q => (acc[q] ? acc[q].reduce((a, b) => a + b, 0) / acc[q].length : null));
  }

  function paintChart() {
    $$('#fedUnit button', root).forEach(b => { b.classList.toggle('on', b.dataset.u === ui.unit); b.onclick = () => { ui.unit = b.dataset.u; saveUi(); paintChart(); }; });
    $('#fedLessons', root).innerHTML = LESSONS.map(([t, d]) => `<div class="card tight"><div style="font-weight:500">${t}</div><div class="hint mt-s">${d}</div></div>`).join('');
    const Q = macro.quarterly;
    if (!Q || typeof Chart === 'undefined') { $('#fedChartNote', root).textContent = 'Chart unavailable right now.'; return; }
    const L = live();
    const mk = (isFinite(ui.markup) ? ui.markup : premium(L) * 100) / 100;
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const C = { fed: css('--accent') || '#E2A77A', silver: css('--silver') || '#45413C', act: css('--up') || '#5B7F5E', grid: css('--sep'), tick: css('--text-3'), text: css('--text-2'), inset: css('--card') };
    const silverData = ui.unit === 'usd' ? Q.xag : Q.xag.map((x, i) => (x != null && Q.usdnpr?.[i] ? x * Q.usdnpr[i] * OZ_TO_TOLA * (1 + mk) : null));
    const ds = [
      { label: 'Fed funds (upper, %)', data: Q.fed, yAxisID: 'yRate', borderColor: C.fed, backgroundColor: C.fed, stepped: 'before', borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4 },
      { label: ui.unit === 'usd' ? 'Silver ($/oz)' : `Silver, estimated (NPR/tola, +${(mk * 100).toFixed(0)}%)`, data: silverData, yAxisID: 'ySilver', borderColor: C.silver, backgroundColor: C.silver, borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, spanGaps: true },
    ];
    if (ui.unit === 'npr') {
      const act = quarterlyFenegosida(Q.labels);
      if (act.some(v => v != null)) ds.push({ label: 'FENEGOSIDA actual', data: act, yAxisID: 'ySilver', borderColor: C.act, backgroundColor: C.act, borderWidth: 2, pointRadius: 3, tension: 0.3 });
    }
    $('#fedLegend', root).innerHTML = ds.map(d => `<span><i style="background:${d.borderColor}"></i>${esc(d.label)}</span>`).join('');
    const narrow = root.clientWidth < 620;
    const ann = {};
    MILESTONES.forEach((m, i) => {
      if (!Q.labels.includes(m.q)) return;
      ann['m' + i] = { type: 'line', drawTime: 'beforeDatasetsDraw', xMin: m.q, xMax: m.q, borderColor: C.grid, borderWidth: 1.5, borderDash: [3, 4],
        label: { display: !narrow, content: m.t, position: i % 2 ? 'end' : 'start', backgroundColor: C.inset, color: C.text, font: { size: 10.5, weight: '500', family: 'DM Sans' }, padding: 5, borderRadius: 6 } };
    });
    const sTick = ui.unit === 'usd' ? v => '$' + v : v => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v);
    const cfg = {
      type: 'line', data: { labels: Q.labels, datasets: ds },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        font: { family: 'DM Sans' },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: C.tick, maxRotation: 0, autoSkip: false, font: { family: 'DM Sans', size: 11 }, callback(v) { const l = this.getLabelForValue(v); return l.endsWith('Q1') && (!narrow || +l.slice(0, 4) % 2 === 0) ? l.slice(0, 4) : ''; } } },
          yRate: { position: 'left', min: 0, suggestedMax: 6, border: { display: false }, grid: { color: C.grid }, ticks: { color: C.tick, font: { family: 'DM Sans', size: 11 }, callback: v => v + '%' } },
          ySilver: { position: 'right', grace: '12%', border: { display: false }, grid: { display: false }, ticks: { color: C.tick, font: { family: 'DM Sans', size: 11 }, callback: sTick } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#45413C', titleFont: { family: 'DM Sans' }, bodyFont: { family: 'DM Sans' }, padding: 10, cornerRadius: 8,
            callbacks: { label(c) { const v = c.parsed.y; if (v == null) return null; return c.dataset.yAxisID === 'yRate' ? ` Fed funds ${v.toFixed(2)}%` : ui.unit === 'usd' ? ` Silver ${usd(v)}` : ` ${c.dataset.label.split(' (')[0]} ${rs(v)}`; } },
          },
          annotation: { annotations: ann },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($('#fedChart', root), cfg);
    $('#fedChartNote', root).textContent = ui.unit === 'usd'
      ? 'Fed line: upper bound of the target range at quarter end (FRED). Silver: average of monthly COMEX closes. The current quarter is partial.'
      : 'Estimate: spot × USD/NPR (from USD/INR × 1.6) × today\'s markup, applied to every year, though duty and premiums changed over time. Green: real FENEGOSIDA quarterly averages.';
  }

  /* ------------------------------------------------------------------ your buys */
  function paintBuys() {
    const box = $('#fedBuys', root);
    const buys = (ctx.txns || []).filter(t => t.metal === 'silver' && t.type === 'buy').sort((a, b) => b.date.localeCompare(a.date));
    if (!buys.length) {
      box.innerHTML = `<div class="card empty"><h2>No silver purchases yet</h2><p>Log your buys and this section shows the Fed rate when you bought each one, plus your average buy-in.</p><button class="btn" id="fedAdd">Add silver</button></div>`;
      $('#fedAdd', box).onclick = () => ctx.addPurchase('silver');
      return;
    }
    const grams = buys.reduce((a, t) => a + t.grams, 0), paid = buys.reduce((a, t) => a + t.amount, 0);
    const avg = paid / grams * TOLA, L = live();
    const vs = L.tola ? L.tola / avg - 1 : null;
    const groups = { up: [], down: [], flat: [] };
    buys.forEach(t => { const f = fedOn(t.date); groups[f ? (f.dir > 0 ? 'up' : f.dir < 0 ? 'down' : 'flat') : 'flat'].push(t); });
    const avgOf = arr => { const g = arr.reduce((a, t) => a + t.grams, 0); return g ? arr.reduce((a, t) => a + t.amount, 0) / g * TOLA : null; };
    const hikeAvg = avgOf(groups.up), cutAvg = avgOf(groups.down);
    box.innerHTML = `
      <div class="stat-grid four">
        <div class="stat"><div class="label">Average buy-in</div><div class="v num">${rs(avg)}</div><div class="s muted">per tola, all-in</div></div>
        <div class="stat"><div class="label">Today vs. average</div><div class="v num ${vs != null ? cls(vs) : ''}">${vs != null ? pct(vs) : '—'}</div><div class="s muted">${L.tola ? rs(L.tola) + ' today' : '&nbsp;'}</div></div>
        <div class="stat"><div class="label">Bought after a hike</div><div class="v num">${hikeAvg ? rs(hikeAvg) : '—'}</div><div class="s muted">${groups.up.length} buy${groups.up.length === 1 ? '' : 's'} · avg/tola</div></div>
        <div class="stat"><div class="label">Bought after a cut</div><div class="v num">${cutAvg ? rs(cutAvg) : '—'}</div><div class="s muted">${groups.down.length} buy${groups.down.length === 1 ? '' : 's'} · avg/tola</div></div>
      </div>
      <div class="list plain mt-s">${buys.slice(0, 12).map(t => {
        const f = fedOn(t.date);
        const tag = f ? (f.dir > 0 ? 'after a hike' : f.dir < 0 ? 'after a cut' : '') : '';
        return `<div class="list-item"><div class="li-main"><div class="li-title">${fmtDay(t.date)} · ${(t.grams / TOLA).toFixed(2)} tola</div>
          <div class="li-sub">Fed ${f ? range(f.lo, f.hi) : '—'}${tag ? ' · ' + tag : ''}</div></div>
          <div class="li-right"><div class="t num">${rs(t.amount / t.grams * TOLA)}</div><div class="s muted">per tola</div></div></div>`;
      }).join('')}</div>
      <p class="form-caption">From your Stack log (all-in price incl. making charge and SDF). Fed rate is the target range in force on the purchase date. <button class="text-btn" id="fedAdd">Add a purchase</button></p>`;
    $('#fedAdd', box).onclick = () => ctx.addPurchase('silver');
  }

  /* ------------------------------------------------------------------ checklist (resets each meeting) */
  const CHECKS = [
    ['Check today\'s FENEGOSIDA rate', 'Confirm the morning rate on the Silver tab before visiting a dealer.'],
    ['Know when the decision lands', 'The statement comes out after midnight Nepal time; the local rate reacts the next morning.'],
    ['Don\'t panic-buy the day before', 'Pre-meeting moves are noisy. Waiting one day for the post-decision rate costs little.'],
    ['Split into tranches', 'Divide this month\'s budget into 2–3 parts: before, after, and a couple of weeks after the meeting.'],
    ['Compare with your average buy-in', 'Buying below your average lowers your break-even.'],
    ['Check the USD/NPR trend', 'A weakening rupee can keep local prices high even when spot dips.'],
    ['Ask the making charge and buyback rate', 'Bars and coins carry lower making charges than jewellery. Know the round-trip cost.'],
    ['Get a stamped bill', 'Weight, purity (e.g. 99.9) and price on a proper bill.'],
  ];
  function paintChecklist() {
    const next = macro.meetings?.next;
    const key = next?.end || 'none';
    let st = store.get(CKEY, {});
    if (st.meeting !== key) st = { meeting: key, done: {} };
    const d = next ? daysTo(next.end) : null;
    $('#checkTitle', root).textContent = next ? (d <= 7 ? `Before you buy: FOMC week (${fmtDay(next.start, { noYear: true })}–${fmtDay(next.end, { noYear: true })})` : `Before you buy around the ${meetingName(next)}`) : 'Before you buy';
    const box = $('#fedChecklist', root);
    const paint = () => {
      const n = CHECKS.filter((_, i) => st.done[i]).length;
      box.innerHTML = `<div class="form-group fed-checks">${CHECKS.map(([t, s], i) => `<label class="field"><input type="checkbox" data-i="${i}" ${st.done[i] ? 'checked' : ''}><span class="li-main"><span class="li-title">${t}</span><span class="li-sub">${s}</span></span></label>`).join('')}</div>
        <div class="row mt-s"><div class="bar-track" style="flex:1;background:var(--card)"><i style="width:${n / CHECKS.length * 100}%;background:var(--accent)"></i></div><span class="small muted">${n}/${CHECKS.length}</span></div>
        <p class="form-caption">Ticks reset automatically for each new FOMC meeting.</p>`;
      $$('input', box).forEach(c => c.onchange = () => { st.done[c.dataset.i] = c.checked; store.set(CKEY, st); paint(); });
    };
    paint();
  }

  function paintFoot() {
    const at = macro.fetchedAt ? new Date(macro.fetchedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
    $('#fedFoot', root).innerHTML = `Updates automatically: Fed range, FOMC calendar, Treasury yields, CPI and the dollar from FRED and federalreserve.gov (last fetched ${at}); silver and USD/NPR from the price feed. The simulator uses simplified, educational correlations and markets often break them. This is for personal tracking, not financial advice. Always confirm the day's FENEGOSIDA rate before buying.`;
  }

  window.FedView = { render, refresh: loadMacro };
})();
