/* Tracker: Music tab. Reads a Spotify data export in the browser and keeps only a compact summary. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A) return;
  const { $, esc, pad, today, parse, fmt, fmtNum, LS, toast, openSheet, closeSheet, paint, barsHtml, daysInYear, HOOKS, EXTRA, VIEWS } = A;

  const KEY = "stillday.music";
  const st = { year: "all", armed: false };
  let M = null;
  try { M = clean(JSON.parse(LS.get(KEY) || "null")); } catch (e) { M = null; }

  /* ---------- helpers ---------- */
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dur = m => m < 60 ? `${m} min` : `${fmtNum(Math.round(m / 60 * 10) / 10)} h`;
  const tick = () => new Promise(r => setTimeout(r));

  /* Rebuilds a summary from untrusted JSON (a backup file) so the page can never break on odd data. */
  function clean(o) {
    if (!o || typeof o !== "object" || o.v !== 1) return null;
    const n = v => (typeof v === "number" && isFinite(v) && v >= 0) ? v : 0;
    const s = v => typeof v === "string" ? v.slice(0, 160) : "";
    const arr = (a, f, max) => Array.isArray(a) ? a.slice(0, max).map(x => f(x)) : [];
    const fixed = (a, len) => arr(a, n, len).concat(Array(len).fill(0)).slice(0, len);
    const out = {
      v: 1, importedAt: s(o.importedAt), files: n(o.files), plays: n(o.plays), min: n(o.min), skips: n(o.skips),
      first: s(o.first), last: s(o.last), uniqueArtists: n(o.uniqueArtists), uniqueTracks: n(o.uniqueTracks),
      hours: fixed(o.hours, 24), wd: fixed(o.wd, 7),
      artists: arr(o.artists, r => [s(r && r[0]), n(r && r[1]), n(r && r[2])], 400),
      tracks: arr(o.tracks, r => [s(r && r[0]), s(r && r[1]), n(r && r[2]), n(r && r[3])], 400),
      albums: arr(o.albums, r => [s(r && r[0]), s(r && r[1]), n(r && r[2])], 200),
      names: arr(o.names, s, 5000), days: {}, years: {}
    };
    if (o.days && typeof o.days === "object") {
      for (const k of Object.keys(o.days).slice(0, 40000)) {
        const r = o.days[k];
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(r)) out.days[k] = [n(r[0]), n(r[1]), Math.floor(n(r[2]))];
      }
    }
    if (o.years && typeof o.years === "object") {
      for (const y of Object.keys(o.years).slice(0, 80)) {
        if (!/^\d{4}$/.test(y)) continue;
        const r = o.years[y] || {};
        out.years[y] = {
          min: n(r.min), plays: n(r.plays), skips: n(r.skips), artists: n(r.artists), hours: fixed(r.hours, 24), wd: fixed(r.wd, 7),
          topArtists: arr(r.topArtists, x => [s(x && x[0]), n(x && x[1])], 30),
          topTracks: arr(r.topTracks, x => [s(x && x[0]), s(x && x[1]), n(x && x[2])], 30)
        };
      }
    }
    return out.plays ? out : null;
  }

  /* ---------- reading a Spotify export ---------- */
  function newAgg() {
    return { seen: new Set(), plays: 0, ms: 0, skips: 0, first: Infinity, last: 0, artists: new Map(), tracks: new Map(), albums: new Map(), days: new Map(), years: new Map(), hours: Array(24).fill(0), wd: Array(7).fill(0) };
  }
  function bump(map, key, init) { let v = map.get(key); if (!v) { v = init(); map.set(key, v); } return v; }

  // Handles both Spotify formats: "Account data" (StreamingHistory*.json) and "Extended streaming history".
  function addPlay(g, r) {
    let ts, ms, artist, track, album;
    if (r && r.ts) { ts = Date.parse(r.ts); ms = r.ms_played; artist = r.master_metadata_album_artist_name; track = r.master_metadata_track_name; album = r.master_metadata_album_album_name; }
    else if (r && r.endTime) {
      let t = String(r.endTime).trim().replace(" ", "T"); if (t.length === 16) t += ":00";
      ts = Date.parse(t + "Z"); ms = r.msPlayed; artist = r.artistName; track = r.trackName;
    } else return;
    if (!isFinite(ts) || typeof ms !== "number" || !isFinite(ms) || ms < 0 || !artist || !track) return; // podcasts and malformed rows
    const key = Math.floor(ts / 60000) + "|" + track + "|" + artist;
    if (g.seen.has(key)) return; // the same play can appear in two exports
    g.seen.add(key);
    const start = new Date(ts - ms), date = iso(start), y = String(start.getFullYear());
    const yr = bump(g.years, y, () => ({ ms: 0, plays: 0, skips: 0, hours: Array(24).fill(0), wd: Array(7).fill(0), artists: new Map(), tracks: new Map() }));
    if (ms < 30000) { g.skips++; yr.skips++; return; } // under 30 seconds counts as a skip
    const h = start.getHours(), w = (start.getDay() + 6) % 7, tk = track + "\u0001" + artist;
    g.plays++; g.ms += ms; yr.plays++; yr.ms += ms;
    g.hours[h] += ms; g.wd[w] += ms; yr.hours[h] += ms; yr.wd[w] += ms;
    if (start < g.first) g.first = +start; if (+start > g.last) g.last = +start;
    const a = bump(g.artists, artist, () => [0, 0]); a[0] += ms; a[1]++;
    const ya = bump(yr.artists, artist, () => [0, 0]); ya[0] += ms; ya[1]++;
    const t = bump(g.tracks, tk, () => [track, artist, 0, 0]); t[2] += ms; t[3]++;
    const yt = bump(yr.tracks, tk, () => [track, artist, 0]); yt[2] += ms;
    if (album) { const b = bump(g.albums, album + "\u0001" + artist, () => [album, artist, 0]); b[2] += ms; }
    const d = bump(g.days, date, () => ({ p: 0, ms: 0, a: new Map() })); d.p++; d.ms += ms; d.a.set(artist, (d.a.get(artist) || 0) + ms);
  }

  function finalize(g, files) {
    const min = ms => Math.round(ms / 60000);
    const top = (rows, idx, n) => rows.sort((a, b) => b[idx] - a[idx]).slice(0, n);
    const names = [], nameIdx = new Map(), days = {};
    for (const [date, d] of g.days) {
      let best = "", bm = -1;
      for (const [a, m] of d.a) if (m > bm) { bm = m; best = a; }
      let i = nameIdx.get(best); if (i == null) { i = names.length; names.push(best); nameIdx.set(best, i); }
      days[date] = [d.p, min(d.ms), i];
    }
    const years = {};
    for (const [y, r] of g.years) {
      years[y] = {
        min: min(r.ms), plays: r.plays, skips: r.skips, artists: r.artists.size, hours: r.hours.map(min), wd: r.wd.map(min),
        topArtists: top([...r.artists].map(([k, v]) => [k, v[0]]), 1, 20).map(x => [x[0], min(x[1])]),
        topTracks: top([...r.tracks.values()], 2, 20).map(x => [x[0], x[1], min(x[2])])
      };
    }
    return {
      v: 1, importedAt: new Date().toISOString(), files, plays: g.plays, min: min(g.ms), skips: g.skips,
      first: g.plays ? iso(new Date(g.first)) : "", last: g.plays ? iso(new Date(g.last)) : "",
      uniqueArtists: g.artists.size, uniqueTracks: g.tracks.size,
      hours: g.hours.map(min), wd: g.wd.map(min),
      artists: top([...g.artists].map(([k, v]) => [k, v[0], v[1]]), 1, 300).map(r => [r[0], min(r[1]), r[2]]),
      tracks: top([...g.tracks.values()], 2, 200).map(r => [r[0], r[1], min(r[2]), r[3]]),
      albums: top([...g.albums.values()], 2, 100).map(r => [r[0], r[1], min(r[2])]),
      names, days, years
    };
  }

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = () => res(window.JSZip);
      s.onerror = () => rej(new Error("Couldn't load the zip reader. Unzip the file and choose the .json files instead."));
      document.head.appendChild(s);
    });
  }
  const isHistory = path => { const f = path.split("/").pop(); return /\.json$/i.test(f) && /streaming[_ ]?history/i.test(f) && !/video|podcast/i.test(f); };
  const progress = msg => { const el = $("#musicProg"); if (el) el.textContent = msg; };

  async function importFiles(list) {
    const files = [...list];
    if (!files.length) return;
    openSheet(`<div class="sheet-head"><h2>Reading your history</h2></div><p class="sub" id="musicProg">Looking through ${files.length} file${files.length === 1 ? "" : "s"}…</p><p class="note">${A.sync && A.sync.signedIn() ? "Only a summary is kept, in your Tracker Drive folder, so your other devices get it too." : "Everything stays in this browser."} Large exports can take a minute.</p>`);
    try {
      const entries = [];
      for (const f of files) {
        if (/\.zip$/i.test(f.name)) {
          progress("Opening the zip…");
          const zip = await (await loadJSZip()).loadAsync(f);
          zip.forEach((path, entry) => { if (!entry.dir && isHistory(path)) entries.push({ read: () => entry.async("string") }); });
        } else if (isHistory(f.name)) entries.push({ read: () => f.text() });
      }
      if (!entries.length) throw new Error("No Spotify streaming history files found. Look for files named StreamingHistory… or Streaming_History_Audio….");
      const g = newAgg();
      let used = 0;
      for (let i = 0; i < entries.length; i++) {
        progress(`Reading file ${i + 1} of ${entries.length}…`);
        await tick();
        let rows = null;
        try { rows = JSON.parse(await entries[i].read()); } catch (e) { continue; }
        if (!Array.isArray(rows)) continue;
        used++;
        for (let j = 0; j < rows.length; j++) { addPlay(g, rows[j]); if (j % 40000 === 39999) await tick(); }
      }
      if (!g.plays) throw new Error("Those files didn't contain any music plays.");
      progress("Summarising…"); await tick();
      const next = finalize(g, used);
      if (!LS.set(KEY, JSON.stringify(next))) throw new Error("Couldn't save the summary. Browser storage may be full.");
      M = next; st.year = "all"; A.changed();
      closeSheet(); paint(true);
      toast(`Imported ${fmtNum(M.plays)} plays`);
      // Keep the summary in Drive, so you never have to choose these files again on another device.
      if (driveReady()) {
        A.sync.call("musicSave", { summary: M })
          .then(() => { drive = { checkedAt: new Date().toISOString(), files: 0, error: "" }; LS.set(DKEY, JSON.stringify(drive)); toast("Music saved to your Drive for your other devices"); })
          .catch(e => toast(`Music is on this device, but saving it to Drive failed: ${e.message}`));
      }
    } catch (e) {
      closeSheet(); toast(e.message || "Couldn't read those files.");
    }
  }

  const picker = document.createElement("input");
  picker.type = "file"; picker.id = "musicFile"; picker.multiple = true; picker.hidden = true;
  picker.accept = ".zip,.json,application/json,application/zip";
  picker.addEventListener("change", () => { const f = [...picker.files]; picker.value = ""; importFiles(f); });
  document.body.appendChild(picker);

  /* ---------- Google Drive: the sheet script reads a Drive folder and sends back the summary ---------- */
  const DKEY = "stillday.musicDrive";
  let drive = {};
  try { drive = JSON.parse(LS.get(DKEY) || "{}") || {}; } catch (e) { drive = {}; }
  let driveBusy = false, autoTried = false;
  const driveReady = () => !!(A.sync && A.sync.signedIn());
  async function fromDrive(manual) {
    if (driveBusy) return;
    if (!driveReady()) { if (manual) toast("Sign in first (Settings → Account)."); return; }
    driveBusy = true; if (manual) paint(true);
    try {
      const out = await A.sync.call("music", { force: manual === "force" });
      const next = clean(out.summary);
      drive = { checkedAt: new Date().toISOString(), files: out.files || 0, error: "" };
      if (!next) throw new Error(out.message || "No Spotify history found in the Drive folder yet.");
      const changed = !M || next.importedAt !== M.importedAt || next.plays !== M.plays;
      if (changed) {
        if (!LS.set(KEY, JSON.stringify(next))) throw new Error("Couldn't save the summary. Browser storage may be full.");
        M = next; A.changed();
      }
      if (manual || changed) toast(changed ? `Music updated: ${fmtNum(M.plays)} plays` : "Music is up to date");
    } catch (e) {
      drive = Object.assign(drive, { checkedAt: new Date().toISOString(), error: e.message || String(e) });
      if (manual) toast(e.message || "Couldn't read the Drive folder.");
    }
    LS.set(DKEY, JSON.stringify(drive));
    driveBusy = false;
    if (document.querySelector("#view") && A.VIEWS && document.querySelector('[data-tab="music"].on')) paint(true);
  }
  // Check Drive when nothing is loaded on this device yet, otherwise at most every 6 hours.
  function check() {
    if (!driveReady() || driveBusy) return Promise.resolve();
    const last = Date.parse(drive.checkedAt || 0) || 0;
    if (M && Date.now() - last < 6 * 3600e3) return Promise.resolve();
    return fromDrive(false);
  }
  function autoCheck() {
    if (autoTried || !driveReady()) return;
    autoTried = true;
    setTimeout(check, 400);
  }
  A.music = { fromDrive, check, has: () => !!M };
  const when = iso => { try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
  function driveBar() {
    if (!driveReady()) return `<p class="note">Sign in (Settings → Account) to keep your music in Google Drive.</p>`;
    return `<div class="drive-bar">
      <span class="sub">${driveBusy ? "Reading your Drive folder…" : drive.error ? `Last check failed: ${esc(drive.error)}` : drive.checkedAt ? `Checked Drive ${esc(when(drive.checkedAt))}` : "Not checked yet"}</span>
      <button class="chip" data-act="music-drive" ${driveBusy ? "disabled" : ""}>${driveBusy ? "Checking…" : "Check Drive now"}</button>
    </div>`;
  }

  /* ---------- views ---------- */
  function heatmap(y) {
    const first = new Date(+y, 0, 1), offset = (first.getDay() + 6) % 7, n = daysInYear(+y);
    const weeks = Math.ceil((offset + n) / 7), keys = [];
    let max = 0;
    for (let i = 0; i < n; i++) { const k = iso(new Date(+y, 0, 1 + i)); keys.push(k); const r = M.days[k]; if (r && r[1] > max) max = r[1]; }
    let cells = "", labels = "";
    keys.forEach((k, i) => {
      const col = Math.floor((offset + i) / 7), row = (offset + i) % 7, r = M.days[k];
      const op = r && max ? (0.22 + 0.78 * Math.sqrt(r[1] / max)).toFixed(2) : 0;
      cells += `<rect x="${col * 12}" y="${26 + row * 12}" width="10" height="10" rx="3" ${r ? `style="fill:var(--accent);fill-opacity:${op}"` : 'style="fill:var(--surface2)"'}><title>${esc(fmt(k, { day: "numeric", month: "short", year: "numeric" }))}${r ? `: ${r[1]} min, ${r[0]} plays` : ""}</title></rect>`;
      if (k.endsWith("-01")) labels += `<text x="${col * 12}" y="16" font-size="16" fill="var(--muted)">${esc(parse(k).toLocaleDateString("en-GB", { month: "short" }))}</text>`;
    });
    return `<svg class="heat" viewBox="0 0 ${weeks * 12} 110" role="img" aria-label="Listening by day, ${y}">${labels}${cells}</svg>`;
  }

  function rank(list, valOf, subOf, nameOf) {
    const max = Math.max(1, ...list.map(valOf));
    return list.map((r, i) => `<div class="rank"><span class="no">${i + 1}</span><div class="nm"><b>${esc(nameOf(r))}</b>${subOf(r) ? `<small>${esc(subOf(r))}</small>` : ""}<div class="bar2"><i style="width:${(valOf(r) / max * 100).toFixed(1)}%;animation-delay:${i * 40}ms"></i></div></div><span class="val">${dur(valOf(r))}</span></div>`).join("");
  }

  function viewMusic() {
    autoCheck();
    if (!M) {
      return `
      <section class="hero">
        <div class="eyebrow">Your soundtrack</div>
        <div class="hero-row"><h1>Music</h1></div>
        <div class="hero-meta"><span class="sub">See what you actually listened to.</span></div>
      </section>
      <section class="section"><div class="card empty">${A.ILLO.spot("music", "empty-spot")}
        <b style="font-size:18px">Load your Spotify history from Google Drive</b>
        <p>Keep your Spotify export in a Drive folder called <b>Tracker Spotify</b>. Your sheet script reads it and sends Tracker a small summary. Drop in a new export any time and it updates by itself.</p>
        <button class="btn primary" data-act="music-drive" style="margin-top:6px" ${driveBusy ? "disabled" : ""}>${driveBusy ? "Reading your Drive folder…" : "Load from Drive"}</button>
        ${driveReady() ? (drive.error ? `<p class="note">Last check: ${esc(drive.error)}</p>` : "") : `<p class="note">Sign in first (Settings → Account).</p>`}
      </div></section>
      <section class="section">
        <h2>How to set it up</h2>
        <ol class="steps">
          <li>Request your data at <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noopener">spotify.com/account/privacy</a>. <b>Extended streaming history</b> covers your whole listening life (can take up to 30 days); <b>Account data</b> covers the last year.</li>
          <li>In Google Drive, make a folder called <b>Tracker Spotify</b>.</li>
          <li>Unzip Spotify's download and put the JSON files (or the whole folder) in it. A ZIP works too if it's not huge.</li>
          <li>Tap <b>Load from Drive</b>. After that, Tracker checks the folder by itself when you open Music.</li>
        </ol>
        <p class="note">Plays under 30 seconds count as skips and podcasts are left out. Have the files on this device instead? <button class="linkbtn" data-act="music-import">Choose them here</button>. Tracker reads them once and keeps the summary in your Drive folder, so you don't need to do it again on another device.</p>
      </section>`;
    }

    const years = Object.keys(M.years).sort().reverse();
    const y = st.year !== "all" && M.years[st.year] ? st.year : "all";
    const Y = y === "all" ? null : M.years[y];
    const minTotal = Y ? Y.min : M.min, plays = Y ? Y.plays : M.plays, skips = Y ? Y.skips : M.skips;
    const artistsN = Y ? Y.artists : M.uniqueArtists;
    const keys = Object.keys(M.days).filter(k => !Y || k.startsWith(y)).sort();
    const span = Y ? (+y === new Date().getFullYear() ? Math.max(1, Math.round((parse(today()) - new Date(+y, 0, 1)) / 864e5) + 1) : daysInYear(+y))
                   : (keys.length ? Math.max(1, Math.round((parse(keys[keys.length - 1]) - parse(keys[0])) / 864e5) + 1) : 1);
    const hours = Y ? Y.hours : M.hours, wd = Y ? Y.wd : M.wd;
    const tile = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;

    let best = null;
    keys.forEach(k => { if (!best || M.days[k][1] > M.days[best][1]) best = k; });

    let monthBars;
    if (Y) {
      const mins = Array.from({ length: 12 }, () => 0);
      keys.forEach(k => { mins[+k.slice(5, 7) - 1] += M.days[k][1]; });
      const MN = Array.from({ length: 12 }, (_, m) => new Date(+y, m, 1).toLocaleDateString("en-GB", { month: "long" }));
      monthBars = { title: "Minutes per month", html: barsHtml(mins, Math.max(...mins, 1), "JFMAMJJASOND".split(""), mins.map((v, i) => `${MN[i]}: ${v} min`), "m12") };
    } else {
      const ys = Object.keys(M.years).sort(), vals = ys.map(k => M.years[k].min);
      monthBars = { title: "Hours per year", html: barsHtml(vals.map(v => Math.round(v / 60)), Math.max(...vals.map(v => Math.round(v / 60)), 1), ys.map(k => "’" + k.slice(2)), ys.map((k, i) => `${k}: ${Math.round(vals[i] / 60)} h`), ys.length > 8 ? "m12" : "") };
    }

    const topA = Y ? Y.topArtists.slice(0, 10) : M.artists.slice(0, 10);
    const topT = Y ? Y.topTracks.slice(0, 10) : M.tracks.slice(0, 10);
    const heatYear = Y ? y : (years[0] || String(new Date().getFullYear()));
    const hrLabels = hours.map((_, i) => i % 6 === 0 ? String(i) : "");
    const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const peakH = hours.indexOf(Math.max(...hours)), peakD = wd.indexOf(Math.max(...wd));

    return `
    <section class="hero">
      <div class="eyebrow">${esc(M.first ? fmt(M.first, { month: "short", year: "numeric" }) : "")} to ${esc(M.last ? fmt(M.last, { month: "short", year: "numeric" }) : "")}</div>
      <div class="hero-row"><h1>Music</h1>${A.ILLO.spot("music", "hero-spot")}</div>
      <div class="hero-meta"><span class="sub">${fmtNum(M.plays)} plays in your history</span></div>
      ${driveBar()}
    </section>
    <div class="chips section" style="margin-top:18px">
      <button class="chip ${y === "all" ? "on" : ""}" data-act="music-year" data-y="all">All time</button>
      ${years.map(k => `<button class="chip ${y === k ? "on" : ""}" data-act="music-year" data-y="${k}">${k}</button>`).join("")}
    </div>
    <section class="section">
      <div class="stat-grid">
        ${tile(fmtNum(Math.round(minTotal / 60)), "hours listened")}
        ${tile(fmtNum(plays), "plays")}
        ${tile(fmtNum(artistsN), "artists")}
        ${tile(`${Math.round(minTotal / span)}`, "minutes a day")}
        ${tile(fmtNum(keys.length), "listening days")}
        ${tile(plays + skips ? `${Math.round(skips / (plays + skips) * 100)}%` : "–", "skipped early")}
      </div>
    </section>
    <section class="section">
      <div class="card">
        <span class="label" style="margin:0">${Y ? `Every day of ${y}` : `Every day of ${heatYear} (latest year)`}</span>
        ${heatmap(heatYear)}
      </div>
    </section>
    ${best ? `<section class="section"><div class="card">
      <span class="label" style="margin:0">Biggest listening day</span>
      <p class="quote" style="margin-top:6px">${esc(fmt(best, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>
      <div class="sub">${dur(M.days[best][1])}, mostly ${esc(M.names[M.days[best][2]] || "")}</div>
    </div></section>` : ""}
    <section class="section">
      <div class="card">
        <span class="label" style="margin:0">${monthBars.title}</span>
        ${monthBars.html}
      </div>
    </section>
    <section class="section">
      <div class="card">
        <span class="label" style="margin:0">When you listen</span>
        <div class="sub" style="margin-top:2px">Mostly around ${pad(peakH)}:00, and most on ${["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][peakD]}.</div>
        ${barsHtml(hours, Math.max(...hours, 1), hrLabels, hours.map((v, i) => `${pad(i)}:00: ${v} min`), "m24")}
        ${barsHtml(wd, Math.max(...wd, 1), ["M", "T", "W", "T", "F", "S", "S"], wd.map((v, i) => `${WD[i]}: ${v} min`))}
      </div>
    </section>
    <section class="section">
      <h2>Top artists</h2>
      <div class="card" style="margin-top:12px;padding-top:6px;padding-bottom:6px">${rank(topA, r => r[1], r => "", r => r[0]) || '<p class="sub">Nothing yet.</p>'}</div>
    </section>
    <section class="section">
      <h2>Top tracks</h2>
      <div class="card" style="margin-top:12px;padding-top:6px;padding-bottom:6px">${rank(topT, r => r[2], r => r[1], r => r[0]) || '<p class="sub">Nothing yet.</p>'}</div>
    </section>
    ${!Y && M.albums.length ? `<section class="section">
      <h2>Top albums</h2>
      <div class="card" style="margin-top:12px;padding-top:6px;padding-bottom:6px">${rank(M.albums.slice(0, 10), r => r[2], r => r[1], r => r[0])}</div>
    </section>` : ""}
    <section class="section">
      <p class="note" style="margin-top:0">Each day's top artist also appears as the soundtrack on that day's Today page.</p>
      <div class="grid2" style="margin-top:12px">
        <button class="btn" data-act="music-drive" data-force="1">Re-read Drive folder</button>
        <button class="btn danger" data-act="music-remove">${st.armed ? "Tap again to remove" : "Remove music data"}</button>
      </div>
    </section>`;
  }

  VIEWS.music = viewMusic;

  /* ---------- hooks ---------- */
  EXTRA.actions["music-import"] = () => picker.click();
  EXTRA.actions["music-drive"] = el => fromDrive(el.dataset.force ? "force" : true);
  EXTRA.actions["music-year"] = el => { st.year = el.dataset.y; st.armed = false; paint(true); };
  EXTRA.actions["music-remove"] = () => {
    if (!st.armed) { st.armed = true; paint(true); return; }
    st.armed = false; M = null; LS.del(KEY); A.changed(); paint(true); toast("Music data removed");
  };

  EXTRA.today.push(d => {
    const r = M && M.days[d];
    if (!r) return "";
    return `<section class="section"><span class="label">Soundtrack of the day</span>
      <div class="card"><b>${esc(M.names[r[2]] || "Unknown")}</b><div class="sub">${r[1]} min listened · ${r[0]} plays</div></div></section>`;
  });

  HOOKS.exportParts.push(() => M ? { music: M } : {});
  HOOKS.importParts.push(raw => { const c = clean(raw && raw.music); if (c && LS.set(KEY, JSON.stringify(c))) M = c; });
  HOOKS.wipe.push(() => { M = null; LS.del(KEY); });
  HOOKS.syncParts.push(() => {
    if (!M) return {};
    const months = {};
    Object.keys(M.days).forEach(k => { const m = k.slice(0, 7), r = months[m] || (months[m] = [0, 0]); r[0] += M.days[k][1]; r[1] += M.days[k][0]; });
    return { music: {
      summary: [["Plays", M.plays], ["Minutes listened", M.min], ["Artists", M.uniqueArtists], ["Tracks", M.uniqueTracks], ["Skipped early", M.skips], ["From", M.first], ["To", M.last]],
      topArtists: M.artists.slice(0, 100),
      months: Object.keys(months).sort().map(m => [m, months[m][0], months[m][1]])
    } };
  });
})();
