/* Tiny dependency-free SVG charts: line (with touch scrubbing), sparkline, bars, ring. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const ro = 'ResizeObserver' in window ? new ResizeObserver(entries => {
    for (const e of entries) if (e.target._chart) e.target._chart();
  }) : null;

  function h(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e7) return (v / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
    if (a >= 1e5) return (v / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(v * 100) / 100);
  }

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateTick(t, spanDays) {
    const d = new Date(t);
    if (spanDays > 400) return MON[d.getMonth()] + " '" + String(d.getFullYear()).slice(2);
    if (spanDays > 60) return MON[d.getMonth()];
    return d.getDate() + ' ' + MON[d.getMonth()];
  }

  /**
   * line(el, opts)
   *  opts.series: [{ data: [[t, y], ...], color, fill?: bool, width?, dash? }]
   *  opts.markers: [{ t, y, color, r? }]
   *  opts.refLines: [{ y, color, label }]
   *  opts.onScrub(pointsPerSeries | null)
   */
  function line(el, opts) {
    el._chart = () => drawLine(el, opts);
    if (ro && !el._observed) { ro.observe(el); el._observed = true; }
    drawLine(el, opts);
  }

  function drawLine(el, opts) {
    const W = el.clientWidth || 320, H = el.clientHeight || 200;
    const series = (opts.series || []).filter(s => s.data && s.data.length);
    el.innerHTML = '';
    if (!series.length || series[0].data.length < 2) {
      el.innerHTML = `<div class="chart-empty">${opts.empty || 'Not enough data yet'}</div>`;
      return;
    }
    const padL = 4, padR = opts.yAxis === false ? 4 : 44, padT = 10, padB = opts.xAxis === false ? 4 : 22;
    let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of series) for (const [t, y] of s.data) {
      if (t < tMin) tMin = t; if (t > tMax) tMax = t;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    for (const m of opts.markers || []) { if (m.y < yMin) yMin = m.y; if (m.y > yMax) yMax = m.y; }
    for (const r of opts.refLines || []) { if (r.y < yMin) yMin = r.y; if (r.y > yMax) yMax = r.y; }
    const padY = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.02 || 1;
    yMin -= padY; yMax += padY;
    const ticks = niceTicks(yMin, yMax, 4).filter(v => v >= yMin && v <= yMax);
    const x = t => padL + (t - tMin) / ((tMax - tMin) || 1) * (W - padL - padR);
    const y = v => padT + (1 - (v - yMin) / ((yMax - yMin) || 1)) * (H - padT - padB);

    const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, el);
    const defs = h('defs', {}, svg);

    if (opts.yAxis !== false) {
      const ax = h('g', { class: 'axis' }, svg);
      for (const v of ticks) {
        h('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, ax);
        const tx = h('text', { x: W - padR + 6, y: y(v) + 3.5 }, ax);
        tx.textContent = (opts.yTick || compact)(v);
      }
    }
    if (opts.xAxis !== false) {
      const ax = h('g', { class: 'axis' }, svg);
      const spanDays = (tMax - tMin) / 864e5;
      const n = Math.max(2, Math.min(5, Math.floor(W / 90)));
      for (let i = 0; i < n; i++) {
        const t = tMin + (tMax - tMin) * (i / (n - 1));
        const tx = h('text', { x: x(t), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, ax);
        tx.textContent = dateTick(t, spanDays);
      }
    }
    for (const r of opts.refLines || []) {
      h('line', { x1: padL, x2: W - padR, y1: y(r.y), y2: y(r.y), stroke: r.color, 'stroke-width': 1.2, 'stroke-dasharray': '4 4', opacity: .8 }, svg);
      if (r.label) {
        const tx = h('text', { x: padL + 4, y: y(r.y) - 5, fill: r.color, 'font-size': 10.5, 'font-weight': 600 }, svg);
        tx.textContent = r.label;
      }
    }

    series.forEach((s, i) => {
      const d = s.data.map(([t, v], j) => (j ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
      if (s.fill) {
        const id = 'g' + Math.random().toString(36).slice(2);
        const lg = h('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        h('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': .16 }, lg);
        h('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, lg);
        const last = s.data[s.data.length - 1], first = s.data[0];
        h('path', { d: d + `L${x(last[0])} ${H - padB}L${x(first[0])} ${H - padB}Z`, fill: `url(#${id})` }, svg);
      }
      h('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'stroke-dasharray': s.dash || '', 'vector-effect': 'non-scaling-stroke',
      }, svg);
    });

    for (const m of opts.markers || []) {
      h('circle', { cx: x(m.t), cy: y(m.y), r: m.r || 4.5, fill: m.color, stroke: 'var(--card)', 'stroke-width': 2 }, svg);
    }

    // Endpoint dot for the primary series
    const p0 = series[0].data[series[0].data.length - 1];
    h('circle', { cx: x(p0[0]), cy: y(p0[1]), r: 4, fill: series[0].color, stroke: 'var(--card)', 'stroke-width': 2 }, svg);

    // Scrubbing
    const cursor = h('line', { class: 'cursor', y1: padT, y2: H - padB, x1: -10, x2: -10, opacity: 0 }, svg);
    const dots = series.map(s => h('circle', { r: 5, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2.5, opacity: 0 }, svg));

    function nearest(data, t) {
      let lo = 0, hi = data.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (data[mid][0] < t) lo = mid; else hi = mid; }
      return Math.abs(data[lo][0] - t) < Math.abs(data[hi][0] - t) ? data[lo] : data[hi];
    }
    function move(clientX) {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) / r.width * W;
      const t = tMin + (px - padL) / (W - padL - padR) * (tMax - tMin);
      const pts = series.map(s => nearest(s.data, t));
      const cx = x(pts[0][0]);
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('opacity', 1);
      pts.forEach((p, i) => {
        dots[i].setAttribute('cx', x(p[0])); dots[i].setAttribute('cy', y(p[1])); dots[i].setAttribute('opacity', 1);
      });
      opts.onScrub && opts.onScrub(pts);
    }
    function end() {
      cursor.setAttribute('opacity', 0);
      dots.forEach(d => d.setAttribute('opacity', 0));
      opts.onScrub && opts.onScrub(null);
    }
    let active = false, startX = 0, startY = 0, decided = false;
    svg.addEventListener('pointerdown', e => {
      active = true; decided = e.pointerType !== 'touch'; startX = e.clientX; startY = e.clientY;
      if (decided) move(e.clientX);
    });
    svg.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' && !active) { move(e.clientX); return; }
      if (!active) return;
      if (!decided) {
        const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
        if (dx < 6 && dy < 6) return;
        if (dy > dx) { active = false; return; } // vertical scroll wins
        decided = true;
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      }
      move(e.clientX);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => svg.addEventListener(ev, () => { if (active || ev === 'pointerleave') end(); active = false; }));
    // Long-press friendly on touch: tap shows point briefly
    svg.addEventListener('click', e => { move(e.clientX); clearTimeout(svg._t); svg._t = setTimeout(end, 1800); });
  }

  function spark(el, data, color) {
    el._chart = () => spark(el, data, color);
    if (ro && !el._observed) { ro.observe(el); el._observed = true; }
    const W = el.clientWidth || 120, H = el.clientHeight || 40;
    el.innerHTML = '';
    if (!data || data.length < 2) return;
    let min = Infinity, max = -Infinity;
    for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
    const pad = (max - min) * 0.1 || 1;
    min -= pad; max += pad;
    const x = i => (i / (data.length - 1)) * W;
    const y = v => (1 - (v - min) / (max - min)) * H;
    const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', width: '100%', height: '100%' }, el);
    const id = 's' + Math.random().toString(36).slice(2);
    const lg = h('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, h('defs', {}, svg));
    h('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .14 }, lg);
    h('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }, lg);
    const d = data.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
    h('path', { d: d + `L${W} ${H}L0 ${H}Z`, fill: `url(#${id})` }, svg);
    h('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }, svg);
  }

  /** bars(el, [{label, value, color}], {fmt}) — vertical bars with labels underneath */
  function bars(el, items, o = {}) {
    el._chart = () => bars(el, items, o);
    if (ro && !el._observed) { ro.observe(el); el._observed = true; }
    const W = el.clientWidth || 320, H = el.clientHeight || 160;
    el.innerHTML = '';
    if (!items.length) { el.innerHTML = `<div class="chart-empty">${o.empty || 'No data yet'}</div>`; return; }
    const padB = 20, padT = 16;
    const max = Math.max(...items.map(i => i.value), 1);
    const svg = h('svg', { viewBox: `0 0 ${W} ${H}` }, el);
    const bw = Math.min(34, (W / items.length) * 0.62);
    const step = W / items.length;
    items.forEach((it, i) => {
      const bh = Math.max(2, (it.value / max) * (H - padB - padT));
      const cx = step * i + step / 2;
      h('rect', { x: cx - bw / 2, y: H - padB - bh, width: bw, height: bh, rx: Math.min(6, bw / 3), fill: it.color }, svg);
      const lab = h('text', { x: cx, y: H - 5, 'text-anchor': 'middle', fill: 'var(--text-3)', 'font-size': 10.5 }, svg);
      lab.textContent = it.label;
      if (o.showValues !== false && items.length <= 12) {
        const v = h('text', { x: cx, y: H - padB - bh - 4, 'text-anchor': 'middle', fill: 'var(--text-2)', 'font-size': 10, 'font-weight': 600 }, svg);
        v.textContent = (o.fmt || compact)(it.value);
      }
    });
  }

  /** ring(el, parts[{value,color}], {label, sub}) — donut */
  function ring(parts, o = {}) {
    const size = o.size || 120, sw = o.stroke || 12, r = (size - sw) / 2, c = 2 * Math.PI * r;
    const total = parts.reduce((a, p) => a + p.value, 0);
    let off = 0;
    let segs = '';
    if (total > 0) {
      for (const p of parts) {
        const len = (p.value / total) * c;
        const gap = parts.filter(q => q.value > 0).length > 1 ? 2 : 0;
        segs += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${p.color}" stroke-width="${sw}" fill="none"
          stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-off}" stroke-linecap="butt"
          transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
        off += len;
      }
    }
    return `<svg class="ring" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">
      <circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}"/>
      ${segs}
      ${o.label ? `<text x="50%" y="${o.sub ? '47%' : '53%'}" text-anchor="middle" font-size="${o.labelSize || 20}" font-weight="700" fill="var(--text)">${o.label}</text>` : ''}
      ${o.sub ? `<text x="50%" y="63%" text-anchor="middle" font-size="11" fill="var(--text-2)">${o.sub}</text>` : ''}
    </svg>`;
  }

  window.Charts = { line, spark, bars, ring, compact };
})();
