import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { OtpForm } from "@/components/OtpForm";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div>
      <h1>Sign in with your Nepal mobile</h1>
      <OtpForm />
      <p className="muted" style={{ fontSize: 13 }}>No password. Google sign-in can be linked later from Settings once your number is verified.</p>
    </div>
  );
}
