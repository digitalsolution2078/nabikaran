import Link from "next/link";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";
import type { Lang } from "@/lib/i18n/dict";

/** Server component: shown instead of reminder forms when the account is below the balance floor. */
export function LockNotice({ available, minBalance, lang, t }: { available: number; minBalance: number; lang: Lang; t: (k: MessageKey, v?: Record<string, string | number>) => string }) {
  const amount = Math.max(20, minBalance - available + 1, -available);
  return (
    <section className="card">
      <div className="alert warn"><Icon name="alert" /> <span><strong>{t("lock.title")}</strong><br />{t("lock.body", { balance: localizeNumber(available, lang), min: localizeNumber(minBalance, lang) })}</span></div>
      <Link href={`/wallet?amount=${amount}`} className="btn btn-primary mt"><Icon name="wallet" size={18} /> {t("lock.cta")}</Link>
    </section>
  );
}
