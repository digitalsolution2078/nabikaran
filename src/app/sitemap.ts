import type { MetadataRoute } from "next";
import { listSeoPages } from "@/lib/services/seo";

export const dynamic = "force-dynamic";
import { env } from "@/lib/env";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = await listSeoPages();
  const base = env.appUrl.replace(/\/$/, "");
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/renewal-reminder`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...pages.map((p) => ({ url: `${base}/renewal-reminder/${p.slug}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.7 })),
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
