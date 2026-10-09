import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/oauth/metadata";
import { corsPreflight, withCors } from "@/lib/http";

export async function GET() {
  return withCors(NextResponse.json(authorizationServerMetadata()));
}

export async function OPTIONS() {
  return corsPreflight();
}
