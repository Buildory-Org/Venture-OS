import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { ChannelsScreen } from "@/screens/sales/channels";

export const metadata: Metadata = { title: "Channels — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><ChannelsScreen /></Suspense>; }
