"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrefs } from "./Prefs";

/** Polls the server (which asks Fonepay) every 4 s for up to 15 minutes, then refreshes on approval. */
export function GatewayPoller({ requestId }: { requestId: string }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [done, setDone] = useState(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop || Date.now() - started > 15 * 60_000) return;
      try {
        const res = await fetch(`/api/topups/manual/${requestId}/check`, { method: "POST", credentials: "same-origin" });
        const data = (await res.json().catch(() => ({}))) as { status?: string };
        if (data.status === "approved") {
          setDone(true);
          router.refresh();
          return;
        }
      } catch {
        /* network blip: keep polling */
      }
      setTimeout(tick, 4000);
    };
    const first = setTimeout(tick, 3000);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [requestId, router]);
  return (
    <div className="alert info" role="status" aria-live="polite">
      {done ? <span>{t("qr.autoConfirmed")}</span> : <><span className="spinner" /> <span>{t("qr.checking")}</span></>}
    </div>
  );
}
