import Link from "@/components/shell/demo-link";
import { MailCheck } from "lucide-react";
import { primaryClass } from "@/components/studio/primitives";

export default function Page(){return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-100 bg-white p-7 text-center shadow-card"><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-700"><MailCheck size={22}/></span><h1 className="mt-5 text-2xl font-extrabold text-neutral-900">Join Meridian Studio</h1><p className="mt-2 text-sm leading-6 text-neutral-500">This page is a demo. The connected invitation flow validates the signed-in identity and token on the server.</p><Link href="/sign-in" className={`mt-5 ${primaryClass}`}>View demo identities</Link><Link href="/invite/live" className="mt-3 block text-xs font-bold text-primary-700 underline">Open connected invitation flow</Link></section></main>}
