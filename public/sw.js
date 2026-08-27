// public/sw.js
//
// Two jobs: (1) receiving Web Push events (unchanged from before), and (2) offline
// app-shell caching, added here.
//
// ⚠️ WHY THIS ISN'T A STANDARD WORKBOX PRECACHE, AND WHAT THAT MEANS FOR YOU:
// A "proper" CRA PWA (via cra-template-pwa) generates a build-time manifest listing
// every hashed asset filename (main.abc123.js, main.def456.css, ...) so the service
// worker can precache the exact right files the moment it installs. I don't have access
// to your build process to generate that manifest, and hardcoding filenames here would
// break on your very next deploy once the hashes change. So instead this uses a
// RUNTIME caching strategy: the service worker caches pages/assets as students actually
// load them, rather than precaching a known list upfront. Practical implications:
//   - Offline support only covers what's already been visited/loaded at least once
//     while online — there's no way around this for ANY offline strategy (even Workbox
//     precache still needs one online visit to populate the cache initially).
//   - Because of how service workers activate, this SW won't intercept anything during
//     a student's very first-ever page load (it installs in the background and doesn't
//     control the page that's already loading) — offline support effectively starts
//     from their SECOND visit/reload onward. This is standard SW lifecycle behavior,
//     not a shortcut specific to this implementation.
//   - If you later adopt a proper Workbox precache build step, this file's `fetch`
//     handler below can be replaced with Workbox's generated one; the push-notification
//     handlers at the bottom should stay as-is either way.
//
// NOTE ON PLACEMENT: same as before — must be served from the site root.

var SHELL_CACHE = "jotting-shell-v1"; // bump this string on any future sw.js logic change to force a clean cache
var STATIC_PRECACHE = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"]; // small, hash-free, safe to name explicitly

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(STATIC_PRECACHE).catch(function () {}); // best-effort — a single 404 here shouldn't block install
    })
  );
  // Deliberately NOT calling self.skipWaiting() here. A newly installed service worker
  // now waits until the app explicitly tells it to take over (see the "message" handler
  // below) — this is what lets App_login.js show an "Update available" prompt instead of
  // silently swapping the app out from under a student mid-session.
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Lets the app (after showing its own "Update available" UI and the student agreeing)
// promote a waiting service worker to active immediately instead of waiting for every
// open tab to close first.
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // never cache writes
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Firebase/Gemini/cross-origin calls pass straight through, untouched
  if (url.pathname.indexOf("/api/") === 0) return;  // never cache the Netlify function calls — always need fresh data

  // Navigations (loading the app itself): network-first, so an online student always
  // gets the latest deploy — only fall back to the cached shell when there's no network.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (cache) { cache.put("/", copy); });
        return res;
      }).catch(function () {
        return caches.match("/").then(function (cached) { return cached || caches.match(req); });
      })
    );
    return;
  }

  // Everything else same-origin (hashed JS/CSS bundles, images, fonts): stale-while-
  // revalidate — serve instantly from cache if we have it, while quietly re-fetching in
  // the background to keep the cache fresh for next time. Hashed filenames mean a new
  // deploy is simply a new URL, so this can't accidentally serve stale JS under the same
  // name — the browser just asks for the new hash and it gets cached fresh.
  event.respondWith(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var networkFetch = fetch(req).then(function (res) {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(function () { return cached; });
        return cached || networkFetch;
      });
    })
  );
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Jotting AI", body: event.data ? event.data.text() : "You have a new reminder." };
  }

  var title = data.title || "Jotting AI";
  var options = {
    body: data.body || "",
    icon: data.icon || "/favicon.ico",
    badge: data.badge || "/favicon.ico",
    tag: data.tag || "jotting-reminder", // same-tag pushes replace each other instead of piling up
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open tab if there is one, otherwise opens
// a new one — standard "bring the app to front" behavior for push notifications.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});