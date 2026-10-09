import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { PrefsProvider } from "@/components/Prefs";
import { SwRegister } from "@/components/SwRegister";
import { getRequestContext } from "@/lib/i18n/server";
import { readWallet } from "@/lib/core/wallet";
import { formatPhoneLocal } from "@/lib/phone";
import { isAdminRole } from "@/lib/auth/rbac";

export const metadata: Metadata = {
  title: { default: "Nabikaran — SMS renewal reminders for Nepal", template: "%s · Nabikaran" },
  description: "Save expiry dates for your Bluebook, licence, passport, insurance, tax and business renewals. Get SMS reminders on your Nepal mobile.",
  manifest: "/manifest.webmanifest",
  applicationName: "Nabikaran",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#6d28d9", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getRequestContext();
  const wallet = ctx.user ? await readWallet(ctx.user.id).catch(() => null) : null;
  const shellUser = ctx.user
    ? { name: ctx.user.displayName, phoneLocal: formatPhoneLocal(ctx.user.phoneE164), isAdmin: isAdminRole(ctx.user.role), availableCredits: wallet?.available ?? 0 }
    : null;
  return (
    <html lang={ctx.prefs.lang}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Mukta:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet" />
      </head>
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
