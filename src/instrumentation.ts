/**
 * Runs once when the Node server starts. Applies missing additive schema steps
 * (e.g. migration 0007) so a deploy that only rebuilds the web container still
 * gets the tables the new code needs. Never blocks start-up on failure.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SCHEMA_AUTO_ENSURE === "off" || !process.env.DATABASE_URL) return;
  try {
    const { ensureSchema } = await import("./lib/schema-ensure");
    const r = await ensureSchema();
    if (r.applied.length) console.log(`[schema] applied: ${r.applied.join(", ")}`);
  } catch (e) {
    console.error("[schema] ensure failed:", (e as Error).message);
  }
}
