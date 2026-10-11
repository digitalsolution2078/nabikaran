"use client";
import { useState } from "react";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Copy / share a paid gift card code. */
export function GiftShare({ code, credits, toName, message, appUrl }: { code: string; credits: number; toName: string | null; message: string | null; appUrl: string }) {
  const { t } = usePrefs();
  const [copied, setCopied] = useState(false);
  const link = `${appUrl}/wallet?code=${encodeURIComponent(code)}#redeem`;
  const text = t("gift.shareText", { name: toName ?? "", credits, code, link }) + (message ? `\n“${message}”` : "");
  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  async function share() {
    if (navigator.share) await navigator.share({ title: "Nabikaran gift card", text }).catch(() => undefined);
    else await copy();
  }
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}><Icon name="copy" size={14} /> {copied ? t("cal.copied") : t("gift.copy")}</button>
      <a className="btn btn-ghost btn-sm" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"><Icon name="message" size={14} /> WhatsApp</a>
      <button type="button" className="btn btn-ghost btn-sm" onClick={share}>{t("gift.share")}</button>
    </div>
  );
}
