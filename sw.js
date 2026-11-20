/* The Stack v50.0 Rebirth — shell cache for Cloudflare Pages / GitHub Pages mirror.
 * Bump CACHE on every shell release. No voice assets. No browser PAT.
 */
const CACHE = "the-stack-shell-v50.0.3-rebirth";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./style.css",
  "./favicon.svg",
  "./manifest.webmanifest",
  "./icon-180.png",
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
  // Never cache BFF API
  if (url.pathname.includes("/api/")) return;
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => hit)
    )
  );
});
