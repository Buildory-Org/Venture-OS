// What the autopilot did, per venture and local day (`sales_autopilot_days`, autopilotDaySchema), kept with $inc so two writers never lose
// a count. `leadWork` (not in the contract) counts the leads Claude worked on that day (judged, first messages, follow-ups): the spend cap.
import { autopilotDaySchema, type AutopilotDay } from "@venture-studio/contracts";
import type { AppDb } from "../../db.js";

export const DAYS = "sales_autopilot_days";
/** `failed` (not in the contract either): items that failed a try that day, including those that reached their stop. */
export type DayCount = Exclude<keyof AutopilotDay, "day"> | "leadWork" | "failed";

export const dayId = (ventureId: string, day: string) => `${ventureId}:${day}`;

export async function bump(db: AppDb, workspaceId: string, ventureId: string, day: string, counts: Partial<Record<DayCount, number>>): Promise<void> {
  const inc = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === "number" && value !== 0));
  if (!Object.keys(inc).length) return;
  await db.collection(DAYS).updateOne({ _id: dayId(ventureId, day) }, { $inc: inc, $set: { updatedAt: new Date() }, $setOnInsert: { workspaceId, ventureId, day } }, { upsert: true });
}

/** The hard cap on calls to Claude per venture and local day, whatever the step: well above a normal day's work for the lead limit. */
export const callBudget = (dailyLeadLimit: number) => dailyLeadLimit * 6 + 60;
export const budgetText = (cap: number) => `Today's limit of ${cap} calls to Claude is used up. It starts again tomorrow.`;

/**
 * Takes one of the day's calls before the model is asked (so a crash after it can't make a call free), in one conditional update: false
 * when the day's budget is used up.
 */
export async function reserveCall(db: AppDb, workspaceId: string, ventureId: string, day: string, cap: number): Promise<boolean> {
  const _id = dayId(ventureId, day);
  try {
    await db.collection(DAYS).updateOne({ _id }, { $setOnInsert: { workspaceId, ventureId, day, modelCalls: 0 } }, { upsert: true });
  } catch (error) {
    // Two first calls of the day raced to create the row: the other one made it.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  // The row may exist without the field yet (another count made it first): missing reads as none.
  const taken = await db.collection(DAYS).updateOne({ _id, $or: [{ modelCalls: { $lt: cap } }, { modelCalls: null }] }, { $inc: { modelCalls: 1 }, $set: { updatedAt: new Date() } });
  return taken.modifiedCount > 0;
}

/** Gives a reserved call back when no call was made after all (the item changed between reading it and counting its try). */
export async function releaseCall(db: AppDb, ventureId: string, day: string): Promise<void> {
  await db.collection(DAYS).updateOne({ _id: dayId(ventureId, day), modelCalls: { $gt: 0 } }, { $inc: { modelCalls: -1 } }).catch(() => undefined);
}

/** The calls already made that day. */
export async function callsMade(db: AppDb, ventureId: string, day: string): Promise<number> {
  return Number((await db.collection(DAYS).findOne({ _id: dayId(ventureId, day) }, { projection: { modelCalls: 1 } }))?.modelCalls ?? 0);
}

/** The leads Claude already worked on that day (the spend cap counts them). */
export async function leadWork(db: AppDb, ventureId: string, day: string): Promise<number> {
  const row = await db.collection(DAYS).findOne({ _id: dayId(ventureId, day) }, { projection: { leadWork: 1 } });
  return Number(row?.leadWork ?? 0);
}

/** That day's counts (zeros when nothing happened), and the latest earlier day with any. */
export async function readDays(db: AppDb, workspaceId: string, ventureId: string, day: string): Promise<{ today: AutopilotDay; previous?: AutopilotDay }> {
  const [today, previous] = await Promise.all([
    db.collection(DAYS).findOne({ _id: dayId(ventureId, day), workspaceId }),
    db.collection(DAYS).find({ workspaceId, ventureId, day: { $lt: day } }).sort({ day: -1 }).limit(1).next(),
  ]);
  return { today: autopilotDaySchema.parse({ ...(today ?? {}), day }), ...(previous ? { previous: autopilotDaySchema.parse(previous) } : {}) };
}
