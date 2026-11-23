/* The Stack v50.6.5 Control Room — network-first shell cache for Cloudflare Pages / GitHub Pages.
 * Always fetches fresh UI when online so pushes appear immediately on iPhone PWAs.
 */
const CACHE = "the-stack-shell-v50.6.5-control-room";
const SHELL = [
  "./",
  "./index.html",
  "./bg-tahoe.svg?v=50.6.5-control-room",
  "./chat.js?v=50.6.5-control-room",
  "./app.js?v=50.6.5-control-room",
  "./explore.js?v=50.6.5-control-room",
  "./polish.js?v=50.6.5-control-room",
  "./config.js?v=50.6.5-control-room",
  "./style.css?v=50.6.5-control-room",
  "./favicon.svg?v=50.6.5-control-room",
  "./manifest.webmanifest?v=50.6.5-control-room",
  "./icon-180.png?v=50.6.5-control-room",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  // Network-first so UI pushes show immediately; fall back to cache offline.
  event.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
