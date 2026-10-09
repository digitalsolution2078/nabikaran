import Link from "next/link";
import { env } from "@/lib/env";
import { LegalContact } from "@/components/LegalContact";

export const metadata = { title: "Privacy policy", description: "How Nabikaran collects, uses, protects and deletes your data." };

export default function Privacy() {
  return (
    <article className="legal">
      <h1>Privacy policy</h1>
      <p className="muted">Effective {env.legal.effectiveDate}. Applies to nabikaran.org, its admin tools, and connected AI assistants.</p>

      <h2>Who we are</h2>
      <LegalContact />

      <h2>What Nabikaran does — and does not do</h2>
      <ul>
        <li>Nabikaran sends <strong>reminders only</strong>, by SMS and/or WhatsApp, about renewal dates <strong>you enter</strong>.</li>
        <li>It does not renew documents, submit applications, or act for you with any office.</li>
        <li>It does not query any government, transport, passport, tax, insurer or bank database. Dates are what you type or confirm.</li>
      </ul>

      <h2>Data we collect</h2>
      <ul>
        <li><strong>Account:</strong> your mobile number (verified by a one-time code), optional name and email, language and calendar preferences.</li>
        <li><strong>Reminders:</strong> category, label, expiry date (AD/BS as entered), optional notes and family-member label, schedule and delivery channel.</li>
        <li><strong>Messages:</strong> delivery status reported by our providers (accepted, delivered, read, failed). Message text is generated from your reminder.</li>
        <li><strong>Wallet and payments:</strong> credit ledger, top-up amounts, payment references, and receipts you upload for QR payments. We never receive card numbers or bank passwords.</li>
        <li><strong>Security:</strong> hashed IP addresses and device information for rate limiting and fraud prevention, and an audit log of sensitive actions.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To send the reminders you scheduled, only to your own verified number.</li>
        <li>To run your prepaid wallet, verify payments and keep accounting records.</li>
        <li>To secure the service, investigate abuse and answer your support requests.</li>
        <li>We do not sell your data and do not use it for advertising.</li>
      </ul>

      <h2>Who we share it with</h2>
      <ul>
        <li><strong>SMS provider</strong> (Aakash SMS) and <strong>WhatsApp</strong> (Meta Platforms, via the WhatsApp Business Cloud API) receive your number and the reminder text needed to deliver it. WhatsApp is used only if you choose it and give consent.</li>
        <li><strong>Payment providers</strong> (Khalti, Fonepay / your bank) process payments you start.</li>
        <li><strong>Hosting provider</strong> stores the service's data on our server.</li>
        <li>Authorities, only when the law of Nepal requires it.</li>
      </ul>

      <h2>WhatsApp consent</h2>
      <p>WhatsApp reminders are sent only after you tick the consent box. Reply <strong>STOP</strong> on WhatsApp at any time to stop them; your SMS reminders continue.</p>

      <h2>Connected AI assistants</h2>
      <p>If you connect ChatGPT, Claude or another app, it can only use the permissions you approve. It can read your account summary and reminders and prepare reminders, but every reminder needs your confirmation of the message text, channel, AD/BS date, schedule and credit cost. Connected apps can never top up your wallet or send messages to any number other than yours. You can disconnect them in Settings.</p>

      <h2>Retention</h2>
      <ul>
        <li>Reminders and preferences: until you delete them or close your account.</li>
        <li>Ledger, payment and receipt records: kept as long as accounting and tax law requires, even after closure.</li>
        <li>Operational logs: phone numbers are masked; detailed logs are pruned regularly.</li>
      </ul>

      <h2>Security</h2>
      <p>Provider tokens, payment credentials and webhook secrets are kept only in the server environment, never in the database or admin screens. One-time codes are stored only as hashes. Staff access is role-based and every sensitive action is written to an append-only audit log.</p>

      <h2>Your choices and rights</h2>
      <ul>
        <li>Export your data or close your account in <Link href="/settings">Settings</Link>.</li>
        <li>Correct your reminders at any time; ask us to correct account data.</li>
        <li>Questions or complaints: use the contact above. We aim to respond within 7 working days, consistent with Nepal&apos;s Individual Privacy Act, 2075.</li>
      </ul>

      <h2>Changes</h2>
      <p>We will post changes here with a new effective date and, for material changes, tell you in the app before they apply.</p>
    </article>
  );
}
