export default function Terms() {
  return (
    <div>
      <h1>Terms, refunds and account closure</h1>
      <div className="card">
        <p><strong>Draft — requires legal and financial review before credits are sold.</strong></p>
        <ul>
          <li>Nabikaran is a reminder service. It does not renew documents, provide legal advice, or guarantee that an SMS reaches your handset. Our service objective is submission to the SMS provider.</li>
          <li>1 wallet credit = NPR 1 of stored value. Credits are not necessarily 1 SMS: each SMS is charged per provider-billable segment at the rate shown at confirmation.</li>
          <li><strong>Purchased credits do not expire</strong> while your account remains active. There is no inactivity sweep or year-end forfeiture.</li>
          <li>Credits are reserved when you schedule and charged only when the provider accepts the SMS. Rejected messages are not charged. Accepted-but-undelivered messages are not automatically refunded unless the provider credits us.</li>
          <li>Credits cannot be transferred between accounts or withdrawn as cash in this version. On account closure, remaining prepaid credits are handled under the closure policy published here (to be finalised after legal review).</li>
          <li>Refunded or charged-back top-ups reverse the credits issued. Already-spent credits are handled as a financial exception, not silently deleted.</li>
          <li>Price changes apply only to new schedules; existing scheduled reminders keep the price shown when confirmed.</li>
        </ul>
      </div>
    </div>
  );
}
