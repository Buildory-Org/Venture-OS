import {
  dashboardResponseSchema,
  errorEnvelopeSchema,
  pagedSuccessEnvelope,
  sessionBootstrapResponseSchema,
  successEnvelope,
  taskSchema,
  updateTaskSchema,
} from "@venture-studio/contracts";

export class StudioApiError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "StudioApiError";
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const localDevAuth = process.env.NODE_ENV === "development" &&
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

export async function listLiveTasks(cursor?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(taskSchema).parse(await request(`/v1/tasks?${params}`)).data;
}

export async function updateLiveTask(id: string, input: unknown) {
  const valid = updateTaskSchema.parse(input);
  return successEnvelope(taskSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}
