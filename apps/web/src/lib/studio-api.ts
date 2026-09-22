import {
  createTaskSchema,
  createChannelMessageSchema,
  commandExecuteSchema,
  commandPreviewRequestSchema,
  commandPreviewSchema,
  dashboardResponseSchema,
  evidenceItemSchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  focusSessionSchema,
  messageSchema,
  notificationSchema,
  pagedSuccessEnvelope,
  reminderSchema,
  snoozeSchema,
  startFocusSchema,
  sessionBootstrapResponseSchema,
  successEnvelope,
  taskListQuerySchema,
  taskSchema,
  taskUpdateSchema,
  updateTaskSchema,
  type Task,
} from "@venture-studio/contracts";

export class StudioApiError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "StudioApiError";
  }
}

async function request(path: string, init?: RequestInit, options: { devAuth?: boolean } = {}): Promise<unknown> {
  const localDevAuth = options.devAuth !== false && process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" && window.location.hostname === "localhost";
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(localDevAuth ? { "x-dev-user-id": "user-divyansh" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorEnvelopeSchema.safeParse(body);
    if (error.success) throw new StudioApiError(error.data.error.message, error.data.error.code, error.data.error.requestId);
    throw new StudioApiError(`The API returned HTTP ${response.status}.`);
  }
  return body;
}

export async function loadLiveDashboard() {
  const [bootstrap, dashboard] = await Promise.all([
    request("/v1/session/bootstrap"),
    request("/v1/dashboard"),
  ]);
  return {
    bootstrap: sessionBootstrapResponseSchema.parse(bootstrap).data,
    dashboard: dashboardResponseSchema.parse(dashboard).data,
  };
}

export async function loadLiveSession() {
  return sessionBootstrapResponseSchema.parse(await request("/v1/session/bootstrap")).data;
}

type TaskFilters = Partial<Pick<Task, "ventureId" | "groupId" | "assigneeId" | "status" | "priority">> & { tag?: string };

export async function listLiveTasks(cursor?: string, filters: TaskFilters = {}) {
  const query = taskListQuerySchema.parse({ limit: 100, cursor, ...filters });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return pagedSuccessEnvelope(taskSchema).parse(await request(`/v1/tasks?${params}`)).data;
}

export async function getLiveTask(id: string) {
  const data = successEnvelope(taskSchema.passthrough()).parse(await request(`/v1/tasks/${encodeURIComponent(id)}`)).data;
  return {
    task: taskSchema.parse(data),
    updates: taskUpdateSchema.array().parse(data.updates),
    evidence: evidenceItemSchema.array().parse(data.evidence),
  };
}

export async function createLiveTask(input: unknown) {
  const valid = createTaskSchema.parse(input);
  return successEnvelope(taskSchema).parse(await request("/v1/tasks", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveTask(id: string, input: unknown) {
  const valid = updateTaskSchema.parse(input);
  return successEnvelope(taskSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function commentOnLiveTask(id: string, body: string) {
  return successEnvelope(taskUpdateSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ body }) })).data;
}

export async function submitLiveEvidence(id: string, input: { title: string; description: string; uri?: string }) {
  return successEnvelope(evidenceItemSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}/evidence`, { method: "POST", body: JSON.stringify({ type: input.uri ? "link" : "note", ...input }) })).data;
}

export async function reviewLiveEvidence(id: string, status: "accepted" | "rejected" | "exception") {
  return successEnvelope(evidenceItemSchema).parse(await request(`/v1/evidence/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ status }) })).data;
}

export async function acceptLiveInvitation(token: string) {
  const result = await request("/v1/invitations/accept", { method: "POST", body: JSON.stringify({ token }) }, { devAuth: false });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("accepted" in result.data) || result.data.accepted !== true) throw new StudioApiError("The invitation response was invalid.");
}

export async function listLiveChannelMessages(channelId: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(messageSchema).parse(await request(`/v1/channels/${encodeURIComponent(channelId)}/messages?${params}`)).data;
}

export async function sendLiveChannelMessage(channelId: string, input: unknown) {
  const valid = createChannelMessageSchema.parse(input);
  const result = await request(`/v1/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", body: JSON.stringify(valid) });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("message" in result.data) || !("event" in result.data)) throw new StudioApiError("The message response was invalid.");
  return { message: messageSchema.parse(result.data.message), event: eventEnvelopeSchema.parse(result.data.event) };
}

export async function previewLiveCommand(input: unknown) {
  const valid = commandPreviewRequestSchema.parse(input);
  return successEnvelope(commandPreviewSchema).parse(await request("/v1/commands/preview", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function executeLiveCommand(input: unknown, kind: "assign" | "notify") {
  const valid = commandExecuteSchema.parse(input);
  const result = await request("/v1/commands/execute", { method: "POST", body: JSON.stringify(valid) });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("reminder" in result.data)) throw new StudioApiError("The command response was invalid.");
  const taskValue = "task" in result.data ? result.data.task : undefined;
  if (kind === "assign" && taskValue === undefined) throw new StudioApiError("The assignment response had no task.");
  return { reminder: reminderSchema.parse(result.data.reminder), task: kind === "assign" ? taskSchema.parse(taskValue) : undefined };
}

export async function listLiveNotifications() {
  return successEnvelope(notificationSchema.array()).parse(await request("/v1/notifications")).data;
}

export async function readLiveNotification(id: string) {
  const result = await request(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new StudioApiError("The notification response was invalid.");
}

export async function snoozeLiveReminder(id: string, minutes: 10 | 20 | 30 | "never") {
  const valid = snoozeSchema.parse({ minutes });
  return successEnvelope(reminderSchema).parse(await request(`/v1/reminders/${encodeURIComponent(id)}/snooze`, { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function getCurrentLiveFocus() {
  return successEnvelope(focusSessionSchema.nullable()).parse(await request("/v1/focus/current")).data;
}

export async function startLiveFocus(input: unknown) {
  const valid = startFocusSchema.parse(input);
  return successEnvelope(focusSessionSchema).parse(await request("/v1/focus", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function completeLiveFocus(id: string) {
  return successEnvelope(focusSessionSchema).parse(await request(`/v1/focus/${encodeURIComponent(id)}/complete`, { method: "POST" })).data;
}
