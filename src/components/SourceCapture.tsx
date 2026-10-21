"use client";
import { useEffect } from "react";

/**
 * Remembers where a visitor came from (?utm_source=, ?utm_campaign= or ?ref=)
 * in a 30-day cookie so the sign-up can be attributed (Admin → Dashboard →
 * Sign-up funnel). First source wins; nothing is sent anywhere.
 */
export function SourceCapture() {
  useEffect(() => {
    try {
      if (document.cookie.includes("nb_src=")) return;
      const q = new URLSearchParams(window.location.search);
      const src = q.get("utm_source") || (q.get("ref") ? "referral" : null) || (document.referrer && !document.referrer.includes(window.location.host) ? new URL(document.referrer).hostname.replace(/^www\./, "") : null);
      const camp = q.get("utm_campaign");
      if (!src) return;
      const value = `${src}${camp ? `/${camp}` : ""}`.toLowerCase().replace(/[^a-z0-9_./-]/g, "").slice(0, 40);
      document.cookie = `nb_src=${encodeURIComponent(value)}; path=/; max-age=${30 * 86400}; samesite=lax`;
    } catch {
      /* cookies blocked: nothing to do */
    }
  }, []);
  return null;
}
