import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { OtpForm } from "@/components/OtpForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && /^\/(?!\/)/.test(next) ? next : null;
  if (await getCurrentUser()) redirect(safeNext ?? "/dashboard");
  return (
    <div>
      <h1>Sign in with your Nepal mobile</h1>
      <OtpForm next={safeNext} />
      <p className="muted" style={{ fontSize: 13 }}>No password. Google sign-in can be linked later from Settings once your number is verified.</p>
    </div>
  );
}
