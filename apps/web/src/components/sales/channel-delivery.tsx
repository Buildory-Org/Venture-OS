"use client";
import clsx from "clsx";
import type { z } from "zod";
import type { deliverySchema } from "@venture-studio/contracts";
import { Check, CheckCheck, CircleAlert, Clock3 } from "@/components/ui/icons";
import { Badge } from "@/components/studio/primitives";
import { absoluteDate, type Tone } from "./sales-ui";

// The delivery of one message sent through a connected account: set while sending, then by WhatsApp's ticks or a bounce.

export type Delivery = z.infer<typeof deliverySchema>;
export const DELIVERY_LABEL: Record<Delivery["state"], string> = { sending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", uncertain: "Couldn't confirm", bounced: "Bounced" };
const TONE: Record<Delivery["state"], Tone> = { sending: "neutral", sent: "neutral", delivered: "neutral", read: "blue", failed: "red", uncertain: "amber", bounced: "red" };
const withReason = (delivery: Delivery) => ["failed", "bounced", "uncertain"].includes(delivery.state) && delivery.error ? `${DELIVERY_LABEL[delivery.state]}: ${delivery.error}` : DELIVERY_LABEL[delivery.state];

/** Ticks after our message: one for sent, two for delivered, two in green for read; red with the reason when it failed or bounced. */
export function DeliveryTicks({ delivery, className }: { delivery: Delivery; className?: string }) {
  const state = delivery.state;
  const TickIcon = state === "sending" ? Clock3 : state === "sent" ? Check : state === "delivered" || state === "read" ? CheckCheck : CircleAlert;
  const color = state === "read" ? "text-primary-700" : state === "failed" || state === "bounced" ? "text-danger-text" : state === "uncertain" ? "text-warning-text" : "text-neutral-500";
  return <span title={`${absoluteDate(delivery.at)}${delivery.to ? ` · to ${delivery.to}` : ""}`} className={clsx("inline-flex min-w-0 items-center gap-1 text-[11px] font-semibold", color, className)}><TickIcon size={13} aria-hidden="true" className="shrink-0" /><span className="[overflow-wrap:anywhere]">{withReason(delivery)}</span></span>;
}

/** The same state as a chip, for a draft's header. */
export function DeliveryChip({ delivery }: { delivery: Delivery }) {
  return <span title={delivery.to ? `Sent to ${delivery.to}` : undefined}><Badge tone={TONE[delivery.state]}>{DELIVERY_LABEL[delivery.state]}</Badge></span>;
}
