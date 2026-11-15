/* Tracker: Flights tab. Log or import flights, see distance, time in the air, a map and lots of statistics. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A) return;
  const { $, esc, pad, today, fmt, fmtNum, LS, toast, openSheet, closeSheet, paint, barsHtml, HOOKS, EXTRA, VIEWS } = A;

  const KEY = "stillday.flights";
  const st = { year: "all", reason: "all", armed: null };
  const CLASSES = ["Economy", "Premium economy", "Business", "First", "Private"];
  const REASONS = ["Leisure", "Business", "Crew", "Other"];
  const SEATS = ["Window", "Middle", "Aisle"];
  const EARTH_KM = 40075, MOON_KM = 384400;

  const AP = new Map((window.STILLDAY_AIRPORTS || []).map(r => [r[0], { code: r[0], city: r[1], cc: r[2], lat: r[3], lon: r[4] }]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- store ---------- */
  function clean(f) {
    if (!f || typeof f !== "object") return null;
    const s = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
    const num = (v, max) => (typeof v === "number" && isFinite(v) && v >= 0 && v <= max) ? v : null;
    const time = v => /^\d{2}:\d{2}$/.test(s(v, 5)) ? s(v, 5) : "";
    const from = s(f.from, 3).toUpperCase(), to = s(f.to, 3).toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !/^[A-Z0-9]{3}$/.test(from) || !/^[A-Z0-9]{3}$/.test(to)) return null;
    const rec = {
      id: s(f.id, 60) || uid(), date: f.date, from, to, airline: s(f.airline, 60), number: s(f.number, 12).toUpperCase(),
      aircraft: s(f.aircraft, 50), reg: s(f.reg, 12).toUpperCase(), cls: CLASSES.includes(f.cls) ? f.cls : "",
      reason: REASONS.includes(f.reason) ? f.reason : "", seat: s(f.seat, 6).toUpperCase(), seatType: SEATS.includes(f.seatType) ? f.seatType : "",
      dep: time(f.dep), arr: time(f.arr), fromCity: s(f.fromCity, 40), toCity: s(f.toCity, 40),
      durationMin: num(f.durationMin, 1500), distanceKm: num(f.distanceKm, 20000), notes: s(f.notes, 200),
      // A flight without a time (from an old file) counts as the oldest copy, so it never overwrites a real change.
      updatedAt: typeof f.updatedAt === "string" && f.updatedAt ? f.updatedAt : "1970-01-01T00:00:00.000Z"
    };
    Object.keys(rec).forEach(k => { if (rec[k] === null || rec[k] === "") delete rec[k]; });
    return rec;
  }
  let F = [];
  try { F = (JSON.parse(LS.get(KEY) || "[]") || []).map(clean).filter(Boolean); } catch (e) { F = []; }
  // Flights you deleted, with when, so your other devices delete them too.
  const GKEY = "stillday.flights.gone";
  let G = {};
  try { G = JSON.parse(LS.get(GKEY) || "{}") || {}; } catch (e) { G = {}; }
  const persist = ids => {
    const ok = LS.set(KEY, JSON.stringify(F)) && LS.set(GKEY, JSON.stringify(G));
    if (ids && A.Outbox) A.Outbox.add("flights", ids);
    A.changed(); return ok;
  };

  /* ---------- maths ---------- */
  const rad = x => x * Math.PI / 180;
  function haversine(a, b) {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  function calc(f) {
    const a = AP.get(f.from), b = AP.get(f.to);
    // Same airfield both ways (a sightseeing or training flight) counts as a local flight with no distance.
    const km = f.distanceKm != null ? f.distanceKm : f.from === f.to ? 0 : (a && b ? Math.round(haversine(a, b)) : null);
    let min = f.durationMin != null ? f.durationMin : null, est = false;
    if (min == null && km != null) { min = Math.round(km / 820 * 60 + 30); est = true; }
    return { a, b, km, min, est };
  }
  // Compass bearing at take-off, in degrees from north.
  function bearing(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
    return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  }
  // Home is the airport you pass through most.
  function homeCode() {
    const m = new Map(); let best = null;
    F.forEach(f => [f.from, f.to].forEach(c => m.set(c, (m.get(c) || 0) + 1)));
    m.forEach((n, c) => { if (!best || n > m.get(best)) best = c; });
    return best;
  }
  /* Flights paired into trips: away from home until a flight lands back there.
     `open` marks a trip whose way home wasn't logged, so its length is a guess. */
  function trips() {
    const t = today(), home = homeCode(), out = [];
    if (!home) return out;
    const gap = (a, b) => Math.round((A.parse(b) - A.parse(a)) / 864e5);
    const fl = F.filter(f => f.date <= t && f.from !== f.to).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (x.dep || "") < (y.dep || "") ? -1 : 1);
    let cur = null;
    const close = (end, open) => {
      cur.end = end; cur.open = !!open; cur.days = gap(cur.start, end) + 1;
      cur.km = cur.flights.reduce((n, f) => n + (calc(f).km || 0), 0);
      const h = AP.get(home);
      // The destination is the stop furthest from home.
      cur.dest = cur.flights.map(f => f.to).filter(c => c !== home).reduce((b, c) => { const p = AP.get(c); if (!b) return c; const q = AP.get(b); return h && p && q && haversine(h, p) > haversine(h, q) ? c : b; }, null) || cur.flights[0].to;
      out.push(cur); cur = null;
    };
    fl.forEach(f => {
      if (cur && gap(cur.last, f.date) > 120) close(cur.last, true);
      if (!cur) { if (f.to === home) return; cur = { start: f.date, last: f.date, flights: [] }; }
      cur.flights.push(f); cur.last = f.date;
      if (f.to === home) close(f.date);
    });
    if (cur) { if (gap(cur.last, t) <= 45) close(t, true); else close(cur.last, true); }
    return out;
  }
  const hm = m => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  const flag = cc => /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0))) : "";
  const place = (code, f) => { const p = AP.get(code); return p ? p.city : (f && (code === f.from ? f.fromCity : f.toCity)) || code; };
  const daysUntil = d => Math.round((A.parse(d) - A.parse(today())) / 864e5);
  const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? "" : "s"}`;

  /* ---------- world map (land outline loaded once, drawn as plain SVG) ---------- */
  let landPath = null, landState = "idle";
  function decodeLand(topo) {
    const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
    const arcs = topo.arcs.map(a => { let x = 0, y = 0; return a.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
    const arcPts = i => i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
    const ring = idxs => { let pts = []; idxs.forEach(i => { const p = arcPts(i); pts = pts.concat(pts.length ? p.slice(1) : p); }); return pts; };
    const obj = topo.objects.land, geoms = obj.geometries || [obj];
    let d = "";
    // Outlines that cross the 180° meridian (Russia, Fiji) are unwrapped so they stay in one piece,
    // then drawn again shifted by a full turn so they re-enter on the other edge.
    const draw = poly => poly.forEach(r => {
      const pts = ring(r), xs = [], ys = [];
      let off = 0, prev = null;
      pts.forEach(p => {
        let x = p[0] + 180 + off;
        if (prev !== null) {
          if (x - prev > 180) { off -= 360; x -= 360; } else if (prev - x > 180) { off += 360; x += 360; }
        }
        prev = x; xs.push(x); ys.push(90 - p[1]);
      });
      const mk = dx => xs.map((x, i) => `${i ? "L" : "M"}${(x + dx).toFixed(1)} ${ys[i].toFixed(1)}`).join("") + "Z";
      const lo = Math.min(...xs), hi = Math.max(...xs);
      d += mk(0);
      if (lo < 0) d += mk(360);
      if (hi > 360) d += mk(-360);
    });
    geoms.forEach(g => { if (g.type === "Polygon") draw(g.arcs); else if (g.type === "MultiPolygon") g.arcs.forEach(draw); });
    return d;
  }
  function ensureLand() {
    if (landState !== "idle") return;
    landState = "loading";
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json")
      .then(r => r.json())
      .then(t => { landPath = decodeLand(t); landState = "done"; const g = $("#landG"); if (g) g.innerHTML = `<path class="land" d="${landPath}"/>`; })
      .catch(() => { landState = "failed"; });
  }

  const proj = p => [p.lon + 180, 90 - p.lat];
  function arcs(list) {
    let out = "";
    const dots = new Map(), seen = new Set();
    list.forEach((f, i) => {
      const a = AP.get(f.from), b = AP.get(f.to);
      if (!a || !b || a === b) return;
      dots.set(f.from, (dots.get(f.from) || 0) + 1); dots.set(f.to, (dots.get(f.to) || 0) + 1);
      const rk = [f.from, f.to].sort().join("");
      if (seen.has(rk)) return; // draw each route once; the dots grow with visits instead
      seen.add(rk);
      const [x1, y1] = proj(a); let [x2, y2] = proj(b);
      if (x2 - x1 > 180) x2 -= 360; else if (x1 - x2 > 180) x2 += 360;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; if (ny > 0) { nx = -nx; ny = -ny; }
      const bend = Math.min(36, len * 0.22), cx = mx + nx * bend, cy = my + ny * bend;
      const d = `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      const wrapped = Math.min(x1, x2, cx) < 0 || Math.max(x1, x2, cx) > 360;
      const path = `<path class="arc" pathLength="1" d="${d}" style="animation-delay:${Math.min(seen.size, 40) * 50}ms"/>`;
      out += wrapped ? `<g transform="translate(-360 0)">${path}</g><g transform="translate(360 0)">${path}</g>${path}` : path;
    });
    const maxV = Math.max(1, ...dots.values());
    const pts = [...dots].map(([c, n]) => { const [x, y] = proj(AP.get(c)); return `<circle class="apt" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1.2 + 1.6 * Math.sqrt(n / maxV)).toFixed(2)}"><title>${esc(c)} · ${esc(place(c))} · ${plural(n, "visit")}</title></circle>`; }).join("");
    return out + pts;
  }
  function mapSvg(list) {
    ensureLand();
    let grat = "";
    for (let x = 0; x <= 360; x += 30) grat += `M${x} 6V150`;
    for (let y = 30; y <= 150; y += 30) grat += `M0 ${y}H360`;
    return `<svg class="map" viewBox="0 6 360 144" role="img" aria-label="Map of your flights"><path class="grat" d="${grat}"/><g id="landG">${landPath ? `<path class="land" d="${landPath}"/>` : ""}</g>${arcs(list)}</svg>`;
  }

  /* ---------- small chart helpers ---------- */
  function topList(map, n, unit) {
    const rows = [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n), max = rows.length ? rows[0][1] : 1;
    return rows.map(([k, v], i) => `<div class="rank"><span class="no">${i + 1}</span><div class="nm"><b>${esc(k)}</b><div class="bar2"><i style="width:${(v / max * 100).toFixed(1)}%;animation-delay:${i * 40}ms"></i></div></div><span class="val">${unit ? unit(v) : `${v}×`}</span></div>`).join("");
  }
  const OPS = [1, .62, .38, .2, .1];
  // One bar split into parts, with a legend underneath.
  function split(parts) {
    const rows = parts.filter(p => p[1] > 0), total = rows.reduce((n, p) => n + p[1], 0);
    if (!total) return `<p class="sub" style="margin-top:8px">No data yet.</p>`;
    return `<div class="split">${rows.map((p, i) => `<i style="flex:${p[1]};--op:${OPS[i] || .1};animation-delay:${i * 80}ms" title="${esc(p[0])}: ${p[1]}"></i>`).join("")}</div>
      <div class="legend">${rows.map((p, i) => `<span style="--op:${OPS[i] || .1}">${esc(p[0])} <b>${Math.round(p[1] / total * 100)}%</b>${p[2] ? ` <small>${esc(p[2])}</small>` : ""}</span>`).join("")}</div>`;
  }
  const kv = (k, v) => v == null || v === "" ? "" : `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  const card = (title, body, sub) => `<section class="section"><div class="card"><span class="label" style="margin:0">${esc(title)}</span>${sub ? `<div class="sub" style="margin-top:2px">${sub}</div>` : ""}${body}</div></section>`;
  const arrow = '<svg width="18" height="12" viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h20M16 2l6 6-6 6"/></svg>';

  function flightCard(c) {
    const f = c.f, soon = f.date > today() ? daysUntil(f.date) : null;
    const tags = [f.reason, f.cls, f.seat ? `Seat ${f.seat}${f.seatType ? ` (${f.seatType.toLowerCase()})` : ""}` : f.seatType].filter(Boolean);
    return `<button class="card flight" data-act="flight-edit" data-id="${esc(f.id)}">
      <div class="row"><b class="route">${esc(f.from)}${arrow}${esc(f.to)}</b><span class="sub">${soon != null ? `<span class="soon">${soon === 0 ? "today" : soon === 1 ? "tomorrow" : `in ${soon} days`}</span>` : f.from === f.to ? "local flight" : c.km != null ? `${fmtNum(c.km)} km` : "distance unknown"}</span></div>
      <div class="sub" style="margin-top:4px">${esc(fmt(f.date, { weekday: "short", day: "numeric", month: "short" }))}${f.dep ? ` · ${esc(f.dep)}` : ""} · ${esc(place(f.from, f))} to ${esc(place(f.to, f))}</div>
      <div class="sub">${[f.airline, f.number, c.min != null ? `${c.est ? "about " : ""}${hm(c.min)}` : "", f.aircraft].filter(Boolean).map(esc).join(" · ")}</div>
      ${tags.length ? `<div class="ftags">${tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    </button>`;
  }

  /* ---------- main view ---------- */
  function viewFlights() {
    const t = today();
    const all = F.slice().sort((x, y) => x.date < y.date ? 1 : x.date > y.date ? -1 : (x.dep || "") < (y.dep || "") ? 1 : -1);
    const hero = `
    <section class="hero">
      <div class="eyebrow">Every trip counts</div>
      <div class="hero-row"><h1>Flights</h1>${A.ILLO.spot("flights", "hero-spot")}</div>
      <div class="hero-meta"><button class="chip accent" data-act="flight-add">+ Add flight</button><button class="chip" data-act="flight-import">Import CSV</button></div>
    </section>`;
    if (!F.length) {
      return hero + `<section class="section"><div class="card empty">${A.ILLO.spot("flights", "empty-spot")}
        <b style="font-size:18px">No flights yet</b>
        <p>Add a flight with its airport codes (like BUD and LHR), or import a CSV export from myFlightradar24. Tracker works out the distance and draws the routes.</p>
        <div class="grid2" style="margin-top:6px"><button class="btn primary" data-act="flight-add">Add a flight</button><button class="btn" data-act="flight-import">Import CSV</button></div>
      </div></section>`;
    }

    const upcoming = all.filter(f => f.date > t).reverse();
    const past = all.filter(f => f.date <= t);
    const years = [...new Set(past.map(f => f.date.slice(0, 4)))];
    const y = st.year !== "all" && years.includes(st.year) ? st.year : "all";
    const hasReason = past.some(f => f.reason);
    const rs = hasReason && st.reason !== "all" ? st.reason : "all";
    const list = past.filter(f => (y === "all" || f.date.startsWith(y)) && (rs === "all" || f.reason === rs));
    const C = list.map(f => Object.assign({ f }, calc(f)));

    const filters = `
    <div class="chips section" style="margin-top:18px">
      <button class="chip ${y === "all" ? "on" : ""}" data-act="flight-year" data-y="all">All time</button>
      ${years.map(k => `<button class="chip ${y === k ? "on" : ""}" data-act="flight-year" data-y="${k}">${k}</button>`).join("")}
    </div>
    ${hasReason ? `<div class="chips" style="margin-top:4px">
      ${["all", "Leisure", "Business"].concat(past.some(f => f.reason === "Crew") ? ["Crew"] : []).concat(past.some(f => f.reason === "Other") ? ["Other"] : []).map(r => `<button class="chip ${rs === r ? "on" : ""}" data-act="flight-reason" data-r="${r}">${r === "all" ? "All trips" : r}</button>`).join("")}
    </div>` : ""}`;

    const upcomingHtml = upcoming.length ? `<section class="section"><h2>Coming up</h2><div class="stack" style="margin-top:12px">${upcoming.map(f => flightCard(Object.assign({ f }, calc(f)))).join("")}</div></section>` : "";

    if (!list.length) return hero + upcomingHtml + filters + `<section class="section"><p class="sub">No flights match these filters.</p></section>`;

    const km = C.reduce((n, c) => n + (c.km || 0), 0), min = C.reduce((n, c) => n + (c.min || 0), 0);
    const codes = new Set(), ccs = new Map();
    list.forEach(f => { [f.from, f.to].forEach(c => { codes.add(c); const p = AP.get(c); if (p) ccs.set(p.cc, (ccs.get(p.cc) || 0) + 1); }); });
    const withKm = C.filter(c => c.km != null && c.km > 0);
    const longest = withKm.reduce((b, c) => !b || c.km > b.km ? c : b, null);
    const shortest = withKm.reduce((b, c) => !b || c.km < b.km ? c : b, null);
    const longestT = C.filter(c => c.min != null && !c.est).reduce((b, c) => !b || c.min > b.min ? c : b, null);
    const routes = new Map(), airports = new Map(), airlines = new Map(), aircraft = new Map(), airlineKm = new Map();
    list.forEach((f, i) => {
      const r = [f.from, f.to].sort().join(" – "); routes.set(r, (routes.get(r) || 0) + 1);
      [f.from, f.to].forEach(c => { const k = `${c} · ${place(c, f)}`; airports.set(k, (airports.get(k) || 0) + 1); });
      if (f.airline) { airlines.set(f.airline, (airlines.get(f.airline) || 0) + 1); airlineKm.set(f.airline, (airlineKm.get(f.airline) || 0) + (C[i].km || 0)); }
      if (f.aircraft) aircraft.set(f.aircraft, (aircraft.get(f.aircraft) || 0) + 1);
    });
    const tile = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    const laps = km / EARTH_KM;
    const kmBy = (key, v) => C.filter(c => c.f[key] === v).reduce((n, c) => n + (c.km || 0), 0);

    // Flights over time: per year (all time) or per month (one year)
    let timeBars;
    if (y === "all") {
      const ys = [...new Set(list.map(f => f.date.slice(0, 4)))].sort();
      const first = +ys[0], last = +ys[ys.length - 1], span = [];
      for (let k = first; k <= last; k++) span.push(String(k));
      const vals = span.map(k => list.filter(f => f.date.startsWith(k)).length);
      timeBars = card("Flights per year", barsHtml(vals, Math.max(...vals, 1), span.map((k, i) => span.length > 12 ? (i % 3 === 0 ? "’" + k.slice(2) : "") : "’" + k.slice(2)), span.map((k, i) => `${k}: ${plural(vals[i], "flight")}`), span.length > 7 ? "m12" : ""),
        `Busiest year: <b>${span[vals.indexOf(Math.max(...vals))]}</b> with ${plural(Math.max(...vals), "flight")}.`);
    } else {
      const vals = Array.from({ length: 12 }, (_, m) => list.filter(f => +f.date.slice(5, 7) === m + 1).length);
      timeBars = card("Flights per month", barsHtml(vals, Math.max(...vals, 1), "JFMAMJJASOND".split(""), vals.map((v, m) => `${new Date(+y, m, 1).toLocaleDateString("en-GB", { month: "long" })}: ${v}`), "m12"));
    }

    // When you fly
    const WD = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    const wd = Array(7).fill(0); list.forEach(f => wd[(A.parse(f.date).getDay() + 6) % 7]++);
    const mo = Array(12).fill(0); list.forEach(f => mo[+f.date.slice(5, 7) - 1]++);
    const withDep = list.filter(f => f.dep);
    const tod = [["Night (0–5)", 0], ["Morning (5–12)", 0], ["Afternoon (12–18)", 0], ["Evening (18–24)", 0]];
    withDep.forEach(f => { const h = +f.dep.slice(0, 2); tod[h < 5 ? 0 : h < 12 ? 1 : h < 18 ? 2 : 3][1]++; });
    const MN = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString("en-GB", { month: "long" }));

    // Records and extremes
    const known = [...codes].map(c => AP.get(c)).filter(Boolean);
    const ext = (cmp) => known.reduce((b, p) => !b || cmp(p, b) ? p : b, null);
    const north = ext((p, b) => p.lat > b.lat), south = ext((p, b) => p.lat < b.lat), east = ext((p, b) => p.lon > b.lon), west = ext((p, b) => p.lon < b.lon);
    const pl = p => p ? `${flag(p.cc)} ${esc(p.city)} <small class="sub">${esc(p.code)}</small>` : "–";
    const domestic = C.filter(c => c.a && c.b && c.a.cc === c.b.cc).length;
    const byMonth = new Map(); list.forEach(f => { const k = f.date.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + 1); });
    const busyM = [...byMonth].sort((a, b) => b[1] - a[1])[0];
    const firstF = list[list.length - 1];
    const route = c => c ? `${esc(c.f.from)} → ${esc(c.f.to)}` : "–";

    // Airports first visited each year (all-time view)
    let newApts = "";
    if (y === "all" && rs === "all") {
      const seenA = new Set(), perYear = new Map();
      list.slice().reverse().forEach(f => [f.from, f.to].forEach(c => { if (!seenA.has(c)) { seenA.add(c); const k = f.date.slice(0, 4); perYear.set(k, (perYear.get(k) || 0) + 1); } }));
      const ys = [...perYear.keys()].sort();
      if (ys.length > 1) newApts = card("New airports each year", barsHtml(ys.map(k => perYear.get(k)), Math.max(...perYear.values()), ys.map(k => "’" + k.slice(2)), ys.map(k => `${k}: ${perYear.get(k)} new`), ys.length > 7 ? "m12" : ""), "The first time you set foot in each airport.");
    }

    const seatTyped = list.filter(f => f.seatType).length;
    const classed = list.filter(f => f.cls).length;

    /* ----- more chart types (charts.js) ----- */
    const X = A.Charts, asc = C.slice().reverse(), kmF = v => `${fmtNum(Math.round(v))} km`;
    const spanYears = (() => { const ys = [...new Set(list.map(f => f.date.slice(0, 4)))].sort(), o = []; for (let k = +ys[0]; k <= +ys[ys.length - 1]; k++) o.push(String(k)); return o; })();
    // Periods for the stacked charts: years for all time, months for one year.
    const P = y === "all"
      ? { keys: spanYears, of: f => f.date.slice(0, 4), labels: spanYears.map(k => "’" + k.slice(2)), tips: spanYears, name: "year" }
      : { keys: MN.map((_, i) => pad(i + 1)), of: f => f.date.slice(5, 7), labels: "JFMAMJJASOND".split(""), tips: MN, name: "month" };
    const stackBy = (groups, pick) => groups.map((g, i) => ({ name: g, c: g === "Other" || g === "Not set" ? 5 : i, vals: P.keys.map(k => list.filter(f => P.of(f) === k && pick(f) === g).length) }));

    // Distance adding up over time, month by month
    let cumCard = "";
    if (km && asc.length > 1) {
      const mk = []; let [yy, mm] = (y === "all" ? asc[0].f.date.slice(0, 7) : `${y}-01`).split("-").map(Number);
      const endM = y === "all" ? asc[asc.length - 1].f.date.slice(0, 7) : (`${y}-12` < t.slice(0, 7) ? `${y}-12` : t.slice(0, 7));
      while (`${yy}-${pad(mm)}` <= endM && mk.length < 1500) { mk.push(`${yy}-${pad(mm)}`); if (++mm > 12) { mm = 1; yy++; } }
      const perM = new Map(); asc.forEach(c => perM.set(c.f.date.slice(0, 7), (perM.get(c.f.date.slice(0, 7)) || 0) + (c.km || 0)));
      let run = 0; const cum = mk.map(k => (run += perM.get(k) || 0));
      const lapsN = Math.floor(km / EARTH_KM), hl = lapsN >= 1 && lapsN <= 4 ? Array.from({ length: lapsN }, (_, i) => ({ v: (i + 1) * EARTH_KM, label: `${i + 1}× round the Earth` })) : [];
      if (mk.length > 1) cumCard = card("Distance adding up", X.line([{ name: "Total distance", vals: cum, area: true }], { labels: mk.map(k => fmt(k + "-01", { month: "short", year: "2-digit" })), fmt: v => v >= 10000 ? `${Math.round(v / 1000)}k` : fmtNum(Math.round(v)), zero: true, hlines: hl, legend: false }), `Every flight stacked on the last: <b>${kmF(km)}</b> so far.`);
    }

    // Seasons: which months you fly, year by year
    const seasonCard = y === "all" && spanYears.length > 1 ? card("Your flying seasons", X.grid(spanYears, "JFMAMJJASOND".split(""), spanYears.map(k => MN.map((_, m) => list.filter(f => f.date.startsWith(`${k}-${pad(m + 1)}`)).length)), { left: 30, ch: 14, show: true, fmt: v => v ? String(v) : "", tip: (r, c, v) => `${MN[c]} ${spanYears[r]}: ${plural(v || 0, "flight")}` }), "Flights in each month of each year.") : "";

    // How far and how long
    const kms = withKm.map(c => c.km), bands = [["Short (under 1,500 km)", kms.filter(v => v < 1500).length], ["Medium (1,500 to 4,000 km)", kms.filter(v => v >= 1500 && v < 4000).length], ["Long (over 4,000 km)", kms.filter(v => v >= 4000).length]];
    const distCard = kms.length >= 5 ? card("How far you fly", X.histogram(kms, { step: Math.max(...kms) > 6000 ? 1000 : 500, lo: 0, fmt: v => fmtNum(Math.round(v)), unit: "flights", marks: [{ v: X.median(kms), label: `median ${kmF(X.median(kms))}` }] }) + `<div class="legend" style="margin-top:12px">${bands.map((b, i) => `<span style="--op:${OPS[i]}">${b[0]} <b>${b[1]}</b></span>`).join("")}</div>`, "Number of flights by distance, in km.") : "";
    const timed = C.filter(c => c.min != null && !c.est), durs = timed.map(c => c.min);
    const durCard = durs.length >= 5 ? card("How long you're in the air", X.histogram(durs, { step: Math.max(...durs) > 600 ? 60 : 30, lo: 0, fmt: v => hm(Math.round(v)).replace(" 00m", ""), unit: "flights", marks: [{ v: X.median(durs), label: `median ${hm(Math.round(X.median(durs)))}` }] }), `Based on ${plural(durs.length, "flight")} with a logged time in the air.`) : "";
    const speedPts = timed.filter(c => c.km > 0 && c.min > 0).map(c => ({ x: c.km, y: c.min, t: `${c.f.from} → ${c.f.to}, ${fmt(c.f.date, { day: "numeric", month: "short", year: "numeric" })}` }));
    const avgSpeed = speedPts.length ? Math.round(speedPts.reduce((n, p) => n + p.x, 0) / (speedPts.reduce((n, p) => n + p.y, 0) / 60)) : 0;
    const speedCard = speedPts.length >= 5 ? card("Distance against time in the air", X.scatter(speedPts, { min: 5, unit: "flights", xFmt: v => fmtNum(Math.round(v)), yFmt: v => hm(Math.round(v)).replace(" 00m", ""), xLabel: "Distance in km", yLabel: "Time in the air" }), `Gate to gate you average <b>${fmtNum(avgSpeed)} km/h</b>. Dots above the line were slow for their distance.`) : "";

    // Clock and compass
    const depH = Array(24).fill(0); withDep.forEach(f => depH[+f.dep.slice(0, 2)]++);
    const peakDep = depH.indexOf(Math.max(...depH));
    const comp = Array(8).fill(0), CN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"], CNAME = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    C.forEach(c => { if (c.a && c.b && c.a !== c.b) comp[Math.round(bearing(c.a, c.b) / 45) % 8]++; });
    const compN = comp.reduce((a, b) => a + b, 0), peakC = comp.indexOf(Math.max(...comp));
    const compCard = compN >= 3 ? card("Which way you head", X.radial(comp, { centered: true, labels: CN, tip: (i, v) => `Heading ${CNAME[i]}: ${plural(v, "flight")}`, center: CN[peakC], sub: "most often", label: "Flights by compass direction" }), `The direction at take-off. Most of your flights head <b>${CNAME[peakC]}</b>.`) : "";

    // Who you fly with, and why, over time
    const topAir = [...airlines].sort((a, b) => b[1] - a[1]).slice(0, 4).map(r => r[0]);
    const airGroups = airlines.size > 4 ? topAir.concat(["Other"]) : topAir;
    const airCard = airlines.size > 1 && P.keys.length > 1 ? card(`Airlines by ${P.name}`, X.stacked(P.labels, stackBy(airGroups, f => !f.airline ? null : topAir.includes(f.airline) ? f.airline : "Other"), { tips: P.tips, fmt: v => plural(v, "flight"), ticks: 12 })) : "";
    const reasonsUsed = REASONS.filter(r => list.some(f => f.reason === r));
    const reasonCard = hasReason && rs === "all" && reasonsUsed.length > 1 && P.keys.length > 1 ? card(`Leisure or business by ${P.name}`, X.stacked(P.labels, stackBy(reasonsUsed, f => f.reason), { tips: P.tips, fmt: v => plural(v, "flight"), ticks: 12 })) : "";

    // The map filling in: airports and countries seen so far
    let grewCard = "";
    if (y === "all" && rs === "all" && spanYears.length > 1) {
      const sa = new Set(), sc = new Set(), aLine = [], cLine = [];
      spanYears.forEach(k => { asc.forEach(c => { if (c.f.date.startsWith(k)) [c.f.from, c.f.to].forEach(code => { sa.add(code); const p = AP.get(code); if (p) sc.add(p.cc); }); }); aLine.push(sa.size); cLine.push(sc.size); });
      grewCard = card("Your map filling in", X.line([{ name: "Airports", vals: aLine, c: 0, dots: true }, { name: "Countries", vals: cLine, c: 1, dots: true }], { labels: spanYears, zero: true, ticks: 6 }), "Different airports and countries you had been to by the end of each year.");
    }

    // Trips: flights paired into time away from home
    const home = homeCode(), allTrips = trips().filter(tr => y === "all" || tr.start.startsWith(y));
    const closed = allTrips.filter(tr => !tr.open);
    let tripCard = "";
    if (rs === "all" && closed.length >= 2) {
      const lens = closed.map(tr => tr.days), longest = closed.reduce((b, tr) => tr.days > b.days ? tr : b);
      const awayBy = P.keys.map(k => closed.filter(tr => (y === "all" ? tr.start.slice(0, 4) : tr.start.slice(5, 7)) === k).reduce((n, tr) => n + tr.days, 0));
      tripCard = `<section class="section"><h2>Trips</h2>
        <p class="sub" style="margin-top:6px">Flights paired into trips: away from ${esc(place(home))} (${esc(home)}, your most-used airport) until a flight lands back there.${allTrips.length > closed.length ? ` ${plural(allTrips.length - closed.length, "trip")} without a logged way home ${allTrips.length - closed.length === 1 ? "is" : "are"} left out.` : ""}</p>
        <div class="stat-grid" style="margin-top:14px">
          ${tile(closed.length, "trips")}
          ${tile(fmtNum(lens.reduce((a, b) => a + b, 0)), "days away")}
          ${tile(`${Math.round(X.median(lens))}`, "days, typical trip")}
        </div>
        <div class="stack" style="margin-top:12px">
          <div class="card"><span class="label" style="margin:0">How long your trips last</span><div class="sub" style="margin-top:2px">Longest: <b>${longest.days} days</b> to ${esc(place(longest.dest))}, from ${esc(fmt(longest.start, { day: "numeric", month: "short", year: "numeric" }))}.</div>${X.histogram(lens, { min: 2, step: Math.max(...lens) > 30 ? 7 : Math.max(...lens) > 12 ? 2 : 1, lo: 0, fmt: v => `${Math.round(v)}d`, unit: "trips", marks: [{ v: X.median(lens), label: `median ${Math.round(X.median(lens))} days` }] })}</div>
          ${P.keys.length > 1 ? `<div class="card"><span class="label" style="margin:0">Days away per ${P.name}</span>${barsHtml(awayBy, Math.max(...awayBy, 1), P.labels.map((l, i) => P.labels.length > 12 ? (i % 3 === 0 ? l : "") : l), awayBy.map((v, i) => `${P.tips[i]}: ${v} days away`), P.keys.length > 7 ? "m12" : "")}</div>` : ""}
        </div></section>`;
    }

    return hero + upcomingHtml + filters + `
    <section class="section">
      <div class="stat-grid">
        ${tile(fmtNum(list.length), list.length === 1 ? "flight" : "flights")}
        ${tile(km >= 100000 ? `${fmtNum(Math.round(km / 1000))}k km` : `${fmtNum(km)} km`, "flown")}
        ${tile(min ? (min >= 6000 ? `${fmtNum(Math.round(min / 60))} h` : hm(min)) : "–", "in the air")}
        ${tile(codes.size, "airports")}
        ${tile(ccs.size, "countries")}
        ${tile(airlines.size || "–", "airlines")}
      </div>
      ${km ? `<p class="sub" style="margin-top:12px">${laps >= 0.1 ? `${(Math.round(laps * 10) / 10).toLocaleString("en-GB")}× around the Earth` : "A fraction of a lap around the Earth"}${km / MOON_KM >= 0.05 ? `, ${Math.round(km / MOON_KM * 100)}% of the way to the Moon` : ""}. That's ${(Math.round(min / 1440 * 10) / 10).toLocaleString("en-GB")} days spent in the air.</p>` : ""}
    </section>
    <section class="section"><div class="card" style="padding:10px">${mapSvg(list)}</div></section>
    ${cumCard}
    ${hasReason ? card("Leisure or business", X.donut(REASONS.map(r => [r, list.filter(f => f.reason === r).length, kmBy("reason", r) ? `${fmtNum(kmBy("reason", r))} km` : ""]).concat([["Not set", list.filter(f => !f.reason).length]]), { center: list.length, sub: "flights", fmt: v => plural(v, "flight"), label: "Flights by reason" })) : ""}
    ${reasonCard}
    ${timeBars}
    ${seasonCard}
    ${seatTyped ? card("Where you sit", X.donut(SEATS.map(s => [s, list.filter(f => f.seatType === s).length]), { keep: true, center: seatTyped, sub: "flights", fmt: v => plural(v, "flight"), label: "Flights by seat type" }), `Based on ${plural(seatTyped, "flight")} with a seat type.`) : ""}
    ${classed ? card("Cabin class", X.donut(CLASSES.map(c => [c, list.filter(f => f.cls === c).length]), { center: classed, sub: "flights", fmt: v => plural(v, "flight"), label: "Flights by cabin class" })) : ""}
    ${card("When you fly",
      `${barsHtml(wd, Math.max(...wd, 1), ["M", "T", "W", "T", "F", "S", "S"], wd.map((v, i) => `${WD[i]}: ${v}`))}
       ${barsHtml(mo, Math.max(...mo, 1), "JFMAMJJASOND".split(""), mo.map((v, i) => `${MN[i]}: ${v}`), "m12")}`,
      `Most often on <b>${WD[wd.indexOf(Math.max(...wd))]}</b> and in <b>${MN[mo.indexOf(Math.max(...mo))]}</b>.`)}
    ${withDep.length >= 3 ? card("Departure clock", X.radial(depH, { labels: depH.map((_, i) => i % 6 === 0 ? pad(i) : ""), tip: (i, v) => `${pad(i)}:00 to ${pad(i)}:59: ${plural(v, "departure")}`, center: `${pad(peakDep)}:00`, sub: "peak", label: "Departures by hour" }) + split(tod), `Local departure times of ${plural(withDep.length, "flight")}.`) : ""}
    ${compCard}
    ${distCard}
    ${durCard}
    ${speedCard}
    ${airCard}
    ${tripCard}
    <section class="section"><div class="card">
      <span class="label" style="margin:0">Records</span>
      <div class="kvs">
        ${kv("Longest by distance", longest ? `${route(longest)} · ${fmtNum(longest.km)} km` : "")}
        ${kv("Longest in the air", longestT ? `${route(longestT)} · ${hm(longestT.min)}` : "")}
        ${kv("Shortest", shortest ? `${route(shortest)} · ${fmtNum(shortest.km)} km` : "")}
        ${kv("Average flight", withKm.length ? `${fmtNum(Math.round(withKm.reduce((n, c) => n + c.km, 0) / withKm.length))} km` : "")}
        ${kv("Busiest month", busyM && busyM[1] > 1 ? `${esc(fmt(busyM[0] + "-01", { month: "long", year: "numeric" }))} · ${busyM[1]} flights` : "")}
        ${kv("Domestic flights", `${domestic} of ${list.length}`)}
        ${kv("Different routes", fmtNum(routes.size))}
        ${kv("First flight here", firstF ? `${esc(fmt(firstF.date, { day: "numeric", month: "short", year: "numeric" }))} · ${esc(firstF.from)} → ${esc(firstF.to)}` : "")}
      </div>
    </div></section>
    ${known.length > 1 ? `<section class="section"><div class="card">
      <span class="label" style="margin:0">Furthest points</span>
      <div class="kvs">${kv("North", pl(north))}${kv("South", pl(south))}${kv("East", pl(east))}${kv("West", pl(west))}</div>
    </div></section>` : ""}
    ${newApts}
    ${grewCard}
    <section class="section">
      <h2>Favourites</h2>
      <div class="card" style="margin-top:12px;padding-top:6px;padding-bottom:6px">
        <span class="label" style="margin:10px 0 0">Routes</span>${topList(routes, 5)}
        <span class="label" style="margin:14px 0 0">Airports</span>${topList(airports, 5)}
        ${airlines.size ? `<span class="label" style="margin:14px 0 0">Airlines by flights</span>${topList(airlines, 5)}` : ""}
        ${airlineKm.size ? `<span class="label" style="margin:14px 0 0">Airlines by distance</span>${topList(airlineKm, 5, v => `${fmtNum(v)} km`)}` : ""}
        ${aircraft.size ? `<span class="label" style="margin:14px 0 0">Aircraft</span>${topList(aircraft, 5)}` : ""}
        <span class="label" style="margin:14px 0 0">Countries</span>${topList(new Map([...ccs].map(([cc, n]) => [`${flag(cc)} ${cc}`, n])), 8)}
      </div>
    </section>
    ${[...new Set(list.map(f => f.date.slice(0, 4)))].map(g => `<section class="section">
      <h2>${g} <span class="sub" style="font-size:14px;font-weight:400">· ${plural(list.filter(f => f.date.startsWith(g)).length, "flight")}</span></h2>
      <div class="stack" style="margin-top:12px">${C.filter(c => c.f.date.startsWith(g)).map(flightCard).join("")}</div>
    </section>`).join("")}
    <section class="section"><button class="btn block" data-act="flight-export">Download flights as CSV</button></section>`;
  }

  VIEWS.flights = viewFlights;
  // For the Insights tab.
  A.Flights = { all: () => F, calc, AP, trips, homeCode, place, flag, hm };

  /* ---------- add / edit ---------- */
  const seg = (name, opts, cur) => `<div class="seg wrap" role="radiogroup">${opts.map(o => `<label class="segopt"><input type="radio" name="${name}" value="${esc(o)}" ${cur === o ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
  function flightSheet(id) {
    const f = id ? F.find(x => x.id === id) : null;
    const v = (k, d = "") => f && f[k] != null ? esc(f[k]) : d;
    openSheet(`
      <div class="sheet-head"><h2>${f ? "Edit flight" : "Add flight"}</h2><button class="icon-btn" data-act="close" aria-label="Close">${A.ICON.close}</button></div>
      <form id="flightForm" data-id="${f ? esc(f.id) : ""}" style="margin-top:14px" autocomplete="off">
        <label><span class="label">Date</span><input class="inp" name="date" type="date" required value="${f ? esc(f.date) : today()}"></label>
        <div class="grid2" style="margin-top:12px">
          <label><span class="label">From (airport code)</span><input class="inp" name="from" list="aptList" maxlength="3" required placeholder="BUD" value="${v("from")}" autocapitalize="characters" style="text-transform:uppercase"></label>
          <label><span class="label">To (airport code)</span><input class="inp" name="to" list="aptList" maxlength="3" required placeholder="LHR" value="${v("to")}" autocapitalize="characters" style="text-transform:uppercase"></label>
        </div>
        <datalist id="aptList">${[...AP.values()].map(p => `<option value="${esc(p.code)}">${esc(p.city)}, ${esc(p.cc)}</option>`).join("")}</datalist>
        <div class="grid2" style="margin-top:12px">
          <label><span class="label">Departs</span><input class="inp" name="dep" type="time" value="${v("dep")}"></label>
          <label><span class="label">Arrives</span><input class="inp" name="arr" type="time" value="${v("arr")}"></label>
        </div>
        <span class="label" style="margin-top:14px">Trip</span>
        ${seg("reason", REASONS, f && f.reason)}
        <div class="grid2" style="margin-top:12px">
          <label><span class="label">Airline</span><input class="inp" name="airline" maxlength="60" value="${v("airline")}"></label>
          <label><span class="label">Flight number</span><input class="inp" name="number" maxlength="12" value="${v("number")}" style="text-transform:uppercase"></label>
        </div>
        <div class="grid2" style="margin-top:12px">
          <label><span class="label">Class</span><select class="inp" name="cls"><option value="">–</option>${CLASSES.map(c => `<option ${f && f.cls === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
          <label><span class="label">Seat</span><input class="inp" name="seat" maxlength="6" placeholder="12A" value="${v("seat")}" style="text-transform:uppercase"></label>
        </div>
        <span class="label" style="margin-top:14px">Seat type</span>
        ${seg("seatType", SEATS, f && f.seatType)}
        <div class="grid2" style="margin-top:12px">
          <label><span class="label">Aircraft</span><input class="inp" name="aircraft" maxlength="50" placeholder="Airbus A320" value="${v("aircraft")}"></label>
          <label><span class="label">Registration</span><input class="inp" name="reg" maxlength="12" placeholder="HA-LWA" value="${v("reg")}" style="text-transform:uppercase"></label>
        </div>
        <span class="label" style="margin-top:12px">Time in the air <span style="opacity:.7">(optional, estimated if empty)</span></span>
        <div class="grid2">
          <input class="inp" name="dh" type="number" inputmode="numeric" min="0" max="24" placeholder="Hours" aria-label="Hours" value="${f && f.durationMin != null ? Math.floor(f.durationMin / 60) : ""}">
          <input class="inp" name="dm" type="number" inputmode="numeric" min="0" max="59" placeholder="Minutes" aria-label="Minutes" value="${f && f.durationMin != null ? f.durationMin % 60 : ""}">
        </div>
        <label style="display:block;margin-top:12px"><span class="label">Distance in km <span style="opacity:.7">(only if the airports aren't in the list)</span></span><input class="inp" name="km" type="number" inputmode="numeric" min="0" max="20000" value="${v("distanceKm")}"></label>
        <label style="display:block;margin-top:12px"><span class="label">Notes</span><input class="inp" name="notes" maxlength="200" placeholder="Window seat, great sunrise…" value="${v("notes")}"></label>
        <div class="grid2" style="margin-top:20px">
          ${f ? `<button type="button" class="btn danger" data-act="flight-del" data-id="${esc(f.id)}">Delete</button>` : `<button type="button" class="btn" data-act="close">Cancel</button>`}
          <button class="btn primary">Save</button>
        </div>
      </form>`);
  }

  EXTRA.submits.flightForm = form => {
    const d = new FormData(form), g = k => String(d.get(k) || "").trim();
    const n = k => { const x = g(k); return x === "" || !isFinite(Number(x)) || Number(x) < 0 ? null : Number(x); };
    const dh = n("dh"), dm = n("dm");
    const old = F.find(x => x.id === form.dataset.id) || {};
    const rec = clean({
      id: form.dataset.id || uid(), date: g("date"), from: g("from"), to: g("to"), airline: g("airline"), number: g("number"),
      aircraft: g("aircraft"), reg: g("reg"), cls: g("cls"), seat: g("seat"), seatType: g("seatType"), reason: g("reason"),
      dep: g("dep"), arr: g("arr"), notes: g("notes"), fromCity: old.fromCity, toCity: old.toCity,
      durationMin: dh == null && dm == null ? null : Math.round((dh || 0) * 60 + (dm || 0)),
      distanceKm: n("km") == null ? null : Math.round(n("km")), updatedAt: new Date().toISOString()
    });
    if (!rec) return toast("Check the date and use three-letter airport codes.");
    const i = F.findIndex(x => x.id === rec.id);
    if (i >= 0) F[i] = rec; else F.push(rec);
    delete G[rec.id];
    const ok = persist([rec.id]);
    closeSheet(); paint(true);
    const c = calc(rec);
    toast(!ok ? "Couldn't save. Is browser storage blocked or full?" : c.km == null ? "Saved. Add a distance, those airports aren't in the list." : "Flight saved");
  };

  /* ---------- CSV import (myFlightradar24 export or any CSV with Date, From, To columns) ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === "," || c === ";") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }
  const norm = h => h.toLowerCase().replace(/[^a-z]/g, "");
  const COLS = {
    date: ["date"], number: ["flightnumber", "flightno", "number", "flight"], from: ["from", "origin", "departure"], to: ["to", "destination", "arrival"],
    dep: ["deptime", "departs", "departuretime"], arr: ["arrtime", "arrives", "arrivaltime"], duration: ["duration", "durationmin"],
    airline: ["airline"], aircraft: ["aircraft"], reg: ["registration", "reg"], seat: ["seatnumber", "seat"], seatType: ["seattype"],
    cls: ["flightclass", "class"], reason: ["flightreason", "reason"], notes: ["note", "notes"], km: ["distancekm", "distance"]
  };
  function aptOf(v) {
    v = (v || "").trim();
    if (/^[A-Za-z0-9]{3}$/.test(v)) return { code: v.toUpperCase(), city: "" };
    const m = v.match(/\(([A-Z0-9]{3})\/[A-Z0-9]{3,4}\)/) || v.match(/\(([A-Z0-9]{3})\)/);
    return m ? { code: m[1], city: v.split(" / ")[0].trim() } : null;
  }
  const stripCode = v => (v || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const toMin = v => { v = (v || "").trim(); if (/^\d+$/.test(v)) return +v; const m = v.match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const toTime = v => { const m = (v || "").trim().match(/^(\d{1,2}):(\d{2})/); return m ? `${pad(+m[1])}:${m[2]}` : ""; };
  const pick = (v, codes, list) => { v = (v || "").trim(); if (/^\d$/.test(v)) return codes[+v] || ""; const hit = list.find(x => x.toLowerCase() === v.toLowerCase()); if (hit) return hit; if (/premium|economy\s*\+|plus/i.test(v) && list === CLASSES) return "Premium economy"; return ""; };

  function importCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error("That file has no rows.");
    const head = rows[0].map(norm), col = {};
    Object.keys(COLS).forEach(k => { const i = head.findIndex(h => COLS[k].includes(h)); if (i >= 0) col[k] = i; });
    if (col.date == null || col.from == null || col.to == null) throw new Error("Couldn't find Date, From and To columns in that CSV.");
    let added = 0, updated = 0, skipped = 0;
    const touched = [];
    rows.slice(1).forEach(r => {
      const g = k => col[k] == null ? "" : (r[col[k]] || "").trim();
      const a = aptOf(g("from")), b = aptOf(g("to")), date = g("date").slice(0, 10);
      if (!a || !b || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; return; }
      const data = {
        date, from: a.code, to: b.code, number: g("number"), airline: stripCode(g("airline")), aircraft: stripCode(g("aircraft")), reg: g("reg"),
        seat: g("seat"), seatType: pick(g("seatType"), ["", "Window", "Middle", "Aisle"], SEATS),
        cls: pick(g("cls"), ["", "Economy", "Business", "First", "Premium economy", "Private"], CLASSES),
        reason: pick(g("reason"), ["", "Leisure", "Business", "Crew", "Other"], REASONS),
        dep: toTime(g("dep")), arr: toTime(g("arr")), durationMin: toMin(g("duration")), notes: g("notes"),
        distanceKm: /^\d+(\.\d+)?$/.test(g("km")) ? Math.round(+g("km")) : null,
        fromCity: AP.has(a.code) ? "" : a.city, toCity: AP.has(b.code) ? "" : b.city, updatedAt: new Date().toISOString()
      };
      if (!data.durationMin) data.durationMin = null;
      // Same date and route (and flight number, if both have one) counts as the same flight.
      const i = F.findIndex(x => x.date === date && x.from === a.code && x.to === b.code && (!x.number || !data.number || x.number === data.number.toUpperCase()));
      if (i >= 0) {
        const merged = clean(Object.assign({}, F[i], Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== "")), { id: F[i].id }));
        if (merged) { F[i] = merged; updated++; touched.push(merged.id); }
      } else {
        const rec = clean(Object.assign(data, { id: `f-${date}-${a.code}${b.code}-${(data.number || data.dep || uid()).replace(/\W/g, "")}` }));
        if (rec) { F.push(rec); delete G[rec.id]; added++; touched.push(rec.id); } else skipped++;
      }
    });
    if (!added && !updated) throw new Error("No flights could be read from that file.");
    if (!persist(touched)) throw new Error("Couldn't save. Browser storage may be full.");
    const unknown = new Set(); F.forEach(f => { if (f.from !== f.to) [f.from, f.to].forEach(c => { if (!AP.has(c) && f.distanceKm == null) unknown.add(c); }); });
    return { added, updated, skipped, unknown: [...unknown] };
  }

  const picker = document.createElement("input");
  picker.type = "file"; picker.id = "flightFile"; picker.hidden = true; picker.accept = ".csv,text/csv";
  picker.addEventListener("change", async () => {
    const file = picker.files[0]; picker.value = "";
    if (!file) return;
    try {
      const r = importCSV(await file.text());
      st.year = "all"; st.reason = "all"; paint();
      toast(`Imported: ${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.unknown.length ? `. No distance for ${r.unknown.slice(0, 4).join(", ")}` : ""}`);
    } catch (e) { toast(e.message || "Couldn't read that CSV."); }
  });
  document.body.appendChild(picker);

  function exportCSV() {
    const head = ["Date", "From", "To", "Departs", "Arrives", "Airline", "Flight number", "Aircraft", "Registration", "Class", "Seat", "Seat type", "Reason", "Duration (min)", "Distance (km)", "Notes"];
    const q = v => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
    const rows = F.slice().sort((a, b) => a.date < b.date ? -1 : 1).map(f => { const c = calc(f); return [f.date, f.from, f.to, f.dep, f.arr, f.airline, f.number, f.aircraft, f.reg, f.cls, f.seat, f.seatType, f.reason, c.min, c.km, f.notes].map(q).join(","); });
    const blob = new Blob([[head.join(",")].concat(rows).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `tracker-flights-${today()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  EXTRA.actions["flight-add"] = () => flightSheet(null);
  EXTRA.actions["flight-import"] = () => picker.click();
  EXTRA.actions["flight-export"] = exportCSV;
  EXTRA.actions["flight-edit"] = el => flightSheet(el.dataset.id);
  EXTRA.actions["flight-year"] = el => { st.year = el.dataset.y; paint(true); };
  EXTRA.actions["flight-reason"] = el => { st.reason = el.dataset.r; paint(true); };
  EXTRA.actions["flight-del"] = el => {
    if (st.armed !== el.dataset.id) { st.armed = el.dataset.id; el.textContent = "Tap again to delete"; return; }
    const id = el.dataset.id;
    st.armed = null; F = F.filter(x => x.id !== id); G[id] = new Date().toISOString(); persist([id]); closeSheet(); paint(true); toast("Flight deleted");
  };

  /* ---------- hooks ---------- */
  EXTRA.today.push(d => {
    const fs = F.filter(f => f.date === d);
    if (!fs.length) return "";
    return `<section class="section"><span class="label">In the air today</span><div class="stack">${fs.map(f => flightCard(Object.assign({ f }, calc(f)))).join("")}</div></section>`;
  });

  // Newest copy wins, one flight at a time, and a deletion counts as a change. Returns the ids that changed here.
  function mergeIn(list) {
    const byId = new Map(F.map((f, i) => [f.id, i])), hit = [];
    let drop = false;
    (Array.isArray(list) ? list : []).forEach(raw => {
      if (!raw || typeof raw.id !== "string" || !raw.id) return;
      const i = byId.has(raw.id) ? byId.get(raw.id) : -1;
      const mine = i >= 0 ? F[i].updatedAt || "" : G[raw.id] || "", up = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
      if (raw.deleted) {
        if (up <= mine) return;
        if (i >= 0) { F[i] = null; drop = true; }
        G[raw.id] = up; hit.push(raw.id);
        return;
      }
      const r = clean(raw); if (!r) return;
      if (i < 0 && G[r.id] && G[r.id] >= r.updatedAt) return;
      if (i >= 0 && !(r.updatedAt > mine)) return;
      if (i >= 0) F[i] = r; else { byId.set(r.id, F.length); F.push(r); }
      delete G[r.id]; hit.push(r.id);
    });
    if (drop) F = F.filter(Boolean);
    return hit;
  }

  // For syncing: these flights (or all of them, with deletions) as the sheet keeps them, and flights from the sheet.
  A.syncKinds.flights = {
    items(ids) {
      const list = ids || [...F.map(f => f.id), ...Object.keys(G)];
      return list.map(id => { const f = F.find(x => x.id === id); return f || (G[id] ? { id, deleted: true, updatedAt: G[id] } : null); }).filter(Boolean);
    },
    merge(list) { const hit = mergeIn(list); if (hit.length) persist(); return hit.length; }
  };

  HOOKS.exportParts.push(() => ({ flights: F }));
  HOOKS.importParts.push(raw => { if (raw && Array.isArray(raw.flights)) { const hit = mergeIn(raw.flights.filter(f => f && !f.deleted)); if (hit.length) persist(hit); } });
  HOOKS.wipe.push(() => { F = []; G = {}; LS.del(KEY); LS.del(GKEY); });
})();
