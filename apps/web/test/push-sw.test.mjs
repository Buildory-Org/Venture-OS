import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8");

function worker() {
  const handlers = new Map();
  const notices = [];
  const opened = [];
  const self = {
    location: { origin: "https://studio.example" },
    registration: { showNotification: async (title, options) => { notices.push({ title, ...options }); } },
    clients: {
      matchAll: async () => [],
      openWindow: async (url) => { opened.push(url); },
    },
    addEventListener: (name, handler) => { handlers.set(name, handler); },
  };
  runInNewContext(source, { self, URL, encodeURIComponent });
  return { handlers, notices, opened };
}

test("push payload opens its task or reminder, with a safe inbox fallback", async () => {
  const { handlers, notices, opened } = worker();
  const push = handlers.get("push");
  const click = handlers.get("notificationclick");
  for (const [payload, expected] of [
    [{ title: "Task", resourceType: "task", resourceId: "task_123" }, "/tasks/live?task=task_123"],
    [{ title: "Reminder", resourceType: "task", resourceId: "task_123", reminderId: "reminder_456" }, "/tasks/live?task=task_123"],
    [{ title: "Reminder", resourceType: "reminder", resourceId: "reminder_456" }, "/notifications/live?reminder=reminder_456"],
    [{ title: "Unsafe", resourceType: "task", resourceId: "https://elsewhere.test" }, "/notifications/live"],
  ]) {
    let done;
    push({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
    await done;
    const notice = notices.at(-1);
    assert.equal(notice.data.url, expected);
    let closed = false;
    click({ notification: { data: notice.data, close: () => { closed = true; } }, waitUntil: (promise) => { done = promise; } });
    await done;
    assert.equal(closed, true);
    assert.equal(opened.at(-1), `https://studio.example${expected}`);
  }
});

test("malformed push data still shows an inbox notice", async () => {
  const { handlers, notices } = worker();
  let done;
  handlers.get("push")({ data: { json: () => { throw new Error("bad json"); } }, waitUntil: (promise) => { done = promise; } });
  await done;
  assert.equal(notices[0].title, "Venture Studio notification");
  assert.equal(notices[0].data.url, "/notifications/live");
});
