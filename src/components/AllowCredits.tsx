"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

/** Pro: allow wallet credits for messages waiting because included messages ran out. */
export function AllowCredits({ label }: { label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("/api/pro", { method: "POST", json: { action: "allow_credits" } });
          router.refresh();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? <span className="spinner" /> : null} {label}</button>
      {err && <span className="field-error"> {err}</span>}
    </>
  );
}
