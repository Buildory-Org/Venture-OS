import { Anim } from "./anim";

/** Page header — breadcrumb + title + right-side actions. */
export function PageHeader({
  crumb,
  title,
  subtitle,
  children,
}: {
  crumb: string;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <Anim className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[11.5px] font-semibold text-neutral-400">{crumb}</p>
        <h1 className="mt-0.5 text-[22px] font-extrabold tracking-tight text-neutral-900">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-0.5 text-[13px] font-medium text-neutral-500">
            {subtitle}
          </p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </Anim>
  );
}
