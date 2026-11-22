/* The Stack v50.6.2 CLARITY — network-first shell cache for Cloudflare Pages / GitHub Pages.
 * Always fetches fresh UI when online so pushes appear immediately on iPhone PWAs.
 */
const CACHE = "the-stack-shell-v50.6.2-clarity";
const SHELL = [
  "./",
  "./index.html",
  "./bg-tahoe.svg?v=50.6.2-clarity",
  "./app.js?v=50.6.2-clarity",
  "./explore.js?v=50.6.2-clarity",
  "./polish.js?v=50.6.2-clarity",
  "./config.js?v=50.6.2-clarity",
  "./style.css?v=50.6.2-clarity",
  "./favicon.svg?v=50.6.2-clarity",
  "./manifest.webmanifest?v=50.6.2-clarity",
  "./icon-180.png?v=50.6.2-clarity",
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
