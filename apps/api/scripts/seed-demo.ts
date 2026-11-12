// Demo data for screenshots and the live demo. ALL FICTIONAL: made-up companies on .example domains, no real people or contacts.
//
// Writes ONLY to the database `vso_demo`, through the demo API on port 4100 (Sales) and directly (tasks, knowledge, channels).
// Safe to re-run: fixed ids and upserts for direct writes, externalRef / name checks for the API writes.
//
//   1. start the demo API (see demo-start.ps1), the base seed and migration must have run once
//   2. source ./demo-env.sh && npm run seed:demo --workspace @venture-studio/api     (or:  npx tsx apps/api/scripts/seed-demo.ts)
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { connectDatabase } from "../src/db.js";

const config = loadConfig();
if (config.MONGODB_DB !== "vso_demo") throw new Error(`Refusing to run: MONGODB_DB is "${config.MONGODB_DB}", this script only writes to vso_demo`);
const API = process.env.DEMO_API ?? "http://localhost:4100";
if (new URL(API).port !== "4100") throw new Error("Refusing to run: the demo API must be on port 4100");

const database = await connectDatabase(config);
const db = database.db;
const workspaceId = "workspace-studio";
const nowReal = new Date();
const IST = 5.5 * 3_600_000;
/** IST wall-clock time `days` days from today (negative = past). */
const at = (days: number, hour: number, minute = 0) => {
  const ist = new Date(nowReal.getTime() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, hour, minute) - IST);
};
const hoursAgo = (hours: number) => new Date(nowReal.getTime() - hours * 3_600_000);
const upsert = async (collection: string, _id: string, doc: Record<string, unknown>) => { await db.collection(collection).updateOne({ _id }, { $set: doc }, { upsert: true }); };

// ---------------------------------------------------------------------------------------------------------------------
// Studio: tasks, evidence, decisions, knowledge, channels, classes
// ---------------------------------------------------------------------------------------------------------------------
type VentureKey = "buildory" | "edithood" | "spotlyst";
const V = {
  buildory: { id: "venture-buildory", group: "group-buildory", channel: "channel-buildory-general", outcome: "outcome-buildory", slug: "buildory" },
  edithood: { id: "venture-edithood", group: "group-editing-edithood", channel: "channel-editing-edithood-general", outcome: "outcome-editing-edithood", slug: "editing-edithood" },
  spotlyst: { id: "venture-spotlyst", group: "group-spotlyst", channel: "channel-spotlyst-general", outcome: "outcome-spotlyst", slug: "spotlyst" },
} as const;
const U = { divyansh: "user-divyansh", adarsh: "user-adarsh", ashutosh: "user-ashutosh", abhinav: "user-abhinav", shubham: "user-shubham" } as const;
type Ev = { title: string; uri: string; description: string; at: Date; status: "accepted" | "rejected" | "pending"; reviewedAt?: Date };
type T = {
  key: string; v: VentureKey; title: string; outcome: string; assignee: keyof typeof U; reviewer: keyof typeof U; creator?: keyof typeof U;
  priority: "low" | "medium" | "high" | "urgent"; status: string; created: Date; due: Date; est: number; dod: string; evReq: string; details?: string; tags: string[];
  blocker?: string; started?: Date; accepted?: Date; completed?: Date; evidence?: Ev[]; comments?: { by: keyof typeof U; body: string; at: Date }[]; blockedAt?: Date;
};
const doc = (host: string, path: string) => `https://${host}.example/${path}`;

