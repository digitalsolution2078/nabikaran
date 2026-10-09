import { createHash, randomBytes } from "node:crypto";

/** Base64url without padding (RFC 7636 §4). */
export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function sha256b64url(input: string): string {
  return b64url(createHash("sha256").update(input).digest());
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 256-bit random, base64url: used for codes, tokens and client ids. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(v: string): boolean {
  return VERIFIER_RE.test(v);
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const expected = sha256b64url(codeVerifier);
  if (expected.length !== codeChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  return diff === 0;
}

/** Test/client helper. */
export function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: sha256b64url(verifier) };
}
