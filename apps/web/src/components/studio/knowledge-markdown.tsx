"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownView = "rendered" | "raw";

export function MarkdownViewToggle({ value, onChange }: { value: MarkdownView; onChange: (value: MarkdownView) => void }) {
  return <div role="group" aria-label="Markdown view" className="flex shrink-0 gap-0.5 rounded-lg border border-white/15 bg-white/10 p-0.5">
    {(["rendered", "raw"] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className={`min-h-8 rounded-md px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${value === mode ? "bg-white text-neutral-900" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>{mode === "rendered" ? "Rendered" : "Raw"}</button>)}
  </div>;
}

export function MarkdownBody({ markdown, view }: { markdown: string; view: MarkdownView }) {
  if (view === "raw") return <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7 text-neutral-800">{markdown}</pre>;
  return <div className="knowledge-markdown text-neutral-800"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // Markdown sources can contain arbitrary image URLs and have no known dimensions.
    // eslint-disable-next-line @next/next/no-img-element
    img: ({ src, alt }) => <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  }}>{markdown}</ReactMarkdown></div>;
}
