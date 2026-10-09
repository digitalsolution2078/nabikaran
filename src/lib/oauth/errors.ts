/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error response. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "access_denied"
  | "invalid_target"
  | "server_error";

export class OAuthError extends Error {
  constructor(public readonly error: OAuthErrorCode, public readonly description: string, public readonly status = 400) {
    super(description);
    this.name = "OAuthError";
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}
