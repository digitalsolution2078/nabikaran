import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { env } from "@/lib/env";
import { integrationStatus } from "@/lib/services/integrations";
import { IntegrationsAdmin } from "@/components/admin/IntegrationsAdmin";

export const dynamic = "force-dynamic";

export default async function AdminIntegrations() {
  const me = await getCurrentUser();
  if (!can(me?.role, "settings.manage")) redirect("/admin");
  const st = await integrationStatus();
  return <IntegrationsAdmin initial={st} isProd={env.isProd} webhookUrl={`${env.appUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`} khaltiReturnUrl={`${env.appUrl.replace(/\/$/, "")}/wallet`} />;
}
