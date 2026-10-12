/**
 * Only same-site paths are allowed as a post-sign-in destination ("next=").
 * Rejects "//host", "/\host" (browsers treat "\" like "/"), control characters
 * and anything that is not a plain path.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || next.length > 500) return null;
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*$/.test(next)) return null;
  if (next.startsWith("//") || next.startsWith("/%2f") || next.startsWith("/%2F") || next.startsWith("/%5c") || next.startsWith("/%5C")) return null;
  try {
    const u = new URL(next, "https://nabikaran.invalid");
    if (u.origin !== "https://nabikaran.invalid") return null;
  } catch {
    return null;
  }
  return next;
}
