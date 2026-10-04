import type { Metadata } from "next";
import { Suspense } from "react";
import { LiveSalesScreen } from "@/screens/live-sales";

export const metadata: Metadata = { title: "Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading sales…</div>}><LiveSalesScreen /></Suspense>; }
