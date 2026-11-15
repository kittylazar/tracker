/* Tracker: Insights tab. Lines up body, music and flights by date and looks for patterns between them. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A || !A.Charts) return;
  const { esc, pad, today, addDays, fmt, fmtNum, fmtSleep, paint, Store, settings, EXTRA, VIEWS, daysFrom, eveMin, fromEve, nightLen, MOODS, avgOf } = A, X = A.Charts;

  const st = { year: "all", pair: null };
  const dur = m => m < 60 ? `${Math.round(m)} min` : `${fmtNum(Math.round(m / 60 * 10) / 10)} h`;
  const slp = v => fmtSleep(Math.round(v)), stepsF = v => fmtNum(Math.round(v)), f1 = v => v.toFixed(1);
  const card = (title, sub, body) => `<div class="card"><span class="label" style="margin:0">${esc(title)}</span>${sub ? `<div class="sub" style="margin-top:2px">${sub}</div>` : ""}${body}</div>`;
  const block = (title, sub, cards) => { const c = cards.filter(Boolean); return c.length ? `<section class="section"><h2>${title}</h2>${sub ? `<p class="sub" style="margin-top:6px">${sub}</p>` : ""}<div class="stack" style="margin-top:12px">${c.join("")}</div></section>` : ""; };
  const h3 = t => `<h3 class="cx-h">${esc(t)}</h3>`;
  // One comparison group: the average of a number over some days.
  const grp = (label, rows, get, c) => { const v = rows.map(get).filter(x => x != null); return { label, v: X.mean(v), n: v.length, c }; };
  const enough = (groups, min) => groups.filter(g => g.n >= (min || 3)).length >= 2;
  const sentence = (a, b, what, f) => a.v == null || b.v == null ? "" : `${what} <b>${f(a.v)}</b> on ${a.label.toLowerCase()} against <b>${f(b.v)}</b> on ${b.label.toLowerCase()}${X.diff(a.v, b.v) && X.diff(a.v, b.v) !== "about the same" ? ` (${X.diff(a.v, b.v)})` : ""}.`;
  // The names that lead the most days in a set of days.
  function topArtists(rows, n) {
    const m = new Map(); rows.forEach(r => { if (r.top) m.set(r.top, (m.get(r.top) || 0) + 1); });
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  const rankRows = list => { const max = list.length ? list[0][1] : 1; return list.map(([k, v], i) => `<div class="rank"><span class="no">${i + 1}</span><div class="nm"><b>${esc(k)}</b><div class="bar2"><i style="width:${(v / max * 100).toFixed(1)}%;animation-delay:${i * 40}ms"></i></div></div><span class="val">${v} day${v === 1 ? "" : "s"}</span></div>`).join(""); };

  /* ---------- one row per day, with everything known about it ---------- */
  function build() {
    const t = today(), all = Store.all(), M = A.music && A.music.get ? A.music.get() : null, FL = A.Flights || null;
    const flights = FL ? FL.all().filter(f => f.date <= t) : [], trips = FL ? FL.trips() : [];
    const bodyKeys = Object.keys(all).sort();
    const firsts = [bodyKeys[0], M && M.first, flights.map(f => f.date).sort()[0]].filter(Boolean).sort();
    if (!firsts.length) return null;
    const byDate = new Map(); flights.forEach(f => { if (!byDate.has(f.date)) byDate.set(f.date, []); byDate.get(f.date).push(f); });
    const away = new Map(), phase = new Map();
    trips.forEach(tr => {
      if (tr.open && tr.days > 60) return;
      daysFrom(tr.start, tr.end).forEach(d => away.set(d, tr));
      if (!tr.open) { for (let k = 1; k <= 3; k++) phase.set(addDays(tr.start, -k), "before"); for (let k = 1; k <= 7; k++) phase.set(addDays(tr.end, k), "after"); }
    });
    const v2 = M && M.v >= 2;
    const rows = daysFrom(firsts[0], t).map(d => {
      const r = all[d] || {}, fs = byDate.get(d) || [], md = M ? M.days[d] : null, inM = !!(M && M.first && d >= M.first && d <= M.last);
      const cs = fs.map(f => FL.calc(f)), nx = v2 ? M.days[addDays(d, 1)] : null;
      return {
        d, sleep: r.sleepMin != null ? r.sleepMin : r.bedAt && r.wakeAt ? nightLen(r.bedAt, r.wakeAt) : null,
        steps: r.steps != null ? r.steps : null, move: r.exerciseMin != null ? r.exerciseMin : null, mood: r.mood || null,
        wo: !!(r.workouts && r.workouts.length), bed: r.bedAt ? eveMin(r.bedAt) : null, logged: !!all[d],
        music: inM ? (md ? md[1] : 0) : null, top: md && md[0] ? (M.names[md[2]] || "") : null,
        // Late listening belongs to the night that starts on this day: 21:00 to midnight, plus midnight to 03:00 of the next day.
        late: inM && v2 ? (md ? md[12] || 0 : 0) + (nx ? nx[5] || 0 : 0) : null,
        blocks: v2 && md ? md.slice(5, 13) : null,
        fl: fs.length, flMin: cs.reduce((n, c) => n + (c.min || 0), 0), flKm: Math.max(0, ...cs.map(c => c.km || 0)),
        trip: away.get(d) || null, phase: away.has(d) ? "during" : phase.get(d) || "other"
      };
    });
    return { rows, idx: new Map(rows.map((r, i) => [r.d, i])), M, v2, trips, flights, has: { body: bodyKeys.some(k => all[k].sleepMin != null || all[k].steps != null || all[k].mood), music: !!M, flights: flights.length > 0 } };
  }

  /* ---------- correlation matrix ---------- */
  const VARS = [
    { k: "Sleep", get: r => r.sleep, f: slp, more: "more sleep", less: "less sleep" },
    { k: "Steps", get: r => r.steps, f: stepsF, more: "more steps", less: "fewer steps" },
    { k: "Mood", get: r => r.mood, f: f1, more: "a brighter mood", less: "a lower mood" },
    { k: "Music", get: r => r.music, f: dur, more: "more music", less: "less music" },
    { k: "Late", name: "Late-evening music", get: r => r.late, f: dur, more: "more late-evening music", less: "less late-evening music" },
    { k: "Flight", name: "Flight day", get: r => r.fl ? 1 : 0, f: v => v >= .5 ? "yes" : "no", bin: "flight days" },
    { k: "Away", name: "Away on a trip", get: r => r.trip ? 1 : 0, f: v => v >= .5 ? "yes" : "no", bin: "days away on a trip" }
  ];
  const SAME = [["Flight", "Away"], ["Music", "Late"]];
  function pairOf(R, a, b) {
    const xs = [], ys = [], pts = [];
    R.forEach(r => { const x = a.get(r), y = b.get(r); if (x != null && y != null) { xs.push(x); ys.push(y); pts.push({ x, y, t: fmt(r.d, { day: "numeric", month: "short", year: "numeric" }) }); } });
    return { r: xs.length >= 15 ? X.pearson(xs, ys) : null, n: xs.length, pts };
  }

  function viewInsights() {
    const D = build();
    const hero = `
    <section class="hero">
      <div class="eyebrow">Body · music · flights, side by side</div>
      <div class="hero-row"><h1>Insights</h1>${A.ILLO.spot("insights", "hero-spot")}</div>
      <div class="hero-meta"><span class="sub">Patterns between the things you track.</span></div>
    </section>`;
    const kinds = D ? Object.values(D.has).filter(Boolean).length : 0;
    if (!D || kinds < 2) {
      return hero + `<section class="section"><div class="card empty">
        <b style="font-size:18px">Not enough to compare yet</b>
        <p>Insights lines up your days across Body, Music and Flights. It needs data in at least two of them. So far: ${D ? ["body", "music", "flights"].filter(k => D.has[k]).map(k => k[0].toUpperCase() + k.slice(1)).join(", ") || "nothing" : "nothing"}.</p>
      </div></section>`;
    }
    const years = [...new Set(D.rows.map(r => r.d.slice(0, 4)))].reverse();
    const y = st.year !== "all" && years.includes(st.year) ? st.year : "all";
    const R = D.rows.filter(r => y === "all" || r.d.startsWith(y));
    const at = (r, k) => D.rows[D.idx.get(r.d) + k] || null;
    const goal = settings.sleepGoalH * 60, has = D.has;
    const chips = `<div class="chips section" style="margin-top:18px">
      <button class="chip ${y === "all" ? "on" : ""}" data-act="ins-year" data-y="all">All time</button>
      ${years.map(k => `<button class="chip ${y === k ? "on" : ""}" data-act="ins-year" data-y="${k}">${k}</button>`).join("")}
    </div>`;

    /* ----- body and music ----- */
    let bm = [];
    if (has.body && has.music) {
      const mm = R.filter(r => r.mood && r.music != null);
      if (mm.length >= 3) {
        const byMood = MOODS.map((l, i) => grp(l, mm.filter(r => r.mood === i + 1), r => r.music, 0));
        bm.push(card("Mood and music", "Each dot is a day: minutes listened across, mood up.",
          X.scatter(mm.map(r => ({ x: r.music, y: r.mood, t: fmt(r.d, { day: "numeric", month: "short", year: "numeric" }) })), { xFmt: dur, yFmt: f1, xLabel: "Music listened", yLabel: "Mood" })
          + (enough(byMood) ? h3("Average listening by mood") + X.paired(byMood, { fmt: dur }) : "")));
      }
      const ln = R.filter(r => r.late != null && r.sleep != null);
      if (ln.length >= 3) {
        const a = grp("Nights with late music", ln.filter(r => r.late >= 30), r => r.sleep, 0), b = grp("Quiet evenings", ln.filter(r => r.late < 30), r => r.sleep, 1);
        const ba = grp("", ln.filter(r => r.late >= 30), r => r.bed), bb = grp("", ln.filter(r => r.late < 30), r => r.bed);
        bm.push(card("Late listening and sleep", "Music between 21:00 and 03:00 against how long you slept that night.",
          X.scatter(ln.map(r => ({ x: r.late, y: r.sleep, t: fmt(r.d, { day: "numeric", month: "short", year: "numeric" }) })), { xFmt: dur, yFmt: v => `${(v / 60).toFixed(1)}h`, xLabel: "Late-evening music", yLabel: "Sleep" })
          + (enough([a, b]) ? h3("30 minutes or more of late music, or less") + X.paired([a, b], { fmt: slp, unit: "nights" }) + (ba.n >= 3 && bb.n >= 3 ? `<p class="sub" style="margin-top:10px">Bedtime averaged <b>${fromEve(ba.v)}</b> after late music and <b>${fromEve(bb.v)}</b> after quiet evenings.</p>` : "") : "")));
      } else if (!D.v2) bm.push(card("Late listening and sleep", "", X.none("Needs the newer music summary. Update the sheet script, then re-read your Drive folder on the Music tab.")));
      const mu = R.filter(r => r.music != null && r.logged);
      const wo = [grp("Workout days", mu.filter(r => r.wo), r => r.music, 0), grp("Rest days", mu.filter(r => !r.wo), r => r.music, 1)];
      const sg = [grp("Step goal reached", mu.filter(r => r.steps != null && r.steps >= settings.stepGoal), r => r.music, 0), grp("Below step goal", mu.filter(r => r.steps != null && r.steps < settings.stepGoal), r => r.music, 1)];
      if (enough(wo) || enough(sg)) bm.push(card("Music on active days", enough(wo) ? sentence(wo[0], wo[1], "You listen", dur) : "",
        (enough(wo) ? X.paired(wo, { fmt: dur }) : "") + (enough(sg) ? h3(`Days over ${fmtNum(settings.stepGoal)} steps, or under`) + X.paired(sg, { fmt: dur }) : "")));
      const after = R.filter(r => r.music != null && at(r, -1) && at(r, -1).sleep != null);
      const sn = [grp(`After under ${settings.sleepGoalH}h of sleep`, after.filter(r => at(r, -1).sleep < goal), r => r.music, 2), grp(`After ${settings.sleepGoalH}h or more`, after.filter(r => at(r, -1).sleep >= goal), r => r.music, 0)];
      if (enough(sn)) bm.push(card("Music after a short night", sentence(sn[0], sn[1], "You listen", dur).replace(" on after", " after").replace(" on after", " after"), X.paired(sn, { fmt: dur })));
      const hi = topArtists(R.filter(r => r.mood >= 4), 5), lo = topArtists(R.filter(r => r.mood && r.mood <= 2), 5);
      if (R.filter(r => r.mood >= 4 && r.top).length >= 3 || R.filter(r => r.mood && r.mood <= 2 && r.top).length >= 3) bm.push(card("The sound of your moods", "The artist you played most on each kind of day.",
        `<div class="cx-two"><div>${h3("Good and bright days")}${rankRows(hi) || X.none()}</div><div>${h3("Heavy and low days")}${rankRows(lo) || X.none("Fewer than 3 such days with music.")}</div></div>`));
    }

    /* ----- body and flights ----- */
    let bf = [];
    const kindOf = r => r.fl ? "flight" : r.trip ? "away" : "home";
    if (has.body && has.flights) {
      const fd = R.filter(r => r.fl), offs = [-2, -1, 0, 1, 2, 3], OL = ["2 nights before", "Night before", "Flight night", "Night after", "2 nights after", "3 nights after"];
      const around = offs.map(k => { const v = fd.map(r => at(r, k)).filter(x => x && x.sleep != null).map(x => x.sleep); return v.length >= 3 ? X.mean(v) : null; });
      const usual = X.mean(R.filter(r => kindOf(r) === "home" && r.sleep != null).map(r => r.sleep));
      if (around.filter(v => v != null).length >= 3) bf.push(card("Sleep around a flight", `Average sleep on the nights before and after you fly${usual != null ? `. Dashed: your usual night at home, <b>${slp(usual)}</b>` : ""}.`,
        X.line([{ name: "Sleep", vals: around, dots: true, w: 2.2 }], { labels: OL.map(l => l.replace(" nights", "").replace("Night ", "").replace("Flight night", "flight")), tips: OL, ticks: 6, fmt: v => `${(v / 60).toFixed(1)}h`, hlines: usual != null ? [{ v: usual, label: "usual" }] : [] })));
      const three = (get, c) => [grp("Flight days", R.filter(r => kindOf(r) === "flight"), get, 0), grp("Away on a trip", R.filter(r => kindOf(r) === "away"), get, 1), grp("At home", R.filter(r => kindOf(r) === "home"), get, 3)];
      const s3 = three(r => r.steps), m3 = three(r => r.mood), n3 = three(r => r.sleep);
      if (enough(s3) || enough(m3) || enough(n3)) bf.push(card("Flying, away and at home", "How your days differ depending on where you are.",
        (enough(s3) ? h3("Steps") + X.paired(s3, { fmt: stepsF }) : "") + (enough(m3) ? h3("Mood, out of 5") + X.paired(m3, { fmt: f1 }) : "") + (enough(n3) ? h3("Sleep that night") + X.paired(n3, { fmt: slp, unit: "nights" }) : "")));
      const bh = R.filter(r => !r.trip && r.bed != null).map(r => r.bed), ba = R.filter(r => r.trip && r.bed != null).map(r => r.bed);
      if (bh.length >= 3 && ba.length >= 3) bf.push(card("Bedtime on the road", `Away, you go to bed around <b>${fromEve(X.mean(ba))}</b>; at home around <b>${fromEve(X.mean(bh))}</b>.`,
        `<div class="kvs"><div class="kv"><span>At home (${bh.length} nights)</span><b>${fromEve(X.mean(bh))} ± ${Math.round(X.stdev(bh))} min</b></div><div class="kv"><span>Away (${ba.length} nights)</span><b>${fromEve(X.mean(ba))} ± ${Math.round(X.stdev(ba))} min</b></div></div><p class="note">± is how much bedtime varies from night to night. Times are as logged, in whatever timezone you were in.</p>`));
      const haul = [grp("After a long flight (over 3,000 km)", fd.filter(r => r.flKm >= 3000), r => r.sleep, 2), grp("After a shorter flight", fd.filter(r => r.flKm > 0 && r.flKm < 3000), r => r.sleep, 0), grp("Usual night at home", R.filter(r => kindOf(r) === "home"), r => r.sleep, 3)];
      if (haul.slice(0, 2).some(g => g.n >= 3) && enough(haul)) bf.push(card("Long haul or short hop", "Sleep on the night of the flight.", X.paired(haul, { fmt: slp, unit: "nights" })));
      const ph = [grp("3 days before a trip", R.filter(r => r.phase === "before"), r => r.mood, 4), grp("During a trip", R.filter(r => r.phase === "during"), r => r.mood, 0), grp("The week after", R.filter(r => r.phase === "after"), r => r.mood, 1), grp("Other days", R.filter(r => r.phase === "other"), r => r.mood, 3)];
      if (ph.slice(0, 3).some(g => g.n >= 3) && enough(ph)) bf.push(card("Mood around a trip", "Average mood, out of 5.", X.paired(ph, { fmt: f1 })));
    }

    /* ----- music and flights ----- */
    let mf = [];
    if (has.music && has.flights) {
      const mu = R.filter(r => r.music != null);
      const k3 = [grp("Flight days", mu.filter(r => kindOf(r) === "flight"), r => r.music, 0), grp("Away on a trip", mu.filter(r => kindOf(r) === "away"), r => r.music, 1), grp("At home", mu.filter(r => kindOf(r) === "home"), r => r.music, 3)];
      if (enough(k3)) mf.push(card("Listening on the move", k3[0].n >= 3 && k3[2].n >= 3 ? sentence(k3[0], k3[2], "You listen", dur) : "", X.paired(k3, { fmt: dur })));
      const fp = mu.filter(r => r.fl && r.flMin > 0).map(r => ({ x: r.flMin, y: r.music, t: fmt(r.d, { day: "numeric", month: "short", year: "numeric" }) }));
      if (fp.length >= 3) mf.push(card("Longer flights, more music?", "Each dot is a day you flew.", X.scatter(fp, { min: 5, unit: "flight days", xFmt: v => `${(v / 60).toFixed(1)}h`, yFmt: dur, xLabel: "Time in the air", yLabel: "Music listened" })));
      if (D.v2) {
        const parts = [["Night (0–6)", [0, 1], 2], ["Morning (6–12)", [2, 3], 4], ["Afternoon (12–18)", [4, 5], 1], ["Evening (18–24)", [6, 7], 0]];
        const sets = [["At home", mu.filter(r => !r.trip && r.blocks)], ["Away", mu.filter(r => r.trip && r.blocks)]];
        if (sets.every(s => s[1].length >= 3)) mf.push(card("When you listen, home and away", "Each bar is 100% of the listening in that setting. Hours follow the timezone the summary was built in, not where you were.",
          X.stacked(sets.map(s => `${s[0]} (${s[1].length} days)`), parts.map(([name, bl, c]) => ({ name, c, vals: sets.map(s => s[1].reduce((n, r) => n + bl.reduce((q, b) => q + (r.blocks[b] || 0), 0), 0)) })), { share: true, fmt: dur, h: 90 })));
      }
      const tf = topArtists(R.filter(r => r.fl), 5), ta = topArtists(R.filter(r => r.trip && !r.fl), 5);
      if (tf.length || ta.length) mf.push(card("Your travel soundtrack", "The artist you played most on each of those days.",
        `<div class="cx-two"><div>${h3("On flight days")}${rankRows(tf) || X.none("No music on flight days yet.")}</div><div>${h3("On other days away")}${rankRows(ta) || X.none("No music on days away yet.")}</div></div>`));
    }

    /* ----- trips, with everything about them ----- */
    const tripList = D.trips.filter(tr => !tr.open && (y === "all" || tr.start.startsWith(y))).reverse().slice(0, 8);
    const tripCards = tripList.map(tr => {
      const rs = D.rows.slice(D.idx.get(tr.start), D.idx.get(tr.end) + 1), ta = topArtists(rs, 1)[0];
      const mins = rs.reduce((n, r) => n + (r.music || 0), 0), mood = X.mean(rs.map(r => r.mood).filter(Boolean)), steps = X.mean(rs.map(r => r.steps).filter(v => v != null)), sleep = X.mean(rs.map(r => r.sleep).filter(v => v != null));
      const p = A.Flights.AP.get(tr.dest);
      const bits = [ta ? `♪ ${esc(ta[0])}` : "", mins ? `${dur(mins)} of music` : "", mood != null ? `mood ${f1(mood)}` : "", steps != null ? `${stepsF(steps)} steps a day` : "", sleep != null ? `${slp(sleep)} a night` : ""].filter(Boolean);
      return `<div class="card"><div class="row"><b>${p ? A.Flights.flag(p.cc) + " " : ""}${esc(A.Flights.place(tr.dest))}</b><span class="sub">${tr.days} day${tr.days === 1 ? "" : "s"} · ${fmtNum(tr.km)} km</span></div>
        <div class="sub" style="margin-top:4px">${esc(fmt(tr.start, { day: "numeric", month: "short" }))} to ${esc(fmt(tr.end, { day: "numeric", month: "short", year: "numeric" }))} · ${tr.flights.map(f => esc(f.from)).concat(esc(tr.flights[tr.flights.length - 1].to)).join(" → ")}</div>
        ${bits.length ? `<div class="ftags">${bits.map(b => `<span>${b}</span>`).join("")}</div>` : `<div class="sub">Nothing else logged on these days.</div>`}</div>`;
    });

    /* ----- everything together ----- */
    const sy = y !== "all" ? y : years.find(k => D.rows.some(r => r.d.startsWith(k) && (r.logged || r.music || r.fl))) || years[0];
    const maxMusic = Math.max(1, ...D.rows.filter(r => r.d.startsWith(sy)).map(r => r.music || 0));
    const rowOf = d => D.rows[D.idx.get(d)];
    const stripRows = [
      has.body ? { label: "Mood", get: d => { const r = rowOf(d); return r && r.mood ? { o: r.mood / 5, t: MOODS[r.mood - 1], c: 0 } : null; } } : null,
      has.body ? { label: "Sleep", get: d => { const r = rowOf(d); return r && r.sleep != null ? { o: Math.min(1, r.sleep / 540), t: slp(r.sleep), c: 1 } : null; } } : null,
      has.body ? { label: "Steps", get: d => { const r = rowOf(d); return r && r.steps != null ? { o: Math.min(1, r.steps / (settings.stepGoal * 1.5)), t: `${stepsF(r.steps)} steps`, c: 3 } : null; } } : null,
      has.music ? { label: "Music", get: d => { const r = rowOf(d); return r && r.music ? { o: Math.sqrt(r.music / maxMusic), t: `${dur(r.music)}${r.top ? `, mostly ${r.top}` : ""}`, c: 4 } : null; } } : null,
      has.flights ? { label: "Travel", get: d => { const r = rowOf(d); return r && (r.fl || r.trip) ? { o: r.fl ? 1 : .4, t: r.fl ? "flight day" : `away (${A.Flights.place(r.trip.dest)})`, c: 2 } : null; } } : null
    ].filter(Boolean);
    const yearCard = card(`${sy} at a glance`, "One sliver per day, the same dates stacked. Stronger colour means more: a brighter mood, longer sleep, more steps or music. Travel is strong on flight days and faint on other days away.", X.strips(sy, stripRows));

    const vars = VARS.filter(v => { const xs = R.map(v.get).filter(x => x != null); return xs.length >= 15 && X.stdev(xs) > 0; });
    let matrix = "", findings = "";
    if (vars.length >= 3) {
      const cells = vars.map(b => vars.map(a => a === b ? null : pairOf(R, a, b)));
      const list = [];
      vars.forEach((b, j) => vars.forEach((a, i) => { const c = cells[j][i]; if (i < j && c && c.r != null && !SAME.some(s => s.includes(a.k) && s.includes(b.k)) && !(a.bin && b.bin)) list.push({ a, b, r: c.r, n: c.n, i, j }); }));
      list.sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
      const sel = st.pair && vars[st.pair[0]] && vars[st.pair[1]] && st.pair[0] !== st.pair[1] ? st.pair : list.length ? [list[0].i, list[0].j] : null;
      const sp = sel ? pairOf(R, vars[sel[0]], vars[sel[1]]) : null;
      matrix = card("What moves together", "Every pair of daily numbers. Strong colour means they rise together; the second colour means one rises as the other falls. Tap a square to see the days behind it.",
        X.grid(vars.map(v => v.k), vars.map(v => v.k), cells.map(row => row.map(c => c ? c.r : null)), { left: 34, ch: 20, diverging: true, max: .6, show: true, fmt: v => v.toFixed(2).replace("0.", "."), label: "Correlation between daily numbers",
          tip: (r, c, v) => r === c ? vars[r].name || vars[r].k : `${vars[c].name || vars[c].k} and ${vars[r].name || vars[r].k}: ${v == null ? "not enough days with both" : `${X.strength(v)} (r = ${v.toFixed(2)}, ${cells[r][c].n} days)`}`,
          attrs: (r, c) => r === c ? "" : `data-act="ins-pair" data-i="${c}" data-j="${r}" class="tap${sel && sel[0] === c && sel[1] === r ? " sel" : ""}"` })
        + (sp ? h3(`${vars[sel[1]].name || vars[sel[1]].k} against ${(vars[sel[0]].name || vars[sel[0]].k).toLowerCase()}`) + X.scatter(sp.pts, { min: 15, xFmt: vars[sel[0]].f, yFmt: vars[sel[1]].f, xLabel: vars[sel[0]].name || vars[sel[0]].k, yLabel: vars[sel[1]].name || vars[sel[1]].k }) : ""));
      const strong = list.filter(p => p.n >= 20 && Math.abs(p.r) >= .15).slice(0, 5);
      findings = `<section class="section"><h2>Strongest patterns</h2>${strong.length ? strong.map(p => {
        const a = p.a.bin ? p.a : p.b.bin ? p.b : p.a, b = a === p.a ? p.b : p.a;
        const text = a.bin ? `On ${a.bin}, you tend to have <b>${p.r > 0 ? b.more : b.less}</b>.` : `Days with ${a.more} tend to come with <b>${p.r > 0 ? b.more : b.less}</b>.`;
        return `<p class="insight">${text} <span class="sub">${X.strength(p.r).replace(/^a /, "A ")}, r = ${p.r.toFixed(2)} over ${fmtNum(p.n)} days.</span></p>`;
      }).join("") : `<p class="sub" style="margin-top:8px">No clear patterns yet. They show up once at least 20 days have both numbers and the link is more than noise.</p>`}
      <p class="note">These are patterns in your own days, not proof that one thing causes the other.</p></section>`;
    }

    const nothing = !bm.length && !bf.length && !mf.length && !tripCards.length && !matrix;
    return hero + chips + (nothing ? `<section class="section"><p class="sub">Not enough overlapping days in ${y === "all" ? "your data" : y} yet.</p></section>` : "") + `
    ${findings}
    <section class="section"><div class="stack">${yearCard}${matrix}</div></section>
    ${block("Body and music", "", bm)}
    ${block("Body and flights", "", bf)}
    ${block("Music and flights", "", mf)}
    ${tripCards.length ? `<section class="section"><h2>Your trips</h2><p class="sub" style="margin-top:6px">The latest ${tripCards.length === 1 ? "trip" : `${tripCards.length} trips`}, with what else happened on those days.</p><div class="stack" style="margin-top:12px">${tripCards.join("")}</div></section>` : ""}
    <p class="note" style="margin-top:16px">How to read this: sleep is counted on the night it started. Music days and hours follow the timezone your summary was built in, not where you were. Flight times are local and trips are guessed from your most-used airport, so days abroad can be off by a few hours.</p>`;
  }

  VIEWS.insights = viewInsights;
  EXTRA.actions["ins-year"] = el => { st.year = el.dataset.y; st.pair = null; paint(true); };
  EXTRA.actions["ins-pair"] = el => { st.pair = [+el.dataset.i, +el.dataset.j]; paint(true); };
})();
