export default function Privacy() {
  return (
    <div>
      <h1>Privacy</h1>
      <div className="card">
        <p><strong>Draft — requires legal review before public launch.</strong></p>
        <ul>
          <li>We store your verified mobile number, the renewal records you enter (category, label, expiry date, optional notes), reminder schedules, wallet ledger and payment order references.</li>
          <li>Reminder SMS are sent only to your own verified number via our SMS provider. We never send user-written messages or messages to third parties.</li>
          <li>We do not access any government or insurer database. Expiry dates are what you enter.</li>
          <li>Phone numbers are redacted in operational logs. Operational data is retained minimally; ledger and payment records are retained as required for accounting.</li>
          <li>You can export your data or close your account from Settings. Closure cancels scheduled reminders; unused prepaid credits are handled under the closure/refund policy in the Terms.</li>
        </ul>
      </div>
    </div>
  );
}
