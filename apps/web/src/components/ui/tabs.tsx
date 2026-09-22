"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import clsx from "clsx";

export type TabDef = { key: string; label: string; badge?: number };

function TabsInner({
  tabs,
  param = "tab",
  onChange,
}: {
  tabs: TabDef[];
  param?: string;
  onChange?: (key: string) => void;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const active = sp.get(param) ?? tabs[0].key;

  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-full bg-neutral-100 p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => {
            onChange?.(t.key);
            const q = new URLSearchParams(sp.toString());
            q.set(param, t.key);
            router.replace(`?${q.toString()}`, { scroll: false });
          }}
          className={clsx(
            "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12px] font-bold",
            "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]",
            active === t.key
              ? "bg-neutral-900 text-white"
              : "text-neutral-500 hover:text-neutral-800"
          )}
        >
          {t.label}
          {t.badge != null && (
            <span
              className={clsx(
                "rounded-full px-1.5 py-0.5 text-[9.5px] font-bold leading-none tnum",
                active === t.key
                  ? "bg-white/20 text-white"
                  : "bg-neutral-200/80 text-neutral-500"
              )}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Tabs(props: {
  tabs: TabDef[];
  param?: string;
  onChange?: (key: string) => void;
}) {
  return (
    <Suspense>
      <TabsInner {...props} />
    </Suspense>
  );
}

/** Client-side active-tab reader for page bodies. */
export function useTab(tabs: TabDef[], param = "tab") {
  const sp = useSearchParams();
  return sp.get(param) ?? tabs[0].key;
}
