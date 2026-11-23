/* The Stack v50.6.5 Control Room — network-first shell cache for Cloudflare Pages / GitHub Pages.
 * Always fetches fresh UI when online so pushes appear immediately on iPhone PWAs.
 */
const CACHE = "the-stack-shell-v50.8.0-phone-ux";
const SHELL = [
  "./",
  "./index.html",
  "./bg-tahoe.svg?v=50.7.0-human-tabs",
  "./chat.js?v=50.7.0-human-tabs",
  "./app.js?v=50.7.0-human-tabs",
  "./explore.js?v=50.7.0-human-tabs",
  "./polish.js?v=50.7.0-human-tabs",
  "./config.js?v=50.7.0-human-tabs",
  "./style.css?v=50.7.0-human-tabs",
  "./favicon.svg?v=50.7.0-human-tabs",
  "./manifest.webmanifest?v=50.7.0-human-tabs",
  "./icon-180.png?v=50.7.0-human-tabs",
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
