import { LiveShell } from "@/components/shell/live-shell";

export default function ConnectedLayout({ children }: { children: React.ReactNode }) { return <LiveShell>{children}</LiveShell>; }
