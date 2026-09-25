"use client";

import { useEffect, useState } from "react";
import { prepareLiveFileDownload, uploadLiveFile } from "@/lib/studio-api";
import { Field, inputClass, secondaryClass } from "@/components/studio/primitives";

type UploadedFile = Awaited<ReturnType<typeof uploadLiveFile>>;

export function LiveFileUpload({ ventureId, groupId, taskId, onUploaded }: {
  ventureId: string;
  groupId?: string;
  taskId?: string;
  onUploaded: (file: UploadedFile) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const form = event.currentTarget;
    setBusy(true); setError("");
    try {
      const uploaded = await uploadLiveFile(file, { ventureId, ...(groupId ? { groupId } : {}), ...(taskId ? { taskId } : {}) });
      setFile(null); form.reset(); onUploaded(uploaded);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The upload failed."); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="space-y-3"><Field label="Choose a file"><input type="file" required accept=".pdf,.md,.txt,.png,.jpg,.jpeg" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className={`${inputClass} py-2`} /></Field><p className="text-xs leading-5 text-neutral-500">PDF, Markdown, text, PNG, or JPEG · 25 MB maximum. A signed upload is finalized only after the file reaches storage.</p>{error && <p role="alert" className="text-xs font-semibold text-danger-text">{error}</p>}<button disabled={busy || !file || !ventureId || (!!taskId && !groupId)} className={secondaryClass}>{busy ? "Uploading…" : "Upload file"}</button></form>;
}

export function LiveFileDownload({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [objectUrl, setObjectUrl] = useState("");

  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  async function prepare() {
    setBusy(true); setError("");
    try { setObjectUrl(await prepareLiveFileDownload(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not download this file."); }
    finally { setBusy(false); }
  }

  return <span className="inline-flex flex-col items-start gap-1">{objectUrl ? <a href={objectUrl} download={name} className="inline-flex min-h-9 items-center rounded-lg px-2 text-xs font-semibold text-primary-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Save {name}</a> : <button type="button" onClick={prepare} disabled={busy} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{busy ? "Preparing download…" : `Prepare download: ${name}`}</button>}{error && <span role="alert" className="text-xs text-danger-text">{error}</span>}</span>;
}
