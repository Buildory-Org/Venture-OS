import assert from "node:assert/strict";
import test from "node:test";
import type { Membership } from "@venture-studio/contracts";
import { can, createPat, dmKey, hasDeadlineRisk, matchesPat, parseCommand, previewCommand, snoozeReminder, validateMembershipSubset } from "../src/index.js";

const ids = {
  membership: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  user: "10000000-0000-4000-8000-000000000003",
  venture: "10000000-0000-4000-8000-000000000004",
  group: "10000000-0000-4000-8000-000000000005",
};
const membership: Membership = { id: ids.membership, workspaceId: ids.workspace, userId: ids.user, role: "contributor", ventureIds: [ids.venture], groupIds: [ids.group], createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };

test("permissions require role and scope, while DMs remain workspace-wide", () => {
  assert.equal(can(membership, "task:update", { ventureId: ids.venture, groupId: ids.group }), true);
  assert.equal(can(membership, "task:review", { ventureId: ids.venture }), false);
  assert.equal(can(membership, "venture:read", { ventureId: "20000000-0000-4000-8000-000000000004" }), false);
  assert.equal(validateMembershipSubset(membership, [{ id: ids.group, ventureId: ids.venture }]), true);
  assert.equal(dmKey("b", "a"), "a:b");
});

test("commands parse into typed, expiring previews with deadline warnings", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const command = parseCommand('/notify @alex "Review this" at=2026-09-23T11:00:00Z timezone=Asia/Kolkata', now);
  assert.equal(command.kind, "notify");
  assert.deepEqual(parseCommand('/notify @alex 1h "Review a=b"', now), { kind: "notify", recipient: "alex", message: "Review a=b", scheduledAt: "2026-09-23T11:00:00.000Z", timezone: "UTC" });
  assert.equal(parseCommand('/notify @alex 10m "Review"', now).kind, "notify");
  assert.deepEqual(parseCommand('/assign @alex "Ship API" "90m" 2026-09-23T12:00:00Z', now), { kind: "assign", assignee: "alex", title: "Ship API", dueAt: "2026-09-23T12:00:00.000Z", estimatedMinutes: 90, timezone: "UTC" });
  assert.equal((parseCommand('/assign @alex "Ship API" 1h 2026-09-23T12:00:00Z', now) as any).estimatedMinutes, 60);
  const preview = previewCommand('/assign @alex "Ship API" due=2026-09-23T10:30:00Z estimate=60 timezone=UTC', now);
  assert.equal(preview.warnings.length, 1);
  for (const input of ['/notify @alex 0h "Review"', '/notify @alex 1.5h "Review"', '/notify @alex 1d "Review"', '/notify @alex 1h"Review"', '/notify @alex 1h "Review" at=2026-09-23T11:00:00Z', '/assign @alex "Ship" 1h 2026-09-23T09:00:00Z', '/assign @alex "Ship" 1h tomorrow', '/assign @alex "Ship" 1h 2026-09-23T12:00:00Z due=2026-09-23T12:00:00Z']) {
    assert.throws(() => previewCommand(input, now));
  }
});

test("reminders and PATs use deterministic boundary rules", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  assert.equal(hasDeadlineRisk("2026-09-23T10:30:00.000Z", 60, now), true);
  assert.equal(hasDeadlineRisk("2026-09-23T11:00:00.000Z", 60, now), true);
  assert.equal(hasDeadlineRisk("2026-09-23T11:00:00.001Z", 60, now), false);
  assert.equal(snoozeReminder(new Date("2026-11-01T05:55:00.000Z"), 10)?.toISOString(), "2026-11-01T06:05:00.000Z");
  assert.equal(snoozeReminder(now, 20)?.toISOString(), "2026-09-23T10:20:00.000Z");
  assert.equal(snoozeReminder(now, "never"), null);
  const pat = createPat();
  assert.equal(matchesPat(pat.token, pat.hash), true);
  assert.equal(matchesPat(`${pat.token}x`, pat.hash), false);
});
