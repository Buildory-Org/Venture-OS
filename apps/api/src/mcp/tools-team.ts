import { createHash } from "node:crypto";
import { z } from "zod";
import { clip, compact, localTime, ToolError, UNTRUSTED_NOTE, validTimeZone } from "./format.js";
import { id, isoField, type Look, once, READ_ONLY, type Register, requestIdField, taskLink, taskRow, timezoneField, type ToolContext, writes } from "./kit.js";

const person = z.union([z.literal("me"), id]).describe('"me" or a person id from find_person');
const priority = z.enum(["low", "medium", "high", "urgent"]);
const stage = z.enum(["identified", "qualified", "contacted", "conversation", "proposal", "won", "lost"]);
const confidence = z.enum(["low", "medium", "high"]);
const channelLink = (ctx: ToolContext, channelId: string) => `${ctx.origin}/channels/live?channel=${encodeURIComponent(channelId)}`;
const money = (minor: unknown, currency: unknown) => typeof minor === "number" ? `${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${typeof currency === "string" ? currency : ""}`.trim() : undefined;
/** The app de-duplicates messages by a client id; deriving it from requestId makes a retried tool call post once. */
const clientId = (requestId: string) => `mcp-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`;

/** People, tasks, reviews, messages, decisions, information requests, sales, and classes. */
export function registerTeamTools(tool: Register, ctx: ToolContext, look: Look): void {
  const who = (value: string | undefined) => value === "me" ? ctx.userId : value;
  const name = async (personId: unknown) => personId === ctx.userId ? "me" : look.person(personId);

  tool("find_person", "ventures:read", {
    title: "Find person", annotations: READ_ONLY,
    description: "Look people up by name or @handle (optionally only those in a venture or group) to get the person id that create_task, mentions, requests, and messages need.",
    inputSchema: z.object({ query: z.string().trim().min(2).max(80).optional().describe("Part of a name, or @handle for an exact handle"), ventureId: id.optional(), groupId: id.optional(), limit: z.number().int().min(1).max(25).default(10) }),
  }, async ({ query, ventureId, groupId, limit }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query?.startsWith("@")) params.set("handle", query.slice(1)); else if (query) params.set("q", query);
    if (ventureId) params.set("ventureId", ventureId); if (groupId) params.set("groupId", groupId);
    const page = await ctx.api<{ items: any[] }>("GET", `/members?${params}`);
    return compact({ people: page.items.map((item) => compact({ id: item.id, name: clip(item.name, 120), handle: item.handle ? `@${item.handle}` : undefined, role: item.role, you: item.id === ctx.userId || undefined })), hint: page.items.length ? undefined : "Nobody matches; try part of the name." });
  });

  tool("create_task", "tasks:write", {
    title: "Create task", annotations: writes(false),
    description: "Create a task in a venture's group and assign it. The assignee and reviewer must belong to that group (or be workspace admins). Outcome, definition of done, and evidence default to sensible text when left out. The assignee is notified and reminded before the due time.",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200), ventureId: id, groupId: id.optional().describe("Needed when the venture has more than one group (see list_ventures)"),
      assignee: person, reviewer: person.optional(), dueAt: isoField("When it is due, ISO 8601 with offset, e.g. 2026-10-12T17:00:00+05:30"),
      estimatedMinutes: z.number().int().min(1).max(100_800).default(60), priority: priority.default("medium"),
      outcome: z.string().trim().min(1).max(2000).optional(), definitionOfDone: z.string().trim().min(1).max(5000).optional(), evidenceRequirement: z.string().trim().min(1).max(2000).optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(), timezone: timezoneField, requestId: requestIdField,
    }),
  }, async (input) => {
    const timeZone = validTimeZone(input.timezone);
    const { ventures } = await look.ventures();
    const venture = ventures.get(input.ventureId);
    if (!venture) throw new ToolError("Venture not found, or you can't open it. Use list_ventures for the ids you can use.", 404);
    let groupId = input.groupId as string | undefined;
    if (!groupId) {
      if (venture.groups.length !== 1) throw new ToolError(venture.groups.length ? `Choose a groupId: ${venture.groups.map((group: any) => `${group.name} (${group.id})`).join(", ")}.` : "This venture has no group you can open, so it can't hold tasks yet.");
      groupId = venture.groups[0].id as string;
    }
    const body = {
      ventureId: input.ventureId, groupId, title: input.title, outcome: input.outcome ?? input.title, assigneeId: who(input.assignee), ...(input.reviewer ? { reviewerId: who(input.reviewer) } : {}),
      priority: input.priority, dueAt: input.dueAt, timezone: timeZone, estimatedMinutes: input.estimatedMinutes,
      definitionOfDone: input.definitionOfDone ?? input.title, evidenceRequirement: input.evidenceRequirement ?? "Evidence link or reviewed exception",
      tags: input.tags ?? [], dependencies: [], evidenceLinks: [],
    };
    return once(ctx, "create_task", input.requestId, body, async () => {
      const task = await ctx.api<any>("POST", "/tasks", body);
      return compact({ ...await taskRow(ctx, look, task, timeZone), assignee: await name(task.assigneeId), reviewer: await name(task.reviewerId) });
    });
  });

  tool("update_task", "tasks:write", {
    title: "Update task", annotations: writes(true),
    description: "Reassign a task or change its reviewer, priority, due time, estimate, or blocker note (null clears it). Only venture leads and admins may change assignment and planning; the assignee or reviewer may set the blocker. Use set_task_status for status.",
    inputSchema: z.object({ taskId: id, assignee: person.optional(), reviewer: person.optional(), priority: priority.optional(), dueAt: isoField("New due time, ISO 8601 with offset").optional(), estimatedMinutes: z.number().int().min(1).max(100_800).optional(), blocker: z.string().trim().max(2000).nullable().optional(), timezone: timezoneField }),
  }, async ({ taskId, assignee, reviewer, priority: newPriority, dueAt, estimatedMinutes, blocker, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const change = compact({ assigneeId: who(assignee), reviewerId: who(reviewer), priority: newPriority, dueAt, estimatedMinutes });
    if (blocker !== undefined) Object.assign(change, { blocker: blocker || null });
    if (!Object.keys(change).length) throw new ToolError("Say what to change.");
    const task = await ctx.api<any>("PATCH", `/tasks/${encodeURIComponent(taskId)}`, change);
    return compact({ ...await taskRow(ctx, look, task, timeZone), assignee: await name(task.assigneeId), reviewer: await name(task.reviewerId) });
  });

  tool("review_evidence", "tasks:write", {
    title: "Review evidence", annotations: writes(false),
    description: "Accept evidence on a task, send it back, or record a reviewed exception (evidence ids come from get_task). Only the task's reviewer or a venture lead may review, never on their own task. An optional comment is posted on the task, e.g. what to fix.",
    inputSchema: z.object({ evidenceId: id, decision: z.enum(["accept", "send_back", "exception"]), comment: z.string().trim().min(1).max(5000).optional(), requestId: requestIdField }),
  }, async ({ evidenceId, decision, comment, requestId }) => once(ctx, "review_evidence", requestId, { evidenceId, decision, comment }, async () => {
    const status = { accept: "accepted", send_back: "rejected", exception: "exception" }[decision as "accept" | "send_back" | "exception"];
    const evidence = await ctx.api<any>("POST", `/evidence/${encodeURIComponent(evidenceId)}/review`, { status });
    if (comment) await ctx.api("POST", `/tasks/${encodeURIComponent(evidence.taskId)}/comments`, { body: comment });
    return compact({ evidenceId, status: evidence.reviewStatus, commented: comment ? true : undefined, url: taskLink(ctx, String(evidence.taskId)) });
  }));

  tool("post_message", "messages:write", {
    title: "Post message", annotations: writes(false),
    description: "Post a message in a channel I belong to (channel ids from list_ventures). It appears under my name with a 'via Claude' label. Mention people by passing their ids in mention. The people mentioned are notified, and so is everyone who follows every message in that channel; notices show the text.",
    inputSchema: z.object({ channelId: id, text: z.string().trim().min(1).max(10_000), mention: z.array(id).max(20).optional(), requestId: requestIdField }),
  }, async ({ channelId, text, mention, requestId }) => {
    await ctx.toolBudget("post_message", 10);
    const posted = await ctx.api<any>("POST", `/channels/${encodeURIComponent(channelId)}/messages`, { body: text, mentionUserIds: mention ?? [], clientId: clientId(requestId) });
    const channel = (await look.ventures()).channels.get(channelId);
    return compact({ messageId: posted.message?.id, channel: channel ? `${channel.groupName} #${channel.name}` : undefined, replayed: posted.replayed || undefined, url: channelLink(ctx, channelId) });
  });

  tool("read_direct_messages", "direct_messages:read", {
    title: "Read direct messages", annotations: READ_ONLY,
    description: "My latest direct messages with one person (oldest first).",
    inputSchema: z.object({ personId: id, limit: z.number().int().min(1).max(100).default(20), timezone: timezoneField }),
  }, async ({ personId, limit, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const messages = (await ctx.api<any[]>("GET", `/direct-messages/${encodeURIComponent(personId)}`)).slice(-limit);
    return compact({ with: await look.person(personId), messages: await Promise.all(messages.map(async (item) => compact({ id: item.id, by: item.authorId === ctx.userId ? "me" : await look.person(item.authorId), text: clip(item.body, 600), at: localTime(item.createdAt, timeZone), files: Array.isArray(item.attachments) && item.attachments.length ? item.attachments.length : undefined, via: item.via }))), url: `${ctx.origin}/messages/live`, note: UNTRUSTED_NOTE });
  });

  tool("send_direct_message", "direct_messages:write", {
    title: "Send direct message", annotations: writes(false),
    description: "Send one person a direct message under my name, labelled 'via Claude'. They are notified.",
    inputSchema: z.object({ personId: id, text: z.string().trim().min(1).max(10_000), requestId: requestIdField }),
  }, async ({ personId, text, requestId }) => {
    if (personId === ctx.userId) throw new ToolError("Direct messages go to someone else.");
    await ctx.toolBudget("send_direct_message", 10);
    const message = await ctx.api<any>("POST", "/direct-messages", { recipientId: personId, body: text, clientId: clientId(requestId) });
    return compact({ messageId: message.id, to: await look.person(personId), url: `${ctx.origin}/messages/live` });
  });

  tool("record_decision", "decisions:write", {
    title: "Record decision", annotations: writes(false),
    description: "Record a decision and why it was made (venture leads and admins). It is saved as a draft for a lead to approve in the app.",
    inputSchema: z.object({ title: z.string().trim().min(1).max(200), decision: z.string().trim().min(1).max(10_000), reason: z.string().trim().min(1).max(5000), ventureId: id.optional().describe("Leave out only for a workspace-wide decision (admins)"), evidence: z.array(z.string().trim().min(1).max(500)).max(20).optional().describe("Links or short notes backing it"), reviewTrigger: z.string().trim().max(1000).optional().describe("When to revisit it"), decidedAt: isoField("When it was decided (default now)").optional(), requestId: requestIdField }),
  }, async ({ title, decision, reason, ventureId, evidence, reviewTrigger, decidedAt, requestId }) => once(ctx, "record_decision", requestId, { title, decision, reason, ventureId, evidence, reviewTrigger, decidedAt }, async () => {
    const item = await ctx.api<any>("POST", "/decisions", { ...(ventureId ? { ventureId } : {}), title, text: decision, reason, ownerId: ctx.userId, decidedAt: decidedAt ?? new Date().toISOString(), evidence: evidence ?? [], affectedWork: [], reviewTrigger: reviewTrigger ?? "", status: "draft" });
    return { decisionId: item.id, status: item.status, url: `${ctx.origin}/decisions/live`, note: "Saved as a draft; approve it in the app when it is final." };
  }));

  tool("list_requests", "requests:read", {
    title: "List information requests", annotations: READ_ONLY,
    description: "Information requests I asked for or was asked to answer, newest first.",
    inputSchema: z.object({ status: z.enum(["open", "answered", "reviewed", "closed"]).optional(), mine: z.enum(["asked_me", "i_asked", "all"]).default("all"), limit: z.number().int().min(1).max(50).default(20), timezone: timezoneField }),
  }, async ({ status, mine, limit, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const { ventures } = await look.ventures();
    const rows = (await ctx.api<any[]>("GET", "/information-requests")).filter((item) => (!status || item.status === status) && (mine === "all" || (mine === "asked_me" ? item.respondentId === ctx.userId : item.requesterId === ctx.userId))).slice(0, limit);
    const items = await Promise.all(rows.map(async (item) => compact({ id: item.id, question: clip(item.question, 300), purpose: clip(item.purpose, 200), status: item.status, due: localTime(item.dueAt, timeZone), from: item.requesterId === ctx.userId ? "me" : await look.person(item.requesterId), to: item.respondentId === ctx.userId ? "me" : await look.person(item.respondentId), venture: ventures.get(item.ventureId)?.name, answer: clip(item.responseMarkdown, 500) })));
    return compact({ items, url: `${ctx.origin}/requests/live`, note: items.length ? UNTRUSTED_NOTE : undefined, hint: items.length ? undefined : "No information requests here." });
  });

  tool("ask_for_information", "requests:write", {
    title: "Ask for information", annotations: writes(false),
    description: "Ask someone in a venture for information by a due time, saying why it is needed. They answer it in the app (or with answer_request).",
    inputSchema: z.object({ personId: id, ventureId: id, question: z.string().trim().min(1).max(5000), purpose: z.string().trim().min(1).max(2000).describe("Why it is needed"), dueAt: isoField("When it is needed by, ISO 8601 with offset"), requestId: requestIdField }),
  }, async ({ personId, ventureId, question, purpose, dueAt, requestId }) => once(ctx, "ask_for_information", requestId, { personId, ventureId, question, purpose, dueAt }, async () => {
    const item = await ctx.api<any>("POST", "/information-requests", { ventureId, respondentId: personId, question, purpose, dueAt });
    return { informationRequestId: item.id, status: item.status, to: await look.person(personId), url: `${ctx.origin}/requests/live` };
  }));

  tool("answer_request", "requests:write", {
    title: "Answer request", annotations: writes(true),
    description: "Answer an information request I was asked (ids from list_requests). Answering again replaces my earlier answer while it is not yet reviewed.",
    inputSchema: z.object({ informationRequestId: id, answer: z.string().trim().min(1).max(50_000).describe("The answer, in Markdown (up to 50,000 characters)") }),
  }, async ({ informationRequestId, answer }) => {
    const item = await ctx.api<any>("PATCH", `/information-requests/${encodeURIComponent(informationRequestId)}`, { status: "answered", responseMarkdown: answer });
    return { informationRequestId, status: item.status, url: `${ctx.origin}/requests/live` };
  });

  tool("list_deals", "sales:read", {
    title: "List deals", annotations: READ_ONLY,
    description: "Sales pipelines and their deals in ventures I can open, filtered by venture or stage. Pipeline ids are needed by add_deal.",
    inputSchema: z.object({ ventureId: id.optional(), stage: stage.optional(), limit: z.number().int().min(1).max(100).default(30), timezone: timezoneField }),
  }, async ({ ventureId, stage: wanted, limit, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const [pipelines, deals] = await Promise.all([ctx.api<any[]>("GET", "/pipelines"), ctx.api<any[]>("GET", "/opportunities")]);
    const { ventures } = await look.ventures();
    const shownPipelines = pipelines.filter((item) => !ventureId || item.ventureId === ventureId);
    const names = new Map(shownPipelines.map((item) => [item.id, item.name]));
    const rows = deals.filter((item) => names.has(item.pipelineId) && (!wanted || item.stage === wanted)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    return compact({
      pipelines: shownPipelines.map((item) => compact({ id: item.id, name: clip(item.name, 120), offer: clip(item.offerName, 160), status: item.status, venture: ventures.get(item.ventureId)?.name })),
      deals: await Promise.all(rows.map(async (item) => compact({ id: item.id, company: clip(item.companyName, 160), contact: clip(item.contactName, 120), stage: item.stage, value: money(item.valueEstimateMinor, item.currency), owner: item.ownerId === ctx.userId ? "me" : await look.person(item.ownerId), nextAction: clip(item.nextAction, 200), nextActionAt: localTime(item.nextActionAt, timeZone), pipeline: names.get(item.pipelineId), confidence: item.evidenceConfidence }))),
      url: `${ctx.origin}/sales/live`, note: UNTRUSTED_NOTE,
      hint: shownPipelines.length ? undefined : "No sales pipeline here yet; a venture lead creates one in the app.",
    });
  });

  tool("add_deal", "sales:write", {
    title: "Add deal", annotations: writes(false),
    description: "Add a deal (opportunity) to a sales pipeline (ids from list_deals). value is in whole currency units, e.g. 200000 with currency INR.",
    inputSchema: z.object({
      pipelineId: id, companyName: z.string().trim().min(1).max(200), contactName: z.string().trim().max(200).optional(), stage: stage.default("identified"),
      source: z.string().trim().max(500).optional().describe("Where the lead came from"), observedSignal: z.string().trim().max(2000).optional().describe("What suggests they need it"), fitReason: z.string().trim().max(2000).optional(),
      confidence: confidence.default("low"), nextAction: z.string().trim().max(1000).optional(), nextActionAt: isoField("When the next action is due").optional(),
      value: z.number().nonnegative().max(1e12).optional(), currency: z.string().trim().length(3).toUpperCase().optional(), owner: person.optional(), requestId: requestIdField,
    }),
  }, async (input) => {
    if (input.value !== undefined && !input.currency) throw new ToolError("Give the currency with the value, e.g. INR or USD.");
    const body = { pipelineId: input.pipelineId, companyName: input.companyName, contactName: input.contactName ?? "", stage: input.stage, source: input.source ?? "", observedSignal: input.observedSignal ?? "", fitReason: input.fitReason ?? "", evidenceConfidence: input.confidence, nextAction: input.nextAction ?? "", ...(input.nextActionAt ? { nextActionAt: input.nextActionAt } : {}), ...(input.value !== undefined ? { valueEstimateMinor: Math.round(input.value * 100), currency: input.currency } : {}), ownerId: who(input.owner) ?? ctx.userId };
    return once(ctx, "add_deal", input.requestId, body, async () => {
      const item = await ctx.api<any>("POST", "/opportunities", body);
      return compact({ dealId: item.id, company: item.companyName, stage: item.stage, value: money(item.valueEstimateMinor, item.currency), url: `${ctx.origin}/sales/live` });
    });
  });

  tool("update_deal", "sales:write", {
    title: "Update deal", annotations: writes(true),
    description: "Move a deal to another stage or change its next action, value, contact, confidence, or owner. The deal's owner or a venture lead may change it.",
    inputSchema: z.object({ dealId: id, stage: stage.optional(), nextAction: z.string().trim().max(1000).optional(), nextActionAt: isoField("When the next action is due").optional(), value: z.number().nonnegative().max(1e12).optional(), currency: z.string().trim().length(3).toUpperCase().optional(), contactName: z.string().trim().max(200).optional(), confidence: confidence.optional(), owner: person.optional() }),
  }, async ({ dealId, stage: nextStage, nextAction, nextActionAt, value, currency, contactName, confidence: nextConfidence, owner }) => {
    if (value !== undefined && !currency) throw new ToolError("Give the currency with the value, e.g. INR or USD.");
    const change = compact({ stage: nextStage, nextAction, nextActionAt, contactName, evidenceConfidence: nextConfidence, ownerId: who(owner), ...(value !== undefined ? { valueEstimateMinor: Math.round(value * 100), currency } : {}) });
    if (!Object.keys(change).length) throw new ToolError("Say what to change.");
    const item = await ctx.api<any>("PATCH", `/opportunities/${encodeURIComponent(dealId)}`, change);
    return compact({ dealId, company: item?.companyName, stage: item?.stage, value: money(item?.valueEstimateMinor, item?.currency), url: `${ctx.origin}/sales/live` });
  });

  tool("list_classes", "classes:read", {
    title: "List classes", annotations: READ_ONLY,
    description: "Classes I take part in, run, or review applications for (venture leads see their ventures' classes).",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20), timezone: timezoneField }),
  }, async ({ limit, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const { ventures } = await look.ventures();
    const rows = (await ctx.api<any[]>("GET", "/classes")).slice(0, limit);
    const items = await Promise.all(rows.map(async (item) => compact({ id: item.id, title: clip(item.title, 160), objective: clip(item.objective, 300), when: localTime(item.scheduledAt, timeZone), minutes: item.durationMinutes, status: item.status, facilitator: item.facilitatorId === ctx.userId ? "me" : await look.person(item.facilitatorId), participants: Array.isArray(item.participantIds) ? item.participantIds.length : undefined, imParticipant: Array.isArray(item.participantIds) && item.participantIds.includes(ctx.userId) || undefined, venture: item.ventureId ? ventures.get(item.ventureId)?.name : "Workspace" })));
    return compact({ items, url: `${ctx.origin}/classes/live`, note: items.length ? UNTRUSTED_NOTE : undefined, hint: items.length ? undefined : "No classes for you yet." });
  });

  tool("list_class_applications", "classes:read", {
    title: "List class applications", annotations: READ_ONLY,
    description: "Applications for one class that I may see (mine, ones I review, or all of them for the class lead).",
    inputSchema: z.object({ classId: id, limit: z.number().int().min(1).max(50).default(20), timezone: timezoneField }),
  }, async ({ classId, limit, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const page = await ctx.api<{ items: any[] }>("GET", `/classes/${encodeURIComponent(classId)}/applications?limit=${limit}`);
    const items = await Promise.all(page.items.map(async (item) => compact({ id: item.id, by: item.userId === ctx.userId ? "me" : await look.person(item.userId), exercise: clip(item.exercise, 500), reviewer: item.reviewerId === ctx.userId ? "me" : await look.person(item.reviewerId), reviewed: localTime(item.reviewedAt, timeZone), assessment: clip(item.assessment, 400), nextGap: clip(item.nextGap, 200), taskUrl: item.taskId ? taskLink(ctx, item.taskId) : undefined })));
    return compact({ items, note: items.length ? UNTRUSTED_NOTE : undefined, hint: items.length ? undefined : "No applications yet." });
  });

  tool("apply_to_class", "classes:write", {
    title: "Apply to class", annotations: writes(false),
    description: "Apply what I learned in a class I'm a participant in: describe the exercise, name a reviewer (not me), and optionally link the task it was applied to.",
    inputSchema: z.object({ classId: id, exercise: z.string().trim().min(1).max(5000), reviewerId: id, taskId: id.optional(), requestId: requestIdField }),
  }, async ({ classId, exercise, reviewerId, taskId, requestId }) => once(ctx, "apply_to_class", requestId, { classId, exercise, reviewerId, taskId }, async () => {
    const item = await ctx.api<any>("POST", `/classes/${encodeURIComponent(classId)}/applications`, { exercise, reviewerId, ...(taskId ? { taskId } : {}) });
    return { applicationId: item.id, reviewer: await look.person(reviewerId), url: `${ctx.origin}/classes/live` };
  }));

  tool("review_class_application", "classes:write", {
    title: "Review class application", annotations: writes(true),
    description: "Assess a class application I review (or any, as the class lead), with the next gap to work on.",
    inputSchema: z.object({ classId: id, applicationId: id, assessment: z.string().trim().min(1).max(5000), nextGap: z.string().trim().max(2000).optional() }),
  }, async ({ classId, applicationId, assessment, nextGap }) => {
    const item = await ctx.api<any>("PATCH", `/classes/${encodeURIComponent(classId)}/applications/${encodeURIComponent(applicationId)}/review`, { assessment, ...(nextGap ? { nextGap } : {}) });
    return compact({ applicationId, reviewed: Boolean(item.reviewedAt), url: `${ctx.origin}/classes/live` });
  });
}
