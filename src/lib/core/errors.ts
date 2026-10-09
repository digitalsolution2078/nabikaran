/**
 * Transport-agnostic error type. The web layer maps `status` to HTTP; the MCP
 * layer (Phase 2+) maps `code` to a tool error. Core code never imports from
 * next/* so the same functions serve both transports.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
  }
}

export class ScopeError extends HttpError {
  constructor(public readonly scope: string) {
    super(403, `Missing scope ${scope}`, "insufficient_scope");
    this.name = "ScopeError";
  }
}

export class RateLimitError extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, "Too many requests", "rate_limited");
    this.name = "RateLimitError";
  }
}
