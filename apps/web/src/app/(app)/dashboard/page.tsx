import { HugeiconsIcon } from "@hugeicons/react";
import { Dropdown } from "@/components/ui/dropdown";
import { ArrowDown01Icon,
  Building06Icon } from "@hugeicons/core-free-icons";
import { KpiStrip } from "@/components/dashboard/kpi-strip";
import { AiSummary } from "@/components/dashboard/ai-summary";
import { HealthScore } from "@/components/dashboard/health-score";
import { CashFlow } from "@/components/dashboard/cash-flow";
import { PlSummary } from "@/components/dashboard/pl-summary";
import { SalesTrend } from "@/components/dashboard/sales-trend";
import { MonthlyTargets } from "@/components/dashboard/monthly-targets";
import { BranchComparison } from "@/components/dashboard/branch-comparison";
import { PendingPayments } from "@/components/dashboard/pending-payments";
import { PendingApprovals } from "@/components/dashboard/pending-approvals";
import { CompanyAlerts } from "@/components/dashboard/company-alerts";
import { TopCustomers, TopRisks, TopVendors } from "@/components/dashboard/top-lists";
import { AiSuggestions } from "@/components/dashboard/ai-suggestions";

export const metadata = { title: "Dashboard — AIBOS" };

const XL = "col-span-12 lg:col-span-8"; // 8-col widget
const M = "col-span-12 md:col-span-6 lg:col-span-4"; // 4-col widget
const S = "col-span-12 sm:col-span-6 lg:col-span-3"; // 3-col widget

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-[1600px] p-6">
      {/* Greeting bar */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-extrabold tracking-tight text-neutral-900">
            Good morning, Rajesh 👋
          </h1>
          <p className="mt-1 text-[13px] font-medium text-neutral-500">
            Here&rsquo;s your business at a glance.
          </p>
        </div>
        <Dropdown
          align="right"
          items={[
            { label: "All branches", icon: Building06Icon },
            { label: "Delhi HQ", icon: Building06Icon },
            { label: "Jaipur", icon: Building06Icon },
            { label: "Lucknow", icon: Building06Icon },
          ]}
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-neutral-600 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"
            >
              Tue, 15 Sep 2026 · Delhi HQ +2 branches
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
      </div>

      <div className="space-y-5">
        {/* Row 1 — ⑫ KPI tiles */}
        <KpiStrip delay={0} />

        {/* Row 2 — ① AI summary + ⑤ health score */}
        <div className="grid grid-cols-12 gap-5">
          <AiSummary delay={60} className={XL} />
          <HealthScore delay={120} className={M} />
        </div>

        {/* Row 3 — ④ cash flow + ② P&L */}
        <div className="grid grid-cols-12 gap-5">
          <CashFlow delay={160} className={XL} />
          <PlSummary delay={220} className={M} />
        </div>

        {/* Row 4 — ③ sales · ⑭ targets · ⑬ branches */}
        <div className="grid grid-cols-12 gap-5">
          <SalesTrend delay={260} className={M} />
          <MonthlyTargets delay={320} className={M} />
          <BranchComparison delay={380} className={M} />
        </div>

        {/* Row 5 — needs attention */}
        <p
          className="animate-widget-in pt-1 text-[11px] font-bold uppercase tracking-[0.09em] text-neutral-400"
          style={{ animationDelay: "420ms" }}
        >
          Needs attention
        </p>
        <div className="grid grid-cols-12 gap-5">
          <PendingPayments delay={440} className={M} />
          <PendingApprovals delay={500} className={M} />
          <CompanyAlerts delay={560} className={M} />
        </div>

        {/* Row 6 — ranked lists + AI feed */}
        <div className="grid grid-cols-12 gap-5 pb-6">
          <TopCustomers delay={600} className={S} />
          <TopVendors delay={660} className={S} />
          <TopRisks delay={720} className={S} />
          <AiSuggestions delay={780} className={S} />
        </div>
      </div>
    </div>
  );
}
