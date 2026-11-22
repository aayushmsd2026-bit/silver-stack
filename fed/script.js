/* Fed Rates & Silver Buying Tracker (Nepal Edition)
   Vanilla JS + Chart.js. Live inputs come from the Stack site's own data files
   (../data/prices.json and ../data/history.json, refreshed by the price workflow).
   Everything else is plain, editable configuration below. */
(function () {
  'use strict';

  /* ================================================================ configuration
     Edit these when the macro picture changes. They are not fetched automatically. */
  const CONFIG = {
    fed: { lo: 3.75, hi: 4.00, asOf: 'Nov 2026' },
    nextMeeting: 'December 2026 FOMC',
    inflation: 'sticky',
    baseCase: 'B',
    // Used only when the live data files can't be loaded (e.g. opened from disk).
    fallback: { spot: 41.08, fx: 148.58, tola: 3110, date: '2026-11-20' },
  };

  const TOLA = 11.6638038;   // grams per tola
  const OZT = 31.1034768;    // grams per troy ounce
  const G_PER_OZ_TO_TOLA = TOLA / OZT;

  /* ================================================================ helpers */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  const nprFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const npr = v => 'Rs ' + nprFmt.format(Math.round(v));
  const usd = (v, d = 2) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v * 100).toFixed(d) + '%';
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '±') + f(Math.abs(v));
  const cls = v => (v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : 'flat');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fedRange = () => `${CONFIG.fed.lo.toFixed(2)}–${CONFIG.fed.hi.toFixed(2)}%`;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ================================================================ live data */
  const live = {
    spot: CONFIG.fallback.spot, fx: CONFIG.fallback.fx, tola: CONFIG.fallback.tola,
    date: CONFIG.fallback.date, prevTola: null, history: null, fromFile: false,
  };

  async function loadLive() {
    const get = p => fetch(p, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [prices, history] = await Promise.all([get('../data/prices.json'), get('../data/history.json')]);
    if (prices?.intl?.xag && prices?.intl?.usdnpr && prices?.silver?.tola) {
      live.spot = prices.intl.xag;
      live.fx = prices.intl.usdnpr;
      live.tola = prices.silver.tola;
      live.prevTola = prices.silver.prevTola || null;
      live.date = prices.date;
      live.fetchedAt = prices.fetchedAt;
      live.fromFile = true;
    }
    if (history?.silver) live.history = history;
  }

  // Nepal premium implied by today's numbers: local rate vs. spot converted to NPR per tola.
  const impliedPremium = () => live.tola / (live.spot * live.fx * G_PER_OZ_TO_TOLA) - 1;

  function monthAgoSpot() {
    const rows = live.history?.intl;
    if (!rows || rows.length < 2) return null;
    const last = new Date(rows[rows.length - 1][0]);
    const target = new Date(last); target.setDate(target.getDate() - 30);
    let pick = rows[0];
    for (const r of rows) { if (new Date(r[0]) <= target) pick = r; }
    return { date: pick[0], xag: pick[2], fx: pick[3] };
  }

  /* ================================================================ 1. header & summary */
  function renderHeader() {
    $('#kpiFed').textContent = fedRange();
    $('#kpiFedNote').textContent = `Target range · ${CONFIG.fed.asOf}`;
    $('#kpiXag').textContent = usd(live.spot) + ' /oz';
    $('#kpiFx').textContent = live.fx.toFixed(2);
    $('#kpiTola').textContent = npr(live.tola);
    $('#kpiTolaNote').textContent = 'per tola · ' + live.date;

    const ago = monthAgoSpot();
    let move = '';
    if (ago) {
      const ch = live.spot / ago.xag - 1;
      const fxch = live.fx / ago.fx - 1;
      $('#kpiXagNote').innerHTML = `<span class="${cls(ch)}">${pct(ch)}</span> in 30 days`;
      $('#kpiFxNote').innerHTML = `<span class="${cls(fxch)}">${pct(fxch, 2)}</span> in 30 days`;
      move = ` Spot silver has moved <b>${pct(ch)}</b> in the past month (${usd(ago.xag)} → ${usd(live.spot)}), so volatility is already high going into the meeting.`;
    } else {
      $('#kpiXagNote').textContent = 'International spot';
      $('#kpiFxNote').textContent = 'NRB reference';
    }

    $('#bannerTitle').textContent = `Hawkish hold at ${fedRange()} — hike risk into December`;
    $('#bannerText').innerHTML =
      `The Fed's target range sits at <b>${fedRange()}</b>, inflation remains <b>${CONFIG.inflation}</b>, and markets lean toward a <b>+25 bp hike</b> at the ${CONFIG.nextMeeting}. ` +
      `Higher-for-longer rates raise the cost of holding silver, which pays no interest, and tend to firm the US dollar: usually a headwind for XAG/USD. ` +
      `For buyers in Nepal the dollar side partly cushions this, because a stronger USD also lifts USD/NPR, so local prices tend to fall <b>less than spot</b>.` + move +
      ` <b>What it signals:</b> no rush to buy before the announcement; staggered buying usually beats trying to time a single day.`;
  }

  /* ================================================================ 2. the chain */
  const CHAIN = [
    {
      title: 'US Fed rate decision', sub: () => `Now ${fedRange()}`,
      head: 'The Fed sets the price of money',
      body: [
        'Eight times a year the FOMC sets the federal funds target, the overnight rate banks charge each other. That rate anchors every other dollar interest rate, from Treasury bills to mortgages.',
        'Markets trade on the <em>surprise</em>, not the decision. A hike that everyone expected is mostly already in the price; a hold when a hike was expected acts like a cut. The statement and the “dot plot” of future rates often matter more than the day\'s move.',
      ],
      rule: 'Rule of thumb: watch the gap between what the Fed does and what was priced in.',
    },
    {
      title: 'Treasury yields & USD (DXY)', sub: () => 'Real yields · dollar index',
      head: 'Higher rates lift yields and the dollar',
      body: [
        'When the Fed is more hawkish, US Treasury yields rise. What matters most for metals is the <em>real</em> yield: the yield after inflation. A higher real yield means cash and bonds now pay you meaningfully to wait.',
        'Higher US yields also attract global money into dollar assets, so the US Dollar Index (DXY) usually strengthens. A dovish turn does the opposite: yields fall and the dollar softens.',
      ],
      rule: 'Rule of thumb: rising real yields + rising DXY = pressure on silver.',
    },
    {
      title: 'Global spot silver (XAG/USD)', sub: () => `Now ${usd(live.spot)}/oz`,
      head: 'Silver pays no interest, so its opportunity cost rises',
      body: [
        'A bar of silver earns nothing. When a Treasury bill pays 4%, holding silver instead means giving up that 4%. The higher the yield, the stronger the reason to sell metal and hold bonds or cash.',
        'Silver is priced in dollars, so a stronger dollar makes it more expensive for buyers using other currencies, cutting demand. Silver is also an industrial metal (solar, electronics), so rate hikes that slow the economy can hit it harder than gold. That is why silver often moves 1.5–2× as much as gold.',
      ],
      rule: 'Rule of thumb: hawkish surprise → silver down; dovish surprise → silver up, often sharply.',
    },
    {
      title: 'USD/NPR & import duties', sub: () => `Now ${live.fx.toFixed(2)} · duty + premium`,
      head: 'The rupee converts spot, and Nepal adds its costs',
      body: () => [
        'The Nepali rupee is pegged to the Indian rupee at 1.6, so USD/NPR moves with USD/INR. When the dollar strengthens globally after a hawkish Fed, the INR (and with it the NPR) usually weakens. Each dollar of silver then costs more rupees.',
        'This is the push-and-pull for Nepal: the same hawkish Fed that pushes spot silver <em>down</em> pushes USD/NPR <em>up</em>, partly cancelling the fall. On top sit customs duty, local charges and the dealer premium. Today these add about <b>' + (impliedPremium() * 100).toFixed(0) + '%</b> over spot converted to NPR.',
      ],
      rule: 'Rule of thumb: a weaker rupee cushions falls in spot and amplifies rises.',
    },
    {
      title: 'Nepal local silver price', sub: () => `Now ${npr(live.tola)}/tola`,
      head: 'What you actually pay at the counter',
      body: [
        'FENEGOSIDA publishes the day\'s rate each morning: roughly <em>spot × USD/NPR × (11.664 ÷ 31.103) × (1 + duty and premium)</em>. Because it is set once a day, overnight moves in New York show up in the next morning\'s Nepal rate.',
        'Jewellers add making charges on top, and the buyback rate is lower than the selling rate. So for an investor the round-trip cost is real: buying in planned tranches matters more than catching the exact bottom.',
      ],
      rule: 'Rule of thumb: Fed decisions land late evening Nepal time; the rate reacts the next morning.',
    },
  ];
  let chainSel = 0;

  function renderChain() {
    $('#chainList').innerHTML = CHAIN.map((c, i) => `
      <li><button class="node" role="tab" type="button" id="node-${i}" aria-selected="${i === chainSel}" aria-controls="chainExplain" data-i="${i}">
        <span class="n">${i + 1}</span>
        <span class="t"><b>${c.title}</b><small>${c.sub()}</small></span>
      </button></li>`).join('');
    $$('#chainList .node').forEach(b => b.addEventListener('click', () => { chainSel = +b.dataset.i; renderChain(); }));
    const c = CHAIN[chainSel];
    const ex = $('#chainExplain');
    ex.setAttribute('aria-labelledby', 'node-' + chainSel);
    ex.innerHTML = `<div class="fade"><h4>${chainSel + 1}. ${c.head}</h4>${(typeof c.body === 'function' ? c.body() : c.body).map(p => `<p>${p}</p>`).join('')}<span class="rule">${c.rule}</span></div>`;
  }

  /* ================================================================ 3. simulator
     Typical first-week reactions, relative to what the market already expects (a +25 bp hike).
     These are educational, rounded correlations, not forecasts. */
  const SCENARIOS = {
    A: {
      label: 'Scenario A', name: 'Fed holds steady', bps: '0 bps', tag: 'Dovish vs. expected',
      dxy: -0.006, xag: 0.025, fx: -0.003,
      why: 'Markets were braced for a hike, so a hold reads as softer than expected. The dollar eases and silver catches a relief bid.',
    },
    B: {
      label: 'Scenario B', name: 'Hike +25 bps', bps: '+25 bps', tag: 'Base case',
      dxy: 0.003, xag: -0.015, fx: 0.002,
      why: 'Largely priced in. Expect a small dip in silver and a slightly firmer dollar. The press conference tone decides the rest.',
    },
    C: {
      label: 'Scenario C', name: 'Hike +50 bps', bps: '+50 bps', tag: 'Hawkish surprise',
      dxy: 0.015, xag: -0.06, fx: 0.008,
      why: 'A surprise jump in real yields and a strong dollar. Silver typically sells off hard, and silver\'s high beta makes it fall more than gold.',
    },
    D: {
      label: 'Scenario D', name: 'Signals future cuts', bps: 'Dovish pivot', tag: 'Dovish surprise',
      dxy: -0.015, xag: 0.05, fx: -0.007,
      why: 'Signalling cuts ahead pulls real yields and the dollar lower. Silver tends to rally strongly, though a softer rupee-dollar trims part of the gain locally.',
    },
  };
  const sim = {
    scenario: store.get('fed.scenario', CONFIG.baseCase),
    spot: null, fx: null, markup: null, intensity: 1,
  };
  if (!SCENARIOS[sim.scenario]) sim.scenario = CONFIG.baseCase;

  function resetInputs() {
    sim.spot = +live.spot.toFixed(2);
    sim.fx = +live.fx.toFixed(2);
    sim.markup = +(impliedPremium() * 100).toFixed(1);
    sim.intensity = 1;
    $('#inSpot').value = sim.spot;
    $('#inFx').value = sim.fx;
    $('#inMarkup').value = sim.markup;
    $('#inIntensity').value = 1;
    $('#markupHint').textContent = `Calibrated from today's FENEGOSIDA rate (${npr(live.tola)}/tola) vs. spot in NPR. Covers duty, local charges and dealer premium, not making charges.`;
    renderSim();
  }

  function renderScenarioButtons() {
    $('#scenarioBtns').innerHTML = Object.entries(SCENARIOS).map(([k, s]) => `
      <button class="scn" type="button" role="radio" aria-checked="${k === sim.scenario}" data-k="${k}">
        <span class="l">${s.label}</span><b>${s.name}</b><small>${s.bps}</small><span class="tag">${s.tag}</span>
      </button>`).join('');
    $$('#scenarioBtns .scn').forEach(b => b.addEventListener('click', () => {
      sim.scenario = b.dataset.k; store.set('fed.scenario', sim.scenario);
      renderScenarioButtons(); renderSim();
    }));
  }

  function renderSim() {
    const s = SCENARIOS[sim.scenario];
    const k = sim.intensity;
    const spot0 = sim.spot > 0 ? sim.spot : live.spot;
    const fx0 = sim.fx > 0 ? sim.fx : live.fx;
    const mk = Math.max(0, isFinite(sim.markup) ? sim.markup : 0) / 100;
    const dS = s.xag * k, dF = s.fx * k;
    const spot1 = spot0 * (1 + dS), fx1 = fx0 * (1 + dF);
    const tola0 = spot0 * fx0 * G_PER_OZ_TO_TOLA * (1 + mk);
    const tola1 = spot1 * fx1 * G_PER_OZ_TO_TOLA * (1 + mk);
    const dT = tola1 / tola0 - 1;
    const mag = v => (Math.abs(v) * 100).toFixed(1) + '%';
    const range = (v, f) => `likely ${f(v * 0.5)} to ${f(v * 1.6)}`;

    $('#intensityVal').textContent = k.toFixed(1) + '×';
    $('#outSpot').textContent = usd(spot1);
    $('#outSpotD').innerHTML = `<span class="${cls(dS)}">${pct(dS)}</span> <span class="faint">· ${range(dS, v => pct(v))}</span>`;
    $('#outFx').textContent = fx1.toFixed(2);
    $('#outFxD').innerHTML = `<span class="${cls(dF)}">${pct(dF, 2)}</span> <span class="faint">· rupee ${dF > 0 ? 'weaker' : 'stronger'}</span>`;
    $('#outTola').textContent = npr(tola1);
    $('#outTolaD').innerHTML = `<span class="${cls(dT)}">${signed(tola1 - tola0, npr)} (${pct(dT)})</span> <span class="faint">vs. ${npr(tola0)} at today's inputs</span>`;
    $('#out10g').textContent = `≈ ${npr(tola1 / TOLA * 10)} per 10 g · ${npr(tola1 / TOLA * 1000)} per kg`;

    // Decomposition of the NPR change: spot effect, FX effect (incl. the tiny cross term).
    const spotPart = tola0 * dS;
    const fxPart = tola1 - tola0 - spotPart;
    const total = tola1 - tola0;
    const max = Math.max(Math.abs(spotPart), Math.abs(fxPart), Math.abs(total), 1);
    const bar = (v, color) => {
      const w = Math.abs(v) / max * 50;
      const left = v >= 0 ? 50 : 50 - w;
      return `<div class="wf-bar" style="left:${left}%;width:${w}%;background:${color}"></div>`;
    };
    const col = v => (v >= 0 ? 'var(--up)' : 'var(--down)');
    $('#waterfall').innerHTML = `
      <div class="wf-row"><span class="lbl">Global silver move</span><div class="wf-track">${bar(spotPart, col(spotPart))}</div><span class="val ${cls(spotPart)}">${signed(spotPart, npr)}</span></div>
      <div class="wf-row"><span class="lbl">USD/NPR move</span><div class="wf-track">${bar(fxPart, col(fxPart))}</div><span class="val ${cls(fxPart)}">${signed(fxPart, npr)}</span></div>
      <div class="wf-row total"><span class="lbl">Net per tola</span><div class="wf-track">${bar(total, 'var(--accent)')}</div><span class="val ${cls(total)}">${signed(total, npr)}</span></div>`;

    // Buyer's takeaway
    const offset = Math.abs(spotPart) > 0 ? Math.abs(fxPart) / Math.abs(spotPart) : 0;
    const box = $('#takeaway');
    box.classList.remove('good', 'bad', 'mixed');
    let lead, tips;
    if (dT < -0.001) {
      box.classList.add('good');
      lead = `<p><b>Prices likely cheaper for you.</b> Spot silver could fall about ${mag(dS)}, but the dollar strengthening against the rupee claws back roughly <b>${(offset * 100).toFixed(0)}%</b> of that fall, so the Nepal rate drops a smaller ${mag(dT)}, about <b>${npr(Math.abs(total))} per tola</b>.</p>`;
      tips = ['Wait for the post-meeting FENEGOSIDA rate (the morning after the announcement) rather than buying the day before.',
        'Sell-offs after hawkish surprises can run for several sessions. Consider buying in two or three tranches over the following weeks.',
        'Don\'t over-read one meeting: the dollar gain that cushions your price can reverse quickly too.'];
    } else if (dT > 0.001) {
      box.classList.add(dS > 0 && dF < 0 ? 'mixed' : 'bad');
      lead = `<p><b>Prices likely higher.</b> Spot silver could rise about ${mag(dS)}. A softer dollar ${dF < 0 ? `makes the rupee a little stronger, trimming roughly <b>${(offset * 100).toFixed(0)}%</b> of the rise` : 'adds to it'}, so the Nepal rate rises about ${mag(dT)}, roughly <b>${npr(total)} per tola</b>.</p>`;
      tips = ['If you planned to buy anyway, a pre-meeting tranche hedges against missing a dovish rally.',
        'Avoid chasing a spike on the morning after: rallies on Fed news often retrace part of the move within days.',
        'Keep the rest of your planned amount for later tranches, so a single headline never decides your whole average.'];
    } else {
      box.classList.add('mixed');
      lead = `<p><b>Roughly a wash.</b> The move in spot silver and the move in USD/NPR largely cancel out, so the Nepal rate barely changes.</p>`;
      tips = ['Stick to your normal DCA schedule.', 'Watch the Fed\'s guidance for the next meeting; that is where the real move may come from.'];
    }
    $('#takeawayText').innerHTML = `<p class="faint" style="font-size:13.5px">${esc(s.name)}: ${esc(s.why)}</p>${lead}<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`;
  }

  function bindSim() {
    const num = (id, key) => $(id).addEventListener('input', e => { sim[key] = parseFloat(e.target.value); renderSim(); });
    num('#inSpot', 'spot'); num('#inFx', 'fx'); num('#inMarkup', 'markup');
    $('#inIntensity').addEventListener('input', e => { sim.intensity = parseFloat(e.target.value) || 1; renderSim(); });
    $('#resetInputs').addEventListener('click', resetInputs);
  }

  /* ================================================================ 4. history chart
     Quarterly data. Fed funds = upper bound of the target range at quarter end.
     Silver ($/oz) and USD/NPR = approximate quarterly averages (rounded, for education).
     2026 Q1–Q3 USD values are left blank; the NPR view shows actual FENEGOSIDA averages from this site's data. */
  const Q = [];
  for (let y = 2018; y <= 2026; y++) for (let q = 1; q <= 4; q++) Q.push(`${y} Q${q}`);
  const FED = [1.75, 2.00, 2.25, 2.50, 2.50, 2.50, 2.00, 1.75, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25,
    0.50, 1.75, 3.25, 4.50, 5.00, 5.25, 5.50, 5.50, 5.50, 5.50, 5.00, 4.50, 4.50, 4.50, 4.25, 3.75,
    null, null, null, CONFIG.fed.hi];
  const XAG = [16.7, 16.5, 14.9, 14.5, 15.6, 14.9, 17.0, 17.3, 16.9, 16.4, 24.3, 24.4, 26.3, 26.7, 24.4, 23.3,
    24.0, 22.6, 19.2, 21.2, 22.6, 24.1, 23.6, 23.2, 23.3, 28.8, 29.4, 31.4, 32.0, 33.6, 39.4, 51.0,
    null, null, null, null];
  const USDNPR = [103.5, 107, 112, 114, 111, 111, 113, 114, 115, 121, 118, 118, 117, 118, 118, 120,
    121, 124, 127, 131, 131, 131, 132, 133, 133, 133, 134, 135, 138, 137, 140, 142,
    null, null, null, null];
  const MILESTONES = [
    { q: '2018 Q4', text: 'Hikes peak 2.50%', lesson: ['2018: hikes squeeze silver', 'Nine hikes from 2015 to 2018 and a strong dollar kept silver near $14–17. Rising real yields made the non-yielding metal unattractive.'] },
    { q: '2020 Q1', text: 'COVID: cut to zero', lesson: ['2020: zero rates ignite a rally', 'Emergency cuts to 0–0.25% sent real yields deeply negative. Silver more than doubled from its March low within five months.'] },
    { q: '2022 Q1', text: 'Fastest hikes since 1980s', lesson: ['2022: inflation shock, hawkish Fed', 'The Fed hiked 4.25 points in 2022. Silver fell toward $18–19 as the dollar surged, though a weaker rupee softened the hit for Nepal buyers.'] },
    { q: '2023 Q3', text: 'Peak 5.50% · pause' },
    { q: '2024 Q3', text: 'First cut' },
    { q: '2025 Q4', text: 'Silver record highs' },
  ];
  let unit = store.get('fed.unit', 'usd');
  let chart = null;

  function fenegosidaQuarterly() {
    const out = Q.map(() => null);
    const rows = live.history?.silver;
    if (!rows) return out;
    const acc = {};
    for (const [d, v] of rows) {
      const k = `${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
      (acc[k] ||= []).push(v);
    }
    Q.forEach((k, i) => { if (acc[k]) out[i] = acc[k].reduce((a, b) => a + b, 0) / acc[k].length; });
    return out;
  }
  function intlQuarterly() {
    // Fill the latest quarter's USD values from this site's international history.
    const rows = live.history?.intl;
    if (!rows?.length) return;
    const acc = {};
    for (const [d, , xag, fx] of rows) {
      const k = `${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
      (acc[k] ||= []).push([xag, fx]);
    }
    Q.forEach((k, i) => {
      if (acc[k] && XAG[i] == null) {
        XAG[i] = acc[k].reduce((a, b) => a + b[0], 0) / acc[k].length;
        USDNPR[i] = acc[k].reduce((a, b) => a + b[1], 0) / acc[k].length;
      }
    });
  }

  function chartData() {
    const mk = Math.max(0, (isFinite(sim.markup) ? sim.markup : impliedPremium() * 100)) / 100;
    const silverColor = css('--silver-line');
    const fedColor = css('--accent');
    const gapDash = ctx => (ctx.p0.skip || ctx.p1.skip ? [5, 5] : undefined);
    const ds = [{
      label: 'Fed funds rate (upper bound, %)', data: FED, yAxisID: 'yRate',
      borderColor: fedColor, backgroundColor: fedColor, stepped: 'before', borderWidth: 2.2,
      pointRadius: 0, pointHoverRadius: 4, spanGaps: true, segment: { borderDash: gapDash },
    }];
    if (unit === 'usd') {
      ds.push({
        label: 'Silver ($/oz)', data: XAG, yAxisID: 'ySilver', borderColor: silverColor, backgroundColor: silverColor,
        borderWidth: 2.2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, segment: { borderDash: gapDash },
      });
    } else {
      const est = XAG.map((x, i) => (x != null && USDNPR[i] != null ? x * USDNPR[i] * G_PER_OZ_TO_TOLA * (1 + mk) : null));
      ds.push({
        label: `Estimated NPR / tola (spot × USD/NPR + ${(mk * 100).toFixed(0)}%)`, data: est, yAxisID: 'ySilver',
        borderColor: silverColor, backgroundColor: silverColor, borderWidth: 2.2, tension: 0.3,
        pointRadius: 0, pointHoverRadius: 4, spanGaps: true, segment: { borderDash: gapDash },
      });
      const act = fenegosidaQuarterly();
      if (act.some(v => v != null)) {
        ds.push({
          label: 'FENEGOSIDA actual (NPR / tola)', data: act, yAxisID: 'ySilver', borderColor: css('--warn'),
          backgroundColor: css('--warn'), borderWidth: 2, pointRadius: 3, tension: 0.3, spanGaps: false,
        });
      }
    }
    return ds;
  }

  function annotations() {
    const narrow = window.innerWidth < 640;
    const lineColor = css('--text-3');
    const out = {};
    MILESTONES.forEach((m, i) => {
      out['m' + i] = {
        type: 'line', xMin: m.q, xMax: m.q, borderColor: lineColor, borderWidth: 1, borderDash: [3, 4],
        label: {
          display: !narrow, content: m.text, position: i % 2 ? 'end' : 'start', backgroundColor: css('--surface-2'),
          color: css('--text-2'), font: { size: 10.5, weight: '600', family: 'Inter' }, padding: 4, borderRadius: 4,
        },
      };
    });
    return out;
  }

  function renderChart() {
    $$('.seg button').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
    if (typeof Chart === 'undefined') {
      $('#chartNote').textContent = 'The chart library could not load (offline?). Reconnect and refresh to see the history chart.';
      return;
    }
    const grid = css('--line'), tick = css('--text-2');
    const silverTick = unit === 'usd' ? v => '$' + v : v => 'Rs ' + nprFmt.format(v);
    const cfg = {
      type: 'line',
      data: { labels: Q, datasets: chartData() },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: tick, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, callback(v) { const l = this.getLabelForValue(v); return l.endsWith('Q1') ? l.slice(0, 4) : ''; } } },
          yRate: { position: 'left', min: 0, max: 6, grid: { color: grid }, ticks: { color: tick, callback: v => v + '%' }, title: { display: window.innerWidth >= 640, text: 'Fed funds', color: tick } },
          ySilver: { position: 'right', grid: { display: false }, ticks: { color: tick, callback: silverTick }, title: { display: window.innerWidth >= 640, text: unit === 'usd' ? 'Silver $/oz' : 'Silver NPR/tola', color: tick } },
        },
        plugins: {
          legend: { labels: { color: tick, boxWidth: 12, boxHeight: 2, usePointStyle: false, font: { family: 'Inter', size: 12 } } },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                if (v == null) return null;
                if (ctx.dataset.yAxisID === 'yRate') return ` Fed funds: ${v.toFixed(2)}%`;
                return unit === 'usd' ? ` Silver: ${usd(v)}` : ` ${ctx.dataset.label.split(' (')[0]}: ${npr(v)}`;
              },
            },
          },
          annotation: { annotations: annotations() },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($('#histChart'), cfg);
    $('#chartNote').innerHTML = unit === 'usd'
      ? 'Fed line = upper bound of the target range at quarter end. Silver = approximate quarterly average. Dashed segments bridge 2026 quarters not recorded here; the last point uses this site\'s live data and the Fed range set in the page config.'
      : 'Estimated NPR uses spot × USD/NPR × (11.664 ÷ 31.103) × today\'s markup, applied to every year (actual duty and premiums changed over time). The amber line is the real FENEGOSIDA quarterly average from this site\'s history.';
  }

  function renderLessons() {
    $('#lessons').innerHTML = MILESTONES.filter(m => m.lesson).map(m => `<div class="card"><b>${m.lesson[0]}</b><p>${m.lesson[1]}</p></div>`).join('');
  }

  function bindChart() {
    $$('.seg button').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; store.set('fed.unit', unit); renderChart(); }));
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderChart, 250); });
  }

  /* ================================================================ 5. DCA log */
  let dca = store.get('fed.dca', []);
  const saveDca = () => store.set('fed.dca', dca);

  function renderDca() {
    const tb = $('#dcaTable tbody');
    const rows = [...dca].sort((a, b) => b.date.localeCompare(a.date));
    tb.innerHTML = rows.length ? rows.map(r => {
      const t = r.grams / TOLA;
      return `<tr>
        <td>${esc(r.date)}</td>
        <td class="num">${t.toFixed(3)} t <span class="faint">(${r.grams.toFixed(1)} g)</span></td>
        <td class="num">${npr(r.price)}</td>
        <td class="num">${npr(r.price / t)}</td>
        <td>${esc(r.fed || '—')}</td>
        <td><button class="del" data-id="${esc(r.id)}" aria-label="Delete purchase on ${esc(r.date)}">×</button></td>
      </tr>`;
    }).join('') : '<tr class="empty"><td colspan="6">No purchases yet. Log your first buy to track your average.</td></tr>';
    $$('.del', tb).forEach(b => b.addEventListener('click', () => {
      dca = dca.filter(r => r.id !== b.dataset.id); saveDca(); renderDca();
    }));

    const grams = dca.reduce((a, r) => a + r.grams, 0);
    const paid = dca.reduce((a, r) => a + r.price, 0);
    const tolas = grams / TOLA;
    const avg = tolas ? paid / tolas : 0;
    const vsToday = avg ? live.tola / avg - 1 : null;
    $('#dcaStats').innerHTML = `
      <div><span class="k">Purchases</span><span class="v mono">${dca.length}</span></div>
      <div><span class="k">Total held</span><span class="v mono">${tolas.toFixed(2)} tola</span></div>
      <div><span class="k">Average buy-in</span><span class="v mono">${avg ? npr(avg) : '—'}</span></div>
      <div><span class="k">Today vs. average</span><span class="v mono ${vsToday != null ? cls(vsToday) : ''}">${vsToday != null ? pct(vsToday) : '—'}</span></div>`;
  }

  function bindDca() {
    $('#fDate').value = new Date().toISOString().slice(0, 10);
    $('#fFed').value = fedRange();
    $('#dcaForm').addEventListener('submit', e => {
      e.preventDefault();
      const w = parseFloat($('#fWeight').value), price = parseFloat($('#fPrice').value);
      if (!(w > 0) || !(price > 0) || !$('#fDate').value) return;
      const grams = $('#fUnit').value === 'tola' ? w * TOLA : w;
      dca.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: $('#fDate').value, grams, price, fed: $('#fFed').value.trim() });
      saveDca(); renderDca();
      $('#fWeight').value = ''; $('#fPrice').value = '';
    });
    $('#dcaClear').addEventListener('click', () => {
      if (dca.length && confirm('Delete every purchase in this log? This cannot be undone.')) { dca = []; saveDca(); renderDca(); }
    });
    $('#dcaExport').addEventListener('click', () => {
      const lines = [['date', 'grams', 'tola', 'price_npr', 'npr_per_tola', 'fed_rate']]
        .concat(dca.map(r => [r.date, r.grams.toFixed(3), (r.grams / TOLA).toFixed(4), r.price, Math.round(r.price / (r.grams / TOLA)), `"${(r.fed || '').replace(/"/g, '""')}"`]));
      const blob = new Blob([lines.map(l => l.join(',')).join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'silver-dca-log.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  /* ================================================================ checklist */
  const CHECKS = [
    ['Check the FENEGOSIDA daily rate', 'Confirm the morning rate (fenegosida.org or this site\'s Silver tab) before visiting any dealer.'],
    ['Know the FOMC date and time', 'Announcements land around 11:45 PM–12:45 AM Nepal time; the local rate reacts the next morning.'],
    ['Don\'t panic-buy the day before', 'Pre-meeting moves are noisy. Waiting one day for the post-decision rate costs little.'],
    ['Split into tranches', 'Divide this month\'s budget into 2–3 parts, e.g. before, after, and two weeks after the meeting.'],
    ['Compare with your average buy-in', 'Use the log above: buying below your average lowers your break-even.'],
    ['Check USD/NPR direction', 'A weakening rupee can keep local prices high even when spot silver dips.'],
    ['Ask for the making charge and buyback rate', 'Bars and coins usually carry lower making charges than jewellery. Know the round-trip cost.'],
    ['Get a proper bill and check purity', 'Insist on a stamped bill with weight and fineness (e.g. 999 / 99.9%).'],
  ];
  let checks = store.get('fed.checklist', {});

  function renderChecklist() {
    $('#checklist').innerHTML = CHECKS.map(([t, d], i) => `
      <li><label><input type="checkbox" data-i="${i}" ${checks[i] ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label></li>`).join('');
    $$('#checklist input').forEach(c => c.addEventListener('change', () => { checks[c.dataset.i] = c.checked; store.set('fed.checklist', checks); updateChecks(); }));
    updateChecks();
  }
  function updateChecks() {
    const done = CHECKS.filter((_, i) => checks[i]).length;
    $('#checkBar').style.width = (done / CHECKS.length * 100) + '%';
    $('#checkStatus').textContent = done === CHECKS.length ? 'All set. You\'re buying with a plan, not on a headline.' : `${done} of ${CHECKS.length} done.`;
  }

  /* ================================================================ theme */
  function bindTheme() {
    $('#themeBtn').addEventListener('click', () => {
      const root = document.documentElement;
      const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : sysDark;
      root.dataset.theme = isDark ? 'light' : 'dark';
      try { localStorage.setItem('fed.theme', root.dataset.theme); } catch (_) {}
      renderChart();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!document.documentElement.dataset.theme) renderChart(); });
  }

  /* ================================================================ boot */
  async function boot() {
    bindTheme();
    await loadLive();
    intlQuarterly();
    renderHeader();
    renderChain();
    renderScenarioButtons();
    bindSim();
    resetInputs();
    renderLessons();
    bindChart();
    renderChart();
    bindDca();
    renderDca();
    renderChecklist();
    $('#dataStamp').textContent = live.fromFile
      ? `Live data: FENEGOSIDA rate for ${live.date}; spot and USD/NPR fetched ${live.fetchedAt ? new Date(live.fetchedAt).toLocaleString() : ''}. Fed range (${fedRange()}) is set manually in the page config.`
      : 'Live data files could not be loaded, so built-in sample values are shown.';
  }
  boot();
})();
