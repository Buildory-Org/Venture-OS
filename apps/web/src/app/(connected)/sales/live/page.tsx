import type { Metadata } from "next";
import { LiveSalesScreen } from "@/screens/live-sales";

export const metadata: Metadata = { title: "Connected Sales — Venture Studio OS" };

export default function Page() { return <LiveSalesScreen />; }
