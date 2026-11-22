import { z } from "zod";
import {
  autopilotRunResultSchema, autopilotSettingsSchema, autopilotStatusSchema, draftBatchInputSchema, draftBatchResultSchema, successEnvelope,
  type AutopilotDay, type AutopilotSendMode, type AutopilotSettings, type AutopilotStatus, type DraftBatchResult,
} from "@venture-studio/contracts";
import { salesRequest as request } from "@/lib/sales-api";

// Client for the Sales autopilot (docs/sales-autopilot.md): a venture's autopilot settings and what it did, asking for a pass now, and
// approving or queueing several drafts at once. Every route lives under /v1/sales and takes a signed-in person only (never Claude).
// A server from before the autopilot answers "Route not found": callers then hide the feature (isRouteMissing in sales-channels-api.ts).

export type { AutopilotDay, AutopilotSendMode, AutopilotSettings, AutopilotStatus, DraftBatchResult };
export type AutopilotSettingsInput = z.input<typeof autopilotSettingsSchema>;
export type DraftBatchInput = z.input<typeof draftBatchInputSchema>;

const id = encodeURIComponent;
const body = (value: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(value) });

/** The venture's autopilot: its settings, whether the server can run each step, what it did today and before, and what waits. */
export async function getAutopilot(ventureId: string): Promise<AutopilotStatus> {
  return successEnvelope(autopilotStatusSchema).parse(await request(`/v1/sales/autopilot?ventureId=${id(ventureId)}`)).data;
}

/** Saves the venture's autopilot settings (a head or an admin). Whatever is left out takes its default. */
export async function saveAutopilot(ventureId: string, input: AutopilotSettingsInput): Promise<AutopilotStatus> {
  return successEnvelope(autopilotStatusSchema).parse(await request(`/v1/sales/autopilot?ventureId=${id(ventureId)}`, body(autopilotSettingsSchema.parse(input), "PUT"))).data;
}

/** Asks the autopilot for a pass now instead of at its next turn. `started` false comes with the reason. */
export async function runAutopilotNow(ventureId: string): Promise<{ started: boolean; reason?: string | undefined }> {
  return successEnvelope(autopilotRunResultSchema).parse(await request(`/v1/sales/autopilot/run?ventureId=${id(ventureId)}`, body({}))).data;
}

/** Approves, queues to send, or takes back several drafts at once. Each draft answers on its own (`results`). */
export async function batchDrafts(input: DraftBatchInput): Promise<DraftBatchResult> {
  return successEnvelope(draftBatchResultSchema).parse(await request("/v1/sales/drafts/batch", body(draftBatchInputSchema.parse(input)))).data;
}
