/* The Stack — shell cache for the installable cloud app.
 * Called by: static/app.js navigator.serviceWorker.register("sw.js") (or /sw.js).
 * Purpose: cache UI shell including github_hub.js (replaces v6 LAN-oriented shell).
 * Data: caches static assets only — no hub schema; hub via GitHub API in page JS.
 * User: "WE DINT WANT THE SAME WIFI THE IDEA IS TO NOT NEED THE MAC AND HAVE CLOUD ACCESS UI HUB FOR AGENTS"
 */
const CACHE = "the-stack-shell-v7-cloud";
const SHELL = [
  "./",
  "./index.html",
  "./cloud.html",
  "./pair.html",
  "./app.js",
  "./github_hub.js",
  "./style.css",
  "./favicon.svg",
  "./icon-512.png",
  "./icon-192.png",
  "./icon-180.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
