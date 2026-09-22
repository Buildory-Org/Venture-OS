import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  AtSign,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns3,
  Flame,
  Hash,
  HeartPulse,
  MessageCircle,
  MoreHorizontal,
  Play,
  Rocket,
  Sparkles,
  Target,
  TimerReset,
  Users,
} from "lucide-react";

export const metadata = { title: "Home — Venture Studio OS" };

const buttonBase = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 active:scale-[0.96]";

const priorities = [
  {
    title: "Finalize onboarding experiment",
    venture: "Northstar Labs",
    group: "Builder",
    due: "Due today · 4:00 PM",
    urgency: "critical",
    progress: 72,
    initials: ["MC", "AM"],
  },
  {
    title: "Review clinic partner shortlist",
    venture: "Lattice Health",
    group: "Partnerships",
    due: "Due tomorrow",
    urgency: "soon",
    progress: 45,
    initials: ["JP"],
  },
  {
    title: "Approve September research budget",
    venture: "Fieldnote",
    group: "Operations",
    due: "Fri, Sep 25",
    urgency: "normal",
    progress: 18,
    initials: ["RK", "AM"],
  },
];

const ventureHealth = [
  { name: "Northstar Labs", stage: "Validate", score: 86, color: "bg-primary-600", status: "On track", tone: "text-success-text bg-success-surface" },
  { name: "Lattice Health", stage: "Discover", score: 68, color: "bg-emerald-600", status: "Watch", tone: "text-warning-text bg-warning-surface" },
  { name: "Fieldnote", stage: "Explore", score: 42, color: "bg-amber-500", status: "Needs input", tone: "text-danger-text bg-danger-surface" },
];

const mentions = [
  { initials: "MC", name: "Maya Chen", channel: "product", text: "Can you review the retention cut before the growth review?", time: "18m", unread: true },
  { initials: "JP", name: "Jon Patel", channel: "partnerships", text: "I added the two clinics we discussed to the shortlist.", time: "1h", unread: true },
  { initials: "RK", name: "Rina Kim", channel: "general", text: "The weekly venture notes are ready for your comments.", time: "3h", unread: false },
];

const activity = [
  { icon: Check, label: "Maya completed", subject: "Activation event spec", meta: "Northstar Labs · 12m" },
  { icon: MessageCircle, label: "Jon replied in", subject: "#partnerships", meta: "Lattice Health · 34m" },
  { icon: Target, label: "Milestone updated", subject: "10 design partners", meta: "Northstar Labs · 2h" },
  { icon: Users, label: "Rina added Arjun to", subject: "Research group", meta: "Fieldnote · 4h" },
];

function SectionHeader({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: string }) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-bold uppercase tracking-[0.1em] text-neutral-400">{eyebrow}</p>}
        <h2 className="text-base font-extrabold tracking-tight text-neutral-900">{title}</h2>
      </div>
      {action && (
        <button type="button" className="flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm font-bold text-primary-600 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]">
          {action}<ChevronRight size={15} />
        </button>
      )}
    </header>
  );
}

