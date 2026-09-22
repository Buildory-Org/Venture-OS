import type { Metadata } from "next";
import { LiveMessagesScreen } from "@/screens/live-messages";

export const metadata: Metadata = { title: "Connected Messages — Venture Studio OS" };

export default function Page() { return <LiveMessagesScreen />; }
