import Link from "next/link";
import { Layers3 } from "lucide-react";

export default function UnavailablePage() {
  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-extrabold text-neutral-900">This feature is not connected yet</h1><p className="mt-2 text-sm leading-6 text-neutral-500">The prototype includes a sample-only version, but this local workspace does not have a live implementation. No action here writes to your workspace.</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/dashboard/live" className="inline-flex min-h-10 items-center rounded-xl bg-neutral-900 px-4 text-xs font-bold text-white">Connected dashboard</Link><Link href="/demo" className="inline-flex min-h-10 items-center rounded-xl border border-neutral-200 px-4 text-xs font-bold text-neutral-700">Review demo prototype</Link></div></section></main>;
}
