// Nabikaran service worker.
// - Static assets (hashed /_next/static files, icons, manifest): cache-first.
// - Page navigations: always network; if the network is down, show /offline.html.
// - Never caches API responses or page HTML: balances, reminders and payments must always be live,
//   and a shared phone must never show another person's data from cache.
const VERSION = "nabikaran-v5";
const PRECACHE = ["/offline.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") || PRECACHE.includes(url.pathname) || url.pathname === "/icon-maskable-512.png" || url.pathname === "/favicon-32.png";

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }

  if (isStatic(url)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});

// Web push: reminder notifications (free, alongside SMS / WhatsApp).
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/dashboard";
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Nabikaran", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/favicon-32.png",
      tag: d.tag || undefined,
      data: { url },
    }),
    // A dot on the app icon until the app is opened (the dashboard then sets the real count).
    self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => undefined) : Promise.resolve(),
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/dashboard", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
