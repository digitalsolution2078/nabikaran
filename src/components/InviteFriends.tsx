"use client";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { CopyField } from "./CopyField";
import { localizeNumber } from "@/lib/i18n/format";

export interface InviteProps {
  link: string;
  referrerCredits: number;
  refereeCredits: number;
  minTopup: number;
  message: string;
  invited: number;
  rewarded: number;
  pending: number;
  creditsEarned: number;
}

export function InviteFriends(p: InviteProps) {
  const { t, prefs } = usePrefs();
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const text = t("ref.shareText", { bonus: String(p.refereeCredits), link: p.link });
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "Nabikaran", text, url: p.link });
    } catch {
      /* cancelled */
    }
  };
  return (
    <section className="card invite-card">
      <div className="row" style={{ gap: 12 }}>
        <span className="icon-chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}><Icon name="gift" size={20} /></span>
        <div>
          <h2 className="mb-0">{t("ref.title")}</h2>
          <p className="small muted mb-0">{t("ref.body", { you: n(p.referrerCredits), them: n(p.refereeCredits), min: n(p.minTopup) })}</p>
        </div>
      </div>
      {p.message && <p className="alert info mt mb-0"><span>{p.message}</span></p>}
      <div className="mt"><CopyField value={p.link} /></div>
      <div className="row mt">
        <a className="btn btn-primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"><Icon name="message" size={16} /> WhatsApp</a>
        <a className="btn btn-secondary" href={`viber://forward?text=${encodeURIComponent(text)}`}>Viber</a>
        <button type="button" className="btn btn-secondary" onClick={share}><Icon name="upload" size={16} /> {t("ref.share")}</button>
      </div>
      <div className="grid grid-3 mt">
        <div className="stat"><div className="label">{t("ref.invited")}</div><div className="value value-sm">{n(p.invited)}</div><div className="sub">{t("ref.pending", { n: n(p.pending) })}</div></div>
        <div className="stat"><div className="label">{t("ref.rewarded")}</div><div className="value value-sm">{n(p.rewarded)}</div></div>
        <div className="stat"><div className="label">{t("ref.earned")}</div><div className="value value-sm">{n(p.creditsEarned)}</div><div className="sub">{t("common.credits")}</div></div>
      </div>
    </section>
  );
}
