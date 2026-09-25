import { notFound } from "next/navigation";
import { SignupForm } from "./signup-form";

type Status = { available: boolean; complete: boolean; configured: boolean; emailDeliveryReady: boolean };

export default async function SignupPage() {
  let status: Status | null = null;
  try {
    const apiOrigin = process.env.VSO_API_ORIGIN ?? "http://localhost:4000";
    const response = await fetch(`${apiOrigin}/v1/setup/first-admin`, { cache: "no-store" });
    if (response.ok) status = (await response.json() as { data: Status }).data;
  } catch { /* The page shows the unavailable state while the API is offline. */ }
  if (status?.complete) notFound();
  return <SignupForm status={status} />;
}
