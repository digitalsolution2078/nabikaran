import Link from "next/link";
import { LogoutButton } from "./LogoutButton";
import { formatPhoneLocal } from "@/lib/phone";

export function Nav({ user }: { user: { role: string; phone: string } | null }) {
  return (
    <header className="nav">
      <div className="inner">
        <Link href="/" className="brand">नविकरण · Nabikaran</Link>
        <nav style={{ flex: 1 }}>
          {user ? (
            <>
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/renewals">Renewals</Link>
              <Link href="/wallet">Wallet</Link>
              <Link href="/settings">Settings</Link>
              {user.role === "admin" && <Link href="/admin">Admin</Link>}
            </>
          ) : (
            <Link href="/login">Sign in</Link>
          )}
        </nav>
        {user && (
          <span className="row" style={{ fontSize: 13 }}>
            <span className="muted">{formatPhoneLocal(user.phone)}</span>
            <LogoutButton />
          </span>
        )}
      </div>
    </header>
  );
}
