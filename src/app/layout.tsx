import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SwRegister } from "@/components/SwRegister";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Nabikaran — SMS renewal reminders for Nepal",
  description: "Save expiry dates for your Bluebook, licence, passport, insurance and more. Get SMS reminders on your verified Nepal mobile.",
  manifest: "/manifest.webmanifest",
  applicationName: "Nabikaran",
};

export const viewport: Viewport = { themeColor: "#4b2e83", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="ne">
      <body>
        <Nav user={user ? { role: user.role, phone: user.phoneE164 } : null} />
        <main>{children}</main>
        <footer>
          Nabikaran sends reminders only. It does not renew documents, query government databases or guarantee handset delivery. ·{" "}
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms &amp; refunds</a>
        </footer>
        <SwRegister />
      </body>
    </html>
  );
}
