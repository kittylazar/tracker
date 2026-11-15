// Tracker service worker.
// The app opens straight from the cache and refreshes its files in the background, so a new version shows up
// the next time you open it. Your data never goes through here: it lives on the device and in your sheet.
const CACHE = "stillday-v9";
const SHELL = ["./", "index.html", "config.js", "airports.js", "charts.js", "music.js", "flights.js", "insights.js", "sync.js",
  "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
// Fonts, the world map outline and the zip reader come from other sites. Their addresses never change, so once
// saved they are used from the cache, also offline.
const EXTERNAL = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//;

self.addEventListener("install", e => {
  // "reload" skips the browser's own cache, so the saved copy is the newest one.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: "reload" })).then(r => r.ok ? c.put(u, r) : null).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (!EXTERNAL.test(req.url)) return;
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy))); }
      return res;
    })));
    return;
  }

  // The app's own files: answer from the cache at once, and fetch a fresh copy for next time.
  const page = req.mode === "navigate";
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(page ? "index.html" : req, { ignoreSearch: page });
    const fresh = fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) e.waitUntil(c.put(page ? "index.html" : req, res.clone()));
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => null)); return hit; }
    // Nothing saved yet: wait for the network. Offline, a page gets the app and anything else a plain error.
    return fresh.catch(() => page ? c.match("index.html").then(r => r || Response.error()) : Response.error());
  }));
});
