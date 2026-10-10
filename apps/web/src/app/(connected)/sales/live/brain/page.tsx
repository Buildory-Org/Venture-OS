import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { BrainScreen } from "@/screens/sales/brain";

export const metadata: Metadata = { title: "Sales knowledge — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><BrainScreen /></Suspense>; }
