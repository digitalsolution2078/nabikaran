"use client";
import { useEffect, useState } from "react";
import { clockText } from "@/lib/i18n/format";
import { usePrefs } from "./Prefs";

/**
 * Nepal-time header clock. The server renders the time it saw (`initialIso`);
 * the client takes over after mount and ticks every second. The text nodes
 * carry suppressHydrationWarning because a second may pass between server
 * render and hydration.
 */
export function LiveClock({ initialIso }: { initialIso: string }) {
  const { prefs } = usePrefs();
  const [now, setNow] = useState(() => new Date(initialIso));
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const c = clockText(now, prefs);
  return (
    <div className="clock" aria-live="off" title="Nepal Time (Asia/Kathmandu)">
      <span className="dot" aria-hidden />
      <span className="full" suppressHydrationWarning>{c.day}, {c.date} |</span>
      <strong suppressHydrationWarning>{c.time}</strong>
    </div>
  );
}
