import { randomUUID } from "node:crypto";
import { commandPreviewSchema, type CommandPreview, type ParsedCommand } from "@venture-studio/contracts";
import { hasDeadlineRisk } from "./reminders.js";

export class CommandSyntaxError extends Error {}

function tokens(input: string): string[] {
  const values = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return values.map((value) => value.startsWith('"') ? value.slice(1, -1) : value);
}

function fields(parts: string[]): Map<string, string> {
  return new Map(parts.flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
  }));
}

function user(value: string | undefined): string {
  if (!value?.startsWith("@") || value.length < 2) throw new CommandSyntaxError("A recipient like @name is required");
  return value.slice(1);
}

function iso(value: string | undefined, field: string): string {
  if (!value || Number.isNaN(Date.parse(value))) throw new CommandSyntaxError(`${field} must be an ISO 8601 date`);
  return new Date(value).toISOString();
}

export function parseCommand(input: string): ParsedCommand {
  const parts = tokens(input.trim());
  const options = fields(parts.slice(2));
  const timezone = options.get("timezone") ?? "UTC";
  if (parts[0] === "/assign") {
    const title = parts[2]?.includes("=") ? undefined : parts[2];
    const estimate = Number(options.get("estimate"));
    if (!title) throw new CommandSyntaxError("Usage: /assign @user \"task\" due=<ISO> estimate=<minutes> [timezone=<IANA>]");
    return { kind: "assign", assignee: user(parts[1]), title, dueAt: iso(options.get("due"), "due"), estimatedMinutes: estimate, timezone };
  }
  if (parts[0] === "/notify") {
    const message = parts[2]?.includes("=") ? undefined : parts[2];
    if (!message) throw new CommandSyntaxError("Usage: /notify @user \"message\" at=<ISO> [timezone=<IANA>]");
    return { kind: "notify", recipient: user(parts[1]), message, scheduledAt: iso(options.get("at"), "at"), timezone };
  }
  throw new CommandSyntaxError("Supported commands are /assign and /notify");
}

export function previewCommand(input: string, now = new Date()): CommandPreview {
  const command = parseCommand(input);
  const warnings: string[] = [];
  if (command.kind === "assign" && hasDeadlineRisk(command.dueAt, command.estimatedMinutes, now)) {
    warnings.push("Estimated effort exceeds the time remaining before the deadline.");
  }
  return commandPreviewSchema.parse({
    previewId: randomUUID(),
    normalizedInput: input.trim().replace(/\s+/g, " "),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    command,
    warnings,
  });
}
