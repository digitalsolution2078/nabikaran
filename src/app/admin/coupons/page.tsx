import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { giftCardStats, listCouponBatches } from "@/lib/services/credit-codes";
import { getSetting } from "@/lib/services/settings";
import { CouponsAdmin } from "@/components/admin/CouponsAdmin";

export const dynamic = "force-dynamic";

export default async function CouponsPage() {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "coupons.manage")) redirect("/admin");
  const [batches, gifts, codes] = await Promise.all([listCouponBatches(), giftCardStats(), getSetting("codes")]);
  return <CouponsAdmin batches={batches} gifts={gifts} settings={codes} canSettings={can(user.role, "settings.manage")} />;
}
