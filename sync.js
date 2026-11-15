/* Tracker: your account. You sign in once per device with the password from your sheet script; after that
   everything (journal, body numbers, ideas, flights, music) is loaded from and saved to your Google Sheet
   and Drive folder by itself. The device keeps only a random login key, never the password.

   Each sync is one small request: this device sends only what changed here since the last sync (the outbox),
   and the sheet answers with only what changed there since then. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A) return;
  const { $, esc, toast, paint, Store, Ideas, Outbox, settings, saveSettings, HOOKS, EXTRA } = A;
  const CFG = window.STILLDAY_CONFIG || {};

  const URL_OK = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+\/|macros\/)s\/[\w-]+\/exec$/;
  const sheetUrl = () => URL_OK.test(settings.syncUrl || "") ? settings.syncUrl : (URL_OK.test(CFG.sheetUrl || "") ? CFG.sheetUrl : "");
  const signedIn = () => !!(settings.session && sheetUrl());

  // Older versions kept a secret word, a yes/no "dirty" flag and sent everything. Unsent changes from then are
  // sent in full once.
  if ("syncToken" in settings || "syncAuto" in settings) { delete settings.syncToken; delete settings.syncAuto; saveSettings(); }
  if ("dirty" in settings) { if (settings.dirty) settings.pushAll = true; delete settings.dirty; saveSettings(); }

  const TIMEOUT = 25000;
  let timer = null, running = null, again = null, merging = false, quiet = false, state = "ok", err = "", lastTry = 0, fails = 0;
  const when = iso => { try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };

  /* ---------- talking to the sheet script ---------- */
  async function post(url, body, opts) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const stop = ctl ? setTimeout(() => ctl.abort(), TIMEOUT) : null;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // a "simple" request, so no CORS preflight
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
        // Lets the request finish even if you close Tracker right after a change.
        keepalive: !!(opts && opts.keepalive)
      });
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? "Your sheet took too long to answer." : "Couldn't reach your sheet. Check your internet connection.");
    } finally { clearTimeout(stop); }
    let out = null;
    try { out = await res.json(); } catch (e) {}
    if (!out) throw new Error("Your sheet script didn't answer. Check the address and that access is set to Anyone.");
    if (out.ok === false) { const e = new Error(out.error || "The sheet script refused the request."); e.auth = !!out.auth; throw e; }
    return out;
  }

  async function call(action, extra, opts) {
    if (!signedIn()) { const e = new Error("Sign in first."); e.auth = true; throw e; }
    try {
      return await post(sheetUrl(), Object.assign({ session: settings.session, action }, extra || {}), opts);
    } catch (e) {
      if (e.auth) forget(e.message);
      throw e;
    }
  }

  /* ---------- status pill in the header ---------- */
  function setState(s, msg) {
    state = s; err = msg || "";
    const pill = $("#syncPill");
    if (pill) {
      pill.hidden = !signedIn();
      pill.dataset.state = s;
      pill.innerHTML = `<i></i><span>${s === "busy" ? "Syncing…" : s === "pending" ? "Saving soon" : s === "err" ? "Not synced" : "Synced"}</span>`;
      pill.title = s === "err" ? err : (settings.lastSync ? `Last synced ${when(settings.lastSync)}` : "Synced with your Google Sheet");
    }
    const line = $("#syncStatus");
    if (line) line.textContent = statusText();
  }
  function statusText() {
    if (!signedIn()) return "Not signed in. What you add stays only on this device.";
    if (state === "busy") return "Syncing…";
    if (state === "pending") return "Saving your changes in a moment…";
    if (state === "err") return `Couldn't sync: ${err} Your changes are kept on this device and sent next time.`;
    return settings.lastSync ? `Everything is synced. Last time: ${when(settings.lastSync)}.` : "Signed in.";
  }

  /* ---------- the one sync ---------- */
  const flightsKind = () => (A.syncKinds && A.syncKinds.flights) || { items: () => [], merge: () => 0 };

  // What this device sends: only what's in the outbox, or everything right after signing in.
  function payload(sent, all) {
    return {
      days: Store.records(all ? null : Object.keys(sent.days)),
      flights: flightsKind().items(all ? null : Object.keys(sent.flights)),
      ideas: Ideas.items(all ? Ideas.ids() : Object.keys(sent.ideas))
    };
  }

  // opts.full: ask the sheet for everything, not just what changed (Sync now does this).
  // opts.keepalive: Tracker is going into the background, so let the request outlive the page.
  function sync(opts) {
    opts = opts || {};
    if (!signedIn()) return Promise.resolve(false);
    // One at a time: a sync asked for while one is running happens right after it.
    if (running) { again = again ? { full: again.full || opts.full, noMusic: again.noMusic && opts.noMusic } : { full: opts.full, noMusic: opts.noMusic }; return running; }
    clearTimeout(timer); timer = null;
    lastTry = Date.now();
    running = (async () => {
      let ok = false;
      setState("busy");
      try {
        const sent = Outbox.take(), all = !!settings.pushAll;
        const body = Object.assign({ since: opts.full || all ? "" : (settings.since || "") }, payload(sent, all));
        const small = JSON.stringify(body).length < 60000;
        const out = await call("sync2", body, { keepalive: !!opts.keepalive && small });
        if (!out.now) throw new Error("Your sheet script is an older version. Update it (see the setup guide), then sync again.");
        merging = true;
        try {
          Store.mergeRemote(out.days);
          Ideas.mergeRemote(out.ideas);
          flightsKind().merge(out.flights);
        } finally { merging = false; }
        settings.since = out.now;
        if (all) settings.pushAll = false;
        Outbox.done(sent);
        settings.lastSync = new Date().toISOString(); saveSettings();
        fails = 0; ok = true;
        setState(Outbox.size() ? "pending" : "ok");
      } catch (e) {
        merging = false; fails++;
        setState(signedIn() ? "err" : "ok", e.message || String(e));
      }
      // Music is a separate, sometimes slower, read of your Drive folder.
      if (ok && A.music && !opts.noMusic) { try { await A.music.check(); } catch (e) {} }
      return ok;
    })();
    const v0 = A.version();
    return running.then(ok => {
      running = null;
      if (A.version() !== v0) redraw();
      if (again) { const next = again; again = null; return sync(next); }
      if (ok && Outbox.size()) schedule();
      return ok;
    });
  }

  function schedule() {
    if (!running) setState("pending");
    clearTimeout(timer); timer = setTimeout(() => sync({ noMusic: true }), 3000);
  }

  // Redraw the page with what just arrived, but never while you are typing in it.
  function redraw() {
    const a = document.activeElement;
    if (a && a.closest && a.closest("#view") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { setTimeout(redraw, 1500); return; }
    if (document.getElementById("sheet") && document.getElementById("sheet").open) return;
    paint(true);
  }

  /* ---------- signing in and out ---------- */
  function deviceName() {
    const u = navigator.userAgent || "";
    const dev = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Mac/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : "Device";
    const br = /CriOS|Chrome/.test(u) && !/Edg/.test(u) ? "Chrome" : /Edg/.test(u) ? "Edge" : /Firefox|FxiOS/.test(u) ? "Firefox" : /Safari/.test(u) ? "Safari" : "";
    return br ? `${dev}, ${br}` : dev;
  }

  let gateMsg = "", editUrl = false, gateBusy = false;
  function gateHtml() {
    const url = sheetUrl(), askUrl = !url || editUrl;
    return `<div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
      <div class="brand"><i></i>Tracker</div>
      <div class="gate-scene">${A.ILLO ? A.ILLO.scene() : ""}</div>
      <h1 id="gateTitle">Sign in</h1>
      <p class="sub">Your journal, body numbers, flights and music are kept in your Tracker sheet in Google Drive. Sign in once on this device and it stays signed in.</p>
      <form id="loginForm" autocomplete="on">
        <input type="text" name="username" autocomplete="username" value="Tracker" hidden aria-hidden="true">
        ${askUrl ? `<label class="gate-field"><span class="label">Sheet script address (only the first time on this device)</span>
          <input class="inp" id="loginUrl" name="sheet" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}" required></label>
          <p class="note">In your sheet: Extensions → Apps Script → Deploy → Manage deployments → copy the Web app URL.</p>`
        : `<p class="note gate-url">Your sheet: <span>${esc(url.replace(/^https:\/\//, "").slice(0, 34))}…</span> <button type="button" class="linkbtn" data-act="login-url">Change</button></p>`}
        <label class="gate-field"><span class="label">Password</span>
          <input class="inp" id="loginPw" name="password" type="password" autocomplete="current-password" required minlength="10"></label>
        <button class="btn primary block" type="submit" ${gateBusy ? "disabled" : ""}>${gateBusy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p class="note gate-msg" id="loginMsg" role="alert">${esc(gateMsg)}</p>
      <p class="note gate-alt">Not your Tracker? <button type="button" class="linkbtn" data-act="login-local">Use it without an account</button>. Whatever you add then stays only in this browser.</p>
    </div>`;
  }
  function showGate(msg) {
    if (msg !== undefined) gateMsg = msg;
    let g = $("#gate");
    if (!g) { g = document.createElement("div"); g.id = "gate"; g.className = "gate"; document.body.appendChild(g); }
    g.innerHTML = gateHtml();
    document.body.classList.add("gated");
    const sh = document.getElementById("sheet"); if (sh && sh.open) sh.close();
    const first = $(sheetUrl() && !editUrl ? "#loginPw" : "#loginUrl"); if (first && matchMedia("(hover: hover)").matches) first.focus();
  }
  function hideGate() {
    const g = $("#gate"); if (g) g.remove();
    document.body.classList.remove("gated");
    gateMsg = ""; editUrl = false;
  }

  // The sheet script said this device's login key no longer works (signed out on every device, or expired).
  function forget(msg) {
    if (!settings.session) return;
    settings.session = null; saveSettings();
    setState("ok");
    showGate(msg || "You were signed out. Sign in again.");
  }

  EXTRA.submits.loginForm = async form => {
    if (gateBusy) return;
    const urlIn = $("#loginUrl", form), pw = $("#loginPw", form).value;
    const url = urlIn ? urlIn.value.trim() : sheetUrl();
    const msg = t => { gateMsg = t; const el = $("#loginMsg"); if (el) el.textContent = t; };
    if (!URL_OK.test(url)) { msg("That doesn't look like your sheet script's address. It starts with https://script.google.com/ and ends in /exec."); return; }
    gateBusy = true; msg("");
    const btn = form.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
    try {
      const out = await post(url, { action: "login", password: pw, device: deviceName() });
      if (!out.session) throw new Error("Your sheet script is an older version. Update it (see the setup guide) and try again.");
      settings.syncUrl = url; settings.session = out.session; settings.localOnly = false;
      // Anything already on this device gets merged into the sheet on the first sync, and everything in the sheet comes here.
      settings.pushAll = true; settings.since = ""; saveSettings();
      gateBusy = false;
      hideGate();
      setState("busy");
      toast("Signed in. Loading your data…");
      const ok = await sync({});
      toast(ok ? "All your data is here" : "Signed in, but loading failed. It will try again.");
    } catch (e) {
      gateBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Sign in"; }
      msg(e.message || String(e));
    }
  };
  EXTRA.actions["login-url"] = () => { editUrl = true; showGate(); };
  EXTRA.actions["login-local"] = () => { settings.localOnly = true; saveSettings(); hideGate(); setState("ok"); toast("Using Tracker on this device only"); };
  EXTRA.actions["sign-in"] = () => showGate("");

  // Signing out sends your latest changes first, then clears this device. Your data stays in the sheet.
  let outArmed = "";
  async function signOut(everywhere) {
    const btnAct = everywhere ? "sign-out-all" : "sign-out";
    if (outArmed !== btnAct) {
      outArmed = btnAct;
      const b = document.querySelector(`[data-act="${btnAct}"]`);
      if (b) b.textContent = everywhere ? "Tap again: sign out on every device" : "Tap again to sign out";
      return;
    }
    outArmed = "";
    toast("Saving your latest changes…");
    const ok = await sync({ noMusic: true });
    if (!ok || Outbox.size()) { toast("Couldn't reach your sheet, so you're still signed in. Try again when you're online."); return; }
    try { await call(everywhere ? "logoutAll" : "logout"); } catch (e) {}
    quiet = true;
    Store.clear(); Ideas.clear(); Outbox.clear(); HOOKS.wipe.forEach(f => { try { f(); } catch (e) {} });
    quiet = false;
    settings.session = null; settings.since = ""; settings.pushAll = false; settings.lastSync = null; saveSettings();
    setState("ok"); paint();
    showGate(everywhere ? "Signed out on every device. Your data is safe in your sheet." : "Signed out. Your data is safe in your sheet.");
  }
  EXTRA.actions["sign-out"] = () => signOut(false);
  EXTRA.actions["sign-out-all"] = () => signOut(true);

  // Sync now asks for everything, which also picks up changes you made by hand in the sheet.
  EXTRA.actions["sync-now"] = async () => {
    if (!signedIn()) { showGate(""); return; }
    const ok = await sync({ full: true, noMusic: false });
    toast(ok ? "Everything is synced" : `Couldn't sync: ${err}`);
  };

  /* ---------- automatic syncing ---------- */
  HOOKS.change.push(() => {
    if (merging || quiet || !signedIn() || !Outbox.size()) return;
    schedule();
  });
  // "Delete everything" on this device: the sheet keeps it all, so load it again from scratch.
  HOOKS.wipe.push(() => { if (!quiet) { settings.since = ""; saveSettings(); } });
  document.addEventListener("visibilitychange", () => {
    if (!signedIn()) return;
    if (document.hidden) { if (Outbox.size()) sync({ noMusic: true, keepalive: true }); }
    else if (Date.now() - lastTry > 30000) sync({});
  });
  window.addEventListener("online", () => { if (signedIn()) sync({}); });
  // While Tracker is on screen: changes that couldn't be sent are tried again, waiting longer after each failure
  // (up to 15 minutes), and otherwise it checks the sheet every 5 minutes.
  setInterval(() => {
    if (!signedIn() || document.hidden || running) return;
    const wait = state === "err" ? Math.min(15 * 60e3, 30e3 * 2 ** Math.min(fails, 5)) : Outbox.size() ? 30e3 : 5 * 60e3;
    if (Date.now() - lastTry > wait) sync({ noMusic: true });
  }, 30e3);

  /* ---------- settings ---------- */
  EXTRA.settings.push(() => (outArmed = "", signedIn()) ? `
    <h3>Account</h3>
    <p class="note" style="margin-top:0">Signed in on this device. Everything is kept in your <b>Tracker</b> sheet and Drive folder, and syncs by itself when you open Tracker or change something.</p>
    <p class="note" id="syncStatus">${esc(statusText())}</p>
    <div class="grid2" style="margin-top:14px">
      <button class="btn" data-act="sync-now">Sync now</button>
      <button class="btn" data-act="sign-out">Sign out</button>
    </div>
    <p class="note">Lost a phone? <button class="linkbtn" data-act="sign-out-all">Sign out on every device</button>, then sign in again here.</p>` : `
    <h3>Account</h3>
    <p class="note" style="margin-top:0" id="syncStatus">${esc(statusText())}</p>
    <button class="btn block" data-act="sign-in" style="margin-top:12px">Sign in</button>`);

  A.sync = { sync, call, ready: signedIn, signedIn };

  function boot() {
    setState("ok");
    if (signedIn()) sync({});
    else if (!settings.localOnly) showGate("");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
