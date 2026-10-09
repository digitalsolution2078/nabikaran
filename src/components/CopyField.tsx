"use client";
import { useState } from "react";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

export function CopyField({ value, display }: { value: string; display?: string }) {
  const { t } = usePrefs();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span>{display ?? value}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked; the value is visible to copy manually */
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? t("qr.copied") : t("qr.copy")}
      </button>
    </div>
  );
}
