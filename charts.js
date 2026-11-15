/* Tracker: shared chart kit. Every function returns an HTML/SVG string coloured by the theme variables. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A) return;
  const { esc, fmtNum } = A;

  /* ---------- statistics ---------- */
  const nums = a => a.filter(v => v != null && isFinite(v));
  const sum = a => a.reduce((x, y) => x + y, 0);
  const mean = a => a.length ? sum(a) / a.length : null;
  const quantile = (a, q) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return s[lo] + (s[hi] - s[lo]) * (p - lo);
  };
  const median = a => quantile(a, .5);
  const stdev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  // Trailing average over up to n values; gaps (null) are skipped, and a point needs at least half a window of data.
  function movingAvg(vals, n) {
    return vals.map((_, i) => {
      const w = nums(vals.slice(Math.max(0, i - n + 1), i + 1));
      return w.length >= Math.min(i + 1, Math.ceil(n / 2)) && w.length ? mean(w) : null;
    });
  }
  function pearson(xs, ys) {
    const n = xs.length; if (n < 3) return null;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function linreg(xs, ys) {
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    if (!sxx) return null;
    const b = sxy / sxx; return { a: my - b * mx, b };
  }
  // Plain words for a correlation, so nobody has to read r.
  function strength(r) {
    if (r == null) return "no clear link";
    const a = Math.abs(r);
    return a < .1 ? "no clear link" : `${a < .3 ? "a weak" : a < .5 ? "a moderate" : "a strong"} ${r > 0 ? "positive" : "negative"} link`;
  }

  /* ---------- shared bits ---------- */
  const COL = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)"];
  const col = i => COL[Math.min(i, COL.length - 1)];
  const none = msg => `<p class="sub cx-none">${esc(msg || "Not enough data yet.")}</p>`;
  const num = v => fmtNum(Math.round(v));
  const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
  const legend = items => `<div class="legend cx-leg">${items.map(([name, i, note]) => `<span style="--lc:${col(i)}">${esc(name)}${note ? ` <b>${esc(note)}</b>` : ""}</span>`).join("")}</div>`;
  // Up to `max` evenly spread indexes out of n, always with the first and last.
  function spread(n, max) {
    if (n <= max) return Array.from({ length: n }, (_, i) => i);
    const out = []; for (let k = 0; k < max; k++) out.push(Math.round(k * (n - 1) / (max - 1)));
    return [...new Set(out)];
  }

  /* ---------- line / area ----------
     series: [{ name, vals: [number|null], c: colour index, area, dash, w, dots }]
     o: { labels, tips, fmt, min, max, zero, h, hlines: [{ v, label }], base } */
  function line(series, o = {}) {
    const n = Math.max(0, ...series.map(s => s.vals.length));
    const all = nums(series.flatMap(s => s.vals)).concat((o.hlines || []).map(h => h.v));
    if (!n || !nums(series.flatMap(s => s.vals)).length) return none(o.empty);
    let lo = o.min != null ? o.min : Math.min(...all), hi = o.max != null ? o.max : Math.max(...all);
    if (o.zero) lo = Math.min(0, lo);
    if (hi === lo) hi = lo + 1;
    const padY = (hi - lo) * .07;
    if (o.min == null && !(o.zero && lo === 0)) lo -= padY;
    if (o.max == null) hi += padY;
    const W = 300, H = o.h || 120, L = 36, R = 6, T = 8, B = 18;
    const x = i => L + (n === 1 ? (W - L - R) / 2 : i / (n - 1) * (W - L - R));
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const f = o.fmt || num;
    let g = "";
    [0, .5, 1].forEach(t => { const v = lo + (hi - lo) * t; g += `<path class="cx-grid" d="M${L} ${y(v).toFixed(1)}H${W - R}"/><text class="cx-t" x="${L - 4}" y="${(y(v) + 2.6).toFixed(1)}" text-anchor="end">${esc(f(v))}</text>`; });
    (o.hlines || []).forEach(h => { g += `<path class="cx-goal" d="M${L} ${y(h.v).toFixed(1)}H${W - R}"/>${h.label ? `<text class="cx-t cx-hl" x="${L + 3}" y="${(y(h.v) - 2.5).toFixed(1)}">${esc(h.label)}</text>` : ""}`; });
    const base = y(o.base != null ? Math.max(lo, Math.min(hi, o.base)) : lo);
    let paths = "";
    series.forEach((s, si) => {
      const c = col(s.c != null ? s.c : si);
      let d = "", area = "", open = false, startX = 0, lastX = 0;
      s.vals.forEach((v, i) => {
        if (v == null || !isFinite(v)) { if (open && s.area) area += `L${lastX.toFixed(1)} ${base.toFixed(1)}L${startX.toFixed(1)} ${base.toFixed(1)}Z`; open = false; return; }
        const px = x(i), py = y(v);
        if (!open) { startX = px; if (s.area) area += `M${px.toFixed(1)} ${py.toFixed(1)}`; }
        else if (s.area) area += `L${px.toFixed(1)} ${py.toFixed(1)}`;
        d += `${open ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
        open = true; lastX = px;
      });
      if (open && s.area) area += `L${lastX.toFixed(1)} ${base.toFixed(1)}L${startX.toFixed(1)} ${base.toFixed(1)}Z`;
      if (s.area) paths += `<path d="${area}" style="fill:${c};fill-opacity:.16"/>`;
      paths += `<path class="cx-line${s.dash ? " dash" : ""}" d="${d}" style="stroke:${c};stroke-width:${s.w || 1.6};${s.faint ? "stroke-opacity:.35" : ""}"/>`;
      if (s.dots || n === 1 || s.vals.filter(v => v != null).length === 1) s.vals.forEach((v, i) => { if (v != null) paths += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8" style="fill:${c}"/>`; });
    });
    let xl = "";
    if (o.labels) spread(n, o.ticks || 5).forEach((i, k, arr) => { xl += `<text class="cx-t" x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="${n === 1 ? "middle" : k === 0 ? "start" : k === arr.length - 1 ? "end" : "middle"}">${esc(o.labels[i] || "")}</text>`; });
    let hov = "";
    if (n <= 400) {
      const bw = n === 1 ? W - L - R : (W - L - R) / (n - 1);
      for (let i = 0; i < n; i++) {
        const parts = series.filter(s => s.name && s.vals[i] != null).map(s => `${s.name}: ${(s.fmt || f)(s.vals[i])}`);
        if (!parts.length) continue;
        hov += `<rect class="cx-hit" x="${(x(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"><title>${esc(((o.tips && o.tips[i]) || (o.labels && o.labels[i]) || "") + "\n" + parts.join("\n"))}</title></rect>`;
      }
    }
    const named = series.filter(s => s.name);
    return `${named.length > 1 || o.legend ? legend(named.map(s => [s.name, s.c != null ? s.c : series.indexOf(s)])) : ""}<svg class="cx" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "Line chart")}">${g}${paths}${xl}${hov}</svg>`;
  }

  /* ---------- scatter with a trend line ----------
     points: [{ x, y, t }]; o: { xFmt, yFmt, xLabel, yLabel, min } */
  function scatter(points, o = {}) {
    const pts = points.filter(p => p.x != null && p.y != null && isFinite(p.x) && isFinite(p.y));
    if (pts.length < (o.min || 10)) return none(`Needs at least ${o.min || 10} ${o.unit || "days"} with both numbers (${pts.length} so far).`);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 === x0) x1 = x0 + 1; if (y1 === y0) y1 = y0 + 1;
    // A little air around the dots, without pushing an axis below zero when nothing is negative.
    const px = (x1 - x0) * .05, py = (y1 - y0) * .08, xPos = x0 >= 0, yPos = y0 >= 0;
    x0 -= px; x1 += px; y0 -= py; y1 += py;
    if (xPos) x0 = Math.max(0, x0); if (yPos) y0 = Math.max(0, y0);
    const W = 300, H = 170, L = 36, R = 8, T = 8, B = 28;
    const X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const xf = o.xFmt || num, yf = o.yFmt || num;
    let g = "";
    [0, .5, 1].forEach(t => {
      const yv = y0 + (y1 - y0) * t, xv = x0 + (x1 - x0) * t;
      g += `<path class="cx-grid" d="M${L} ${Y(yv).toFixed(1)}H${W - R}"/><text class="cx-t" x="${L - 4}" y="${(Y(yv) + 2.6).toFixed(1)}" text-anchor="end">${esc(yf(yv))}</text>`;
      g += `<text class="cx-t" x="${X(xv).toFixed(1)}" y="${H - 16}" text-anchor="${t === 0 ? "start" : t === 1 ? "end" : "middle"}">${esc(xf(xv))}</text>`;
    });
    if (o.xLabel) g += `<text class="cx-t cx-ax" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">${esc(o.xLabel)}</text>`;
    const r = pearson(xs, ys), reg = linreg(xs, ys);
    let trend = "";
    if (reg) {
      // Clip the trend line to the plot area.
      const cl = v => Math.max(y0, Math.min(y1, v));
      trend = `<path class="cx-trend" d="M${X(x0).toFixed(1)} ${Y(cl(reg.a + reg.b * x0)).toFixed(1)}L${X(x1).toFixed(1)} ${Y(cl(reg.a + reg.b * x1)).toFixed(1)}"/>`;
    }
    const step = Math.max(1, Math.ceil(pts.length / 1200));
    const dots = pts.filter((_, i) => i % step === 0).map(p => `<circle class="cx-dot" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${pts.length > 300 ? 1.6 : 2.4}"><title>${esc(`${p.t ? p.t + "\n" : ""}${o.xLabel || "x"}: ${xf(p.x)}\n${o.yLabel || "y"}: ${yf(p.y)}`)}</title></circle>`).join("");
    return `<svg class="cx" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${o.yLabel || ""} against ${o.xLabel || ""}`)}">${g}${dots}${trend}</svg>
      <div class="sub cx-cap">${esc(o.yLabel || "")}${o.yLabel ? " (up) against " : ""}${esc((o.xLabel || "").toLowerCase())}${o.xLabel ? " (across). " : ""}${strength(r).replace(/^./, c => c.toUpperCase())}${r != null ? ` (r = ${f2(r)}, ${pts.length} ${o.unit || "days"})` : ""}.</div>`;
  }

  /* ---------- donut ---------- parts: [[label, value, note]]; o: { center, sub, fmt } */
  function donut(parts, o = {}) {
    let rows = parts.filter(p => p[1] > 0).sort((a, b) => o.keep ? 0 : b[1] - a[1]);
    const total = sum(rows.map(p => p[1]));
    if (!total) return none(o.empty || "No data yet.");
    if (rows.length > 5) rows = rows.slice(0, 4).concat([["Other", sum(rows.slice(4).map(p => p[1])), ""]]);
    let acc = 0;
    const segs = rows.map((p, i) => {
      const pct = p[1] / total * 100, gap = rows.length > 1 ? .8 : 0;
      const s = `<circle cx="50" cy="50" r="38" pathLength="100" stroke-dasharray="${Math.max(.1, pct - gap).toFixed(2)} ${(100 - Math.max(.1, pct - gap)).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" style="stroke:${p[0] === "Other" ? "var(--c6)" : col(i)}"><title>${esc(p[0])}: ${esc((o.fmt || num)(p[1]))} (${Math.round(pct)}%)</title></circle>`;
      acc += pct; return s;
    }).join("");
    return `<div class="cx-donut"><svg viewBox="0 0 100 100" role="img" aria-label="${esc(o.label || "Shares")}"><g transform="rotate(-90 50 50)" fill="none" stroke-width="13">${segs}</g>
      ${o.center != null ? `<text x="50" y="${o.sub ? 49 : 54}" text-anchor="middle" class="cx-big">${esc(o.center)}</text>` : ""}${o.sub ? `<text x="50" y="61" text-anchor="middle" class="cx-t">${esc(o.sub)}</text>` : ""}</svg>
      <div class="cx-dl">${rows.map((p, i) => `<span style="--lc:${p[0] === "Other" ? "var(--c6)" : col(i)}"><em>${esc(p[0])}</em><b>${Math.round(p[1] / total * 100)}%</b>${p[2] ? `<small>${esc(p[2])}</small>` : ""}</span>`).join("")}</div></div>`;
  }

  /* ---------- stacked bars ---------- series: [{ name, vals }]; o: { fmt, tips, h, share } */
  function stacked(labels, series, o = {}) {
    const n = labels.length, totals = labels.map((_, i) => sum(series.map(s => s.vals[i] || 0)));
    const max = Math.max(...totals, 0);
    if (!n || !max) return none(o.empty || "No data yet.");
    const W = 300, H = o.h || 110, B = 16, T = 4, bw = W / n, gap = n > 30 ? 1 : n > 14 ? 2 : 5, f = o.fmt || num;
    let bars = "";
    labels.forEach((l, i) => {
      let yb = H - B; const tot = o.share ? totals[i] : max;
      if (!tot) return;
      series.forEach((s, si) => {
        const v = s.vals[i] || 0; if (!v) return;
        const h = v / tot * (H - B - T); yb -= h;
        bars += `<rect x="${(i * bw + gap / 2).toFixed(1)}" y="${yb.toFixed(1)}" width="${Math.max(.6, bw - gap).toFixed(1)}" height="${Math.max(.4, h - .5).toFixed(1)}" rx="${Math.min(2, (bw - gap) / 3).toFixed(1)}" style="fill:${col(s.c != null ? s.c : si)}"><title>${esc(`${(o.tips && o.tips[i]) || l}\n${s.name}: ${f(v)}${totals[i] ? ` (${Math.round(v / totals[i] * 100)}%)` : ""}`)}</title></rect>`;
      });
    });
    const xl = spread(n, o.ticks || 6).map((i, k, arr) => `<text class="cx-t" x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(labels[i])}</text>`).join("");
    return `${legend(series.map((s, si) => [s.name, s.c != null ? s.c : si]))}<svg class="cx" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "Stacked bars")}">${bars}${xl}</svg>`;
  }

  /* ---------- heatmap grid ----------
     vals[r][c]; o: { fmt, max, diverging, show, colEvery, ch, tip(r,c,v), attrs(r,c) } */
  function grid(rows, cols, vals, o = {}) {
    const flat = nums(vals.flat());
    if (!flat.length) return none(o.empty || "No data yet.");
    const max = o.max || Math.max(...flat.map(Math.abs), 1e-9);
    const W = 300, L = o.left || 26, T = 12, cw = (W - L) / cols.length, ch = o.ch || Math.min(cw, 16), gap = cw > 8 ? 1.5 : .8;
    let out = "";
    cols.forEach((c, i) => { if (!o.colEvery || i % o.colEvery === 0) out += `<text class="cx-t" x="${(L + i * cw + cw / 2).toFixed(1)}" y="8" text-anchor="middle">${esc(c)}</text>`; });
    rows.forEach((r, ri) => {
      out += `<text class="cx-t" x="${L - 4}" y="${(T + ri * ch + ch / 2 + 2.6).toFixed(1)}" text-anchor="end">${esc(r)}</text>`;
      cols.forEach((c, ci) => {
        const v = vals[ri][ci], has = v != null && isFinite(v);
        const op = has ? (o.diverging ? Math.min(1, Math.abs(v) / max) : v > 0 ? .14 + .86 * Math.sqrt(Math.min(1, v / max)) : 0) : 0;
        const fill = !has || (!o.diverging && v <= 0) ? "var(--surface2)" : o.diverging && v < 0 ? "var(--c3)" : "var(--c1)";
        const x = L + ci * cw + gap / 2, y = T + ri * ch + gap / 2;
        out += `<rect ${o.attrs ? o.attrs(ri, ci, v) : ""} x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw - gap).toFixed(1)}" height="${(ch - gap).toFixed(1)}" rx="${Math.min(3, cw / 4).toFixed(1)}" style="fill:${fill}${fill === "var(--surface2)" ? "" : `;fill-opacity:${Math.max(.08, op).toFixed(2)}`}"><title>${esc(o.tip ? o.tip(ri, ci, v) : `${r} · ${c}: ${has ? (o.fmt || num)(v) : "no data"}`)}</title></rect>`;
        if (o.show && has) out += `<text class="cx-t cx-cell" x="${(x + (cw - gap) / 2).toFixed(1)}" y="${(y + (ch - gap) / 2 + 2.4).toFixed(1)}" text-anchor="middle">${esc((o.fmt || num)(v))}</text>`;
      });
    });
    return `<svg class="cx" viewBox="0 0 ${W} ${(T + rows.length * ch).toFixed(1)}" role="img" aria-label="${esc(o.label || "Heatmap")}">${out}</svg>`;
  }

  /* ---------- year calendar ---------- get(date) -> null | { o: 0..1, t: title, c: colour index } */
  function calendar(year, get, o = {}) {
    const first = new Date(+year, 0, 1), offset = (first.getDay() + 6) % 7, n = A.daysInYear(+year), weeks = Math.ceil((offset + n) / 7);
    let cells = "", labels = "";
    for (let i = 0; i < n; i++) {
      const k = A.ymd(new Date(+year, 0, 1 + i)), colN = Math.floor((offset + i) / 7), row = (offset + i) % 7, r = get(k);
      cells += `<rect ${o.attrs ? o.attrs(k) : ""} x="${colN * 12}" y="${26 + row * 12}" width="10" height="10" rx="3" style="${r ? `fill:${col(r.c || 0)};fill-opacity:${Math.max(.15, Math.min(1, r.o)).toFixed(2)}` : "fill:var(--surface2)"}"><title>${esc(A.fmt(k, { day: "numeric", month: "short", year: "numeric" }))}${r && r.t ? `: ${esc(r.t)}` : ""}</title></rect>`;
      if (k.endsWith("-01")) labels += `<text x="${colN * 12}" y="16" font-size="16" fill="var(--muted)">${esc(A.parse(k).toLocaleDateString("en-GB", { month: "short" }))}</text>`;
    }
    return `<svg class="heat" viewBox="0 0 ${weeks * 12} 110" role="img" aria-label="${esc(o.label || `Calendar of ${year}`)}">${labels}${cells}</svg>`;
  }

  /* ---------- year strips: several rows of one thin cell per day, on one time axis ---------- */
  function strips(year, rows) {
    const n = A.daysInYear(+year), W = 300, L = 44, cw = (W - L) / n, rh = 14;
    let out = "";
    for (let m = 0; m < 12; m++) { const d = Math.round((new Date(+year, m, 1) - new Date(+year, 0, 1)) / 864e5); out += `<text class="cx-t" x="${(L + d * cw).toFixed(1)}" y="8">${"JFMAMJJASOND"[m]}</text>`; }
    rows.forEach((r, ri) => {
      const y = 12 + ri * (rh + 4);
      out += `<text class="cx-t" x="${L - 4}" y="${y + rh / 2 + 2.6}" text-anchor="end">${esc(r.label)}</text><rect x="${L}" y="${y}" width="${W - L}" height="${rh}" rx="2" style="fill:var(--surface2)"/>`;
      for (let i = 0; i < n; i++) {
        const k = A.ymd(new Date(+year, 0, 1 + i)), v = r.get(k);
        if (!v) continue;
        out += `<rect x="${(L + i * cw).toFixed(2)}" y="${y}" width="${(cw + .05).toFixed(2)}" height="${rh}" style="fill:${col(v.c != null ? v.c : ri)};fill-opacity:${Math.max(.2, Math.min(1, v.o)).toFixed(2)}"><title>${esc(A.fmt(k, { day: "numeric", month: "short" }))}${v.t ? `: ${esc(v.t)}` : ""}</title></rect>`;
      }
    });
    return `<svg class="cx" viewBox="0 0 ${W} ${12 + rows.length * (rh + 4)}" role="img" aria-label="Year at a glance">${out}</svg>`;
  }

  /* ---------- radial bars (a clock, or a compass) ---------- o: { labels, tip(i,v), center, sub } */
  function radial(vals, o = {}) {
    const n = vals.length, max = Math.max(...vals, 0);
    if (!max) return none(o.empty || "No data yet.");
    const cx = 100, cy = 100, r0 = 34, r1 = 82, step = Math.PI * 2 / n, off = o.centered ? 0 : step / 2;
    const pt = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    let out = `<circle cx="${cx}" cy="${cy}" r="${r0 - 3}" class="cx-ring"/><circle cx="${cx}" cy="${cy}" r="${r1 + 2}" class="cx-ring"/>`;
    const peak = vals.indexOf(max);
    vals.forEach((v, i) => {
      const a = -Math.PI / 2 + i * step + off, len = v / max * (r1 - r0);
      const [x1, y1] = pt(a, r0), [x2, y2] = pt(a, r0 + Math.max(len, v ? 1.5 : 0));
      if (v) out += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}" class="cx-rad${i === peak ? " peak" : ""}" style="stroke-width:${Math.min(16, 2 * Math.PI * r0 / n * .72).toFixed(1)}"><title>${esc(o.tip ? o.tip(i, v) : `${i}: ${num(v)}`)}</title></path>`;
    });
    (o.labels || []).forEach((l, i) => { if (!l) return; const a = -Math.PI / 2 + i * step + (o.centered ? 0 : 0), [x, y] = pt(a, r1 + 11); out += `<text class="cx-t" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${esc(l)}</text>`; });
    if (o.center != null) out += `<text x="${cx}" y="${o.sub ? cy : cy + 4}" text-anchor="middle" class="cx-big sm">${esc(o.center)}</text>`;
    if (o.sub) out += `<text x="${cx}" y="${cy + 11}" text-anchor="middle" class="cx-t">${esc(o.sub)}</text>`;
    return `<svg class="cx cx-radial" viewBox="0 0 200 200" role="img" aria-label="${esc(o.label || "Radial chart")}">${out}</svg>`;
  }

  /* ---------- histogram ---------- o: { bins, step, lo, hi, fmt, marks: [{ v, label }], unit } */
  function histogram(values, o = {}) {
    const vs = nums(values);
    if (vs.length < (o.min || 5)) return none(`Needs at least ${o.min || 5} values (${vs.length} so far).`);
    let lo = o.lo != null ? o.lo : Math.min(...vs), hi = o.hi != null ? o.hi : Math.max(...vs);
    let step = o.step;
    if (step) { lo = Math.floor(lo / step) * step; hi = Math.max(lo + step, Math.ceil((hi + 1e-9) / step) * step); }
    else { if (hi === lo) hi = lo + 1; step = (hi - lo) / (o.bins || 12); }
    const nb = Math.max(1, Math.round((hi - lo) / step)), bins = Array(nb).fill(0);
    vs.forEach(v => { bins[Math.max(0, Math.min(nb - 1, Math.floor((v - lo) / step)))]++; });
    const max = Math.max(...bins), W = 300, H = 100, T = 14, B = 16, bw = W / nb, f = o.fmt || num, X = v => (v - lo) / (hi - lo) * W;
    let out = "";
    bins.forEach((c, i) => {
      const h = c / max * (H - T - B);
      out += `<rect class="cx-bar${c === max ? " peak" : ""}" x="${(i * bw + 1).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${Math.max(.6, bw - 2).toFixed(1)}" height="${Math.max(c ? 1 : 0, h).toFixed(1)}" rx="${Math.min(3, bw / 4).toFixed(1)}"><title>${esc(`${f(lo + i * step)} to ${f(lo + (i + 1) * step)}: ${c} ${o.unit || "days"}`)}</title></rect>`;
    });
    (o.marks || []).forEach((m, i) => {
      if (m.v == null || m.v < lo || m.v > hi) return;
      const x = X(m.v);
      out += `<path class="${i ? "cx-goal" : "cx-mark"}" d="M${x.toFixed(1)} ${T - 2}V${H - B}"/><text class="cx-t" x="${x.toFixed(1)}" y="${i ? 14 : 7}" text-anchor="${x > W - 50 ? "end" : x < 50 ? "start" : "middle"}">${esc(m.label)}</text>`;
    });
    [0, .5, 1].forEach(t => { out += `<text class="cx-t" x="${(t * W).toFixed(1)}" y="${H - 4}" text-anchor="${t === 0 ? "start" : t === 1 ? "end" : "middle"}">${esc(f(lo + (hi - lo) * t))}</text>`; });
    return `<svg class="cx" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "Distribution")}">${out}</svg>`;
  }

  /* ---------- range rows: min to max, the middle half, and the median ---------- rows: [{ label, vals }] */
  function range(rows, o = {}) {
    const all = nums(rows.flatMap(r => r.vals));
    if (!all.length) return none(o.empty);
    const lo = o.lo != null ? o.lo : Math.min(...all), hi = Math.max(o.hi != null ? o.hi : Math.max(...all), lo + 1e-9), f = o.fmt || num;
    const P = v => ((v - lo) / (hi - lo) * 100).toFixed(1);
    return `<div class="cx-range">${rows.map(r => {
      const v = nums(r.vals);
      if (!v.length) return `<div class="cx-rr"><small>${esc(r.label)}</small><span class="trk"></span><b>–</b></div>`;
      const mn = Math.min(...v), mx = Math.max(...v), q1 = quantile(v, .25), q3 = quantile(v, .75), md = median(v);
      return `<div class="cx-rr" title="${esc(`${r.label}: ${f(mn)} to ${f(mx)}, median ${f(md)} (${v.length} days)`)}"><small>${esc(r.label)}</small><span class="trk"><i class="w" style="left:${P(mn)}%;width:${(P(mx) - P(mn)).toFixed(1)}%"></i><i class="q" style="left:${P(q1)}%;width:${Math.max(1, P(q3) - P(q1)).toFixed(1)}%"></i><i class="m" style="left:${P(md)}%"></i>${o.goal != null ? `<i class="g" style="left:${P(Math.max(lo, Math.min(hi, o.goal)))}%"></i>` : ""}</span><b>${esc(f(md))}</b></div>`;
    }).join("")}</div><div class="chart-foot"><span>${esc(f(lo))}</span><span>thin line: lowest to highest · thick: middle half · dot: median</span><span>${esc(f(hi))}</span></div>`;
  }

  /* ---------- slope: rank in one period against rank in another ---------- rows: [{ label, a, b }] (values; null = absent) */
  function slope(rows, o = {}) {
    const rank = key => { const m = new Map(); rows.filter(r => r[key] != null).sort((x, y) => y[key] - x[key]).forEach((r, i) => m.set(r, i)); return m; };
    const ra = rank("a"), rb = rank("b"), n = Math.max(ra.size, rb.size);
    if (!n) return none(o.empty);
    const W = 300, rh = 15, T = 16, H = T + n * rh + 4, xa = 112, xb = 188, f = o.fmt || num, y = i => T + i * rh + rh / 2;
    const cut = s => s.length > 17 ? s.slice(0, 16) + "…" : s;
    let out = `<text class="cx-t cx-ax" x="${xa}" y="9" text-anchor="end">${esc(o.la || "")}</text><text class="cx-t cx-ax" x="${xb}" y="9">${esc(o.lb || "")}</text>`;
    rows.forEach(r => {
      const ia = ra.get(r), ib = rb.get(r), up = ia != null && ib != null && ib < ia;
      if (ia != null) out += `<text class="cx-t cx-nm" x="${xa - 6}" y="${y(ia) + 2.6}" text-anchor="end">${esc(cut(r.label))}</text><circle cx="${xa}" cy="${y(ia)}" r="2.2" class="cx-sd"/>`;
      if (ib != null) out += `<text class="cx-t cx-nm" x="${xb + 6}" y="${y(ib) + 2.6}">${esc(cut(r.label))}</text><circle cx="${xb}" cy="${y(ib)}" r="2.2" class="cx-sd"/>`;
      if (ia != null && ib != null) out += `<path class="cx-sl${up ? " up" : ib > ia ? " down" : ""}" d="M${xa} ${y(ia)}L${xb} ${y(ib)}"><title>${esc(`${r.label}: ${f(r.a)} → ${f(r.b)}`)}</title></path>`;
    });
    return `<svg class="cx" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "Change in rank")}">${out}</svg>`;
  }

  /* ---------- sparkline ---------- */
  function spark(vals) {
    const v = nums(vals); if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v) === lo ? lo + 1 : Math.max(...v), n = vals.length;
    let d = "", open = false;
    vals.forEach((x, i) => { if (x == null) { open = false; return; } d += `${open ? "L" : "M"}${(i / (n - 1) * 60).toFixed(1)} ${(15 - (x - lo) / (hi - lo) * 13).toFixed(1)}`; open = true; });
    return `<svg class="cx-spark" viewBox="0 0 60 16" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  /* ---------- group comparison: one bar per group ---------- groups: [{ label, v, n }] */
  function paired(groups, o = {}) {
    const g = groups.filter(x => x.v != null && x.n >= (o.min || 3));
    if (g.length < 2) return none(`Needs at least ${o.min || 3} days in each group (${groups.map(x => `${x.label.toLowerCase()}: ${x.n || 0}`).join(", ")}).`);
    const max = Math.max(...g.map(x => x.v), 1e-9), f = o.fmt || num;
    return `<div class="cx-pair">${g.map((x, i) => `<div class="cx-pr"><small>${esc(x.label)}</small><span class="trk"><i style="width:${Math.max(1.5, x.v / max * 100).toFixed(1)}%;background:${col(x.c != null ? x.c : i)};animation-delay:${i * 60}ms"></i></span><b>${esc(f(x.v))}</b><em>${fmtNum(x.n)} ${o.unit || "days"}</em></div>`).join("")}</div>`;
  }
  // "12% more" / "8% less" between two group means.
  function diff(a, b) {
    if (a == null || b == null || !b) return "";
    const p = Math.round((a - b) / Math.abs(b) * 100);
    return p === 0 ? "about the same" : `${Math.abs(p)}% ${p > 0 ? "more" : "less"}`;
  }

  A.Charts = {
    nums, sum, mean, median, quantile, stdev, movingAvg, pearson, linreg, strength, diff, none, legend, col, spread,
    line, scatter, donut, stacked, grid, calendar, strips, radial, histogram, range, slope, spark, paired, f1, f2
  };
})();
