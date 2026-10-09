import { env } from "@/lib/env";

/** Operator and grievance contact, from server configuration. */
export function LegalContact() {
  const l = env.legal;
  return (
    <p>
      {l.entityName ? <><strong>{l.entityName}</strong>{l.address ? `, ${l.address}` : ""}. </> : "The operator of nabikaran.org. "}
      {l.supportEmail && <>Email: <a href={`mailto:${l.supportEmail}`}>{l.supportEmail}</a>. </>}
      {l.supportPhone && <>Phone: {l.supportPhone}. </>}
      {!l.supportEmail && !l.supportPhone && <>Contact us through the support details published on nabikaran.org. </>}
    </p>
  );
}
