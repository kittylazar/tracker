/* Tracker: Google Sheets sync. Talks to a small Apps Script web app that lives in the user's own sheet. */
(function () {
  "use strict";
  const A = window.Stillday;
  if (!A) return;
  const { $, esc, fmt, LS, toast, paint, Store, Ideas, settings, saveSettings, HOOKS, EXTRA } = A;

  const URL_OK = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+\/|macros\/)s\/[\w-]+\/exec$/;
  let timer = null, busy = false, pulling = false, state = "idle", err = "";

  const ready = () => URL_OK.test(settings.syncUrl || "") && !!settings.syncToken;
  const when = iso => { try { const d = new Date(iso); return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };

  /* ---------- status pill in the header ---------- */
  function setState(s, msg) {
    state = s; err = msg || "";
    const pill = $("#syncPill");
    if (pill) {
      pill.hidden = !ready();
      pill.dataset.state = s;
      pill.innerHTML = `<i></i><span>${s === "busy" ? "Syncing…" : s === "pending" ? "Saving soon" : s === "err" ? "Sync failed" : "Synced"}</span>`;
      pill.title = s === "err" ? err : (settings.lastSync ? `Last synced ${when(settings.lastSync)}` : "Google Sheets sync");
    }
    const line = $("#syncStatus");
    if (line) line.textContent = statusText();
  }
  function statusText() {
    if (!ready()) return "Not connected yet.";
    if (state === "busy") return "Syncing…";
    if (state === "err") return `Last attempt failed: ${err}`;
    return settings.lastSync ? `Connected. Last synced ${when(settings.lastSync)}.` : "Connected. Nothing synced yet.";
  }

  /* ---------- what gets sent ---------- */
  function snapshot() {
    const days = Object.values(Store.all()).sort((a, b) => a.date < b.date ? -1 : 1);
    const payload = { days, ideas: Ideas.get() };
    HOOKS.syncParts.forEach(f => { try { Object.assign(payload, f()); } catch (e) {} });
    return payload;
  }

  async function call(action, extra) {
    const res = await fetch(settings.syncUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // a "simple" request, so no CORS preflight
      body: JSON.stringify(Object.assign({ token: settings.syncToken, action }, extra || {}))
    });
    let out = null;
    try { out = await res.json(); } catch (e) {}
    if (!out) throw new Error("No answer from the web app. Check the address and that access is set to Anyone.");
    if (out.ok === false) throw new Error(out.error || "The web app refused the request.");
    return out;
  }

  async function push() {
    clearTimeout(timer); timer = null;
    if (!ready() || busy || pulling) return;
    busy = true; setState("busy");
    try {
      await call("sync", { payload: snapshot() });
      settings.lastSync = new Date().toISOString(); saveSettings(); setState("ok");
    } catch (e) { setState("err", e.message || String(e)); }
    busy = false;
  }

  /* Merge rule: a remote day wins only if it is newer; otherwise it just fills gaps. */
  function mergeDays(list) {
    const remote = A.cleanDays({ days: Object.fromEntries((Array.isArray(list) ? list : []).filter(r => r && typeof r.date === "string").map(r => [r.date, r])) });
    if (!remote) return 0;
    const local = Store.all(), out = {};
    Object.keys(remote).forEach(k => {
      const r = remote[k], l = local[k];
      if (!l) out[k] = r;
      else if ((r.updatedAt || "") > (l.updatedAt || "")) out[k] = Object.assign({}, l, r);
      else {
        const fill = {}; let any = false;
        Object.keys(r).forEach(f => { if (l[f] == null && f !== "updatedAt") { fill[f] = r[f]; any = true; } });
        if (any) out[k] = Object.assign({}, l, fill);
      }
    });
    const n = Object.keys(out).length;
    if (n) Store.merge(out);
    return n;
  }

  async function pull(manual) {
    if (!ready() || busy) return;
    busy = true; pulling = true; setState("busy");
    try {
      const out = await call("pull");
      const n = mergeDays(out.days);
      Ideas.merge(out.ideas);
      HOOKS.pullParts.forEach(f => { try { f(out); } catch (e) {} });
      settings.lastSync = new Date().toISOString(); saveSettings(); setState("ok");
      if (manual || n) { paint(true); toast(n ? `Loaded ${n} change${n === 1 ? "" : "s"} from the sheet` : "Already up to date"); }
    } catch (e) { setState("err", e.message || String(e)); if (manual) toast(e.message || "Couldn't reach the sheet."); }
    busy = false; pulling = false;
  }

  /* ---------- wiring ---------- */
  HOOKS.change.push(() => {
    if (pulling || !ready() || settings.syncAuto === false) return;
    setState("pending");
    clearTimeout(timer); timer = setTimeout(push, 5000);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) push(); });

  EXTRA.actions["sync-now"] = async () => { if (!ready()) { toast("Connect Google Sheets in Settings first."); return; } await push(); toast(state === "ok" ? "Synced to your sheet" : "Sync failed. See Settings."); };
  EXTRA.actions["sync-pull"] = () => { if (!ready()) { toast("Connect Google Sheets in Settings first."); return; } pull(true); };

  EXTRA.changes.syncUrl = el => {
    const v = el.value.trim();
    if (v && !URL_OK.test(v)) { toast("That doesn't look like a Google Apps Script web app address (it ends in /exec)."); el.value = settings.syncUrl || ""; return; }
    settings.syncUrl = v; saveSettings(); setState(state);
  };
  EXTRA.changes.syncToken = el => { settings.syncToken = el.value.trim(); saveSettings(); setState(state); };
  EXTRA.changes.syncAuto = el => { settings.syncAuto = el.checked; saveSettings(); };

  EXTRA.settings.push(() => `
    <h3>Google Sheets</h3>
    <p class="note" style="margin-top:0">Keeps a copy of everything (journal, body numbers, ideas, flights, music summary) in a Google Sheet you own. Setup steps are in the <b>stillday-setup</b> folder.</p>
    <label style="display:block;margin-top:12px"><span class="label">Web app address</span><input class="inp" id="syncUrl" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(settings.syncUrl || "")}"></label>
    <label style="display:block;margin-top:12px"><span class="label">Secret word (the same one you put in the script)</span><input class="inp" id="syncToken" type="password" autocomplete="off" value="${esc(settings.syncToken || "")}"></label>
    <div class="row" style="margin-top:14px"><span>Sync automatically</span><label class="switch"><input type="checkbox" id="syncAuto" ${settings.syncAuto === false ? "" : "checked"} aria-label="Sync automatically"><span></span></label></div>
    <div class="grid2" style="margin-top:14px">
      <button class="btn" data-act="sync-now">Sync now</button>
      <button class="btn" data-act="sync-pull">Restore from sheet</button>
    </div>
    <p class="note" id="syncStatus">${esc(statusText())}</p>`);

  A.sync = { push, pull, snapshot, ready, call };
  document.addEventListener("DOMContentLoaded", () => { setState("ok"); if (ready()) pull(false); });
})();