function PulseStat({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-neutral-100 px-4 py-4 last:border-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone}`}><Icon size={18} strokeWidth={1.9} /></span>
      <div className="min-w-0">
        <p className="text-xl font-extrabold tracking-tight text-neutral-900 tnum">{value}</p>
        <p className="truncate text-xs font-semibold text-neutral-500">{label} · <span className="font-medium text-neutral-400">{detail}</span></p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-[1540px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-neutral-400">
            <span>Meridian Studio</span><ChevronRight size={13} /><span>Northstar Labs</span><ChevronRight size={13} /><span className="text-neutral-600">Builder</span>
          </div>
          <h1 className="text-[clamp(1.5rem,3vw,2rem)] font-extrabold tracking-[-0.035em] text-neutral-900">Good morning, Alex.</h1>
          <p className="mt-1 text-sm font-medium text-neutral-500 sm:text-base">Three decisions need your attention today.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${buttonBase} bg-white text-neutral-700 shadow-sm ring-1 ring-neutral-900/5 hover:bg-neutral-50`}><Hash size={16} />Open channel</button>
          <button type="button" className={`${buttonBase} bg-neutral-900 text-white hover:bg-neutral-800`}><Rocket size={16} />New work item</button>
        </div>
      </div>

      <section aria-label="Today at a glance" className="animate-widget-in mb-5 grid overflow-hidden rounded-2xl bg-white shadow-card sm:grid-cols-2 xl:grid-cols-4">
        <PulseStat icon={Flame} label="Due today" value="3" detail="1 urgent" tone="bg-danger-surface text-danger-text" />
        <PulseStat icon={AtSign} label="Mentions" value="3" detail="2 unread" tone="bg-primary-50 text-primary-700" />
        <PulseStat icon={HeartPulse} label="Venture health" value="78" detail="+4 this week" tone="bg-success-surface text-success-text" />
        <PulseStat icon={Clock3} label="Focus time" value="2h 35m" detail="this week" tone="bg-ai-surface text-ai-text" />
      </section>

      <div className="grid grid-cols-12 gap-5">
        <section className="animate-widget-in col-span-12 rounded-2xl bg-white p-5 shadow-card lg:col-span-8" style={{ animationDelay: "70ms" }}>
          <SectionHeader title="Your priority queue" eyebrow="Assigned to you" action="Open Kanban" />
          <div className="mt-4 space-y-2">
            {priorities.map((item, index) => (
              <article key={item.title} className="group grid gap-3 rounded-xl bg-neutral-50 p-3.5 transition-[background-color,transform] duration-150 hover:bg-neutral-100/80 active:scale-[0.99] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                <button type="button" aria-label={`Mark ${item.title} complete`} className="grid h-10 w-10 place-items-center rounded-xl border border-neutral-300 bg-white text-transparent transition-[color,border-color,background-color] duration-150 hover:border-success hover:bg-success-surface hover:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Check size={16} strokeWidth={2.5} /></button>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-extrabold text-neutral-900 sm:text-base">{item.title}</h3>
                    {index === 0 && <span className="rounded-full bg-danger-surface px-2 py-1 text-xs font-bold text-danger-text">Urgent</span>}
                  </div>
                  <p className="mt-1 text-xs font-medium text-neutral-400">{item.venture} · {item.group}</p>
                  <div className="mt-2 h-1.5 max-w-xs overflow-hidden rounded-full bg-neutral-200"><div className="h-full rounded-full bg-primary-600" style={{ width: `${item.progress}%` }} /></div>
                </div>
                <div className="flex items-center justify-between gap-4 sm:justify-end">
                  <div className="flex -space-x-1.5">
                    {item.initials.map((initial) => <span key={initial} className="grid h-7 w-7 place-items-center rounded-full bg-white text-[10px] font-extrabold text-neutral-600 ring-2 ring-neutral-50">{initial}</span>)}
                  </div>
                  <time className={`min-w-32 text-right text-sm font-bold ${item.urgency === "critical" ? "text-danger-text" : item.urgency === "soon" ? "text-warning-text" : "text-neutral-500"}`}>{item.due}</time>
                  <button type="button" aria-label={`More options for ${item.title}`} className="grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-white hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><MoreHorizontal size={18} /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="animate-widget-in col-span-12 rounded-2xl bg-white p-5 shadow-card lg:col-span-4" style={{ animationDelay: "140ms" }}>
          <SectionHeader title="Venture health" eyebrow="Portfolio pulse" action="View all" />
          <div className="mt-4 space-y-3">
            {ventureHealth.map((venture) => (
              <article key={venture.name} className="rounded-xl bg-neutral-50 p-3.5">
                <div className="flex items-center gap-3">
                  <span className={`h-9 w-1.5 rounded-full ${venture.color}`} />
                  <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-extrabold text-neutral-800">{venture.name}</h3><p className="text-xs font-medium text-neutral-400">{venture.stage} stage</p></div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${venture.tone}`}>{venture.status}</span>
                </div>
                <div className="mt-3 flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200"><div className={venture.color + " h-full rounded-full"} style={{ width: `${venture.score}%` }} /></div><span className="w-7 text-right font-mono text-xs font-bold text-neutral-500 tnum">{venture.score}</span></div>
              </article>
            ))}
          </div>
          <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-warning-surface px-3.5 py-3 text-warning-text">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            <p className="text-xs font-semibold leading-5">Lattice’s customer signal is 12 minutes behind. Last good sync: 10:30 AM.</p>
          </div>
        </section>

        <section className="animate-widget-in col-span-12 rounded-2xl bg-neutral-900 p-5 text-white shadow-e3" style={{ animationDelay: "210ms" }}>
          <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div className="max-w-xl">
              <div className="mb-4 flex items-center gap-2 text-primary-300"><Sparkles size={16} /><p className="text-xs font-bold uppercase tracking-[0.1em]">Suggested next move</p></div>
              <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">Turn the onboarding result into a decision.</h2>
              <p className="mt-2 text-sm leading-6 text-white/60">Activation improved 14%, but week-two retention is flat. Capture the tradeoff before today’s 4 PM review.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
              <button type="button" className={`${buttonBase} bg-white/10 text-white hover:bg-white/15`}><MessageCircle size={16} />Discuss in chat</button>
              <button type="button" className={`${buttonBase} bg-white text-neutral-900 hover:bg-neutral-100`}><Play size={15} fill="currentColor" />Start focus session</button>
            </div>
          </div>
        </section>

        <section className="animate-widget-in col-span-12 rounded-2xl bg-white p-5 shadow-card lg:col-span-7" style={{ animationDelay: "280ms" }}>
          <SectionHeader title="Mentions that need you" eyebrow="Conversations" action="Open all" />
          <div className="mt-4 divide-y divide-neutral-100">
            {mentions.map((mention) => (
              <article key={mention.name} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-50 text-xs font-extrabold text-primary-700">{mention.initials}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="text-sm font-extrabold text-neutral-800">{mention.name}</h3><span className="flex items-center gap-1 text-xs font-semibold text-neutral-400"><Hash size={12} />{mention.channel}</span><time className="ml-auto text-xs text-neutral-400">{mention.time}</time></div>
                  <p className="mt-1 text-sm leading-6 text-neutral-600"><span className="font-bold text-primary-600">@Alex</span> {mention.text}</p>
                </div>
                {mention.unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary-600" aria-label="Unread" />}
              </article>
            ))}
          </div>
        </section>

        <section className="animate-widget-in col-span-12 rounded-2xl bg-white p-5 shadow-card lg:col-span-5" style={{ animationDelay: "350ms" }}>
          <SectionHeader title="Recent activity" eyebrow="Across your ventures" />
          <div className="mt-4 space-y-4">
            {activity.map(({ icon: Icon, label, subject, meta }) => (
              <div key={subject} className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-neutral-100 text-neutral-500"><Icon size={16} /></span>
                <div className="min-w-0"><p className="text-sm leading-5 text-neutral-600">{label} <span className="font-extrabold text-neutral-800">{subject}</span></p><p className="mt-0.5 text-xs font-medium text-neutral-400">{meta}</p></div>
              </div>
            ))}
          </div>
        </section>

        <section className="animate-widget-in col-span-12 pb-5" style={{ animationDelay: "420ms" }}>
          <SectionHeader title="Jump back in" eyebrow="Quick entry points" />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {[
              { icon: TimerReset, title: "Focus mode", detail: "One task, one timer", tone: "bg-primary-50 text-primary-700" },
              { icon: MessageCircle, title: "Channels & chat", detail: "3 unread mentions", tone: "bg-ai-surface text-ai-text" },
              { icon: Columns3, title: "Kanban board", detail: "7 items assigned", tone: "bg-success-surface text-success-text" },
            ].map(({ icon: Icon, title, detail, tone }) => (
              <button key={title} type="button" className="group flex min-h-20 items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-card transition-[box-shadow,transform] duration-150 hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]">
                <span className={`grid h-11 w-11 place-items-center rounded-xl ${tone}`}><Icon size={19} /></span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-extrabold text-neutral-900">{title}</span><span className="block text-xs font-medium text-neutral-400">{detail}</span></span>
                <ArrowRight size={17} className="text-neutral-300 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-neutral-600" />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
