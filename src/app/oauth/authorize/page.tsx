import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { validateAuthorizeRequest, AuthorizeError } from "@/lib/oauth/codes";
import { formatPhoneLocal } from "@/lib/phone";

const SCOPE_TEXT: Record<string, { en: string; ne: string }> = {
  "account:read": { en: "See your display name and masked phone number", ne: "तपाईंको नाम र आंशिक रूपमा लुकाइएको फोन नम्बर हेर्न" },
  "wallet:read": { en: "See your credit balance (cannot top up or spend)", ne: "तपाईंको क्रेडिट ब्यालेन्स हेर्न (टप-अप वा खर्च गर्न सक्दैन)" },
  "reminders:read": { en: "See your renewals and reminder history", ne: "तपाईंका नवीकरण र रिमाइन्डर इतिहास हेर्न" },
  "reminders:write": { en: "Create, change, pause or cancel reminders — this reserves credits only after you confirm", ne: "रिमाइन्डर बनाउन, बदल्न, रोक्न वा रद्द गर्न — क्रेडिट तपाईंले पुष्टि गरेपछि मात्र रिजर्भ हुन्छ" },
};

export const dynamic = "force-dynamic";

/**
 * OAuth 2.1 authorization endpoint (consent page). Requires a web session; the
 * phone that will receive SMS is shown so the user knows exactly what the
 * connected app can do.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? null;
  const params = {
    response_type: one("response_type"),
    client_id: one("client_id"),
    redirect_uri: one("redirect_uri"),
    scope: one("scope"),
    state: one("state"),
    code_challenge: one("code_challenge"),
    code_challenge_method: one("code_challenge_method"),
    resource: one("resource"),
  };

  let validated;
  try {
    validated = await validateAuthorizeRequest(params);
  } catch (e) {
    if (e instanceof AuthorizeError && e.redirectable && e.redirectUri) {
      const u = new URL(e.redirectUri);
      u.searchParams.set("error", e.error);
      u.searchParams.set("error_description", e.description);
      if (e.state) u.searchParams.set("state", e.state);
      redirect(u.toString());
    }
    return (
      <div className="card">
        <h1>Cannot connect this app</h1>
        <p className="error">{(e as Error).message}</p>
      </div>
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    const self = new URL("/oauth/authorize", "http://x");
    for (const [k, v] of Object.entries(params)) if (v) self.searchParams.set(k, v);
    redirect(`/login?next=${encodeURIComponent(self.pathname + self.search)}`);
  }

  const hidden = Object.entries(params).filter(([, v]) => v) as [string, string][];
  return (
    <div>
      <h1>Connect {validated.client.name}</h1>
      <div className="card">
        <p><strong>{validated.client.name}</strong> wants to access your Nabikaran account for <strong>{formatPhoneLocal(user.phoneE164)}</strong>.</p>
        <p className="muted" style={{ fontSize: 13 }}>Reminders will only ever be sent to this verified number. The app cannot top up your wallet, see payment details or change your phone number.</p>
        <ul>
          {validated.scopes.map((s) => (
            <li key={s}><strong>{SCOPE_TEXT[s]?.en ?? s}</strong><br /><span className="muted">{SCOPE_TEXT[s]?.ne}</span></li>
          ))}
        </ul>
        <form method="post" action="/oauth/authorize/decision" className="row">
          {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <button type="submit" name="decision" value="allow">Allow</button>
          <button type="submit" name="decision" value="deny" className="secondary">Deny</button>
        </form>
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>Redirects to {validated.redirectUri}. You can disconnect at any time from Settings → Connected apps.</p>
      </div>
    </div>
  );
}
