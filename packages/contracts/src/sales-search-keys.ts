import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// The company-search keys (TinyFish, Exa) an admin saves in Sales setup: up to 10 per engine, tried in order (the next one when a key is
// used up, refused or busy). The API never returns a key: only an id per key, where it comes from (saved in the app, or the server's
// environment), a saved key's last four characters, when and by whom, and what it used this period.

export const SALES_SEARCH_ENGINES = ["tinyfish", "exa"] as const;
export const salesSearchEngineSchema = z.enum(SALES_SEARCH_ENGINES);
export type SalesSearchEngine = z.infer<typeof salesSearchEngineSchema>;
/** At most this many keys per engine saved in the app (and read from the server's environment). */
export const MAX_SEARCH_KEYS = 10;
/** A key's id: made when it is saved, "main" for the one saved before several keys were allowed, "server-1"… for the server's. */
export const salesSearchKeyIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,40}$/, "not a key id");

/** A key as pasted: trimmed, 10 to 300 characters, with no spaces, commas or line breaks inside. */
export const salesSearchKeyInputSchema = z.object({
  key: z.string().trim().min(10, "A key is at least 10 characters").max(300, "A key is at most 300 characters").regex(/^[^\s,]+$/, "A key has no spaces, commas or line breaks in it"),
});
export type SalesSearchKeyInput = z.infer<typeof salesSearchKeyInputSchema>;

/**
 * One key. `source` "app" is a key saved here (saved keys replace the server's), "server" one from the API's environment. `unreadable` is a
 * saved key that can't be decrypted any more (enter it again). `used` of `limit` is this period's calls (a day for TinyFish, a month for
 * Exa); `usedUp` means search skips it for now: its allowance is used (until the period ends), or the engine refused it (paused for up to
 * an hour; a test that works ends the pause).
 */
export const salesSearchKeyEntrySchema = z.object({
  id: salesSearchKeyIdSchema, source: z.enum(["app", "server"]),
  last4: z.string().max(4).optional(), setAt: isoDateSchema.optional(), setBy: idSchema.optional(), setByName: z.string().max(200).optional(), unreadable: z.boolean().optional(),
  used: z.number().int().nonnegative(), limit: z.number().int().positive(), period: z.enum(["day", "month"]), usedUp: z.boolean().optional(),
});
export type SalesSearchKeyEntry = z.infer<typeof salesSearchKeyEntrySchema>;
/** One engine: `set` when search can use it, `source` where the keys in use come from, and its keys in the order they are tried. */
export const salesSearchKeyStatusSchema = z.object({ set: z.boolean(), source: z.enum(["app", "server"]).nullable(), keys: z.array(salesSearchKeyEntrySchema).max(2 * MAX_SEARCH_KEYS) });
export type SalesSearchKeyStatus = z.infer<typeof salesSearchKeyStatusSchema>;
export const salesSearchKeysSchema = z.object({ tinyfish: salesSearchKeyStatusSchema, exa: salesSearchKeyStatusSchema });
export type SalesSearchKeys = z.infer<typeof salesSearchKeysSchema>;

/** What one small test search with a key said: it worked, or a short message that carries no part of the key. */
export const salesSearchKeyTestSchema = z.object({ ok: z.boolean(), message: z.string().max(300).optional() });
export type SalesSearchKeyTest = z.infer<typeof salesSearchKeyTestSchema>;
