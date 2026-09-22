import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "AIBOS — AI Business Operations System",
  description:
    "AI-assisted business operations: sales, inventory, finance, HR and an AI CEO dashboard — built by Buildory.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${jbMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-canvas font-sans text-neutral-900">
        {children}
      </body>
    </html>
  );
}
