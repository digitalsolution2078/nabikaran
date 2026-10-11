import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { PrefsProvider } from "@/components/Prefs";
import { SwRegister } from "@/components/SwRegister";
import { getRequestContext } from "@/lib/i18n/server";
import { readWallet } from "@/lib/core/wallet";
import { formatPhoneLocal } from "@/lib/phone";
import { isAdminRole } from "@/lib/auth/rbac";
import { getPlanState } from "@/lib/services/plans";
import { getSetting } from "@/lib/services/settings";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Nabikaran — SMS renewal reminders for Nepal", template: "%s · Nabikaran" },
  description: "Save expiry dates for your Bluebook, licence, passport, insurance, tax and business renewals. Get SMS reminders on your Nepal mobile.",
  manifest: "/manifest.webmanifest",
  applicationName: "Nabikaran",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "Nabikaran", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { themeColor: "#55239a", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getRequestContext();
  // Light brand theme unless the person chose dark (or "follow my device") in Settings.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const [wallet, plan, offer] = ctx.user
    ? await Promise.all([readWallet(ctx.user.id).catch(() => null), getPlanState(ctx.user.id).catch(() => null), getSetting("pro").catch(() => null)])
    : [null, null, null];
  const shellUser = ctx.user
    ? {
        name: ctx.user.displayName, phoneLocal: formatPhoneLocal(ctx.user.phoneE164), isAdmin: isAdminRole(ctx.user.role), availableCredits: wallet?.available ?? 0,
        pro: plan?.tier === "pro", proOffer: Boolean(offer?.enabled),
        plan: plan?.tier === "pro"
          ? { kind: plan.kind, endsAt: plan.endsAt, left: plan.allowances.length ? Object.fromEntries(plan.allowances.map((a) => [a.channel, a.left])) as Record<"sms" | "whatsapp" | "email", number> : null }
          : null,
      }
    : null;
  return (
    <html lang={ctx.prefs.lang} data-theme={theme}>
      <body>
        <a href="#main" className="sr-only">Skip to content</a>
        <PrefsProvider initial={ctx.prefs} chosen={ctx.chosen} signedIn={Boolean(ctx.user)}>
          <Shell user={shellUser} clockIso={new Date().toISOString()}>{children}</Shell>
        </PrefsProvider>
        <SwRegister />
      </body>
    </html>
  );
}
