"use client";

import { KnowledgeFileIcon, fileExtension } from "@/components/studio/knowledge-file-icon";

export function KnowledgeDocumentTile({ title, venture, status, updatedAt, onOpen, selected, onSelect, contentType, fileName }: {
  title: string;
  venture: string;
  status: string;
  updatedAt: string;
  onOpen: () => void;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  contentType?: string;
  fileName?: string;
}) {
  return <div className="group relative min-w-0">
    <button type="button" onClick={onOpen} aria-label={`Open ${title}`} className="knowledge-tile block w-full min-w-0 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2">
      <span className="knowledge-tile-preview relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 p-4">
        <KnowledgeFileIcon name={fileName ?? `${title}.md`} contentType={contentType ?? "text/markdown"} />
        <span className="absolute bottom-2 right-2 rounded-md border border-neutral-200 bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">{fileExtension(fileName ?? `${title}.md`, contentType ?? "text/markdown")}</span>
      </span>
      <span className="mt-2 block min-h-10 line-clamp-2 px-0.5 text-sm font-semibold leading-5 text-neutral-900" title={title}>{title}</span>
      <span className="mt-0.5 block truncate px-0.5 text-xs text-neutral-500">{venture} · {status} · {updatedAt}</span>
    </button>
    {onSelect && <label className="absolute left-2 top-2 grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-neutral-200 bg-white/95 shadow-sm" title="Include in context packet"><input type="checkbox" checked={Boolean(selected)} onChange={(event) => onSelect(event.target.checked)} aria-label={`Include ${title} in context packet`} className="h-4 w-4 accent-primary-600" /></label>}
  </div>;
}
