import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  AtSign,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns3,
  Hash,
  HeartPulse,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Sparkles,
  Target,
  TimerReset,
  TrendingUp,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { FocusSprintTrigger } from "@/components/dashboard/focus-sprint-trigger";

export const metadata = { title: "Dashboard — Venture Studio OS" };

const priorities = [
  { title: "Finalize onboarding decision", context: "Northstar Labs · Builder", due: "Today · 4:00 PM", status: "In review", tone: "danger", owners: ["AM", "MC"] },
  { title: "Review clinic partner shortlist", context: "Lattice Health · Partnerships", due: "Tomorrow", status: "Blocked", tone: "warning", owners: ["JP"] },
  { title: "Approve research budget", context: "Fieldnote · Operations", due: "Fri · Sep 25", status: "Ready", tone: "neutral", owners: ["RK", "AM"] },
  { title: "Write weekly venture update", context: "Meridian Studio · Leadership", due: "Mon · Sep 28", status: "Draft", tone: "neutral", owners: ["AM"] },
];

const ventures = [
  { name: "Northstar Labs", stage: "Validate", health: 86, signal: "+6", tone: "bg-primary-600", note: "Activation is moving" },
  { name: "Lattice Health", stage: "Discover", health: 68, signal: "−4", tone: "bg-emerald-600", note: "Partner signal delayed" },
  { name: "Fieldnote", stage: "Explore", health: 42, signal: "+1", tone: "bg-amber-500", note: "Awaiting first interviews" },
];

const mentions = [
  { initials: "MC", name: "Maya Chen", channel: "product", message: "Can you sign off on the retention read before the review?", time: "18m" },
  { initials: "JP", name: "Jon Patel", channel: "partnerships", message: "Two clinics confirmed calls for next week.", time: "1h" },
];

const activity = [
  { icon: Check, text: "Activation event spec completed", meta: "Northstar Labs · 12m" },
  { icon: Target, text: "Design-partner milestone updated", meta: "Northstar Labs · 2h" },
  { icon: Users, text: "Arjun joined Research", meta: "Fieldnote · 4h" },
];

const pressable = "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

function Card({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return <section className={clsx("animate-widget-in rounded-2xl bg-white shadow-card", className)} style={{ animationDelay: `${delay}ms` }}>{children}</section>;
}

function CardHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: string }) {
  return (
    <header className="flex items-start justify-between gap-3 px-5 pt-5">
      <div><p className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-neutral-400">{eyebrow}</p><h2 className="mt-1 text-[15px] font-extrabold tracking-tight text-neutral-900">{title}</h2></div>
      {action && <button type="button" className={clsx("flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-extrabold text-primary-600 hover:bg-primary-50", pressable)}>{action}<ChevronRight size={14} /></button>}
    </header>
  );
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: string }) {
  return (
    <section className="animate-widget-in rounded-2xl bg-white px-4 py-4 shadow-card transition-colors duration-150 hover:bg-neutral-50/70">
      <div className="flex items-start gap-3">
        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", tone)}><Icon size={16} strokeWidth={2} /></span>
        <div className="min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-neutral-400">{label}</p><p className="mt-0.5 text-xl font-extrabold tracking-tight text-neutral-900 tnum">{value}</p><p className="mt-1 truncate text-[11px] font-semibold text-neutral-400">{detail}</p></div>
      </div>
    </section>
  );
}

