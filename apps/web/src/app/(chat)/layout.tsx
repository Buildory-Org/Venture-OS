import { RouteTransition } from "@/components/ui/route-transition";

export default function ChatLayout({ children }: { children: React.ReactNode }) { return <RouteTransition>{children}</RouteTransition>; }
