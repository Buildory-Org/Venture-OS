import type { AppDb } from "./db.js";

type Actor = NonNullable<Express.Request["actor"]>;

/** Read only notices whose current channel scope remains visible to this member. */
export async function listVisibleNotifications(db: AppDb, actor: Actor, filter: Record<string, unknown> = {}, limit = 100) {
  const visible: Record<string, any>[] = [];
  let before: { createdAt: Date; _id: string } | null = null;
  const scopedChannels = actor.membership.role === "admin" ? null : await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ventureId: { $in: actor.membership.ventureIds }, groupId: { $in: actor.membership.groupIds } }).project({ _id: 1 }).toArray();
  const modernScope = scopedChannels ? { $or: [{ chatKind: { $ne: "channel" } }, { chatKind: "channel", chatId: { $in: scopedChannels.map((channel) => String(channel._id)) } }] } : null;
  while (visible.length < limit) {
    const page = await db.collection("notifications").find({ workspaceId: actor.membership.workspaceId, userId: actor.id, ...filter, ...((modernScope || before) ? { $and: [...(modernScope ? [modernScope] : []), ...(before ? [{ $or: [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, _id: { $lt: before._id } }] }] : [])] } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    if (!page.length) break;
    before = { createdAt: page[page.length - 1]!.createdAt, _id: String(page[page.length - 1]!._id) };
    const legacyIds = page.filter((item) => !item.chatKind && item.resourceType === "message").map((item) => String(item.resourceId));
    const legacyMessages = legacyIds.length ? await db.collection("messages").find({ _id: { $in: legacyIds }, workspaceId: actor.membership.workspaceId }).project({ _id: 1, channelId: 1 }).toArray() : [];
    const messageById = new Map(legacyMessages.map((message) => [String(message._id), message]));
    const channelIds = [...new Set(page.map((item) => item.chatKind === "channel" ? String(item.chatId) : messageById.get(String(item.resourceId))?.channelId).filter((id): id is string => typeof id === "string"))];
    const channels = channelIds.length ? await db.collection("channels").find({ _id: { $in: channelIds }, workspaceId: actor.membership.workspaceId }).project({ _id: 1, ventureId: 1, groupId: 1 }).toArray() : [];
    const accessible = new Set(channels.filter((channel) => actor.membership.role === "admin" || (actor.membership.ventureIds.includes(String(channel.ventureId)) && actor.membership.groupIds.includes(String(channel.groupId)))).map((channel) => String(channel._id)));
    for (const item of page) {
      const legacy = !item.chatKind && item.resourceType === "message" ? messageById.get(String(item.resourceId)) : undefined;
      if (!item.chatKind && item.resourceType === "message" && !legacy) continue;
      const channelId = item.chatKind === "channel" ? String(item.chatId) : legacy?.channelId;
      if (channelId && !accessible.has(String(channelId))) continue;
      visible.push(item);
      if (visible.length === limit) break;
    }
    if (page.length < 100) break;
  }
  return visible;
}
