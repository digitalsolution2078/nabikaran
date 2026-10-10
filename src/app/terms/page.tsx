import Link from "next/link";
import { env } from "@/lib/env";
import { LegalContact } from "@/components/LegalContact";

export const metadata = { title: "Terms of service", description: "Nabikaran terms: reminder service only, prepaid credits, delivery, refunds and account closure." };

export default function Terms() {
  return (
    <article className="legal">
      <h1>Terms of service</h1>
      <p className="muted">Effective {env.legal.effectiveDate}. By creating an account you agree to these terms.</p>

      <h2>1. The service</h2>
      <ul>
        <li>Nabikaran is a <strong>reminder service</strong>. It sends SMS and/or WhatsApp reminders about dates you enter.</li>
        <li>It <strong>does not renew</strong> documents, licences, policies, registrations or subscriptions, and does not give legal advice.</li>
        <li>It <strong>does not query government or third-party databases</strong>. Templates and descriptions are general guidance; always use the date printed on your own document and confirm renewal rules with the issuing office.</li>
        <li>You are responsible for entering correct dates and confirming converted dates (Bikram Sambat ↔ Gregorian) before saving.</li>
      </ul>

      <h2>2. Delivery</h2>
      <ul>
        <li>We submit each reminder to our provider at the scheduled time. <strong>We cannot guarantee handset delivery</strong> of SMS (network, phone, DND settings) or WhatsApp delivery or read status beyond what the provider reports.</li>
        <li>Statuses shown are the provider&apos;s: <em>Sent</em> (accepted), <em>Delivered</em>, <em>Read</em> (WhatsApp) and <em>Failed</em>.</li>
        <li>Do not rely on Nabikaran as your only record of important deadlines.</li>
      </ul>

      <h2>3. Prepaid credits</h2>
      <ul>
        <li>1 credit = NPR 1 of prepaid value. Credits <strong>do not expire</strong> while your account is open.</li>
        <li>Each message costs the credits shown before you save the reminder (SMS and WhatsApp are priced separately). All messages of a reminder are reserved when you save it; a reminder cannot be saved without enough credits.</li>
        <li>You are charged only when the provider accepts a message. If a message is rejected, or later reported as failed, the credits are returned automatically.</li>
        <li>Each successful sign-in uses the sign-in SMS fee shown on the login page (currently 1 credit). If you have no credits, your balance may go below zero; the next top-up settles it first. Below the published limit (currently −5 credits) you must top up before adding, editing or resuming reminders.</li>
        <li>Price changes apply only to reminders saved after the change.</li>
        <li>Credits cannot be transferred between accounts or withdrawn as cash.</li>
      </ul>

      <h2>4. Payments and refunds</h2>
      <ul>
        <li>Khalti payments are credited automatically after Khalti confirms them. QR payments are credited after the payment is confirmed by Fonepay or verified by our staff against the bank statement; a screenshot alone is not proof of payment.</li>
        <li>Prepaid credits are <strong>not refundable</strong>, except for a duplicate or erroneous payment reported within 30 days with its payment reference, which we refund to the original payment method after verification.</li>
        <li><strong>Nabikaran Pro</strong> is bought with wallet credits for a fixed period (shown before you buy). A Pro purchase is <strong>final and not refundable</strong>, in whole or in part, including unused included messages, which expire when the plan period ends. The free trial gives Pro features only (no included messages), once per account. Pro ends automatically at the end of the period; nothing renews or is charged without you buying again. When Pro ends, your data and reminders stay, and messages use wallet credits as usual.</li>
        <li>A reversed or charged-back payment removes the credits it added. If those credits were already used, the shortfall is handled as a financial exception and may be recovered from you.</li>
      </ul>

      <h2>5. Account closure</h2>
      <ul>
        <li>You can close your account in <Link href="/settings">Settings</Link>. Closure cancels all scheduled reminders and releases their reserved credits immediately.</li>
        <li>Unused credits at closure are not refunded except under section 4. The balance at closure is recorded and shown to you before you confirm. Export your data first if you need it.</li>
        <li>Ledger and payment records are retained as required by law (see the <Link href="/privacy">Privacy policy</Link>).</li>
      </ul>

      <h2>6. Acceptable use</h2>
      <p>Reminders go only to your own verified number. Do not use the service to send messages to others, to impersonate anyone, or to attempt to bypass limits or security. We may suspend accounts that do.</p>

      <h2>7. Connected AI assistants</h2>
      <p>Assistants you connect can prepare reminders but cannot save them without your explicit confirmation of the message text, channel, AD/BS date, schedule and cost. They cannot top up your wallet or message any other number. You are responsible for confirming details an assistant read from a document photo.</p>

      <h2>8. Liability</h2>
      <p>To the extent permitted by law, our total liability for any claim is limited to the credits you paid in the 3 months before the claim. We are not liable for fines, penalties or losses from a missed renewal.</p>

      <h2>9. Law and contact</h2>
      <p>These terms are governed by the laws of Nepal, including the Electronic Transactions Act, 2063. Questions and complaints:</p>
      <LegalContact />
    </article>
  );
}
