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
    // v1 is the first summary; v2 adds per-day skips, artist counts and time-of-day blocks, a weekday-by-hour grid, months and artist spans.
    if (!o || typeof o !== "object" || (o.v !== 1 && o.v !== 2)) return null;
    const v2 = o.v === 2;
    const n = v => (typeof v === "number" && isFinite(v) && v >= 0) ? v : 0;
    const s = v => typeof v === "string" ? v.slice(0, 160) : "";
    const arr = (a, f, max) => Array.isArray(a) ? a.slice(0, max).map(x => f(x)) : [];
    const fixed = (a, len) => arr(a, n, len).concat(Array(len).fill(0)).slice(0, len);
    const out = {
      v: o.v, importedAt: s(o.importedAt), files: n(o.files), plays: n(o.plays), min: n(o.min), skips: n(o.skips),
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
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(r)) out.days[k] = [n(r[0]), n(r[1]), Math.floor(n(r[2]))].concat(v2 ? fixed(r.slice(3), 10) : []);
      }
    }
    if (v2) {
      out.hw = fixed(o.hw, 168); out.months = {};
      if (o.months && typeof o.months === "object") for (const k of Object.keys(o.months).slice(0, 1200)) if (/^\d{4}-\d{2}$/.test(k)) out.months[k] = fixed(o.months[k], 4);
      out.artistSpan = arr(o.artistSpan, r => [s(r && r[0]), s(r && r[1]), s(r && r[2]), n(r && r[3])], 60);
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
        if (v2) out.years[y].hw = fixed(r.hw, 168);
      }
    }
    return out.plays ? out : null;
  }

  /* ---------- reading a Spotify export ---------- */
  function newAgg() {
    return { seen: new Set(), plays: 0, ms: 0, skips: 0, first: Infinity, last: 0, artists: new Map(), tracks: new Map(), albums: new Map(), days: new Map(), years: new Map(), hours: Array(24).fill(0), wd: Array(7).fill(0), hw: Array(168).fill(0), months: new Map() };
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
    const yr = bump(g.years, y, () => ({ ms: 0, plays: 0, skips: 0, hours: Array(24).fill(0), wd: Array(7).fill(0), hw: Array(168).fill(0), artists: new Map(), tracks: new Map() }));
    const d = bump(g.days, date, () => ({ p: 0, ms: 0, s: 0, b: Array(8).fill(0), a: new Map() }));
    const mo = bump(g.months, date.slice(0, 7), () => ({ a: new Set(), s: 0 }));
    if (ms < 30000) { g.skips++; yr.skips++; d.s++; mo.s++; return; } // under 30 seconds counts as a skip
    const h = start.getHours(), w = (start.getDay() + 6) % 7, tk = track + "\u0001" + artist;
    g.plays++; g.ms += ms; yr.plays++; yr.ms += ms;
    g.hours[h] += ms; g.wd[w] += ms; yr.hours[h] += ms; yr.wd[w] += ms;
    g.hw[w * 24 + h] += ms; yr.hw[w * 24 + h] += ms;
    if (start < g.first) g.first = +start; if (+start > g.last) g.last = +start;
    // Artists also keep their first and last play and the months they were heard in.
    const a = bump(g.artists, artist, () => [0, 0, Infinity, 0, new Set()]); a[0] += ms; a[1]++;
    if (+start < a[2]) a[2] = +start; if (+start > a[3]) a[3] = +start; a[4].add(date.slice(0, 7));
    const ya = bump(yr.artists, artist, () => [0, 0]); ya[0] += ms; ya[1]++;
    const t = bump(g.tracks, tk, () => [track, artist, 0, 0, Infinity]); t[2] += ms; t[3]++; if (+start < t[4]) t[4] = +start;
    const yt = bump(yr.tracks, tk, () => [track, artist, 0]); yt[2] += ms;
    if (album) { const b = bump(g.albums, album + "\u0001" + artist, () => [album, artist, 0]); b[2] += ms; }
    d.p++; d.ms += ms; d.b[Math.floor(h / 3)] += ms; d.a.set(artist, (d.a.get(artist) || 0) + ms);
    mo.a.add(artist);
  }

  function finalize(g, files) {
    const min = ms => Math.round(ms / 60000);
    const top = (rows, idx, n) => rows.sort((a, b) => b[idx] - a[idx]).slice(0, n);
    const names = [], nameIdx = new Map(), days = {};
    for (const [date, d] of g.days) {
      let best = "", bm = -1;
      for (const [a, m] of d.a) if (m > bm) { bm = m; best = a; }
      let i = nameIdx.get(best); if (i == null) { i = names.length; names.push(best); nameIdx.set(best, i); }
      // plays, minutes, top artist, skips, different artists, then minutes in eight 3-hour blocks from midnight
      days[date] = [d.p, min(d.ms), i, d.s, d.a.size].concat(d.b.map(min));
    }
    // Per month: artists and tracks heard for the first time, different artists, skips.
    const months = {};
    for (const [m, r] of g.months) months[m] = [0, 0, r.a.size, r.s];
    for (const a of g.artists.values()) { const m = months[iso(new Date(a[2])).slice(0, 7)]; if (m) m[0]++; }
    for (const t of g.tracks.values()) { const m = months[iso(new Date(t[4])).slice(0, 7)]; if (m) m[1]++; }
    const years = {};
    for (const [y, r] of g.years) {
      years[y] = {
        min: min(r.ms), plays: r.plays, skips: r.skips, artists: r.artists.size, hours: r.hours.map(min), wd: r.wd.map(min), hw: r.hw.map(min),
        topArtists: top([...r.artists].map(([k, v]) => [k, v[0]]), 1, 20).map(x => [x[0], min(x[1])]),
        topTracks: top([...r.tracks.values()], 2, 20).map(x => [x[0], x[1], min(x[2])])
      };
    }
    return {
      v: 2, importedAt: new Date().toISOString(), files, plays: g.plays, min: min(g.ms), skips: g.skips,
      first: g.plays ? iso(new Date(g.first)) : "", last: g.plays ? iso(new Date(g.last)) : "",
      uniqueArtists: g.artists.size, uniqueTracks: g.tracks.size,
      hours: g.hours.map(min), wd: g.wd.map(min),
      artists: top([...g.artists].map(([k, v]) => [k, v[0], v[1]]), 1, 300).map(r => [r[0], min(r[1]), r[2]]),
      tracks: top([...g.tracks.values()], 2, 200).map(r => [r[0], r[1], min(r[2]), r[3]]),
      albums: top([...g.albums.values()], 2, 100).map(r => [r[0], r[1], min(r[2])]),
      names, days, years,
      hw: g.hw.map(min), months,
      artistSpan: top([...g.artists].map(([k, v]) => [k, v[0], v[2], v[3], v[4].size]), 1, 50).map(r => [r[0], iso(new Date(r[2])), iso(new Date(r[3])), r[4]])
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
          .then(out => { drive = { checkedAt: new Date().toISOString(), files: 0, error: "", sig: (out && out.sig) || "" }; LS.set(DKEY, JSON.stringify(drive)); toast("Music saved to your Drive for your other devices"); })
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
      // Tell the script which version this device has, so an unchanged summary isn't downloaded again.
      const have = M && manual !== "force" ? drive.sig || "" : "";
      const out = await A.sync.call("music", { force: manual === "force", have });
      drive = { checkedAt: new Date().toISOString(), files: out.files || 0, error: "", sig: out.sig || "" };
      if (out.same) {
        if (manual) toast("Music is up to date");
        throw null;
      }
      const next = clean(out.summary);
      if (!next) throw new Error(out.message || "No Spotify history found in the Drive folder yet.");
      const changed = !M || next.importedAt !== M.importedAt || next.plays !== M.plays;
      if (changed) {
        if (!LS.set(KEY, JSON.stringify(next))) throw new Error("Couldn't save the summary. Browser storage may be full.");
        M = next; A.changed();
      }
      if (manual || changed) toast(changed ? `Music updated: ${fmtNum(M.plays)} plays` : "Music is up to date");
    } catch (e) {
      // null: nothing went wrong, the summary just hadn't changed.
      if (e !== null) {
        drive = Object.assign(drive, { checkedAt: new Date().toISOString(), error: e.message || String(e) });
        if (manual) toast(e.message || "Couldn't read the Drive folder.");
      }
    }
    if (manual) delete drive.removed;
    LS.set(DKEY, JSON.stringify(drive));
    driveBusy = false;
    if (document.querySelector("#view") && A.VIEWS && document.querySelector('[data-tab="music"].on')) paint(true);
  }
  // Check Drive the first time, then at most every 6 hours (also when the folder had nothing yet).
  // After "Remove music data" it only looks again when you ask it to.
  function check() {
    if (!driveReady() || driveBusy || drive.removed) return Promise.resolve();
    const last = Date.parse(drive.checkedAt || 0) || 0;
    if (Date.now() - last < 6 * 3600e3) return Promise.resolve();
    return fromDrive(false);
  }
  function autoCheck() {
    if (autoTried || !driveReady()) return;
    autoTried = true;
    setTimeout(check, 400);
  }
  A.music = { fromDrive, check, has: () => !!M, get: () => M };
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
      const op = r && r[0] && max ? (0.22 + 0.78 * Math.sqrt(r[1] / max)).toFixed(2) : 0;
      cells += `<rect x="${col * 12}" y="${26 + row * 12}" width="10" height="10" rx="3" ${r && r[0] ? `style="fill:var(--accent);fill-opacity:${op}"` : 'style="fill:var(--surface2)"'}><title>${esc(fmt(k, { day: "numeric", month: "short", year: "numeric" }))}${r && r[0] ? `: ${r[1]} min, ${r[0]} plays` : ""}</title></rect>`;
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
        <div class="hero-row"><h1>Music</h1>${A.ILLO.spot("music", "hero-spot")}</div>
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
    // Days with at least one real play (a day of only skips doesn't count as a listening day).
    const keys = Object.keys(M.days).filter(k => M.days[k][0] > 0 && (!Y || k.startsWith(y))).sort();
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

    /* ----- more chart types (charts.js) ----- */
    const X = A.Charts, V2 = M.v >= 2;
    const card = (title, body, sub) => `<section class="section"><div class="card"><span class="label" style="margin:0">${esc(title)}</span>${sub ? `<div class="sub" style="margin-top:2px">${sub}</div>` : ""}${body}</div></section>`;
    const MNL = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString("en-GB", { month: "long" }));
    const yearsAsc = Object.keys(M.years).sort();
    // Periods: the months of one year, or every year.
    const P = Y ? { keys: MNL.map((_, i) => `${y}-${pad(i + 1)}`), labels: "JFMAMJJASOND".split(""), tips: MNL.map(m => `${m} ${y}`), name: "month" }
                : { keys: yearsAsc, labels: yearsAsc.map(k => "’" + k.slice(2)), tips: yearsAsc, name: "year" };
    const inP = (k, p) => k.startsWith(p);
    const hF = v => `${fmtNum(Math.round(v / 60 * 10) / 10)} h`;

    // Weekday by hour
    const hw = V2 ? (Y ? Y.hw : M.hw) : null;
    const whenBody = hw && hw.some(v => v)
      ? X.grid(WD, hours.map((_, i) => pad(i)), WD.map((_, d) => hw.slice(d * 24, d * 24 + 24)), { colEvery: 3, ch: 13, fmt: dur, tip: (r, c, v) => `${WD[r]} ${pad(c)}:00 to ${pad(c)}:59: ${dur(v || 0)}`, label: "Listening by weekday and hour" })
      : `${barsHtml(hours, Math.max(...hours, 1), hrLabels, hours.map((v, i) => `${pad(i)}:00: ${v} min`), "m24")}${barsHtml(wd, Math.max(...wd, 1), ["M", "T", "W", "T", "F", "S", "S"], wd.map((v, i) => `${WD[i]}: ${v} min`))}`;
    const clock = X.radial(hours, { labels: hours.map((_, i) => i % 6 === 0 ? pad(i) : ""), tip: (i, v) => `${pad(i)}:00 to ${pad(i)}:59: ${dur(v)}`, center: `${pad(peakH)}:00`, sub: "peak", label: "Listening by hour of the day" });

    // Listening over time, smoothed
    let trendCard;
    if (Y) {
      const end = +y === new Date().getFullYear() ? today() : `${y}-12-31`, ds = A.daysFrom(`${y}-01-01`, end);
      const vals = ds.map(k => M.days[k] ? M.days[k][1] : 0);
      trendCard = card("Listening through the year", X.line([{ name: "Each day", vals, c: 0, faint: true, w: 1 }, { name: "30-day average", vals: X.movingAvg(vals, 30), c: 0, w: 2.2 }], { labels: ds.map(k => fmt(k, { day: "numeric", month: "short" })), fmt: v => `${Math.round(v)}m`, zero: true }), "Minutes a day. The thick line smooths out single days.");
    } else {
      const mk = []; let [yy, mm] = (keys[0] || today()).slice(0, 7).split("-").map(Number); const endM = (keys[keys.length - 1] || today()).slice(0, 7);
      while (`${yy}-${pad(mm)}` <= endM && mk.length < 1200) { mk.push(`${yy}-${pad(mm)}`); if (++mm > 12) { mm = 1; yy++; } }
      const per = new Map(); keys.forEach(k => per.set(k.slice(0, 7), (per.get(k.slice(0, 7)) || 0) + M.days[k][1]));
      const vals = mk.map(k => per.get(k) || 0);
      trendCard = mk.length > 2 ? card("Listening over the years", X.line([{ name: "Each month", vals, c: 0, faint: true, w: 1 }, { name: "12-month average", vals: X.movingAvg(vals, 12), c: 0, w: 2.2 }], { labels: mk.map(k => fmt(k + "-01", { month: "short", year: "2-digit" })), fmt: v => `${Math.round(v / 60)}h`, zero: true }), "Hours a month. The thick line smooths out single months.") : "";
    }

    // Time of day, period by period
    let todCard = "";
    if (V2) {
      const parts = [["Night (0–6)", [0, 1]], ["Morning (6–12)", [2, 3]], ["Afternoon (12–18)", [4, 5]], ["Evening (18–24)", [6, 7]]];
      const series = parts.map(([name, bl], i) => ({ name, c: [2, 4, 1, 0][i], vals: P.keys.map(p => keys.reduce((n, k) => inP(k, p) ? n + bl.reduce((s, b) => s + (M.days[k][5 + b] || 0), 0) : n, 0)) }));
      if (series.some(s => s.vals.some(v => v))) todCard = card(`Time of day by ${P.name}`, X.stacked(P.labels, series, { share: true, tips: P.tips, fmt: dur, ticks: 12 }), "Each bar is 100% of that period's listening, split by when you pressed play.");
    }

    // Discovery: artists heard for the first time
    let discCard = "";
    if (V2 && Object.keys(M.months).length) {
      const mKeys = Object.keys(M.months).sort();
      const newBy = P.keys.map(p => mKeys.reduce((n, k) => inP(k, p) ? n + M.months[k][0] : n, 0)), newT = mKeys.reduce((n, k) => (!Y || inP(k, y)) ? n + M.months[k][1] : n, 0);
      let run = 0; const cum = mKeys.map(k => (run += M.months[k][0]));
      const tot = newBy.reduce((a, b) => a + b, 0);
      discCard = card("Discovery", barsHtml(newBy, Math.max(...newBy, 1), P.labels.map((l, i) => P.labels.length > 12 ? (i % 3 === 0 ? l : "") : l), newBy.map((v, i) => `${P.tips[i]}: ${v} new artists`), P.keys.length > 7 ? "m12" : "")
        + (!Y && mKeys.length > 2 ? `<span class="label" style="margin:16px 0 0">Artists you've heard, adding up</span>${X.line([{ name: "Artists so far", vals: cum, area: true }], { labels: mKeys.map(k => fmt(k + "-01", { month: "short", year: "2-digit" })), zero: true })}` : ""),
        `New artists per ${P.name}: the first time each one shows up in your history. <b>${fmtNum(tot)}</b> new artists and <b>${fmtNum(newT)}</b> new tracks ${Y ? `in ${y}` : "in all"}.`);
    }

    // Skips over time
    let skipCard = "";
    {
      const rate = Y ? (V2 ? P.keys.map(p => { const pl = keys.reduce((n, k) => inP(k, p) ? n + M.days[k][0] : n, 0), sk = (M.months[p] || [0, 0, 0, 0])[3]; return pl + sk >= 20 ? sk / (pl + sk) * 100 : null; }) : [])
                     : yearsAsc.map(k => { const r = M.years[k]; return r.plays + r.skips >= 20 ? r.skips / (r.plays + r.skips) * 100 : null; });
      if (rate.filter(v => v != null).length >= 2) skipCard = card("Skipping", X.line([{ name: "Skipped early", vals: rate, dots: true }], { labels: Y ? MNL.map(m => m.slice(0, 3)) : yearsAsc, fmt: v => `${Math.round(v)}%`, zero: true, ticks: Y ? 6 : 8 }), `Share of plays you left within 30 seconds, per ${P.name}.`);
    }

    // How concentrated your listening is
    const artistRows = Y ? Y.topArtists : M.artists;
    const sumTo = (a, b) => artistRows.slice(a, b).reduce((n, r) => n + r[1], 0);
    const conc = [[artistRows[0] ? artistRows[0][0] : "Top artist", sumTo(0, 1)], ["Artists 2 to 5", sumTo(1, 5)], ["Artists 6 to 20", sumTo(5, 20)], ["Everyone else", Math.max(0, minTotal - sumTo(0, 20))]];
    let half = 0; { let acc = 0; for (const r of M.artists) { acc += r[1]; half++; if (acc >= M.min / 2) break; } if (acc < M.min / 2) half = 0; }
    const concCard = minTotal && artistRows.length ? card("How concentrated your listening is", X.donut(conc, { keep: true, center: `${Math.round(sumTo(0, 5) / minTotal * 100)}%`, sub: "top 5", fmt: dur, label: "Share of listening by artist rank" }), !Y && half ? `Just <b>${fmtNum(half)}</b> of your ${fmtNum(M.uniqueArtists)} artists make up half of everything you've played.` : "Share of listening time that goes to your most-played artists.") : "";

    // Who led each day
    let reignCard = "";
    {
      const ry = heatYear, rk = Object.keys(M.days).filter(k => k.startsWith(ry) && M.days[k][0] > 0).sort();
      const tops = new Map(); rk.forEach(k => { const a = M.names[M.days[k][2]] || ""; tops.set(a, (tops.get(a) || 0) + 1); });
      const top5 = [...tops].sort((a, b) => b[1] - a[1]).slice(0, 5).map(r => r[0]);
      let bestRun = { n: 0 }, run = { a: null, n: 0, from: null }, prev = null;
      rk.forEach(k => { const a = M.names[M.days[k][2]] || ""; if (a === run.a && prev && A.addDays(prev, 1) === k) run.n++; else run = { a, n: 1, from: k }; if (run.n > bestRun.n) bestRun = Object.assign({}, run); prev = k; });
      if (rk.length >= 14) {
        const ds = A.daysFrom(`${ry}-01-01`, rk[rk.length - 1]);
        const cells = ds.map(k => { const r = M.days[k], a = r && r[0] ? M.names[r[2]] || "" : null, i = a == null ? -1 : top5.indexOf(a); return `<i style="flex:1;background:${a == null ? "transparent" : i < 0 ? "var(--c6)" : X.col(i)}" title="${esc(fmt(k, { day: "numeric", month: "short" }))}${a != null ? `: ${esc(a)}` : ""}"></i>`; }).join("");
        reignCard = card(`Who led each day of ${ry}`, `<div class="cx-reign" role="img" aria-label="Top artist of each day">${cells}</div>${X.legend(top5.map((a, i) => [a, i, `${tops.get(a)} days`]).concat([["Others", 5]]))}`,
          `One sliver per day, coloured by that day's most-played artist.${bestRun.n >= 3 ? ` Longest run: <b>${esc(bestRun.a)}</b>, ${bestRun.n} days in a row from ${esc(fmt(bestRun.from, { day: "numeric", month: "short" }))}.` : ""}`);
      }
    }

    // A typical day
    const dayMins = keys.map(k => M.days[k][1]);
    const histCard = dayMins.length >= 10 ? card("A typical listening day", X.histogram(dayMins, { step: Math.max(...dayMins) > 480 ? 60 : Math.max(...dayMins) > 240 ? 30 : 15, lo: 0, fmt: v => v >= 60 ? `${Math.round(v / 6) / 10}h` : `${Math.round(v)}m`, marks: [{ v: X.median(dayMins), label: `median ${dur(Math.round(X.median(dayMins)))}` }] }), `Days by minutes listened. On half of your listening days you play more than <b>${dur(Math.round(X.median(dayMins)))}</b>.`) : "";

    // Rank changes between two years
    let slopeCard = "";
    {
      const yb = Y ? y : yearsAsc[yearsAsc.length - 1], ya = yearsAsc[yearsAsc.indexOf(yb) - 1];
      if (ya && M.years[ya].topArtists.length && M.years[yb].topArtists.length) {
        const a = new Map(M.years[ya].topArtists), b = new Map(M.years[yb].topArtists);
        const namesU = [...new Set(M.years[ya].topArtists.slice(0, 10).map(r => r[0]).concat(M.years[yb].topArtists.slice(0, 10).map(r => r[0])))];
        const rowsS = namesU.map(nm => ({ label: nm, a: M.years[ya].topArtists.slice(0, 10).some(r => r[0] === nm) ? a.get(nm) : null, b: M.years[yb].topArtists.slice(0, 10).some(r => r[0] === nm) ? b.get(nm) : null }));
        slopeCard = card(`Top 10 artists: ${ya} to ${yb}`, X.slope(rowsS, { la: ya, lb: yb, fmt: dur, label: "Change in artist rank" }), "Ranked by listening time in each year. A coloured line going up means the artist climbed.");
      }
    }

    // Loyalty: artists you keep coming back to
    const loyal = V2 && !Y ? M.artistSpan.slice().sort((p, q) => q[3] - p[3]).slice(0, 8) : [];
    const loyalCard = loyal.length ? `<section class="section"><h2>Longest companions</h2><p class="sub" style="margin-top:6px">Of your 50 most-played artists, the ones you've come back to in the most different months.</p>
      <div class="card" style="margin-top:12px;padding-top:6px;padding-bottom:6px">${loyal.map((r, i) => `<div class="rank"><span class="no">${i + 1}</span><div class="nm"><b>${esc(r[0])}</b><small>${esc(fmt(r[1], { month: "short", year: "numeric" }))} to ${esc(fmt(r[2], { month: "short", year: "numeric" }))}</small><div class="bar2"><i style="width:${(r[3] / loyal[0][3] * 100).toFixed(1)}%;animation-delay:${i * 40}ms"></i></div></div><span class="val">${r[3]} months</span></div>`).join("")}</div></section>` : "";

    const v1Note = V2 ? "" : `<section class="section"><p class="insight">More charts are waiting: listening by weekday and hour, time of day by month, new artists discovered and skips over time. Update the sheet script (see <b>tracker-setup</b>), then tap <b>Re-read Drive folder</b> below.</p></section>`;

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
        ${whenBody}
        ${clock}
      </div>
    </section>
    ${v1Note}
    ${trendCard}
    ${todCard}
    ${histCard}
    ${concCard}
    ${reignCard}
    ${discCard}
    ${skipCard}
    ${slopeCard}
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
    ${loyalCard}
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
    st.armed = false; M = null; LS.del(KEY);
    drive = Object.assign(drive, { removed: true, sig: "" }); LS.set(DKEY, JSON.stringify(drive));
    A.changed(); paint(true); toast("Music data removed from this device");
  };

  EXTRA.today.push(d => {
    const r = M && M.days[d];
    if (!r || !r[0]) return "";
    return `<section class="section"><span class="label">Soundtrack of the day</span>
      <div class="card"><b>${esc(M.names[r[2]] || "Unknown")}</b><div class="sub">${r[1]} min listened · ${r[0]} plays</div></div></section>`;
  });

  HOOKS.exportParts.push(() => M ? { music: M } : {});
  HOOKS.importParts.push(raw => { const c = clean(raw && raw.music); if (c && LS.set(KEY, JSON.stringify(c))) M = c; });
  HOOKS.wipe.push(() => { M = null; LS.del(KEY); drive = {}; LS.del(DKEY); });
})();
