import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { PrefsProvider } from "@/components/Prefs";
import { SwRegister } from "@/components/SwRegister";
import { getRequestContext } from "@/lib/i18n/server";
import { readWallet } from "@/lib/core/wallet";
import { formatPhoneLocal } from "@/lib/phone";
import { isAdminRole } from "@/lib/auth/rbac";
import { isPro } from "@/lib/services/plans";
import { getSetting } from "@/lib/services/settings";

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
  const [wallet, pro, offer] = ctx.user
    ? await Promise.all([readWallet(ctx.user.id).catch(() => null), isPro(ctx.user.id).catch(() => false), getSetting("pro").catch(() => null)])
    : [null, false, null];
  const shellUser = ctx.user
    ? { name: ctx.user.displayName, phoneLocal: formatPhoneLocal(ctx.user.phoneE164), isAdmin: isAdminRole(ctx.user.role), availableCredits: wallet?.available ?? 0, pro, proOffer: Boolean(offer?.enabled) }
    : null;
  return (
    <html lang={ctx.prefs.lang}>
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
