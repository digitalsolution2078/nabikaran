"use client";
import { useEffect } from "react";

/** Installed app icon badge: how many reminders are expired or due soon (Android/desktop Chrome, iOS 16.4+ home-screen apps). */
export function AppBadge({ count }: { count: number }) {
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [count]);
  return null;
}
