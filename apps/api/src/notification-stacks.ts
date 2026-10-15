import { mergeRings, type RingRow } from "@venture-studio/core";
import { atomic, type Database } from "./db.js";

/**
 * Inbox rows from before reminders stacked: each person's rings of one reminder become one row, the newest (its read state kept),
 * with every ring time and the count; the rest go. One reminder at a time, in a transaction, so a second run (or the worker folding
 * a new ring meanwhile) never counts a ring twice. Nothing to do once every reminder has one row.
 */
export async function stackReminderNotifications(database: Database): Promise<number> {
  const notifications = database.db.collection("notifications");
  const groups = await notifications.aggregate<{ _id: { workspaceId: string; userId: string; reminderId: string } }>([
    { $match: { reminderId: { $exists: true } } },
    { $group: { _id: { workspaceId: "$workspaceId", userId: "$userId", reminderId: "$reminderId" }, rows: { $sum: 1 } } },
    { $match: { rows: { $gt: 1 } } },
  ]).toArray();
  let folded = 0;
  for (const { _id: scope } of groups) {
    folded += await atomic(database, async (session) => {
      const rows = await notifications.find(scope, { session }).sort({ createdAt: -1, _id: -1 }).toArray();
      const [newest, ...earlier] = rows;
      if (!newest || !earlier.length) return 0;
      await notifications.updateOne({ _id: newest._id }, { $set: mergeRings(rows as unknown as RingRow[]) }, { session });
      await notifications.deleteMany({ ...scope, _id: { $in: earlier.map((row) => row._id) } }, { session });
      return earlier.length;
    });
  }
  return folded;
}
