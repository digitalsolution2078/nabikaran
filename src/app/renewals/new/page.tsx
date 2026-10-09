import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { RenewalForm } from "@/components/RenewalForm";

export default async function NewRenewal() {
  if (!(await getCurrentUser())) redirect("/login");
  return (
    <div>
      <h1>Add renewal</h1>
      <RenewalForm />
    </div>
  );
}
