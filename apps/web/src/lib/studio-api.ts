import {
  createTaskSchema,
  channelSchema,
  createChannelMessageSchema,
  createChannelSchema,
  commandExecuteSchema,
  commandPreviewRequestSchema,
  commandPreviewSchema,
  dashboardResponseSchema,
  evidenceItemSchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  focusSessionSchema,
  informationRequestSchema,
  knowledgeSearchResponseSchema,
  knowledgeSearchSchema,
  messageSchema,
  membershipSchema,
  opportunityInputSchema,
  opportunitySchema,
  pipelineInputSchema,
  pipelineSchema,
  pinUpdateSchema,
  reactionUpdateSchema,
  saveUpdateSchema,
  notificationSchema,
  outcomeSchema,
  pagedSuccessEnvelope,
  reminderSchema,
  snoozeSchema,
  startFocusSchema,
  classSchema,
  decisionSchema,
  documentSchema,
  documentVersionSchema,
  sessionBootstrapResponseSchema,
  successEnvelope,
  taskListQuerySchema,
  taskSchema,
  taskUpdateSchema,
  updateTaskSchema,
  updateInformationRequestSchema,
  updateClassSchema,
  updateDecisionSchema,
  updateMembershipSchema,
  updateOpportunitySchema,
  updateOutcomeSchema,
  updatePipelineSchema,
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

export async function updateLiveMessageReaction(id: string, emoji: string, active: boolean) {
  const valid = reactionUpdateSchema.parse({ emoji, active });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/reaction`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function updateLiveMessageSave(id: string, saved: boolean) {
  const valid = saveUpdateSchema.parse({ saved });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/save`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function updateLiveMessagePin(id: string, pinned: boolean) {
  const valid = pinUpdateSchema.parse({ pinned });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/pin`, { method: "PUT", body: JSON.stringify(valid) })).data;
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

export async function searchLiveKnowledge(q: string, ventureId?: string) {
  const query = knowledgeSearchSchema.parse({ q, ventureId, limit: 25 });
  const params = new URLSearchParams({ q: query.q, limit: String(query.limit) });
  if (query.ventureId) params.set("ventureId", query.ventureId);
  return knowledgeSearchResponseSchema.parse(await request(`/v1/knowledge/search?${params}`)).data;
}

export async function getLiveDocument(id: string) {
  const data = successEnvelope(documentSchema.passthrough()).parse(await request(`/v1/documents/${encodeURIComponent(id)}`)).data;
  return { document: documentSchema.parse(data), version: documentVersionSchema.parse(data.currentVersion) };
}

export async function listLiveOutcomes() {
  return successEnvelope(outcomeSchema.array()).parse(await request("/v1/outcomes")).data;
}

export async function updateLiveOutcome(id: string, input: unknown) {
  const valid = updateOutcomeSchema.parse(input);
  return successEnvelope(outcomeSchema).parse(await request(`/v1/outcomes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveDecisions() {
  return successEnvelope(decisionSchema.array()).parse(await request("/v1/decisions")).data;
}

export async function updateLiveDecision(id: string, input: unknown) {
  const valid = updateDecisionSchema.parse(input);
  return successEnvelope(decisionSchema).parse(await request(`/v1/decisions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveClasses() {
  return successEnvelope(classSchema.array()).parse(await request("/v1/classes")).data;
}

export async function updateLiveClass(id: string, input: unknown) {
  const valid = updateClassSchema.parse(input);
  return successEnvelope(classSchema).parse(await request(`/v1/classes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveInformationRequests() {
  return successEnvelope(informationRequestSchema.array()).parse(await request("/v1/information-requests")).data;
}

export async function updateLiveInformationRequest(id: string, input: unknown) {
  const valid = updateInformationRequestSchema.parse(input);
  return successEnvelope(informationRequestSchema).parse(await request(`/v1/information-requests/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLivePipelines() {
  return successEnvelope(pipelineSchema.array()).parse(await request("/v1/pipelines")).data;
}

export async function createLivePipeline(input: unknown) {
  const valid = pipelineInputSchema.parse(input);
  return successEnvelope(pipelineSchema).parse(await request("/v1/pipelines", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLivePipeline(id: string, input: unknown) {
  const valid = updatePipelineSchema.parse(input);
  return successEnvelope(pipelineSchema).parse(await request(`/v1/pipelines/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveOpportunities() {
  return successEnvelope(opportunitySchema.array()).parse(await request("/v1/opportunities")).data;
}

export async function createLiveOpportunity(input: unknown) {
  const valid = opportunityInputSchema.parse(input);
  return successEnvelope(opportunitySchema).parse(await request("/v1/opportunities", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveOpportunity(id: string, input: unknown) {
  const valid = updateOpportunitySchema.parse(input);
  return successEnvelope(opportunitySchema).parse(await request(`/v1/opportunities/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveMemberships() {
  return successEnvelope(membershipSchema.array()).parse(await request("/v1/admin/memberships")).data;
}

export async function updateLiveMembership(id: string, input: unknown) {
  const valid = updateMembershipSchema.parse(input);
  return successEnvelope(membershipSchema).parse(await request(`/v1/admin/memberships/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function createLiveChannel(input: unknown) {
  const valid = createChannelSchema.parse(input);
  return successEnvelope(channelSchema).parse(await request("/v1/admin/channels", { method: "POST", body: JSON.stringify(valid) })).data;
}
