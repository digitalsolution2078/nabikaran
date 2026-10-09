import { env } from "../env";
import { SCOPES } from "../core/principal";

/** RFC 8414 authorization server metadata (served at /.well-known/oauth-authorization-server). */
export function authorizationServerMetadata() {
  const issuer = env.oauthIssuer.replace(/\/$/, "");
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: `${issuer}/docs/mcp`,
    ui_locales_supported: ["ne-NP", "en-NP"],
  };
}

/** RFC 9728 protected resource metadata (served at /.well-known/oauth-protected-resource on the MCP host). */
export function protectedResourceMetadata() {
  return {
    resource: env.mcpResource,
    authorization_servers: [env.oauthIssuer.replace(/\/$/, "")],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Nabikaran",
    resource_documentation: `${env.oauthIssuer.replace(/\/$/, "")}/docs/mcp`,
  };
}

/** Value for WWW-Authenticate on 401 from the MCP endpoint. */
export function wwwAuthenticate(reason?: string): string {
  const metadataUrl = `${new URL(env.mcpResource).origin}/.well-known/oauth-protected-resource`;
  const parts = [`Bearer resource_metadata="${metadataUrl}"`];
  if (reason) parts.push(`error="invalid_token"`, `error_description="${reason}"`);
  return parts.join(", ");
}
