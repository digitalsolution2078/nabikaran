import { listDocTemplates } from "@/lib/services/admin-console";
import { DocTemplateEditor } from "@/components/admin/DocTemplateEditor";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

export default async function AdminTemplates() {
  const [templates, me] = await Promise.all([listDocTemplates(true), getCurrentUser()]);
  return (
    <div className="stack">
      <div className="alert info">
        <span>Templates pre-fill the reminder form (name, SMS label, suggested schedule). They must not state official validity periods or legal deadlines as fact — descriptions ask customers to enter the date on their own document and to confirm rules with the issuing office.</span>
      </div>
      <DocTemplateEditor templates={templates} canEdit={can(me?.role, "templates.manage")} />
    </div>
  );
}
