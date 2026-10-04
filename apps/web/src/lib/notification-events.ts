export const notificationSnapshotEvent = "vso:notification-snapshot";
export const notificationRefreshEvent = "vso:notification-refresh";

type Linkable = { resourceType: string; resourceId: string; chatKind?: "direct" | "channel"; chatId?: string };
/** Where a notification should take the reader: the task, the conversation, or the inbox. */
export function notificationHref(item: Linkable): { href: string; label: string } {
  if (item.resourceType === "task") return { href: `/tasks/live?task=${encodeURIComponent(item.resourceId)}`, label: "Open task" };
  if (item.chatKind === "channel" && item.chatId) return { href: `/channels/live?channel=${encodeURIComponent(item.chatId)}`, label: "Open channel" };
  if (item.chatKind === "direct" && item.chatId) return { href: `/messages/live?with=${encodeURIComponent(item.chatId)}`, label: "Open conversation" };
  return { href: "/notifications/live", label: "Open inbox" };
}
