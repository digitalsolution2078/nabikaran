"use client";
import Link from "next/link";
import { useEffect } from "react";
import { usePrefs } from "@/components/Prefs";

/** App-wide error boundary: a calm message plus the error ID operators can find in the server logs. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = usePrefs();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="card" style={{ maxWidth: 560, margin: "40px auto" }} role="alert">
      <h1>{t("err.title")}</h1>
      <p className="muted">{t("err.body")}</p>
      {error.digest && <p className="small">Error ID: <span className="mono">{error.digest}</span></p>}
      <div className="row mt">
        <button className="btn btn-primary" onClick={reset}>{t("err.retry")}</button>
        <Link href="/dashboard" className="btn btn-secondary">{t("err.home")}</Link>
      </div>
    </div>
  );
}
