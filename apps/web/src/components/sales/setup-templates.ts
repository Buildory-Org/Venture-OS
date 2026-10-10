import type { BrainKind } from "./brain-form";

// Starting texts for the three brain items a venture needs before Claude can sell for it. People fill them in (or ask Claude to);
// a venture head approves them on the Sales knowledge page.

export const SETUP_TEMPLATES: Partial<Record<BrainKind, { title: string; body: string }>> = {
  offer: {
    title: "Our offer",
    body: `## What we sell
One plain sentence: what it is, and who it is for.

## The value in one line
What changes for the buyer, in their words.

## What is included
-
-

## What is not included
-

## Price boundary
A range only, never a bare number before the written scope. The lowest we go.

## Approved proof words
The claims and numbers we may use, and where they are true (a client, a case).

## Claims to avoid
What we never promise: results, timelines, guarantees.
`,
  },
  target_profile: {
    title: "Target profile",
    body: `## Buyer type
Who buys: the kind of company, its size, how it sells.

## Places
Cities, states or regions we work in. Where we do not.

## Size
Team, turnover or dealer count that fits.

## Buyer roles
Who decides, who signs, who uses it.

## Signals that matter
- A sign on their own site or listing that the problem exists.
-

## Gates (hard no's, checked in this order)
1.
2.
3.

## Scoring criteria
- Fit (1 to 3):
- Need (1 to 3):
- Access (1 to 3):
- Ability (1 to 3):
- Timing (1 to 3):

## Evidence questions
1. What on their own site shows the problem?
2.
3.
`,
  },
  message_rules: {
    title: "Message rules",
    body: `## Channels and lengths
- Call: one short opener, one question.
- Email: under 100 words, one ask.
- WhatsApp: only after they opt in, under 60 words.

## Templates by signal
- Signal:
  Opening line:

## Follow-up rule
One follow-up after 4 working days that adds something useful, then stop.

## Reply wording
- Interested:
- Wants details:
- Asks the price first:
- Not now:
- Wrong person:
- Has a system already:
- Opt-out or hostile: never reply. They go on the do-not-contact list.
`,
  },
};