export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-bold text-neutral-400"><span>Meridian Studio</span><ChevronRight size={12} /><span>Northstar Labs</span><ChevronRight size={12} /><span className="text-neutral-600">Builder</span></div>
          <h1 className="text-[clamp(1.45rem,2.6vw,1.9rem)] font-extrabold tracking-[-0.04em] text-neutral-900">Good morning, Alex.</h1>
          <p className="mt-1 text-sm font-medium text-neutral-500">Wednesday, 23 September · Three decisions need you.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={clsx("flex min-h-10 items-center gap-2 rounded-xl bg-white px-3.5 text-xs font-extrabold text-neutral-700 shadow-sm ring-1 ring-neutral-900/5 hover:bg-neutral-50", pressable)}><CalendarClock size={15} />Weekly review</button>
          <FocusSprintTrigger className={clsx("flex min-h-10 items-center gap-2 rounded-xl bg-neutral-900 px-3.5 text-xs font-extrabold text-white hover:bg-neutral-800", pressable)}><Play size={14} fill="currentColor" />Start focus sprint</FocusSprintTrigger>
        </div>
      </header>

      <section aria-label="Studio metrics" className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric icon={CalendarClock} label="Due today" value="3" detail="1 decision is urgent" tone="bg-danger-surface text-danger-text" />
        <Metric icon={AtSign} label="Mentions" value="3" detail="2 still unread" tone="bg-primary-50 text-primary-700" />
        <Metric icon={HeartPulse} label="Portfolio health" value="78" detail="Up 4 points this week" tone="bg-success-surface text-success-text" />
        <Metric icon={Clock3} label="Focus time" value="2h 35m" detail="Across 6 sessions" tone="bg-ai-surface text-ai-text" />
      </section>

      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 overflow-hidden lg:col-span-8" delay={45}>
          <div className="grid min-h-[286px] lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="p-5 sm:p-6">
              <div className="flex items-center gap-2 text-ai-text"><span className="grid h-8 w-8 place-items-center rounded-xl bg-ai-surface"><Sparkles size={15} /></span><span className="text-[10px] font-extrabold uppercase tracking-[0.1em]">Studio briefing</span></div>
              <h2 className="mt-5 max-w-2xl text-[clamp(1.35rem,2.5vw,1.85rem)] font-extrabold leading-tight tracking-[-0.035em] text-neutral-900">Activation moved. Retention didn’t.</h2>
              <p className="mt-3 max-w-2xl text-sm font-medium leading-6 text-neutral-500">Northstar’s new onboarding lifted activation to 61%, but week-two retention remains flat. The 4 PM review needs a ship, iterate, or stop recommendation—not another data pull.</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-lg bg-success-surface px-2.5 py-1.5 text-[11px] font-extrabold text-success-text">Activation +14%</span>
                <span className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[11px] font-extrabold text-neutral-600">W2 retention 31%</span>
                <span className="rounded-lg bg-warning-surface px-2.5 py-1.5 text-[11px] font-extrabold text-warning-text">Decision due 4 PM</span>
              </div>
            </div>
            <div className="flex flex-col justify-between bg-neutral-900 p-5 text-white">
              <div><p className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-white/40">Recommended next move</p><p className="mt-3 text-base font-extrabold leading-6">Iterate once on the retention gap.</p><p className="mt-2 text-xs font-medium leading-5 text-white/55">Keep the activation win. Test the week-one habit loop with the same cohort.</p></div>
              <button type="button" className={clsx("mt-5 flex min-h-10 items-center justify-center gap-2 rounded-xl bg-white px-3 text-xs font-extrabold text-neutral-900 hover:bg-neutral-100", pressable)}>Open decision brief<ArrowRight size={14} /></button>
            </div>
          </div>
        </Card>

        <Card className="col-span-12 lg:col-span-4" delay={90}>
          <CardHeader eyebrow="Portfolio pulse" title="Studio health" action="Breakdown" />
          <div className="flex flex-col items-center px-5 pb-5 pt-2">
            <svg viewBox="0 0 180 110" className="w-full max-w-[220px]" aria-label="Studio health score 78 out of 100" role="img">
              <path d="M 20 94 A 70 70 0 0 1 160 94" fill="none" stroke="#F1F5F9" strokeWidth="15" strokeLinecap="round" />
              <path d="M 20 94 A 70 70 0 0 1 160 94" fill="none" stroke="#2453DB" strokeWidth="15" strokeLinecap="round" strokeDasharray="219.9" strokeDashoffset="48.4" />
              <text x="90" y="78" textAnchor="middle" style={{ fontSize: 35, fontWeight: 800, fill: "#0F172A" }}>78</text>
              <text x="90" y="97" textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: "#64748B", letterSpacing: "0.08em" }}>GOOD · /100</text>
            </svg>
            <div className="grid w-full grid-cols-3 gap-2">
              {[{ label: "Signal", value: "82" }, { label: "Pace", value: "74" }, { label: "Team", value: "79" }].map((item) => <div key={item.label} className="rounded-xl bg-neutral-50 px-2 py-2.5 text-center"><p className="font-mono text-sm font-bold text-neutral-800 tnum">{item.value}</p><p className="mt-0.5 text-[9px] font-extrabold uppercase tracking-[0.08em] text-neutral-400">{item.label}</p></div>)}
            </div>
            <div className="mt-3 flex w-full items-start gap-2 rounded-xl bg-warning-surface px-3 py-2.5 text-warning-text"><CircleAlert size={14} className="mt-0.5 shrink-0" /><p className="text-[11px] font-semibold leading-4">Lattice’s customer signal is 12 minutes behind.</p></div>
          </div>
        </Card>

        <Card className="col-span-12 lg:col-span-8" delay={135}>
          <CardHeader eyebrow="Assigned to you" title="Priority queue" action="Open board" />
          <div className="mt-3 px-3 pb-3">
            {priorities.map((item, index) => (
              <article key={item.title} className="grid gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-neutral-50 sm:grid-cols-[36px_minmax(0,1fr)_auto] sm:items-center">
                <button type="button" aria-label={`Mark ${item.title} complete`} className={clsx("grid h-9 w-9 place-items-center rounded-xl border border-neutral-200 bg-white text-transparent hover:border-success hover:bg-success-surface hover:text-success", pressable)}><Check size={15} strokeWidth={2.4} /></button>
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-[13px] font-extrabold text-neutral-800 sm:text-sm">{item.title}</h3><span className={clsx("rounded-md px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.05em]", item.tone === "danger" ? "bg-danger-surface text-danger-text" : item.tone === "warning" ? "bg-warning-surface text-warning-text" : "bg-neutral-100 text-neutral-500")}>{item.status}</span></div><p className="mt-1 text-[11px] font-semibold text-neutral-400">{item.context}</p></div>
                <div className="flex items-center justify-between gap-3 sm:justify-end"><div className="flex -space-x-1.5">{item.owners.map((owner) => <span key={owner} className="grid h-7 w-7 place-items-center rounded-full bg-primary-50 text-[9px] font-extrabold text-primary-700 ring-2 ring-white">{owner}</span>)}</div><time className={clsx("min-w-28 text-right text-xs font-extrabold", index === 0 ? "text-danger-text" : index === 1 ? "text-warning-text" : "text-neutral-500")}>{item.due}</time><button type="button" aria-label={`More options for ${item.title}`} className={clsx("grid h-9 w-9 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800", pressable)}><MoreHorizontal size={16} /></button></div>
              </article>
            ))}
          </div>
        </Card>

        <Card className="col-span-12 lg:col-span-4" delay={180}>
          <CardHeader eyebrow="Work modes" title="Move the day forward" />
          <div className="space-y-2 px-4 pb-4 pt-3">
            {[
              { icon: TimerReset, title: "Focus sprint", detail: "Finalize onboarding decision", tone: "bg-primary-50 text-primary-700" },
              { icon: MessageSquareText, title: "Open #product", detail: "2 unread mentions", tone: "bg-ai-surface text-ai-text" },
              { icon: Columns3, title: "Kanban board", detail: "7 items assigned to you", tone: "bg-success-surface text-success-text" },
            ].map(({ icon: Icon, title, detail, tone }) => (
              <button key={title} type="button" className={clsx("group flex min-h-16 w-full items-center gap-3 rounded-xl bg-neutral-50 px-3 text-left hover:bg-neutral-100", pressable)}><span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", tone)}><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-extrabold text-neutral-800">{title}</span><span className="mt-0.5 block truncate text-[10px] font-semibold text-neutral-400">{detail}</span></span><ArrowRight size={15} className="text-neutral-300 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-neutral-600" /></button>
            ))}
          </div>
        </Card>

        <Card className="col-span-12 xl:col-span-7" delay={225}>
          <CardHeader eyebrow="Across the studio" title="Venture momentum" action="View portfolio" />
          <div className="space-y-2 px-4 pb-4 pt-3">
            {ventures.map((venture) => (
              <article key={venture.name} className="grid gap-3 rounded-xl bg-neutral-50 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_190px_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3"><span className={clsx("h-9 w-1.5 shrink-0 rounded-full", venture.tone)} /><div className="min-w-0"><h3 className="truncate text-xs font-extrabold text-neutral-800">{venture.name}</h3><p className="mt-0.5 truncate text-[10px] font-semibold text-neutral-400">{venture.stage} · {venture.note}</p></div></div>
                <div className="flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200"><div className={clsx("h-full rounded-full", venture.tone)} style={{ width: `${venture.health}%` }} /></div><span className="w-7 text-right font-mono text-[10px] font-bold text-neutral-500 tnum">{venture.health}</span></div>
                <span className={clsx("justify-self-start rounded-md px-2 py-1 text-[10px] font-extrabold sm:justify-self-end", venture.signal.startsWith("+") ? "bg-success-surface text-success-text" : "bg-danger-surface text-danger-text")}>{venture.signal}</span>
              </article>
            ))}
          </div>
        </Card>

        <Card className="col-span-12 xl:col-span-5" delay={270}>
          <div className="grid h-full sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <div className="p-5"><div className="flex items-center gap-2"><AtSign size={15} className="text-primary-600" /><h2 className="text-sm font-extrabold text-neutral-900">Mentions</h2></div><div className="mt-4 space-y-4">{mentions.map((mention) => <article key={mention.name} className="flex gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-50 text-[9px] font-extrabold text-primary-700">{mention.initials}</span><div className="min-w-0"><div className="flex items-center gap-1.5"><p className="truncate text-[11px] font-extrabold text-neutral-800">{mention.name}</p><span className="flex items-center gap-0.5 text-[9px] font-bold text-neutral-400"><Hash size={10} />{mention.channel}</span><time className="ml-auto text-[9px] font-semibold text-neutral-400">{mention.time}</time></div><p className="mt-1 text-[11px] font-medium leading-4 text-neutral-500"><span className="font-extrabold text-primary-600">@Alex</span> {mention.message}</p></div></article>)}</div></div>
            <div className="border-t border-neutral-100 p-5 sm:border-l sm:border-t-0 xl:border-l-0 xl:border-t 2xl:border-l 2xl:border-t-0"><div className="flex items-center gap-2"><TrendingUp size={15} className="text-success" /><h2 className="text-sm font-extrabold text-neutral-900">Recent activity</h2></div><div className="mt-4 space-y-4">{activity.map(({ icon: Icon, text, meta }) => <div key={text} className="flex gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-neutral-100 text-neutral-500"><Icon size={14} /></span><div className="min-w-0"><p className="text-[11px] font-bold leading-4 text-neutral-700">{text}</p><p className="mt-0.5 text-[9px] font-semibold text-neutral-400">{meta}</p></div></div>)}</div></div>
          </div>
        </Card>
      </div>
    </div>
  );
}
