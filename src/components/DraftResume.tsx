"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Shown after a top-up when the customer left the Add Reminder wizard to buy credits. */
export function DraftResume() {
  const { t } = usePrefs();
  const [has, setHas] = useState(false);
  useEffect(() => {
    try {
      setHas(Boolean(sessionStorage.getItem("nabikaran.reminderDraft")));
    } catch {
      setHas(false);
    }
  }, []);
  if (!has) return null;
  return (
    <div className="alert info row between">
      <span><Icon name="bell" size={16} /> {t("topup.resume")}</span>
      <Link href="/renewals/new" className="btn btn-primary btn-sm">{t("topup.resumeCta")}</Link>
    </div>
  );
}
