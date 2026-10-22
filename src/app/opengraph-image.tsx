import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Social share image (Facebook, WhatsApp, Viber, X): the logo on the brand background. */
export const alt = "Nabikaran — renewal reminders for Nepal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logo = await readFile(path.join(process.cwd(), "public", "brand", "nabikaran-logo.png"));
  const src = `data:image/png;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "linear-gradient(135deg, #f8f7fc 0%, #ede7f8 60%, #fde7d6 100%)", fontFamily: "sans-serif", color: "#1a1033" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" width={420} height={90} style={{ objectFit: "contain" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 66, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.5 }}>Never miss a Bluebook, licence or insurance renewal again.</div>
          <div style={{ fontSize: 30, color: "#55239a", fontWeight: 600 }}>All your expiry dates in one place. SMS, WhatsApp and app reminders before each one. Free to start.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 26, color: "#5b5675" }}>
          <span>nabikaran.org</span>
          <span style={{ display: "flex", gap: 14 }}>
            <span style={{ padding: "8px 18px", borderRadius: 999, background: "#55239a", color: "#fff", fontWeight: 700 }}>Made for Nepal</span>
            <span style={{ padding: "8px 18px", borderRadius: 999, background: "#fff", border: "2px solid #d9d2ea", fontWeight: 700 }}>BS + AD dates</span>
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