const tasks: T[] = [
  // ---- Done over the last two weeks (these drive the leaderboard) --------------------------------------------------------
  { key: "d1", v: "edithood", title: "Set the weekly editing capacity plan", outcome: "One page that says how many reels the team can edit each week and who edits what.", assignee: "divyansh", reviewer: "adarsh", priority: "medium", status: "done",
    created: at(-13, 10), due: at(-11, 18), est: 90, dod: "Capacity plan lists editors, reels per week and the cut-off for new batches.", evReq: "Link to the plan document.", tags: ["planning", "capacity"], accepted: at(-13, 11), started: at(-12, 10), completed: at(-11, 16),
    evidence: [{ title: "EditHood weekly capacity plan", uri: doc("docs", "edithood/capacity-plan"), description: "Plan with 14 reels a week across three editors.", at: at(-11, 15, 20), status: "accepted", reviewedAt: at(-11, 16) }] },
  { key: "d2", v: "spotlyst", title: "Write the pilot café scope and success measures", outcome: "A one-page scope the pilot café owner can say yes to.", assignee: "divyansh", reviewer: "adarsh", priority: "high", status: "done",
    created: at(-12, 10), due: at(-9, 18), est: 120, dod: "Scope names the screens, the evening service we test on, and two measurable results.", evReq: "Link to the scope document.", tags: ["pilot", "scope"], accepted: at(-12, 11), started: at(-11, 10), completed: at(-9, 17),
    evidence: [{ title: "Pilot café scope v2", uri: doc("docs", "spotlyst/pilot-scope"), description: "Scope with the wrong-order and repeat-call measures.", at: at(-9, 16, 40), status: "accepted", reviewedAt: at(-9, 17) }] },
  { key: "d3", v: "spotlyst", title: "Price the pilot: fixed fee and what it includes", outcome: "A fixed-fee pilot offer the café owner can accept in one reading.", assignee: "divyansh", reviewer: "adarsh", priority: "medium", status: "done",
    created: at(-8, 10), due: at(-5, 18), est: 60, dod: "One fixed fee, what is included, and what is not.", evReq: "Link to the pricing note.", tags: ["pilot", "pricing"], accepted: at(-8, 11), started: at(-7, 10), completed: at(-4, 11, 30),
    evidence: [
      { title: "Pilot pricing note", uri: doc("docs", "spotlyst/pilot-price-v1"), description: "First version of the pricing note.", at: at(-5, 17, 10), status: "rejected", reviewedAt: at(-5, 19) },
      { title: "Pilot pricing note v2", uri: doc("docs", "spotlyst/pilot-price-v2"), description: "Added what is not included.", at: at(-4, 11), status: "accepted", reviewedAt: at(-4, 11, 30) },
    ] },
  { key: "a1", v: "buildory", title: "Shortlist 20 pump and pipe makers in Chhattisgarh and Odisha", outcome: "A list of 20 manufacturers that sell through dealers, each with one proof line from their own site.", assignee: "adarsh", reviewer: "divyansh", priority: "high", status: "done",
    created: at(-13, 10), due: at(-11, 17), est: 180, dod: "20 companies, each with a website and one quote showing they sell through dealers.", evReq: "Link to the shortlist sheet.", tags: ["sales", "research"], accepted: at(-13, 11), started: at(-12, 10), completed: at(-11, 15),
    evidence: [{ title: "Dealer Commerce shortlist", uri: doc("sheets", "buildory/shortlist"), description: "20 companies with quotes and links.", at: at(-11, 14, 10), status: "accepted", reviewedAt: at(-11, 15) }] },
  { key: "a2", v: "buildory", title: "Map the dealer onboarding flow on one page", outcome: "A single page that shows how a dealer gets their first order into the system.", assignee: "adarsh", reviewer: "divyansh", priority: "medium", status: "done",
    created: at(-11, 10), due: at(-9, 18), est: 90, dod: "Flow covers invite, price tier, first order and first dispatch update.", evReq: "Link to the flow diagram.", tags: ["product", "onboarding"], accepted: at(-11, 11), started: at(-10, 10), completed: at(-9, 12),
    evidence: [{ title: "Dealer onboarding flow", uri: doc("docs", "buildory/onboarding-flow"), description: "One-page flow, reviewed with Abhinav.", at: at(-9, 11, 45), status: "accepted", reviewedAt: at(-9, 12) }] },
  { key: "a3", v: "buildory", title: "Write the Dealer Commerce one-page brief", outcome: "A brief the whole team can read in two minutes and repeat to a manufacturer.", assignee: "adarsh", reviewer: "divyansh", priority: "high", status: "done",
    created: at(-10, 10), due: at(-7, 18), est: 120, dod: "Says who it is for, what it does, what we never claim, and the next step.", evReq: "Link to the brief in Knowledge.", tags: ["sales", "offer"], accepted: at(-10, 11), started: at(-9, 10), completed: at(-8, 17),
    evidence: [{ title: "Dealer Commerce: who it's for", uri: doc("venture-os", "knowledge/dealer-commerce"), description: "Approved brief in Knowledge.", at: at(-8, 16, 30), status: "accepted", reviewedAt: at(-8, 17) }],
    comments: [{ by: "divyansh", body: "Clear. The 'what we never claim' part is the most useful bit.", at: at(-8, 17, 5) }] },
  { key: "a4", v: "spotlyst", title: "Interview two café owners about order slips", outcome: "Two real stories of orders that went wrong between the counter and the kitchen.", assignee: "adarsh", reviewer: "divyansh", priority: "medium", status: "done",
    created: at(-9, 10), due: at(-6, 18), est: 120, dod: "Two interviews written up with the exact words the owners used.", evReq: "Link to the interview notes.", tags: ["pilot", "research"], accepted: at(-9, 11), started: at(-8, 10), completed: at(-6, 13),
    evidence: [{ title: "Café owner interview notes", uri: doc("docs", "spotlyst/interviews"), description: "Two interviews, 40 minutes each.", at: at(-6, 12), status: "accepted", reviewedAt: at(-6, 13) }] },
  { key: "a5", v: "spotlyst", title: "Sketch the kitchen order ticket (KOT) screen", outcome: "A ticket the kitchen can read at a glance from two metres away.", assignee: "adarsh", reviewer: "divyansh", priority: "medium", status: "done",
    created: at(-7, 10), due: at(-4, 12), est: 120, dod: "Sketch shows table, items, notes and a 'ready' button, tested on a tablet.", evReq: "Link to the sketch.", tags: ["pilot", "design"], accepted: at(-7, 11), started: at(-6, 10), completed: at(-4, 21),
    evidence: [{ title: "KOT screen sketch", uri: doc("design", "spotlyst/kot-screen"), description: "Tablet-sized sketch, large type.", at: at(-4, 20, 30), status: "accepted", reviewedAt: at(-4, 21) }] },
  { key: "s1", v: "edithood", title: "Deliver batch 10: six reels for a dental clinic", outcome: "Six finished reels the clinic can post this week.", assignee: "ashutosh", reviewer: "divyansh", priority: "high", status: "done",
    created: at(-14, 10), due: at(-12, 18), est: 300, dod: "Six reels, 9:16, captions in English and Hindi, brand colours checked.", evReq: "Link to the delivery folder.", tags: ["delivery", "reels"], accepted: at(-14, 11), started: at(-13, 10), completed: at(-12, 16),
    evidence: [{ title: "Batch 10 delivery folder", uri: doc("drive", "edithood/batch-10"), description: "Six reels with caption files.", at: at(-12, 15), status: "accepted", reviewedAt: at(-12, 16) }] },
  { key: "s2", v: "edithood", title: "Deliver batch 11: four reels for a fitness coach", outcome: "Four reels the coach can schedule for the next two weeks.", assignee: "ashutosh", reviewer: "divyansh", priority: "high", status: "done",
    created: at(-9, 10), due: at(-7, 18), est: 240, dod: "Four reels, 9:16, captions, intro card applied.", evReq: "Link to the delivery folder.", tags: ["delivery", "reels"], accepted: at(-9, 11), started: at(-8, 10), completed: at(-7, 18),
    evidence: [{ title: "Batch 11 delivery folder", uri: doc("drive", "edithood/batch-11"), description: "Four reels with caption files.", at: at(-7, 17, 20), status: "accepted", reviewedAt: at(-7, 18) }] },
  { key: "s3", v: "edithood", title: "Build the reel review checklist", outcome: "A checklist that catches the five mistakes we keep fixing after delivery.", assignee: "ashutosh", reviewer: "divyansh", priority: "medium", status: "done",
    created: at(-8, 10), due: at(-6, 18), est: 90, dod: "Checklist has captions, audio level, safe margins, brand colours and file naming.", evReq: "Link to the checklist in Knowledge.", tags: ["quality", "process"], accepted: at(-8, 11), started: at(-7, 10), completed: at(-6, 14),
    evidence: [{ title: "EditHood delivery checklist", uri: doc("venture-os", "knowledge/edithood-delivery-checklist"), description: "Checklist published in Knowledge.", at: at(-6, 13), status: "accepted", reviewedAt: at(-6, 14) }] },
  { key: "s4", v: "edithood", title: "Fix caption timing on batch 9 for the coaching client", outcome: "Captions that land on the beat for all four reels of batch 9.", assignee: "ashutosh", reviewer: "divyansh", priority: "urgent", status: "done",
    created: at(-6, 10), due: at(-4, 18), est: 120, dod: "All captions within 0.2 seconds of the spoken word.", evReq: "Link to the corrected folder.", tags: ["delivery", "fix"], accepted: at(-6, 11), started: at(-5, 10), completed: at(-3, 11),
    evidence: [
      { title: "Corrected captions, first pass", uri: doc("drive", "edithood/batch-9-fix-1"), description: "First correction pass.", at: at(-4, 15), status: "rejected", reviewedAt: at(-4, 17) },
      { title: "Corrected captions, second pass", uri: doc("drive", "edithood/batch-9-fix-2"), description: "Re-timed reel 3 and 4.", at: at(-3, 10, 30), status: "accepted", reviewedAt: at(-3, 11) },
    ] },
  { key: "s5", v: "edithood", title: "Cut the Hindi teaser for the clinic's festival offer", outcome: "A 20-second Hindi teaser for the clinic's festival offer.", assignee: "ashutosh", reviewer: "divyansh", priority: "medium", status: "done",
    created: at(-4, 10), due: at(-2, 18), est: 120, dod: "20 seconds, Hindi captions, offer end date shown.", evReq: "Link to the teaser.", tags: ["delivery", "teaser"], accepted: at(-4, 11), started: at(-3, 10), completed: at(-2, 15),
    evidence: [{ title: "Festival teaser (Hindi)", uri: doc("drive", "edithood/clinic-teaser"), description: "20-second teaser with captions.", at: at(-2, 14), status: "accepted", reviewedAt: at(-2, 15) }] },
  { key: "b1", v: "buildory", title: "Build the demo catalogue: 40 pump SKUs with dealer price tiers", outcome: "A believable pump catalogue the dealer ordering demo can run on.", assignee: "abhinav", reviewer: "adarsh", priority: "high", status: "done",
    created: at(-13, 10), due: at(-10, 18), est: 240, dod: "40 SKUs, three dealer price tiers, images and stock numbers.", evReq: "Link to the catalogue file.", tags: ["demo", "catalogue"], accepted: at(-13, 11), started: at(-12, 10), completed: at(-10, 17),
    evidence: [{ title: "Demo catalogue (40 SKUs)", uri: doc("sheets", "buildory/demo-catalogue"), description: "Catalogue with three price tiers.", at: at(-10, 16, 30), status: "accepted", reviewedAt: at(-10, 17) }] },
  { key: "b2", v: "buildory", title: "Record the 3-minute dealer ordering walkthrough", outcome: "A short video that shows a dealer placing an order from a phone.", assignee: "abhinav", reviewer: "adarsh", priority: "medium", status: "done",
    created: at(-9, 10), due: at(-6, 18), est: 120, dod: "Under three minutes, shows login, price tier, order and status update.", evReq: "Link to the recording.", tags: ["demo", "video"], accepted: at(-9, 11), started: at(-8, 10), completed: at(-5, 13),
    evidence: [{ title: "Dealer ordering walkthrough", uri: doc("loom", "buildory/dealer-walkthrough"), description: "2 minute 40 second walkthrough.", at: at(-5, 12), status: "accepted", reviewedAt: at(-5, 13) }] },
  { key: "b3", v: "buildory", title: "Write the dealer order status email templates", outcome: "Three plain emails dealers get when an order is confirmed, dispatched and delayed.", assignee: "abhinav", reviewer: "adarsh", priority: "low", status: "done",
    created: at(-7, 10), due: at(-5, 18), est: 60, dod: "Three templates, under 60 words each, no jargon.", evReq: "Link to the templates.", tags: ["demo", "copy"], accepted: at(-7, 11), started: at(-6, 10), completed: at(-5, 12),
    evidence: [{ title: "Order status templates", uri: doc("docs", "buildory/status-emails"), description: "Confirmed, dispatched, delayed.", at: at(-5, 10, 30), status: "accepted", reviewedAt: at(-5, 12) }] },
  { key: "l1", v: "buildory", title: "Learner exercise: write a definition of done for a real task", outcome: "A definition of done another person could check without asking questions.", assignee: "shubham", reviewer: "adarsh", priority: "medium", status: "done",
    created: at(-10, 10), due: at(-7, 18), est: 60, dod: "One sentence for the result, one for the evidence, no vague words.", evReq: "Link to the exercise.", tags: ["learning", "class"], accepted: at(-10, 11), started: at(-9, 10), completed: at(-7, 12),
    evidence: [{ title: "Definition of done exercise", uri: doc("docs", "buildory/learner-dod"), description: "Rewrote the café ordering task.", at: at(-7, 11), status: "accepted", reviewedAt: at(-7, 12) }] },
  { key: "l2", v: "buildory", title: "Shadow one dealer demo call and write the notes", outcome: "Notes from one demo call that show what the dealer actually asked.", assignee: "shubham", reviewer: "adarsh", priority: "low", status: "done",
    created: at(-6, 10), due: at(-3, 18), est: 90, dod: "Questions the dealer asked, word for word, and what we answered.", evReq: "Link to the notes.", tags: ["learning", "demo"], accepted: at(-6, 11), started: at(-5, 10), completed: at(-3, 14),
    evidence: [{ title: "Dealer demo call notes", uri: doc("docs", "buildory/call-notes"), description: "Seven questions, with answers.", at: at(-3, 13), status: "accepted", reviewedAt: at(-3, 14) }] },

  // ---- Open work ------------------------------------------------------------------------------------------------------
  { key: "o1", v: "spotlyst", title: "Run the KOT flow with the pilot cafe", outcome: "One full evening service where every table order reaches the kitchen screen without shouting.", assignee: "adarsh", reviewer: "divyansh", priority: "urgent", status: "in_progress",
    created: at(-3, 10), due: at(0, 18), est: 120, dod: "40 tickets sent during one evening service, fewer than 2 wrong, kitchen never asks for a repeat.", evReq: "Photo of the kitchen screen and the count sheet.", tags: ["pilot", "kot"], accepted: at(-3, 11), started: at(-1, 15),
    details: "## Plan\n- Two tablets at the counter, one kitchen printer as backup.\n- Adarsh at the counter, one of the café staff in the kitchen.\n- Count every ticket: sent, wrong, repeated.\n\n## What we measure\n1. Wrong orders out of 40 tickets.\n2. Times the kitchen asks for a repeat (baseline: about 1 in 6 today).\n\n## If it goes wrong\nSwitch to the printer, note the time, carry on. A failed evening is still evidence.",
    comments: [{ by: "adarsh", body: "Tablets charged and the café confirmed 7 PM service. Taking the printer as backup.", at: at(-1, 17, 45) }] },
  { key: "o2", v: "edithood", title: "Send the batch 13 reel previews for review", outcome: "The client sees batch 13 previews today and has one clear thing to approve.", assignee: "ashutosh", reviewer: "divyansh", priority: "high", status: "in_progress",
    created: at(-2, 10), due: at(0, 21), est: 60, dod: "Previews exported at 720p, one message to the client with the three questions to answer.", evReq: "Link to the preview folder.", tags: ["delivery", "previews"], accepted: at(-2, 11), started: at(-1, 16) },
  { key: "o3", v: "edithood", title: "Deliver batch 12: four reels for a coaching client", outcome: "Four finished reels, ready to post this week.", assignee: "ashutosh", reviewer: "divyansh", priority: "high", status: "review",
    created: at(-4, 10), due: at(1, 18), est: 240, dod: "Four reels, 9:16, captions in Hindi and English, intro card applied, checklist ticked.", evReq: "Link to the delivery folder with caption files.", tags: ["delivery", "reels"], accepted: at(-4, 11), started: at(-3, 10),
    details: "## Brief\nCoaching client, four reels from the October webinar. Hindi and English captions, new intro card confirmed on Friday.\n\n## Checklist\n- [x] Captions timed\n- [x] Audio level -16 LUFS\n- [x] Safe margins\n- [ ] Brand colours (waiting on reviewer)",
    evidence: [{ title: "Batch 12 delivery folder", uri: doc("drive", "edithood/batch-12"), description: "Four reels with Hindi and English caption files, checklist attached.", at: at(-1, 18, 25), status: "pending" }],
    comments: [{ by: "ashutosh", body: "All four reels uploaded. The client confirmed the new intro card on Friday, message is in the folder.", at: at(-1, 18, 30) }, { by: "divyansh", body: "Looking at it first thing tomorrow. Please keep the folder untouched until I reply.", at: at(-1, 19, 10) }] },
  { key: "o4", v: "buildory", title: "Write the Dealer Commerce offer pack", outcome: "One offer pack that says who Dealer Commerce is for, what we claim, and how we write to them.", assignee: "adarsh", reviewer: "divyansh", priority: "high", status: "review",
    created: at(-5, 10), due: at(1, 12), est: 240, dod: "Pack covers who it is for, gates, signs on their site, allowed and forbidden claims, writing style and price rules.", evReq: "Link to the pack in Sales > Offers.", tags: ["sales", "offer"], accepted: at(-5, 11), started: at(-4, 10),
    evidence: [{ title: "Dealer Commerce offer pack (approved version)", uri: doc("venture-os", "sales/offers/dealer-commerce"), description: "Pack with four gates, four website signs and price rules.", at: at(-1, 11, 40), status: "pending" }] },
  { key: "o5", v: "buildory", title: "Ship dealer ordering demo for a pump manufacturer", outcome: "A demo a pump manufacturer's sales head can try on their own phone, using their catalogue and price tiers.", assignee: "abhinav", reviewer: "adarsh", priority: "urgent", status: "in_progress",
    created: at(-6, 10), due: at(2, 18), est: 480, dod: "Dealer logs in, sees own price tier, places an order of 5+ lines, gets a status update on WhatsApp. Demo link works on a mid-range Android phone.", evReq: "Demo link and a 60-second screen recording of one order.", tags: ["demo", "dealer-commerce"], accepted: at(-6, 11), started: at(-5, 10),
    details: "## Background\nShree Ganesh Pumps has about 140 dealers who order by phone and WhatsApp. We are building a demo on a pump catalogue first, then swapping in theirs.\n\n## Scope\n- Dealer login with a one-time code\n- Catalogue with three price tiers (done)\n- Order of 5+ lines with a running total\n- Order status updates by WhatsApp (blocked, see the WhatsApp task)\n\n## Out of scope\n- Payments, credit limits, tax invoices\n\n## Links\n- Catalogue: sheets.example/buildory/demo-catalogue\n- Walkthrough: loom.example/buildory/dealer-walkthrough",
    comments: [{ by: "abhinav", body: "Order screen and price tiers work. WhatsApp updates are the last piece and depend on the verification task.", at: at(-1, 17) }, { by: "adarsh", body: "Fine. Ship it with email status updates if WhatsApp is not through by Tuesday night.", at: at(-1, 18, 10) }] },
  { key: "o6", v: "buildory", title: "Connect WhatsApp order updates to the dealer demo", outcome: "A dealer gets an order update on WhatsApp within a minute of a status change.", assignee: "adarsh", reviewer: "divyansh", priority: "high", status: "blocked",
    created: at(-5, 10), due: at(3, 18), est: 180, dod: "Status change sends a WhatsApp message to the dealer's number within one minute, in three test orders.", evReq: "Screen recording of three test orders.", tags: ["demo", "whatsapp"], accepted: at(-5, 11), started: at(-4, 14), blockedAt: at(-2, 12),
    blocker: "Waiting on WhatsApp Business verification for the demo number. Chased on Friday, expected Thursday." },
  { key: "o7", v: "buildory", title: "Prepare the 12-slide dealer demo deck", outcome: "A short deck to leave with a manufacturer after the demo call.", assignee: "abhinav", reviewer: "adarsh", priority: "medium", status: "in_progress",
    created: at(-7, 10), due: at(-1, 18), est: 180, dod: "12 slides, no prices, one slide per question a dealer asks, closing slide with the next step.", evReq: "Link to the deck.", tags: ["demo", "deck"], accepted: at(-7, 11), started: at(-3, 10) },
  { key: "o8", v: "edithood", title: "Plan the Hindi voice-over pilot for reels", outcome: "A small pilot: two reels with Hindi voice-over, and what it would cost us in time.", assignee: "ashutosh", reviewer: "divyansh", priority: "low", status: "todo",
    created: at(-1, 10), due: at(5, 18), est: 120, dod: "Pilot plan with two reels, the tool, the hours it takes and a go or no-go line.", evReq: "Link to the plan.", tags: ["planning", "pilot"], accepted: at(-1, 11) },
  { key: "o9", v: "spotlyst", title: "Draft the pilot café agreement outline", outcome: "A one-page outline of what the café and we each agree to for the pilot.", assignee: "divyansh", reviewer: "adarsh", priority: "medium", status: "accepted",
    created: at(-2, 10), due: at(4, 18), est: 90, dod: "Outline covers dates, what we install, what the café does, how it ends.", evReq: "Link to the outline.", tags: ["pilot", "legal"], accepted: at(-2, 11) },
  { key: "o10", v: "buildory", title: "Dealer demo script: five questions for the pump manufacturer", outcome: "Five questions that show how dealers order today, written so a learner can ask them.", assignee: "shubham", reviewer: "adarsh", priority: "medium", status: "in_progress",
    created: at(-2, 10), due: at(1, 12), est: 90, dod: "Five open questions, each with why we ask it and what a good answer sounds like.", evReq: "Link to the script.", tags: ["learning", "demo"], accepted: at(-2, 11), started: at(-1, 11),
    comments: [{ by: "shubham", body: "First draft is in the doc. Could someone check it against the definition of done?", at: at(-1, 19) }] },
  { key: "o11", v: "buildory", title: "Read the first-message drafts before they go out", outcome: "Every first message for the Dealer Commerce play has been read by a person, not only by Claude.", assignee: "divyansh", reviewer: "adarsh", priority: "high", status: "accepted",
    created: at(-1, 10), due: at(1, 12), est: 45, dod: "Each draft opens with something real from the company's site, asks one question, and has no price.", evReq: "Note in Sales > Review listing the drafts approved or sent back.", tags: ["sales", "review"], accepted: at(-1, 11) },
  { key: "o12", v: "edithood", title: "Set up the client feedback tracker", outcome: "One sheet where every client comment on a reel is logged with a date and a fix.", assignee: "ashutosh", reviewer: "divyansh", priority: "low", status: "proposed",
    created: at(-1, 15), due: at(6, 18), est: 60, dod: "Tracker has client, reel, comment, fix, date fixed; two past comments back-filled.", evReq: "Link to the tracker.", tags: ["process"] },
];

