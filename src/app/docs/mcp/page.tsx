import { env } from "@/lib/env";

export default function McpDocs() {
  const issuer = env.oauthIssuer.replace(/\/$/, "");
  return (
    <div>
      <h1>Use Nabikaran from your AI assistant</h1>
      <p>Nabikaran is an MCP server. Connect it to ChatGPT, Claude or any MCP-compatible assistant to check your balance and manage renewal reminders by chatting.</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Server URL</h2>
        <pre className="sms">{env.mcpResource}</pre>
        <p className="muted" style={{ fontSize: 13 }}>Transport: Streamable HTTP · Auth: OAuth 2.1 with PKCE (your assistant registers itself; you sign in with your Nepal mobile and approve the permissions).</p>
        <h2>What the assistant can do</h2>
        <ul>
          <li><code>get_account</code> — your name and masked phone</li>
          <li><code>get_credit_balance</code> — available / reserved credits and price per SMS</li>
          <li><code>list_reminders</code> — your renewals with AD and BS dates and SMS status</li>
          <li><code>prepare_reminder</code> → <code>confirm_reminder</code> — add or edit a reminder: you see the exact SMS text, dates (AD + BS) and credit cost, then confirm; credits are reserved only after you confirm</li>
          <li><code>update_reminder</code> — pause or resume; <code>cancel_reminder</code> — cancel unsent SMS and release credits</li>
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>Bikram Sambat dates and dates read from a document photo always require your explicit confirmation of the converted Gregorian date. The assistant can never top up your wallet, see payment details, or send SMS to any other number.</p>
        <h2>Connect</h2>
        <ol>
          <li><strong>Claude</strong>: Settings → Connectors → Add custom connector → paste the server URL.</li>
          <li><strong>ChatGPT</strong>: Settings → Connectors (developer mode) → Create → MCP server URL, authentication OAuth.</li>
          <li>Approve the permissions on the Nabikaran consent screen. Disconnect any time from <a href="/settings">Settings → Connected apps</a>.</li>
        </ol>
        <p className="muted" style={{ fontSize: 12 }}>Discovery: <code>{env.mcpResource.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource</code> · <code>{issuer}/.well-known/oauth-authorization-server</code></p>
      </div>
    </div>
  );
}
