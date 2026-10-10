import { listSeoPages } from "@/lib/services/seo";
import { listDocTemplates } from "@/lib/services/admin-console";
import { SeoEditor } from "@/components/admin/SeoEditor";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

export default async function AdminSeo() {
  const [pages, templates, me] = await Promise.all([listSeoPages({ includeHidden: true }), listDocTemplates(true), getCurrentUser()]);
  return (
    <div className="stack">
      <div className="alert info">
        <span>Landing pages that bring customers from Google (for example “bluebook renewal reminder Nepal”). Edit the built-in pages, hide them, or add new ones; changes are live immediately and appear in the sitemap. “Reset” returns a built-in page to its original text.</span>
      </div>
      <SeoEditor pages={pages} templates={templates.map((t) => ({ slug: t.slug, name_en: t.name_en }))} canEdit={can(me?.role, "templates.manage")} />
    </div>
  );
}
