import { Router } from "express";
import { idSchema, leaderboardQuerySchema, type LeaderboardBoard } from "@venture-studio/contracts";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { AppError } from "../errors.js";
import { inArchivedVenture } from "../archive-scope.js";
import { jsonValue } from "../json.js";
import { computeBoard, localDate, MINIMUM_TASKS, periodRange, previousRange, type ComputedBoard } from "../leaderboard.js";

const weekSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A week is its first day, as YYYY-MM-DD");
const HOUR = 3_600_000;
const withoutTasks = ({ tasks: _tasks, ...board }: ComputedBoard): LeaderboardBoard => board;

/** Everyone in the workspace sees everyone's ranking; a venture's board is for those who can open that venture. */
export function leaderboardRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  const timeZone = config.LEADERBOARD_TIME_ZONE;

  function boardInput(actor: NonNullable<Express.Request["actor"]>, query: z.infer<typeof leaderboardQuerySchema>) {
    const membership = actor.membership;
    if (query.ventureId && (inArchivedVenture(membership, query.ventureId) || (membership.role !== "admin" && !membership.ventureIds.includes(query.ventureId)))) throw new AppError(404, "NOT_FOUND", "Venture not found");
    return { workspaceId: membership.workspaceId, ventureId: query.ventureId, includeLearners: query.learners === "true", archivedVentureIds: membership.archivedVentureIds ?? [] };
  }

  router.get("/leaderboard", async (req, res) => {
    const actor = req.actor!;
    const query = leaderboardQuerySchema.parse(req.query);
    const now = new Date();
    const range = periodRange(query.period, now, timeZone);
    const input = boardInput(actor, query);
    const [board, before] = await Promise.all([computeBoard(db, { ...input, ...range, now }), computeBoard(db, { ...input, ...previousRange(range), now, light: true })]);
    const earlier = new Map(before.people.filter((entry) => entry.rank).map((entry) => [entry.userId, entry.rank!]));
    const people = board.people.map((entry) => earlier.has(entry.userId) ? { ...entry, previousRank: earlier.get(entry.userId) } : entry);
    res.json({ ok: true, data: jsonValue({ ...withoutTasks(board), people, period: { key: query.period, ...range }, timeZone, minimumTasks: MINIMUM_TASKS }) });
  });

  // One person's counted tasks and what each earned; tasks the viewer can't open are only counted. With `week`, as that
  // weekly edition saw them (the whole workspace, as of the Saturday it closed).
  router.get("/leaderboard/people/:userId", async (req, res) => {
    const actor = req.actor!;
    const userId = idSchema.parse(req.params.userId);
    const query = leaderboardQuerySchema.parse(req.query);
    let range = periodRange(query.period, new Date(), timeZone);
    let now = new Date();
    if (query.week) {
      const edition = await db.collection("leaderboard_editions").findOne({ _id: `${actor.membership.workspaceId}:${query.week}` }, { projection: { weekStart: 1, weekEnd: 1 } });
      if (!edition) throw new AppError(404, "NOT_FOUND", "There is no edition for that week");
      range = { from: edition.weekStart as Date, to: edition.weekEnd as Date }; now = edition.weekEnd as Date;
    }
    const board = await computeBoard(db, { ...boardInput(actor, { ...query, ventureId: query.week ? undefined : query.ventureId }), ...range, now });
    const entry = board.people.find((item) => item.userId === userId);
    if (!entry) throw new AppError(404, "NOT_FOUND", "This person has no tasks due in this period");
    const membership = actor.membership;
    const canOpen = (task: { ventureId: string; groupId: string }) => membership.role === "admin" || (membership.ventureIds.includes(task.ventureId) && membership.groupIds.includes(task.groupId));
    const counted = board.tasks.get(userId) ?? [];
    const visible = counted.filter(canOpen).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    const hours = (ms: number) => ms ? Math.round((ms / HOUR) * 10) / 10 : undefined;
    res.json({ ok: true, data: jsonValue({
      entry, period: { key: query.period, ...range }, hidden: counted.length - visible.length,
      tasks: visible.map((task) => ({
        id: task.id, title: task.title, dueAt: task.dueAt, ...(task.deliveredAt ? { deliveredAt: task.deliveredAt } : {}), outcome: task.outcome, credit: task.credit,
        ...(task.outcome === "on_time" ? {} : { daysLate: Math.round((task.lateMs / 86_400_000) * 10) / 10 }),
        ...(hours(task.blockedMs) ? { blockedHours: hours(task.blockedMs) } : {}), ...(hours(task.allowanceMs) ? { allowanceHours: hours(task.allowanceMs) } : {}),
        ...(task.firstTimeRight === undefined ? {} : { firstTimeRight: task.firstTimeRight }),
      })),
    }) });
  });

  /**
   * Last week's edition (Saturday to Friday), made by whoever opens the app first after Saturday midnight and then kept
   * as it was, so everyone sees the same board. It holds the board with and without learners.
   */
  const generating = new Map<string, Promise<unknown>>();
  async function latestEdition(workspaceId: string) {
    const clock = new Date();
    const { from: weekStart, to: weekEnd } = periodRange("last_week", clock, timeZone);
    const week = localDate(weekStart, timeZone);
    const id = `${workspaceId}:${week}`;
    const found = await db.collection("leaderboard_editions").findOne({ _id: id });
    if (found) return found;
    // Requests arriving together share one generation (and a second server's is settled by the write below).
    if (!generating.has(id)) generating.set(id, (async () => {
      const scope = await db.collection("ventures").find({ workspaceId, status: "archived" }, { projection: { _id: 1 } }).toArray();
      // As of Saturday midnight, so the board is the same whenever it's first opened.
      const base = { workspaceId, from: weekStart, to: weekEnd, now: weekEnd, archivedVentureIds: scope.map((venture) => String(venture._id)) };
      const [board, withLearners] = await Promise.all([computeBoard(db, { ...base, includeLearners: false }), computeBoard(db, { ...base, includeLearners: true })]);
      const edition = { workspaceId, week, weekStart, weekEnd, timeZone, generatedAt: new Date(), board: withoutTasks(board), boardWithLearners: withoutTasks(withLearners) };
      // Two servers opening it at once: the first one written wins, and both see it.
      await db.collection("leaderboard_editions").updateOne({ _id: id }, { $setOnInsert: edition }, { upsert: true }).catch((cause: unknown) => { if ((cause as { code?: number }).code !== 11000) throw cause; });
    })().finally(() => generating.delete(id)));
    await generating.get(id);
    return (await db.collection("leaderboard_editions").findOne({ _id: id }))!;
  }
  const seenBy = async (workspaceId: string, week: string, userId: string) => Boolean(await db.collection("leaderboard_seen").findOne({ _id: `${workspaceId}:${week}:${userId}` }));

  // What the app checks when it opens: is there an edition this person hasn't seen, with anyone on it?
  router.get("/leaderboard/weekly/status", async (req, res) => {
    const actor = req.actor!;
    const edition = await latestEdition(actor.membership.workspaceId);
    const board = edition.board as LeaderboardBoard;
    res.json({ ok: true, data: jsonValue({ id: edition.week, weekStart: edition.weekStart, weekEnd: edition.weekEnd, ranked: board.people.filter((entry) => entry.rank).length, seen: await seenBy(actor.membership.workspaceId, String(edition.week), actor.id) }) });
  });

  router.get("/leaderboard/weekly", async (req, res) => {
    const actor = req.actor!;
    const learners = z.enum(["true", "false"]).optional().parse(req.query.learners) === "true";
    const edition = await latestEdition(actor.membership.workspaceId);
    res.json({ ok: true, data: jsonValue({ id: edition.week, weekStart: edition.weekStart, weekEnd: edition.weekEnd, timeZone: edition.timeZone, generatedAt: edition.generatedAt, board: learners ? edition.boardWithLearners : edition.board, seen: await seenBy(actor.membership.workspaceId, String(edition.week), actor.id) }) });
  });

  router.post("/leaderboard/weekly/:week/seen", async (req, res) => {
    const actor = req.actor!;
    const week = weekSchema.parse(req.params.week);
    const workspaceId = actor.membership.workspaceId;
    if (!(await db.collection("leaderboard_editions").findOne({ _id: `${workspaceId}:${week}` }, { projection: { _id: 1 } }))) throw new AppError(404, "NOT_FOUND", "There is no edition for that week");
    await db.collection("leaderboard_seen").updateOne({ _id: `${workspaceId}:${week}:${actor.id}` }, { $setOnInsert: { workspaceId, week, userId: actor.id, seenAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: { seen: true } });
  });

  return router;
}
