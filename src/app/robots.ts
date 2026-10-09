import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/dashboard", "/renewals", "/messages", "/wallet", "/settings", "/oauth", "/pay"] }],
    sitemap: `${env.appUrl.replace(/\/$/, "")}/sitemap.xml`,
  };
}
