// public/sw.js
//
// Minimal service worker whose only job is receiving Web Push events and turning them
// into an OS-level notification — this is the piece that makes reminders work even
// when Jotting AI isn't open in any tab. It does NOT do offline caching / asset
// precaching; that's a separate concern (a PWA install strategy) and out of scope here.
//
// NOTE ON PLACEMENT: this file needs to be served from the SITE ROOT (e.g.
// https://yourapp.com/sw.js), not a subfolder — a service worker can only control pages
// under the path it's served from. If your build tool doesn't already publish
// /public/*.js files to the root as-is (check after `npm run build`), move this file to
// wherever your bundler serves static assets verbatim (e.g. Vite's `public/`, CRA's
// `public/`) so the built output still has it at the root.

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
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
