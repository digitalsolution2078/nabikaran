import { handleMcpRequest } from "@/lib/mcp/handler";

/**
 * Remote MCP endpoint (Streamable HTTP). Reached as https://mcp.nabikaran.org/mcp
 * (and / on that host via the rewrite in next.config.ts). Bearer tokens come from
 * the OAuth 2.1 server in this same app; see /.well-known/oauth-protected-resource.
 */
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleMcpRequest(req);
}
export async function GET(req: Request) {
  return handleMcpRequest(req);
}
export async function DELETE(req: Request) {
  return handleMcpRequest(req);
}
export async function OPTIONS(req: Request) {
  return handleMcpRequest(req);
}
