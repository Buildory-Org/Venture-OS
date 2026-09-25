import { notFound } from "next/navigation";
import { CompleteSignupClient } from "./complete-client";

export default async function CompleteSignupPage() {
  const apiOrigin = process.env.VSO_API_ORIGIN ?? "http://localhost:4000";
  let complete = false;
  try {
    const response = await fetch(`${apiOrigin}/v1/setup/first-admin`, { cache: "no-store" });
    if (response.ok) complete = Boolean((await response.json() as { data?: { complete?: boolean } }).data?.complete);
  } catch { /* The client shows a retryable API error. */ }
  if (complete) notFound();
  return <CompleteSignupClient />;
}
