/* The Stack — shell cache for the installable cloud app.
 * Called by: static/app.js navigator.serviceWorker.register("./sw.js", { scope: "./" }).
 * Purpose: cache UI shell including github_hub.js under GitHub Pages subpath /the-stack-ui/.
 * Data: caches static assets only — no hub schema; hub via GitHub API in page JS.
 * User: cloud access UI hub — no Mac / same Wi‑Fi required.
 *
 * Auto-update: skipWaiting + clients.claim on every install/activate. The page calls
 * registration.update() on focus / every 5 min; controllerchange triggers one reload.
 * Bump CACHE when shipping a shell release so old caches are dropped on activate.
 */
const CACHE = "the-stack-shell-v31.2";
const SHELL = [
  "./index.html",
  "./cloud.html",
  "./phone.html",
  "./pair.html",
  "./app.js",
  "./github_hub.js",
  "./style.css",
  "./favicon.svg",
  "./icon-512.png",
  "./icon-192.png",
  "./icon-180.png",
  "./icon-maskable-512.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  // Per-URL add: cache.addAll fails the whole install if one URL errors/redirects.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const url of SHELL) {
        try {
          await cache.add(url);
        } catch {
          /* skip missing/redirect-odd asset; shell still usable */
        }
      }
    })()
  );
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
  // Never cache GitHub API or local /api — cloud mode uses api.github.com (other origin).
  if (url.pathname.includes("/api/")) return;

  // Always revalidate with the server (Pages can cache ~10 min). Offline falls back to cache.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && event.request.method === "GET") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html")))
  );
});

// v24 push: payload {title, body, url, tag} from .github/workflows/stack-push.yml.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "The Stack", {
      body: data.body || "An agent needs you",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "./index.html?cloud=1" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html?cloud=1";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
