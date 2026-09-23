const opaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* A malformed payload still gets a visible notice. */ }
  if (!payload || typeof payload !== "object") payload = {};
  // A subscription can outlive sign-out or transfer while a send is in flight.
  event.waitUntil(self.registration.showNotification("Venture Studio update", {
    body: "Open your inbox to view the latest update.",
    tag: opaqueId(payload.notificationId) ? payload.notificationId : undefined,
    data: { url: "/notifications/live" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url;
  let target = new URL(typeof path === "string" ? path : "/notifications/live", self.location.origin);
  if (target.origin !== self.location.origin || !["/tasks/live", "/notifications/live"].includes(target.pathname)) target = new URL("/notifications/live", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === target.origin);
    if (existing) {
      try {
        const navigated = await existing.navigate(target.href);
        await (navigated ?? existing).focus();
        return;
      } catch { /* A closed tab can fail navigation; open a fresh one below. */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