async function seedTasks() {
  for (const t of tasks) {
    const v = V[t.v]; const id = `demo-task-${t.key}`;
    const creator = U[t.creator ?? (t.status === "proposed" ? "divyansh" : t.v === "edithood" ? "divyansh" : "divyansh")];
    await upsert("tasks", id, {
      workspaceId, ventureId: v.id, groupId: v.group, channelId: v.channel, outcomeId: v.outcome, title: t.title, outcome: t.outcome,
      assigneeId: U[t.assignee], creatorId: creator, reviewerId: U[t.reviewer], priority: t.priority, status: t.status, dueAt: t.due, timezone: "Asia/Kolkata",
      estimatedMinutes: t.est, definitionOfDone: t.dod, evidenceRequirement: t.evReq, dependencies: [], evidenceLinks: t.evidence?.filter((e) => e.status === "accepted").map((e) => e.uri) ?? [],
      tags: t.tags, deadlineRisk: false, createdAt: t.created, updatedAt: t.completed ?? t.started ?? t.created,
      ...(t.details ? { details: t.details } : {}), ...(t.blocker ? { blocker: t.blocker } : {}), ...(t.accepted ? { acceptedAt: t.accepted } : {}), ...(t.started ? { startedAt: t.started } : {}), ...(t.completed ? { completedAt: t.completed } : {}),
      lastActivityAt: t.completed ?? t.evidence?.at(-1)?.at ?? t.started ?? t.created,
    });
    const updates: { key: string; by: keyof typeof U; type: string; body: string; from?: string; to?: string; at: Date }[] = [
      { key: "proposed", by: "divyansh", type: "status", body: "Task proposed", to: "proposed", at: t.created },
    ];
    if (t.accepted) updates.push({ key: "accepted", by: t.assignee, type: "status", body: "Accepted the task", from: "proposed", to: "accepted", at: t.accepted });
    if (t.started) updates.push({ key: "started", by: t.assignee, type: "status", body: "Started work", from: "accepted", to: "in_progress", at: t.started });
    if (t.blockedAt) updates.push({ key: "blocked", by: t.assignee, type: "blocker", body: t.blocker ?? "Blocked", from: "in_progress", to: "blocked", at: t.blockedAt });
    for (const [index, e] of (t.evidence ?? []).entries()) updates.push({ key: `ev${index}`, by: t.assignee, type: "evidence", body: `Sent evidence: ${e.title}`, at: e.at });
    if (t.evidence?.length && t.status === "review") updates.push({ key: "review", by: t.assignee, type: "status", body: "Sent for review", from: "in_progress", to: "review", at: t.evidence.at(-1)!.at });
    if (t.completed) updates.push({ key: "done", by: t.reviewer, type: "status", body: "Evidence accepted, task done", from: "review", to: "done", at: t.completed });
    for (const [index, c] of (t.comments ?? []).entries()) updates.push({ key: `c${index}`, by: c.by, type: "comment", body: c.body, at: c.at });
    for (const u of updates) await upsert("task_updates", `demo-upd-${t.key}-${u.key}`, { workspaceId, taskId: id, authorId: U[u.by], type: u.type, body: u.body, ...(u.from ? { fromStatus: u.from } : {}), ...(u.to ? { toStatus: u.to } : {}), createdAt: u.at });
    for (const [index, e] of (t.evidence ?? []).entries()) {
      await upsert("evidence_items", `demo-ev-${t.key}-${index}`, { workspaceId, taskId: id, type: "link", title: e.title, uri: e.uri, description: e.description, submittedBy: U[t.assignee], submittedAt: e.at, reviewStatus: e.status, ...(e.status !== "pending" ? { reviewedBy: U[t.reviewer], reviewedAt: e.reviewedAt ?? e.at } : {}) });
    }
  }
  // The base seed's placeholder work was dated two weeks ago: move it into this week so nothing shows as long overdue.
  for (const slug of ["buildory", "editing-edithood", "spotlyst"]) await db.collection("tasks").updateOne({ _id: `task-${slug}-demo` }, { $set: { dueAt: at(3, 17), reviewAt: at(3, 18), createdAt: at(-5, 10), updatedAt: at(-1, 10) } });
  await db.collection("information_requests").updateOne({ _id: "request-buildory-proof" }, { $set: { dueAt: at(2, 18), question: "Which two manufacturers have agreed to see a live dealer ordering demo this week?", purpose: "So the demo is built on a real catalogue, not an invented one." } });
  // Extra outcomes so the ventures overview has more than one line each.
  const outcomes: [string, VentureKey, string, string, keyof typeof U][] = [
    ["demo-outcome-buildory-2", "buildory", "Two manufacturers see a live dealer ordering demo", "Book and run two demos on a manufacturer's own catalogue by the end of the month.", "adarsh"],
    ["demo-outcome-edithood-2", "edithood", "Zero reels sent back for caption timing", "Delivery checklist is used on every batch for two weeks in a row.", "ashutosh"],
    ["demo-outcome-spotlyst-2", "spotlyst", "One café runs a full evening on KOT tickets", "Pilot café completes one evening service with fewer than 2 wrong orders out of 40.", "adarsh"],
  ];
  const achieved: [string, VentureKey, string, string, keyof typeof U][] = [
    ["demo-outcome-buildory-0", "buildory", "Shortlist 20 manufacturers that sell through dealers", "A researched list with one proof line per company.", "adarsh"],
    ["demo-outcome-edithood-0", "edithood", "Agree the weekly editing capacity", "One capacity plan the whole team signed off.", "ashutosh"],
    ["demo-outcome-spotlyst-0", "spotlyst", "Pilot café agrees to a one-evening pilot", "Scope and success measures accepted by the café owner.", "adarsh"],
  ];
  for (const [id, key, title, description, owner] of achieved) await upsert("outcomes", id, { workspaceId, ventureId: V[key].id, title, description, ownerId: U[owner], priority: "medium", startAt: at(-20, 10), reviewAt: at(-5, 10), successEvidence: "Reviewed evidence link", status: "achieved", createdAt: at(-20, 10), updatedAt: at(-5, 10) });
  for (const [id, key, title, description, owner] of outcomes) await upsert("outcomes", id, { workspaceId, ventureId: V[key].id, title, description, ownerId: U[owner], priority: "high", startAt: at(-10, 10), reviewAt: at(14, 10), successEvidence: "Reviewed evidence link", status: "active", createdAt: at(-10, 10), updatedAt: at(-2, 10) });
}

