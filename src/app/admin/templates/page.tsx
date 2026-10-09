import { listDocTemplates } from "@/lib/services/admin-console";
import { DocTemplateEditor } from "@/components/admin/DocTemplateEditor";

export const dynamic = "force-dynamic";

export default async function AdminTemplates() {
  const templates = await listDocTemplates(true);
  return (
    <div className="stack">
      <div className="alert info">
        <span>Templates pre-fill the reminder form (name, SMS label, suggested schedule). They must not state official validity periods or legal deadlines as fact — descriptions ask customers to enter the date on their own document and to confirm rules with the issuing office.</span>
      </div>
      <DocTemplateEditor templates={templates} />
    </div>
  );
}
