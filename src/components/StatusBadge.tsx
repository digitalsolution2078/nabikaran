const LABELS: Record<string, { text: string; cls: string }> = {
  planned: { text: "Planned (beyond 2-year horizon)", cls: "info" },
  awaiting_credits: { text: "Awaiting credits", cls: "warn" },
  scheduled: { text: "Scheduled", cls: "info" },
  sending: { text: "Sending", cls: "info" },
  submitted: { text: "Submitted to provider", cls: "ok" },
  delivered: { text: "Delivered", cls: "ok" },
  failed: { text: "Failed", cls: "bad" },
  unknown: { text: "Unknown — reconciling", cls: "warn" },
  cancelled: { text: "Cancelled", cls: "" },
  active: { text: "Active", cls: "ok" },
  paused: { text: "Paused", cls: "warn" },
  paid: { text: "Paid", cls: "ok" },
  pending: { text: "Pending", cls: "warn" },
  initiated: { text: "Initiated", cls: "" },
  expired: { text: "Expired", cls: "" },
  refunded: { text: "Refunded", cls: "bad" },
};

export function StatusBadge({ status }: { status: string }) {
  const l = LABELS[status] ?? { text: status, cls: "" };
  return <span className={`badge ${l.cls}`}>{l.text}</span>;
}
