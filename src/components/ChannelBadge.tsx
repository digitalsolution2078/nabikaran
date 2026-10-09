/** Small, colour-coded channel marker. Server- and client-safe. */
export function ChannelBadge({ channel }: { channel: "sms" | "whatsapp" | string }) {
  const wa = channel === "whatsapp";
  return <span className={`ch-badge ${wa ? "ch-wa" : "ch-sms"}`}>{wa ? "WhatsApp" : "SMS"}</span>;
}

export function ChannelBadges({ channels }: { channels: string[] }) {
  return (
    <span className="ch-badges">
      {channels.map((c) => <ChannelBadge key={c} channel={c} />)}
    </span>
  );
}
