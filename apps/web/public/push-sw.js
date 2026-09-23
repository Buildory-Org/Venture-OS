const opaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function targetFor(payload) {
  if (payload.resourceType === "task" && opaqueId(payload.resourceId)) return `/tasks/live?task=${encodeURIComponent(payload.resourceId)}`;
  const reminderId = opaqueId(payload.reminderId) ? payload.reminderId : payload.resourceType === "reminder" && opaqueId(payload.resourceId) ? payload.resourceId : null;
  if (reminderId) return `/notifications/live?reminder=${encodeURIComponent(reminderId)}`;
  return "/notifications/live";
}

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* A malformed payload still gets a visible notice. */ }
  if (!payload || typeof payload !== "object") payload = {};
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.slice(0, 200) : "Venture Studio notification";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 500) : "Open your inbox for the latest update.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: opaqueId(payload.notificationId) ? payload.notificationId : undefined,
    data: { url: targetFor(payload) },
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
