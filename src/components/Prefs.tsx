"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Lang, type MessageKey } from "@/lib/i18n/dict";
import type { DateFormat, Prefs } from "@/lib/i18n/format";
import { PREFS_STORAGE_KEY, decodePrefs, encodePrefs } from "@/lib/i18n/prefs";

interface PrefsCtx {
  prefs: Prefs;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setPrefs: (p: Prefs & { smsLanguage?: "en-NP" | "ne-NP" }) => Promise<void>;
  signedIn: boolean;
}

const Ctx = createContext<PrefsCtx | null>(null);

export function usePrefs(): PrefsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrefs outside PrefsProvider");
  return c;
}

function readStored(): Prefs | null {
  try {
    return decodePrefs(window.localStorage.getItem(PREFS_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(p: Prefs) {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, encodePrefs(p));
  } catch {
    /* private mode: cookie still holds the choice */
  }
}

export function PrefsProvider({ initial, chosen, signedIn, children }: { initial: Prefs; chosen: boolean; signedIn: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const [prefs, setLocal] = useState<Prefs>(initial);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => setLocal(initial), [initial]);

  const persist = useCallback(
    async (p: Prefs & { smsLanguage?: "en-NP" | "ne-NP" }) => {
      setLocal({ lang: p.lang, date: p.date });
      writeStored(p);
      await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p), credentials: "same-origin" }).catch(() => undefined);
      document.documentElement.lang = p.lang;
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (chosen) {
      writeStored(initial);
      return;
    }
    // First render for a guest without the cookie: restore from localStorage, else ask.
    const stored = readStored();
    if (stored) void persist(stored);
    else setShowOnboarding(true);
  }, [chosen, initial, persist]);

  const value = useMemo<PrefsCtx>(
    () => ({ prefs, t: (k, v) => translate(prefs.lang, k, v), setPrefs: persist, signedIn }),
    [prefs, persist, signedIn],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {showOnboarding && <OnboardingPrefs onDone={async (p) => { setShowOnboarding(false); await persist(p); }} />}
    </Ctx.Provider>
  );
}

function OnboardingPrefs({ onDone }: { onDone: (p: Prefs) => void }) {
  const [lang, setLang] = useState<Lang>("ne");
  const [date, setDate] = useState<DateFormat>("BS");
  const t = (k: MessageKey) => translate(lang, k);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="prefs-title">
      <div className="modal">
        <div className="logo" style={{ marginBottom: 14 }}>
          <span className="logo-mark">न</span>
          <span>Nabikaran<small>नवीकरण</small></span>
        </div>
        <h2 id="prefs-title">{t("prefs.title")}</h2>
        <p className="muted">{t("prefs.subtitle")}</p>
        <div className="field">
          <span className="label">{t("prefs.language")} · Language</span>
          <div className="grid grid-2">
            <label className="choice"><input type="radio" name="lang" checked={lang === "ne"} onChange={() => setLang("ne")} /><span><strong>नेपाली</strong><br /><span className="small muted">Nepali</span></span></label>
            <label className="choice"><input type="radio" name="lang" checked={lang === "en"} onChange={() => setLang("en")} /><span><strong>English</strong><br /><span className="small muted">अंग्रेजी</span></span></label>
          </div>
        </div>
        <div className="field">
          <span className="label">{t("prefs.dateFormat")}</span>
          <div className="grid grid-2">
            <label className="choice"><input type="radio" name="date" checked={date === "BS"} onChange={() => setDate("BS")} /><span><strong>{t("prefs.bs")}</strong><br /><span className="small muted">२०८३ असोज २३</span></span></label>
            <label className="choice"><input type="radio" name="date" checked={date === "AD"} onChange={() => setDate("AD")} /><span><strong>{t("prefs.ad")}</strong><br /><span className="small muted">9 October 2026</span></span></label>
          </div>
        </div>
        <button className="btn btn-primary btn-block btn-lg" onClick={() => onDone({ lang, date })}>{t("prefs.continue")}</button>
      </div>
    </div>
  );
}

/** Translate inside client components. */
export function T({ k, vars }: { k: MessageKey; vars?: Record<string, string | number> }) {
  const { t } = usePrefs();
  return <>{t(k, vars)}</>;
}
