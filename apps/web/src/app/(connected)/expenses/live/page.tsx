import { Suspense } from "react";
import { LiveExpensesScreen } from "@/screens/live-expenses";

export const metadata = { title: "Expenses — Venture Studio OS" };
export default function LiveExpensesPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading expenses…</div>}><LiveExpensesScreen /></Suspense>; }
