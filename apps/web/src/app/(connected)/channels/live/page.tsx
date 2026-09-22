import { Suspense } from "react";
import { LiveChannelsScreen } from "@/screens/live-channels";

export const metadata = { title: "Connected Channels — Venture Studio OS" };
export default function LiveChannelsPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading connected channels…</div>}><LiveChannelsScreen /></Suspense>; }
