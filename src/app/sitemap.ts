import type { MetadataRoute } from "next";
import { SEO_PAGES } from "@/lib/seo-pages";
import { env } from "@/lib/env";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.appUrl.replace(/\/$/, "");
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/renewal-reminder`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...SEO_PAGES.map((p) => ({ url: `${base}/renewal-reminder/${p.slug}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.7 })),
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
