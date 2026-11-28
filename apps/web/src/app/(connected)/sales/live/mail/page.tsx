import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { MailScreen } from "@/screens/sales/mail";

export const metadata: Metadata = { title: "Mail — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><MailScreen /></Suspense>; }
