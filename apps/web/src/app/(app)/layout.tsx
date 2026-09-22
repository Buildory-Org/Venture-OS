import { AppShell } from "@/components/shell/app-shell";
import { StudioProvider } from "@/lib/studio-store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <StudioProvider><AppShell>{children}</AppShell></StudioProvider>;
}