const md = (title: string, ...sections: string[]) => `# ${title}\n\n${sections.join("\n\n")}`;
const chunksOf = (markdown: string) => {
  const out: { heading: string; text: string }[] = []; let heading = markdown.split("\n")[0]!.replace(/^#+\s*/, ""); let buf: string[] = [];
  const flush = () => { const text = buf.join("\n").trim(); if (text) out.push({ heading, text }); buf = []; };
  for (const line of markdown.split("\n").slice(1)) { if (/^##\s/.test(line)) { flush(); heading = line.replace(/^#+\s*/, ""); } else buf.push(line); }
  flush(); return out.length ? out : [{ heading, text: markdown }];
};
const documents: { key: string; v?: VentureKey; title: string; owner: keyof typeof U; rank: number; cls: string; days: number; markdown: string }[] = [
  { key: "dod", title: "How we write a task's definition of done", owner: "divyansh", rank: 90, cls: "approved_decision", days: -9, markdown: md("How we write a task's definition of done",
    "A task is done when someone else can check it without asking you a question. That is the only test.",
    "## The three lines\n1. **Result**: what exists when the task is finished, in one sentence.\n2. **Evidence**: the link, file or screenshot that proves it.\n3. **Check**: who reviews it and what they look at.",
    "## Words we do not use\n\"Improve\", \"look into\", \"handle\", \"as needed\". If the sentence still works after you delete the verb, it is vague.",
    "## Example\nBad: Work on the pilot scope.\nGood: One-page pilot scope, names the evening service and two measures, linked in the task as a document.") },
  { key: "dc", v: "buildory", title: "Dealer Commerce: who it's for", owner: "adarsh", rank: 85, cls: "approved_decision", days: -8, markdown: md("Dealer Commerce: who it's for",
    "Dealer Commerce is a dealer ordering system for manufacturers and distributors who sell through 30 to 500 dealers.",
    "## Who we talk to\nOwners, sales heads and dealer network managers at manufacturers in Chhattisgarh, Madhya Pradesh, Maharashtra and Odisha. Pumps, cables, pipes, tiles, hardware, switchgear.",
    "## How we know they fit\nTheir own site says they sell through authorised dealers or distributors, and dealers still order by phone, WhatsApp or price-list PDFs.",
    "## Who we do not talk to\nCompanies that sell only direct to large industrial buyers, and companies that already run a dealer portal.",
    "## What we never say\nNo price before a call. No promise of more orders. No customer names we do not have permission to use.") },
  { key: "eh", v: "edithood", title: "EditHood delivery checklist", owner: "ashutosh", rank: 80, cls: "verified_fact", days: -6, markdown: md("EditHood delivery checklist",
    "Run this list before any batch is marked ready for review.",
    "## Picture\n- 9:16 export, 1080 x 1920\n- Safe margins respected for captions and platform buttons\n- Brand colours match the client's sheet",
    "## Sound\n- Loudness around -16 LUFS\n- No clipped words at cuts",
    "## Captions\n- Hindi and English files both attached\n- Timing within 0.2 seconds of the spoken word",
    "## Delivery\n- File names follow client_batch_reel\n- Folder shared with view access only") },
  { key: "sp", v: "spotlyst", title: "Spotlyst pilot café: scope and success measures", owner: "divyansh", rank: 80, cls: "approved_decision", days: -9, markdown: md("Spotlyst pilot café: scope and success measures",
    "One café, one evening service, one kitchen screen. The pilot shows whether KOT tickets beat shouting across the counter.",
    "## What we install\nTwo tablets at the counter, one kitchen screen, one backup printer.",
    "## What we measure\n1. Wrong orders out of 40 tickets: fewer than 2.\n2. Times the kitchen asks for a repeat: fewer than before (baseline about 1 in 6).",
    "## When it ends\nAfter one evening service we review the count sheet with the owner and decide whether to run a full week.") },
  { key: "fm", title: "How we write a first message", owner: "adarsh", rank: 85, cls: "approved_decision", days: -4, markdown: md("How we write a first message",
    "A first message earns one reply. It does not sell.",
    "## The shape\n1. Open with one real thing from their own site, quoted or paraphrased exactly.\n2. Ask one question about how they work today.\n3. One next step: a 20-minute call.",
    "## Rules\n- Under 90 words.\n- No prices, no attachments, no links except their own site.\n- If the opening line could be sent to anyone, rewrite it.",
    "## Follow-up\nOne follow-up after four working days with one new thought. Then we stop.") },
];
async function seedKnowledge() {
  // The base seed's three placeholder overviews become real short overviews.
  const overviews: [string, string, string][] = [
    ["buildory", "Buildory overview", md("Buildory", "Buildory builds software for businesses that sell through dealers. This month it sells one offer, Dealer Commerce, to manufacturers and distributors in Chhattisgarh, Madhya Pradesh, Maharashtra and Odisha.", "## This month\nProve one repeatable, sales-ready offer: two live demos on a manufacturer's own catalogue.")],
    ["editing-edithood", "Editing/EditHood overview", md("Editing/EditHood", "EditHood edits short-form video for coaches and clinics. Every batch is checked against the delivery checklist before it goes to review.", "## This month\nStabilise the delivery loop: no reel comes back for caption timing, and weekly intake stays at 14 reels.")],
    ["spotlyst", "Spotlyst overview", md("Spotlyst", "Spotlyst turns table orders into kitchen tickets for cafés and small restaurants.", "## This month\nRun the first pilot: one café, one evening service, fewer than 2 wrong orders out of 40 tickets.")],
  ];
  for (const [slug, title, markdown] of overviews) {
    await db.collection("documents").updateOne({ _id: `document-${slug}-overview` }, { $set: { title, slug: `${slug}-overview`, updatedAt: at(-3, 12) } });
    await db.collection("document_versions").updateOne({ _id: `document-version-${slug}-1` }, { $set: { markdown } });
    await db.collection("document_chunks").updateOne({ _id: `chunk-${slug}-1` }, { $set: { plainText: markdown.replace(/^# /, "") } });
  }
  await db.collection("decisions").updateOne({ _id: "decision-chatgpt-primary" }, { $set: { status: "superseded" } });
  for (const d of documents) {
    const id = `demo-doc-${d.key}`; const versionId = `demo-doc-${d.key}-v1`; const created = at(d.days, 12);
    await upsert("documents", id, { workspaceId, ...(d.v ? { ventureId: V[d.v].id } : {}), title: d.title, slug: d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), ownerId: U[d.owner], status: "approved", evidenceClass: d.cls, sensitivity: "team", authoritativeRank: d.rank, currentVersionId: versionId, lastReviewedAt: created, createdAt: created, updatedAt: created });
    await upsert("document_versions", versionId, { workspaceId, documentId: id, version: 1, markdown: d.markdown, changeSummary: "Approved version", createdBy: U[d.owner], createdAt: created });
    await db.collection("document_chunks").deleteMany({ documentId: id });
    for (const [index, chunk] of chunksOf(d.markdown).entries()) await upsert("document_chunks", `demo-chunk-${d.key}-${index}`, { workspaceId, ...(d.v ? { ventureId: V[d.v].id } : {}), documentId: id, documentVersionId: versionId, headingPath: chunk.heading, ordinal: index, plainText: chunk.text, createdAt: created });
  }
}

const decisions: { key: string; v?: VentureKey; title: string; text: string; reason: string; trigger: string; owner: keyof typeof U; days: number; evidence: string[] }[] = [
  { key: "1", v: "buildory", title: "Sell Dealer Commerce to manufacturers before anything else", text: "For the next 30 days Buildory sells one offer, Dealer Commerce, to manufacturers and distributors with 30 to 500 dealers. We do not take custom app work.", reason: "One offer is the only way to find out if the message works. Custom work would hide the answer.", trigger: "No manufacturer agrees to a demo by 30 November.", owner: "divyansh", days: -9, evidence: ["Dealer Commerce: who it's for"] },
  { key: "2", v: "buildory", title: "No price in any first message", text: "First messages and follow-ups never mention a price. Price is discussed on the call, after we know the number of dealers and products.", reason: "A price in a cold message ends the conversation before it starts, and we cannot price without knowing the dealer count.", trigger: "Three replies in a row asking for a price first.", owner: "adarsh", days: -7, evidence: ["How we write a first message"] },
  { key: "3", v: "edithood", title: "Cap weekly intake at 14 reels", text: "EditHood accepts at most 14 reels a week until the delivery checklist has been used on every batch for two weeks.", reason: "Two batches went back for caption timing. We fix quality before we sell capacity.", trigger: "Two clean weeks in a row, or a second editor joins.", owner: "divyansh", days: -6, evidence: ["EditHood delivery checklist"] },
  { key: "4", v: "spotlyst", title: "Run the first pilot at one café, for one evening", text: "The first Spotlyst pilot is one café, one evening service, one kitchen screen. No second venue until we have the count sheet.", reason: "A small test with a real count teaches more than a week of loose use.", trigger: "Fewer than 2 wrong orders out of 40 tickets.", owner: "adarsh", days: -8, evidence: ["Spotlyst pilot café: scope and success measures"] },
  { key: "5", title: "A task counts only with a definition of done and evidence", text: "Every task in Venture OS has a definition of done and an evidence requirement. Work without evidence is not counted on the leaderboard.", reason: "People are judged on what can be checked, not on how busy they look.", trigger: "If reviewers cannot keep up, we revisit the review rota.", owner: "divyansh", days: -12, evidence: ["How we write a task's definition of done"] },
];
async function seedDecisions() {
  for (const d of decisions) await upsert("decisions", `demo-decision-${d.key}`, { workspaceId, ...(d.v ? { ventureId: V[d.v].id } : {}), title: d.title, text: d.text, ownerId: U[d.owner], decidedAt: at(d.days, 11), evidence: d.evidence, reason: d.reason, affectedWork: [], reviewTrigger: d.trigger, status: "approved", createdAt: at(d.days, 11), updatedAt: at(d.days, 11) });
}

const chat: [VentureKey, keyof typeof U, string, Date][] = [
  ["buildory", "adarsh", "Shree Ganesh Pumps opened the demo link we sent their ops head. Abhinav, can you keep the catalogue frozen until Wednesday?", at(-2, 11, 5)],
  ["buildory", "abhinav", "Frozen. 40 SKUs, three dealer price tiers. Order screen works, WhatsApp status updates are the last bit.", at(-2, 11, 32)],
  ["buildory", "divyansh", "Good. The first messages for the Dealer Commerce play are in review. Please read them before they go out, not after.", at(-2, 16, 10)],
  ["buildory", "adarsh", "Reading them tonight. Rule of thumb: if the opening line could be sent to anyone, rewrite it.", at(-2, 16, 48)],
  ["buildory", "shubham", "I wrote the five dealer demo questions in the task. Could someone check them against the definition of done?", at(-1, 12, 15)],
  ["buildory", "adarsh", "Will do after standup. Nice that you linked the doc.", at(-1, 13, 2)],
  ["edithood", "ashutosh", "Batch 12 is in review. Four reels, captions in Hindi and English, 9:16 only.", at(-1, 18, 32)],
  ["edithood", "divyansh", "Looking at it first thing tomorrow. Did the client confirm the new intro card?", at(-1, 19, 5)],
  ["edithood", "ashutosh", "Yes, confirmed on Friday. I put the message in the task.", at(-1, 19, 20)],
  ["edithood", "divyansh", "Perfect. Reminder: previews for batch 13 go out today, not tomorrow.", at(-1, 19, 41)],
  ["edithood", "ashutosh", "On it. Capacity this week is 14 reels and we are at 11 booked.", at(-1, 19, 55)],
  ["spotlyst", "adarsh", "The pilot café agreed to run the KOT flow on Monday's evening service. Two tablets, one kitchen printer as backup.", at(-2, 15, 0)],
  ["spotlyst", "divyansh", "Great. Success measure: fewer than 2 wrong orders out of 40 tickets. Put it on the whiteboard.", at(-2, 15, 22)],
  ["spotlyst", "adarsh", "Done. I also asked them to count how often the kitchen asks for a repeat. That is our baseline.", at(-2, 15, 41)],
  ["spotlyst", "divyansh", "Good. Bring photos, not just notes.", at(-2, 15, 50)],
];
async function seedChannels() {
  for (const [index, [venture, author, body, when]] of chat.entries()) {
    const v = V[venture];
    await upsert("messages", `demo-msg-${index + 1}`, { workspaceId, ventureId: v.id, groupId: v.group, channelId: v.channel, authorId: U[author], body, attachments: [], mentionUserIds: [], clientId: `demo-client-${String(index + 1).padStart(3, "0")}`, createdAt: when });
  }
}
async function seedClasses() {
  await db.collection("classes").updateOne({ _id: "class-task-ownership" }, { $set: { status: "completed", scheduledAt: at(-6, 15), updatedAt: at(-6, 16) } });
  await upsert("classes", "demo-class-first-message", { workspaceId, ventureId: V.buildory.id, title: "Writing a first message that earns a reply", objective: "Rewrite three cold messages so each opens with something real from the company's own site and asks one question.", scheduledAt: at(2, 16), durationMinutes: 60, facilitatorId: U.adarsh, participantIds: [U.abhinav, U.shubham], status: "scheduled", createdAt: at(-3, 10), updatedAt: at(-3, 10) });
  await upsert("classes", "demo-class-dealer-demo", { workspaceId, ventureId: V.buildory.id, title: "Running a dealer ordering demo", objective: "Run the five-question demo script on a live call and note every question the dealer asks.", scheduledAt: at(4, 15), durationMinutes: 45, facilitatorId: U.adarsh, participantIds: [U.shubham], status: "scheduled", createdAt: at(-2, 10), updatedAt: at(-2, 10) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Sales (through the demo API, so every record is validated by the app's own rules)
// ---------------------------------------------------------------------------------------------------------------------
async function api<T = any>(method: string, path: string, body?: unknown, as = "user-divyansh"): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/v1${path}`, { method, headers: { "content-type": "application/json", "x-dev-user-id": as }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 10_000)); continue; }
    if (!json.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 400)}`);
    return json.data as T;
  }
}

const packet = {
  summary: "A dealer ordering and catalogue system for manufacturers and distributors who sell through dealers: dealers order, check their own prices and track dispatch from a phone, so the sales desk stops retyping WhatsApp lists.",
  whoFor: {
    description: "Manufacturers and distributors in central and eastern India who sell through 30 to 500 dealers, wholesalers or retailers and still take dealer orders by phone, WhatsApp, email and price-list PDFs. The buyer is the owner, the sales head or the person who runs the dealer network.",
    industries: ["Pumps and motors", "Electrical cables and switchgear", "PVC pipes and fittings", "Tiles and ceramics", "Agricultural implements", "Fasteners and industrial hardware"],
    customerTypes: ["Manufacturer with a dealer network", "Regional distributor with retailers"], places: ["Chhattisgarh", "Madhya Pradesh", "Maharashtra", "Odisha"],
    companySizes: ["30 to 500 active dealers", "Turnover roughly 10 to 200 crore rupees"], buyerRoles: ["Owner or managing director", "Head of sales", "Dealer network manager"],
  },
  gates: [
    { code: "G1", rule: "Sells through dealers, distributors, wholesalers or retailers, not only direct to end users.", ifFails: "reject" as const, note: "Their own site must say so." },
    { code: "G2", rule: "Based in, or clearly serving, Chhattisgarh, Madhya Pradesh, Maharashtra or Odisha.", ifFails: "reject" as const, note: "" },
    { code: "G3", rule: "There is a published way to reach the company (form, address or a named role).", ifFails: "hold" as const, note: "Ask a person to find the right route." },
    { code: "G4", rule: "Their site shows dealers order by phone, WhatsApp, email or PDF price lists today.", ifFails: "hold" as const, note: "No sign of the manual process means we cannot open with something real." },
  ],
  signals: {
    lookFor: [
      { phrase: "authorised dealer", meaning: "Sells through a dealer network." }, { phrase: "dealer enquiry", meaning: "Takes dealer requests through a form or phone desk." },
      { phrase: "send your order on WhatsApp", meaning: "Dealer orders are handled by hand." }, { phrase: "price list", meaning: "Dealers get prices as lists, not live." },
    ],
    searchWords: ["dealer enquiry", "authorised dealer", "distributor network"], negatives: ["direct to consumer", "online store only", "export only"],
  },
  exclusions: ["Companies that sell only direct to large industrial buyers.", "Companies that already run a dealer portal or ordering app.", "Retail shops with no dealers of their own."],
  say: {
    valueProposition: "Dealers order from a catalogue with their own prices and see dispatch status, and your sales desk stops retyping orders from WhatsApp.",
    pitchAngles: ["Fewer order mistakes from phone and WhatsApp lists.", "Each dealer sees their own price tier.", "A working demo on your own catalogue in two weeks."],
    proofWords: "A working dealer ordering demo exists; a pilot is in progress.",
    approvedClaims: ["We build dealer ordering systems for manufacturers and distributors.", "A demo on your own catalogue can be ready in about two weeks."],
    claimsToAvoid: ["Guaranteed increase in orders.", "Any named customer or revenue figure.", "Any price, range or discount before a call."],
  },
  messages: "First message: one email, under 90 words. Open with one real thing from their own site, quoted or paraphrased exactly. Ask one question about how dealer orders work today. One next step: a 20-minute call. No prices, no attachments, no links except their own site. One follow-up after four working days with one new thought, then stop.",
  price: "Never state or hint at a price in a first message or a follow-up. If asked, say it depends on the number of dealers and products and offer to talk it through on the call.",
  scoring: "Score fit, need, access, ability and timing from 1 to 3. Recommend when fit and need are both 3, or the total is 11 or more.",
  notes: "Buildory sells to the manufacturer, not to the dealers. Plain English, no jargon, no exclamation marks.",
};

type Quote = { claim: string; quote: string; path: string };
type Lead = {
  key: string; name: string; domain: string; city: string; region: string; category: string; owner: keyof typeof U; stage: string;
  decision: "recommend" | "hold" | "reject"; confidence: "low" | "medium" | "high"; summary: string; against: string; open: string; fit: string; quotes: Quote[];
  gates: ("pass" | "fail" | "unknown")[]; scores: Record<string, number>; relevance: number; band: "A" | "B" | "C"; createdDaysAgo: number; verdictDaysAgo: number;
  value?: number; closeInDays?: number; updated: number; next?: [string, number, number]; won?: boolean; draft?: { subject: string; body: string; status: "in_review" | "ready" };
};
const leads: Lead[] = [
  { key: "shreeganesh", name: "Shree Ganesh Pumps & Motors", domain: "shreeganeshpumps.example", city: "Raipur", region: "Chhattisgarh", category: "Pumps and motors", owner: "divyansh", stage: "approved_for_contact", decision: "recommend", confidence: "high", relevance: 92, band: "A", createdDaysAgo: 9, verdictDaysAgo: 3, value: 9_500_000, closeInDays: 50, updated: 3, next: ["Approve the first message, then send it", 1, 10],
    summary: "Pump maker with 140 dealers who still order by phone and WhatsApp. Strong fit for Dealer Commerce.", fit: "Passes all four gates: sells through dealers, based in Chhattisgarh, published enquiry route, dealer orders taken by hand.",
    against: "Monthly PDF price lists suggest a long-standing process they trust. A family-run order desk may see no reason to change what works.", open: "Who decides on tools: the owner or the sales head?",
    quotes: [
      { claim: "Found on their site: sells through an authorised dealer network", quote: "Our pumps reach farmers and contractors through 140 authorised dealers across Chhattisgarh and western Odisha.", path: "dealers" },
      { claim: "Found on their site: dealer orders are taken by phone and WhatsApp", quote: "Dealers can place orders with our order desk by phone between 10 AM and 6 PM, or send the list on WhatsApp.", path: "dealer-enquiry" },
      { claim: "Found on their site: prices reach dealers as a monthly PDF", quote: "Dealer price lists are shared every month as a PDF.", path: "dealers" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 3, access: 2, ability: 2, timing: 2 },
    draft: { status: "ready", subject: "Dealer orders at Shree Ganesh Pumps", body: "Hello,\n\nYour dealers page says orders from your 140 authorised dealers reach your order desk by phone and WhatsApp.\n\nHow do you check today that each list has the right price tier before it goes to dispatch?\n\nAt Buildory we build dealer ordering for manufacturers: dealers order from a catalogue with their own prices. Could we have a 20-minute call this week? I can show a demo built on a pump catalogue.\n\nAdarsh Singh\nBuildory" } },
  { key: "mahakaushal", name: "Mahakaushal Cables & Conductors", domain: "mahakaushalcables.example", city: "Jabalpur", region: "Madhya Pradesh", category: "Electrical cables", owner: "adarsh", stage: "approved_for_contact", decision: "recommend", confidence: "high", relevance: 88, band: "A", createdDaysAgo: 8, verdictDaysAgo: 2, value: 6_000_000, closeInDays: 55, updated: 2, next: ["Wait for the review of the first message", 1, 11],
    summary: "Cable maker recruiting distributors in every district, with price lists sent on request. Good fit.", fit: "Passes all gates. Distributor enquiry form and a two-day wait for price lists show a manual process.",
    against: "Cables are a thin-margin commodity: they may judge any tool by cost first and leave tools to the distributors.", open: "Do distributors order from the company or from a depot?",
    quotes: [
      { claim: "Found on their site: recruiting distributors by district", quote: "We are looking for distributors for every district of Madhya Pradesh and Chhattisgarh.", path: "distributors" },
      { claim: "Found on their site: price lists are sent by hand after a form", quote: "Fill in the distributor enquiry form and our sales team will send the current price list within two working days.", path: "distributor-enquiry" },
      { claim: "Found on their site: a retail dealer base already exists", quote: "More than 90 retail dealers stock Mahakaushal cables.", path: "about" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 3, access: 2, ability: 2, timing: 1 },
    draft: { status: "in_review", subject: "Price lists at Mahakaushal Cables", body: "Hello,\n\nYour distributor page promises the current price list within two working days of the enquiry form.\n\nHow do your distributors find out when a cable size changes price in between?\n\nBuildory builds dealer ordering for manufacturers, where each distributor sees their own live prices. Would a 20-minute call this week be useful? I can show a short demo.\n\nAdarsh Singh\nBuildory" } },
  { key: "vidarbha", name: "Vidarbha PVC Pipes Pvt Ltd", domain: "vidarbhapvcpipes.example", city: "Nagpur", region: "Maharashtra", category: "PVC pipes and fittings", owner: "abhinav", stage: "approved_for_contact", decision: "recommend", confidence: "medium", relevance: 81, band: "A", createdDaysAgo: 7, verdictDaysAgo: 2, value: 7_000_000, closeInDays: 60, updated: 2, next: ["Approve the first message, then send it", 1, 12],
    summary: "Pipe maker with 300 dealer counters where orders pass through regional sales officers.", fit: "Passes the gates. Medium confidence: the sales officers' role in orders is unclear.",
    against: "Orders go through regional sales officers, who may see an ordering system as a threat to their role.", open: "Are the regional sales officers employees or agents?",
    quotes: [
      { claim: "Found on their site: a large dealer network", quote: "Available at more than 300 dealer counters across Vidarbha and Marathwada.", path: "where-to-buy" },
      { claim: "Found on their site: dealer orders go through a sales officer", quote: "To place a dealer order, contact your regional sales officer, who will confirm stock and rate.", path: "dealers" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 2, access: 2, ability: 2, timing: 2 },
    draft: { status: "ready", subject: "Confirming stock and rate for dealers at Vidarbha PVC Pipes", body: "Hello,\n\nYour dealers page says a dealer's order is confirmed for stock and rate by the regional sales officer.\n\nHow long does it usually take from a dealer's request to a confirmed rate?\n\nBuildory builds dealer ordering for manufacturers, so dealers see stock and their own rate straight away and your officers handle only the exceptions. Could we talk for 20 minutes this week?\n\nAdarsh Singh\nBuildory" } },
  { key: "utkal", name: "Utkal Agri Implements", domain: "utkalagriimplements.example", city: "Bhubaneswar", region: "Odisha", category: "Agricultural implements", owner: "adarsh", stage: "contacted", decision: "recommend", confidence: "high", relevance: 84, band: "A", createdDaysAgo: 14, verdictDaysAgo: 10, value: 7_500_000, closeInDays: 45, updated: 5, next: ["Send the follow-up (waiting for review)", 0, 11],
    summary: "Implement maker with dealers in all 30 districts who collect against written orders.", fit: "Passes all gates; dealers collect from the yard against paper orders.",
    against: "Their season is short and peak orders come before the monsoon: a new tool introduced in July would be ignored.", open: "When is their slowest month, the right time to introduce a change?",
    quotes: [
      { claim: "Found on their site: dealers in every district", quote: "Find your nearest Utkal dealer in all 30 districts of Odisha.", path: "dealers" },
      { claim: "Found on their site: dealers collect against written orders", quote: "Dealers collect implements directly from our Bhubaneswar yard against a written order.", path: "dealers" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 2, access: 2, ability: 2, timing: 1 } },
  { key: "narmada", name: "Narmada Tiles & Ceramics", domain: "narmadatiles.example", city: "Indore", region: "Madhya Pradesh", category: "Tiles and ceramics", owner: "divyansh", stage: "replied", decision: "recommend", confidence: "high", relevance: 90, band: "A", createdDaysAgo: 15, verdictDaysAgo: 12, value: 11_000_000, closeInDays: 40, updated: 0.5,
    summary: "Tile maker with 60 showrooms that send their monthly need on WhatsApp.", fit: "Passes all gates; showroom partners send requirements by WhatsApp to a dispatch desk.",
    against: "Showroom owners are close to the family and may prefer WhatsApp; adoption by dealers, not the owner, is the risk.", open: "Would the owner mandate the tool for showroom partners?",
    quotes: [
      { claim: "Found on their site: exclusive showroom partners", quote: "Sold through 60 exclusive dealer showrooms in Madhya Pradesh.", path: "showrooms" },
      { claim: "Found on their site: monthly need sent on WhatsApp", quote: "Showroom partners send their monthly requirement by WhatsApp to the dispatch desk.", path: "partners" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 3, access: 3, ability: 2, timing: 2 } },
  { key: "pune", name: "Pune Precision Fasteners", domain: "puneprecisionfasteners.example", city: "Pune", region: "Maharashtra", category: "Fasteners and industrial hardware", owner: "adarsh", stage: "discovery_booked", decision: "recommend", confidence: "high", relevance: 86, band: "A", createdDaysAgo: 16, verdictDaysAgo: 14, value: 9_000_000, closeInDays: 35, updated: 3,
    summary: "Fastener maker supplying hardware distributors in three cities with purchase orders by email.", fit: "Passes all gates; distributors email purchase orders and wait a working day for confirmation.",
    against: "Industrial fasteners are bought on specification and price; a dealer tool may matter less than a good catalogue search.", open: "How many SKUs do distributors choose from?",
    quotes: [
      { claim: "Found on their site: sells to distributors in three cities", quote: "We supply industrial hardware distributors in Pune, Nashik and Aurangabad.", path: "distributors" },
      { claim: "Found on their site: orders confirmed by email", quote: "Distributors send purchase orders by email and we confirm within one working day.", path: "ordering" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 2, access: 2, ability: 3, timing: 2 } },
  { key: "kalinga", name: "Kalinga Switchgear Works", domain: "kalingaswitchgear.example", city: "Cuttack", region: "Odisha", category: "Electrical switchgear", owner: "divyansh", stage: "proposal", decision: "recommend", confidence: "high", relevance: 94, band: "A", createdDaysAgo: 21, verdictDaysAgo: 19, value: 12_000_000, closeInDays: 12, updated: 4,
    summary: "Switchgear maker with 75 wholesalers who order against quotations.", fit: "Passes all gates; wholesalers order against quotations and stock is confirmed the same day.",
    against: "They quote each order by hand, which they may see as their edge with big wholesalers.", open: "Which wholesalers would join a first pilot?",
    quotes: [
      { claim: "Found on their site: a wholesaler network", quote: "Our switchgear is stocked by 75 electrical wholesalers across Odisha.", path: "wholesalers" },
      { claim: "Found on their site: orders follow a manual quotation", quote: "Wholesalers place orders against a quotation; we confirm stock the same day.", path: "wholesalers" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 3, access: 3, ability: 3, timing: 2 } },
  { key: "sambalpur", name: "Sambalpur Paints Co.", domain: "sambalpurpaints.example", city: "Sambalpur", region: "Odisha", category: "Paints and coatings", owner: "abhinav", stage: "researched", decision: "hold", confidence: "medium", relevance: 55, band: "B", createdDaysAgo: 6, verdictDaysAgo: 2, updated: 2, next: ["Decide: contact them or park them", 1, 10],
    summary: "Paint maker selling to retail shops and to projects. Unclear which channel is the main one.", fit: "Gate G1 is unknown: the site mentions retail shops and project supply, with no dealer count.",
    against: "If most volume goes straight to building projects, there are no dealers to serve and the message would miss.", open: "How much of their volume goes through retail dealers?",
    quotes: [{ claim: "Found on their site: sells through retail shops and to projects", quote: "Sold through retail paint shops and available for project supply.", path: "about" }], gates: ["unknown", "pass", "pass", "unknown"], scores: { fit: 2, need: 2, access: 2, ability: 2, timing: 2 } },
  { key: "nashik", name: "Nashik Irrigation Systems", domain: "nashikirrigation.example", city: "Nashik", region: "Maharashtra", category: "Irrigation equipment", owner: "abhinav", stage: "researched", decision: "hold", confidence: "medium", relevance: 48, band: "B", createdDaysAgo: 5, verdictDaysAgo: 1, updated: 1, next: ["Decide: contact them or park them", 1, 10],
    summary: "Irrigation maker with dealers in two districts only. May be too small a network yet.", fit: "Sells through dealers in Maharashtra, but the network is two districts, far under 30 dealers.",
    against: "A small local network means the tool may be more than they need, and the owner may not feel the pain yet.", open: "Do they plan to expand beyond Nashik and Ahmednagar?",
    quotes: [{ claim: "Found on their site: dealers in two districts", quote: "Authorised dealers in Nashik and Ahmednagar districts.", path: "dealers" }], gates: ["pass", "pass", "pass", "unknown"], scores: { fit: 2, need: 1, access: 2, ability: 2, timing: 1 } },
  { key: "raigarh", name: "Raigarh Rolling Mill", domain: "raigarhrolling.example", city: "Raigarh", region: "Chhattisgarh", category: "Steel rolling", owner: "abhinav", stage: "disqualified", decision: "reject", confidence: "high", relevance: 12, band: "C", createdDaysAgo: 6, verdictDaysAgo: 3, updated: 3,
    summary: "Sells straight to large industrial buyers on annual contracts and says it has no dealers.", fit: "Fails gate G1: their own site rules out dealers and traders.",
    against: "The only argument for contacting them is their size, but there are no dealers for a dealer system to serve.", open: "",
    quotes: [
      { claim: "Found on their site: sells only direct on annual contracts", quote: "We supply directly to infrastructure and industrial buyers on annual contracts.", path: "customers" },
      { claim: "Found on their site: says it does not sell to dealers", quote: "We do not sell to retail dealers or traders.", path: "customers" },
    ], gates: ["fail", "pass", "unknown", "fail"], scores: { fit: 1, need: 1, access: 1, ability: 1, timing: 1 } },
  { key: "bastar", name: "Bastar Cement Works", domain: "bastarcement.example", city: "Jagdalpur", region: "Chhattisgarh", category: "Cement and building materials", owner: "divyansh", stage: "invoice_contract", decision: "recommend", confidence: "high", relevance: 91, band: "A", createdDaysAgo: 30, verdictDaysAgo: 28, value: 8_500_000, updated: 5, won: true,
    summary: "Cement maker with 120 dealers who book truck loads by phone with the depot manager.", fit: "Passes all gates; dealers book truck loads by phone and the depot confirms by hand.",
    against: "Cement dealers order in truck loads: fewer, bigger orders than a typical catalogue business, so the screens matter less than the dispatch status.", open: "Which depot should the first pilot run from?",
    quotes: [
      { claim: "Found on their site: a dealer network across two divisions", quote: "Sold through 120 cement dealers across the Bastar and Raipur divisions.", path: "dealers" },
      { claim: "Found on their site: dealers book loads by phone", quote: "Dealers book truck loads by phone with the depot manager, who confirms the dispatch date.", path: "dealers" },
    ], gates: ["pass", "pass", "pass", "pass"], scores: { fit: 3, need: 3, access: 3, ability: 3, timing: 3 } },
];

async function seedSales() {
  const buildory = V.buildory.id;
  // Pipeline name and the approved offer
  await api("PATCH", "/pipelines/pipeline-buildory", { name: "Dealer Commerce pipeline", offerName: "Dealer Commerce" }, "user-divyansh");
  const offers = await api<any[]>("GET", `/sales/offers?ventureId=${buildory}`);
  let offer = offers.find((o) => o.name === "Dealer Commerce");
  if (!offer) {
    const version = await api<any>("POST", "/sales/offers", { ventureId: buildory, name: "Dealer Commerce", packet, change: "First approved version of the Dealer Commerce offer pack." }, "user-adarsh");
    offer = await api("POST", `/sales/offers/versions/${version.id}/approve`, {}, "user-divyansh");
  }
  const offerId: string = offer.id;
  // A running play: its leads' drafts need a head's approval until the first batch has been read.
  const plays = await api<any[]>("GET", `/sales/plays?ventureId=${buildory}`);
  let play = plays.find((p) => p.name === "Dealer Commerce: pump, pipe and cable makers");
  if (!play) {
    play = await api("POST", "/sales/plays", { ventureId: buildory, pipelineId: "pipeline-buildory", offerId, name: "Dealer Commerce: pump, pipe and cable makers", motion: "high_touch", audience: "Manufacturers and distributors with 30 to 500 dealers in Chhattisgarh, Madhya Pradesh, Maharashtra and Odisha.", hypothesis: "A first message that opens with something real from their own site gets a reply from at least one in five.", metric: "Replies per first message sent, and demos booked.", stopRule: "Stop after one follow-up, or after any reply asking us to stop.", batchSize: 10,
      steps: [{ day: 0, channel: "email", action: "First message: one real thing from their site, one question, a 20-minute call." }, { day: 4, channel: "email", action: "One follow-up with one new thought." }, { day: 7, channel: "call", action: "Call if a phone route is published." }] }, "user-adarsh");
    await api("POST", `/sales/plays/${play.id}/approve`, {}, "user-divyansh");
    play = await api("PATCH", `/sales/plays/${play.id}`, { status: "running" }, "user-divyansh");
  }
  const playId: string = play.id;

  const leadIds: Record<string, string> = {};
  for (const l of leads) {
    const created = await api<any>("POST", "/sales/leads", {
      pipelineId: "pipeline-buildory", companyName: l.name, source: `the dealers page on their own site (${l.domain})`, observedSignal: l.quotes[0]!.quote, fitReason: l.fit, evidenceConfidence: l.confidence,
      ownerId: U[l.owner], city: l.city, region: l.region, country: "India", website: `https://${l.domain}`, category: l.category, offerId, playId, relevance: l.relevance, fitBand: l.band, tags: ["dealer-commerce"],
      contactRoutes: l.decision === "reject" ? [] : [{ kind: "email", value: `contact@${l.domain}`, label: "Published contact address", sourceUrl: `https://${l.domain}/contact`, publishedByCompany: true }],
      ...(l.value ? { valueEstimateMinor: l.value, currency: "INR" } : {}), ...(l.closeInDays ? { expectedCloseAt: at(l.closeInDays, 12).toISOString() } : {}),
      externalRef: { system: "demo", id: l.key },
    }, "user-divyansh");
    leadIds[l.key] = created.id;
  }
  return { offerId, playId, leadIds };
}

async function seedSalesStory({ offerId, playId, leadIds }: { offerId: string; playId: string; leadIds: Record<string, string> }) {
  const buildory = V.buildory.id;
  const T = (days: number, h = 11, m = 0) => at(days, h, m).toISOString();
  for (const l of leads) {
    const id = leadIds[l.key]!;
    const detail = await api<any>("GET", `/sales/leads/${id}`);
    if (detail.lead.ownerId !== U[l.owner]) await api("PATCH", `/sales/leads/${id}`, { ownerId: U[l.owner] }, "user-divyansh");
    if (l.value && detail.lead.valueEstimateMinor !== l.value) await api("PATCH", `/sales/leads/${id}`, { valueEstimateMinor: l.value, currency: "INR", ...(l.closeInDays ? { expectedCloseAt: at(l.closeInDays, 12).toISOString() } : {}) }, "user-divyansh");
    const wantSource = `the dealers page on their own site (${l.domain})`;
    if (detail.lead.source !== wantSource || detail.lead.observedSignal !== l.quotes[0]!.quote) await api("PATCH", `/sales/leads/${id}`, { source: wantSource, observedSignal: l.quotes[0]!.quote }, "user-divyansh");
    // Verdict (once)
    if (!detail.verdicts.length) {
      const seen = T(-l.verdictDaysAgo, 10);
      await api("POST", `/sales/leads/${id}/verdicts`, {
        decision: l.decision, confidence: l.confidence, offer: "Dealer Commerce", offerId, offerFit: l.fit,
        evidence: l.quotes.map((q) => ({ claim: q.claim, quote: q.quote, url: `https://${l.domain}/${q.path}`, seenAt: seen })),
        gates: ["G1", "G2", "G3", "G4"].map((gate, index) => ({ gate, result: l.gates[index]!, note: "" })), scores: l.scores,
        against: l.against, openQuestion: l.open, contactRoute: l.decision === "reject" ? "" : `contact@${l.domain} (published on their contact page)`, signal: l.quotes[0]!.quote, signalSeenAt: seen, summary: l.summary,
      }, "user-divyansh");
    }
  }
  // Drafts and message history
  const email = (subject: string, body: string) => ({ channel: "email", purpose: "first_touch", subject, body, submit: true });
  const firstMessage: Record<string, { subject: string; body: string; sent: number }> = {
    utkal: { sent: 7, subject: "Written orders at Utkal Agri Implements", body: "Hello,\n\nYour dealers page says dealers collect implements from your Bhubaneswar yard against a written order.\n\nHow do you keep track of which written orders are still waiting to be collected?\n\nBuildory builds dealer ordering for manufacturers: dealers place the order on their phone and see when it is ready. Could we have a 20-minute call this week?\n\nAdarsh Singh\nBuildory" },
    narmada: { sent: 6, subject: "Monthly requirements at Narmada Tiles", body: "Hello,\n\nYour partners page says showroom partners send their monthly requirement to the dispatch desk on WhatsApp.\n\nWhat happens when two showrooms ask for the same batch of a tile?\n\nBuildory builds dealer ordering for manufacturers, so each showroom orders from live stock. Would a 20-minute call this week be useful?\n\nAdarsh Singh\nBuildory" },
    pune: { sent: 12, subject: "Purchase orders at Pune Precision Fasteners", body: "Hello,\n\nYour ordering page says distributors send purchase orders by email and you confirm within one working day.\n\nHow do distributors find the right fastener size without calling you?\n\nBuildory builds dealer ordering for manufacturers, with a searchable catalogue and each distributor's own price. Could we talk for 20 minutes this week?\n\nAdarsh Singh\nBuildory" },
    bastar: { sent: 26, subject: "Truck load bookings at Bastar Cement Works", body: "Hello,\n\nYour dealers page says dealers book truck loads by phone with the depot manager, who confirms the dispatch date.\n\nWhat does a dealer do when the depot manager is unreachable and the truck must be booked today?\n\nBuildory builds dealer ordering for manufacturers, with booking and dispatch status on the dealer's phone. Could we have a 20-minute call this week?\n\nAdarsh Singh\nBuildory" },
    kalinga: { sent: 16, subject: "Quotations at Kalinga Switchgear Works", body: "Hello,\n\nYour wholesaler page says orders are placed against a quotation and stock is confirmed the same day.\n\nHow many quotations does your sales desk write in a normal week?\n\nBuildory builds dealer ordering for manufacturers, where wholesalers see their own prices and stock. Could we have a 20-minute call this week?\n\nAdarsh Singh\nBuildory" },
  };
  const replies: Record<string, { at: number; body: string; replyType: string }> = {
    narmada: { at: -1, replyType: "interested", body: "Thanks for writing. We have about 60 showrooms and the WhatsApp lists are a headache, I will not pretend otherwise. Can you show me how it works? Wednesday afternoon is free." },
    pune: { at: -11, replyType: "interested", body: "Interesting. Our distributors do mail us orders, and it does take us a day. Can we speak?" },
    kalinga: { at: -15, replyType: "interested", body: "We are open to a demo. Please call my office to fix a time." },
    bastar: { at: -25, replyType: "interested", body: "This is a real problem for us in the busy months. Let us talk. Which day suits you?" },
  };
  for (const key of ["utkal", "narmada", "pune", "kalinga", "bastar"]) {
    const id = leadIds[key]!; const msg = firstMessage[key]!;
    const detail = await api<any>("GET", `/sales/leads/${id}`);
    if (!detail.drafts.some((d: any) => d.status === "sent")) {
      const draft = await api<any>("POST", `/sales/leads/${id}/drafts`, email(msg.subject, msg.body), "user-divyansh");
      await api("POST", `/sales/drafts/${draft.id}/review`, { result: "pass", issues: [], notes: "Opens with a real line from their site, one question, one next step, no price." }, "user-divyansh");
      await api("POST", `/sales/drafts/${draft.id}/approve`, {}, "user-divyansh");
      await api("POST", `/sales/drafts/${draft.id}/sent`, { sentVia: "manual", at: T(-msg.sent, 11, 15) }, "user-divyansh");
    }
    const fresh = await api<any>("GET", `/sales/leads/${id}`);
    const reply = replies[key];
    if (reply && !fresh.activities.some((a: any) => a.direction === "in")) {
      await api("POST", `/sales/leads/${id}/activities`, { kind: "email", direction: "in", replyType: reply.replyType, body: reply.body, at: T(reply.at, 16, 20) }, "user-divyansh");
    }
  }
  // Pune: a call booked the discovery meeting. Kalinga: discovery call, then qualified and proposal.
  const pune = await api<any>("GET", `/sales/leads/${leadIds.pune}`);
  if (pune.lead.stage !== "discovery_booked") await api("POST", `/sales/leads/${leadIds.pune}/activities`, { kind: "call", direction: "out", callOutcome: "interested_book", body: "Called the sales head's office. Discovery call fixed for Wednesday 11 AM, they will join from the Pune office.", at: T(-9, 12), nextAction: "Discovery call, Wednesday 11 AM", nextActionAt: T(2, 11) }, "user-divyansh");
  const kal = await api<any>("GET", `/sales/leads/${leadIds.kalinga}`);
  if (kal.lead.stage === "replied") {
    await api("POST", `/sales/leads/${leadIds.kalinga}/activities`, { kind: "call", direction: "out", callOutcome: "interested_book", body: "Booked the discovery call for Friday.", at: T(-13, 12) }, "user-divyansh");
    await api("POST", `/sales/leads/${leadIds.kalinga}/activities`, { kind: "meeting", body: "Discovery call, 40 minutes. 75 wholesalers, quotes written by two people. They want to see wholesalers order on a phone and keep their own quotation for large orders.", at: T(-9, 15) }, "user-divyansh");
    await api("PATCH", `/sales/leads/${leadIds.kalinga}`, { stage: "qualified", nextAction: "Send pilot proposal", probability: 50 }, "user-divyansh");
    await api("PATCH", `/sales/leads/${leadIds.kalinga}`, { stage: "proposal", nextAction: "Follow up on the pilot proposal", nextActionAt: T(1, 11), probability: 65 }, "user-divyansh");
  }
  const bas = await api<any>("GET", `/sales/leads/${leadIds.bastar}`);
  if (bas.lead.stage === "replied") {
    await api("POST", `/sales/leads/${leadIds.bastar}/activities`, { kind: "call", direction: "out", callOutcome: "interested_book", body: "Booked the discovery call with the managing director.", at: T(-23, 12) }, "user-divyansh");
    await api("POST", `/sales/leads/${leadIds.bastar}/activities`, { kind: "meeting", body: "Discovery call, 45 minutes. 120 dealers, truck loads booked by phone with the depot manager. They want dispatch status on the dealer's phone first.", at: T(-19, 15) }, "user-divyansh");
    await api("PATCH", `/sales/leads/${leadIds.bastar}`, { stage: "qualified", nextAction: "Send the pilot proposal" }, "user-divyansh");
    await api("PATCH", `/sales/leads/${leadIds.bastar}`, { stage: "proposal", nextAction: "Follow up on the pilot proposal" }, "user-divyansh");
    await api("PATCH", `/sales/leads/${leadIds.bastar}`, { stage: "invoice_contract", nextAction: "Kick off the pilot at the Jagdalpur depot", nextActionAt: T(2, 11), probability: 90 }, "user-divyansh");
  }
  // Drafts waiting for review or approval (first messages)
  for (const l of leads.filter((x) => x.draft)) {
    const id = leadIds[l.key]!;
    const detail = await api<any>("GET", `/sales/leads/${id}`);
    if (detail.drafts.length) continue;
    const draft = await api<any>("POST", `/sales/leads/${id}/drafts`, email(l.draft!.subject, l.draft!.body), "user-divyansh");
    if (l.draft!.status === "ready") await api("POST", `/sales/drafts/${draft.id}/review`, { result: "pass", issues: [], notes: "Opens with a real line from their site, one question, one next step, no price. Under 90 words." }, "user-divyansh");
  }
  // A follow-up draft waiting for review on the lead that was contacted a week ago
  const utkal = await api<any>("GET", `/sales/leads/${leadIds.utkal}`);
  if (!utkal.drafts.some((d: any) => d.purpose === "follow_up")) {
    await api("POST", `/sales/leads/${leadIds.utkal}/drafts`, { channel: "email", purpose: "follow_up", subject: "Re: Written orders at Utkal Agri Implements", submit: true,
      body: "Hello,\n\nOne more thought after my note last week. Your dealers page lists all 30 districts, so I imagine the written orders pile up before the season starts.\n\nIs the pre-season rush the hardest part of the year for your order desk?\n\nIf it helps, I can show how dealers could order from their phone in 20 minutes.\n\nAdarsh Singh\nBuildory" }, "user-divyansh");
  }
  // A call opener for the review lists is not needed; notes for texture
  const noteFor = async (key: string, body: string, days: number, requestId: string) => {
    const id = leadIds[key]!; const detail = await api<any>("GET", `/sales/leads/${id}`);
    if (!detail.activities.some((a: any) => a.requestId === requestId)) await api("POST", `/sales/leads/${id}/activities`, { kind: "note", body, at: T(days, 14), requestId }, "user-divyansh");
  };
  await noteFor("shreeganesh", "Looked at the dealer enquiry form on their site: it asks for the dealer's town and monthly requirement, no product list. Good opening for a catalogue question.", -2, "demo-note-shreeganesh-1");
  await noteFor("utkal", "Their yard collection process is described on the dealers page; asked Abhinav to check if the owner is named on the about page.", -6, "demo-note-utkal-1");

  // Replies on leads that moved on are handled; Narmada's reply (yesterday) stays in the Inbox.
  for (const key of ["kalinga", "pune", "bastar"]) {
    const detail = await api<any>("GET", `/sales/leads/${leadIds[key]}`);
    for (const a of detail.activities.filter((x: any) => x.direction === "in" && !x.handledAt)) await api("POST", `/sales/activities/${a.id}/handled`, {}, "user-divyansh");
  }
  for (const l of leads.filter((x) => x.next)) {
    const [text, days, hour] = l.next!;
    await api("PATCH", `/sales/leads/${leadIds[l.key]}`, { nextAction: text, nextActionAt: days === 0 ? new Date(Math.max(Date.now() + 3_600_000, at(0, hour).getTime())).toISOString() : T(days, hour) }, "user-divyansh");
  }
  // A shared note for the venture's offers
  const notes = await api<any[]>("GET", `/sales/brain?ventureId=${buildory}`);
  if (!notes.some((n) => n.title === "What the first conversations told us")) {
    const note = await api<any>("POST", "/sales/brain", { ventureId: buildory, kind: "notes", title: "What the first conversations told us", body: "Dealers do not hate WhatsApp; they hate retyping and waiting. Owners ask about dispatch status before they ask about price. Every manufacturer who replied asked how it works for their own dealers, so the demo must run on their catalogue.\n\nWorking limits: one first message and one follow-up per company; a person reads every first message before it goes out." }, "user-adarsh");
    await api("POST", `/sales/brain/${note.id}/approve`, {}, "user-divyansh");
  }

  // --- Post-process directly in vso_demo: dates that tell the story, and who wrote what --------------------------------
  const dnow = nowReal;
  for (const l of leads) {
    const id = leadIds[l.key]!;
    const created = at(-l.createdDaysAgo, 10);
    await db.collection("opportunities").updateOne({ _id: id }, { $set: { createdAt: created } });
    await db.collection("opportunities").updateOne({ _id: id }, { $set: { updatedAt: new Date(nowReal.getTime() - l.updated * 86_400_000) } });
    if (l.closeInDays) await db.collection("opportunities").updateOne({ _id: id }, { $set: { expectedCloseAt: at(l.closeInDays, 12) } });
    if (l.won) await db.collection("opportunities").updateOne({ _id: id }, { $set: { wonAt: at(-5, 12) } });
    // Verdicts and the stage notes made by them were saved "now": date them to when the research happened, and say Claude wrote them.
    const verdictAt = at(-l.verdictDaysAgo, 10, 30);
    await db.collection("sales_verdicts").updateMany({ leadId: id }, { $set: { createdAt: verdictAt, via: "claude" } });
    await db.collection("opportunities").updateOne({ _id: id }, { $set: { "verdict.at": verdictAt, "verdict.via": "claude" } });
    await db.collection("sales_activities").updateMany({ leadId: id, kind: "note", via: "system", stageTo: { $in: ["approved_for_contact", "researched", "disqualified"] }, stageFrom: { $in: ["identified", "researched"] } }, { $set: { at: verdictAt, createdAt: verdictAt } });
  }
  // Stage notes written by the PATCHes on the proposal lead
  const bz = leadIds.bastar!;
  await db.collection("sales_activities").updateOne({ leadId: bz, stageTo: "qualified" }, { $set: { at: at(-17, 11), createdAt: at(-17, 11) } });
  await db.collection("sales_activities").updateOne({ leadId: bz, stageTo: "proposal" }, { $set: { at: at(-12, 12), createdAt: at(-12, 12) } });
  await db.collection("sales_activities").updateOne({ leadId: bz, stageTo: "invoice_contract" }, { $set: { at: at(-5, 12), createdAt: at(-5, 12) } });
  const k = leadIds.kalinga!;
  await db.collection("sales_activities").updateOne({ leadId: k, stageTo: "qualified" }, { $set: { at: at(-8, 11), createdAt: at(-8, 11) } });
  await db.collection("sales_activities").updateOne({ leadId: k, stageTo: "proposal" }, { $set: { at: at(-4, 12), createdAt: at(-4, 12) } });
  // Drafts: written by Claude, read by a second Claude session, then waiting for a person.
  const drafts = await db.collection("sales_drafts").find({ ventureId: buildory }).toArray();
  for (const [index, d] of drafts.entries()) {
    const written = d.status === "sent" ? new Date(d.sentAt.getTime() - 6 * 3_600_000) : at(-1, 11 + index, 20);
    await db.collection("sales_drafts").updateOne({ _id: d._id }, { $set: { authorVia: "claude", authorSessionId: "7f3a9c21", createdAt: written, ...(d.review ? { "review.via": "claude", "review.sessionId": "b21e04d7", "review.at": new Date(written.getTime() + 20 * 60_000) } : {}) } });
  }
  // Only the leads that Claude's verdict approved keep an 'approved for contact by' mark if a person did it: here Claude did.
  await db.collection("opportunities").updateMany({ ventureId: buildory, "externalRef.system": "demo" }, { $unset: { approvedForContactBy: "" } });
  void dnow; void playId;
}

try {
  await seedTasks();
  await seedKnowledge();
  await seedDecisions();
  await seedChannels();
  await seedClasses();
  const sales = await seedSales();
  await seedSalesStory(sales);
  console.info("Demo data seeded into vso_demo.");
} finally {
  await database.client.close();
}
void randomUUID;
