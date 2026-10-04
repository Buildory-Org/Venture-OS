"use client";

import ReactMarkdown from "react-markdown";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import remarkGfm from "remark-gfm";

export type MarkdownView = "rendered" | "raw";

const VIEW_TABS = [{ key: "rendered", label: "Rendered" }, { key: "raw", label: "Raw" }];
export function MarkdownViewToggle({ value, onChange }: { value: MarkdownView; onChange: (value: MarkdownView) => void }) {
  return <SlidingTabs fitContent tone="dark" label="Markdown view" className="shrink-0 !p-0.5" active={value} onChange={(key) => onChange(key as MarkdownView)} tabs={VIEW_TABS} />;
}

export function MarkdownBody({ markdown, view }: { markdown: string; view: MarkdownView }) {
  const motion = useTabMotion(view, ["rendered", "raw"]);
  if (view === "raw") return <pre key="raw" style={motion.style} className="vso-tab-enter whitespace-pre-wrap break-words font-mono text-sm leading-7 text-neutral-800">{markdown}</pre>;
  return <div key="rendered" style={motion.style} className="vso-tab-enter knowledge-markdown text-neutral-800"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // Markdown sources can contain arbitrary image URLs and have no known dimensions.
    // eslint-disable-next-line @next/next/no-img-element
    img: ({ src, alt }) => <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  }}>{markdown}</ReactMarkdown></div>;
}
