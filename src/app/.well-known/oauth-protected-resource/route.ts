import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";
import { corsPreflight, withCors } from "@/lib/http";

/** RFC 9728. Served on the MCP host (mcp.nabikaran.org) and, harmlessly, on the web host. */
export async function GET() {
  return withCors(NextResponse.json(protectedResourceMetadata()));
}

export async function OPTIONS() {
  return corsPreflight();
}
