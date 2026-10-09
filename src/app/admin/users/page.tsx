import Link from "next/link";
import { searchUsers } from "@/lib/services/admin-console";
import { StatusBadge } from "@/components/StatusBadge";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const users = await searchUsers(q, 100);
  return (
    <div className="stack">
      <form className="card row" method="get" role="search">
        <label htmlFor="q" className="sr-only">Search users</label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Name, phone number or email" style={{ flex: 1, minWidth: 220 }} />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>User</th><th className="hide-mobile">Joined</th><th>Role</th><th className="num">Available</th><th className="num hide-mobile">Reserved</th><th className="num hide-mobile">Active reminders</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><Link href={`/admin/users/${u.id}`}><strong>{u.name ?? formatPhoneLocal(u.phone)}</strong></Link><br /><span className="small muted">{u.phone}{u.email ? ` · ${u.email}` : ""}</span>{u.status !== "active" && <> <StatusBadge status={u.status} /></>}</td>
                <td className="hide-mobile nowrap">{u.createdAt.slice(0, 10)}</td>
                <td><StatusBadge status={u.role} /></td>
                <td className="num">{u.available}</td>
                <td className="num hide-mobile">{u.reserved}</td>
                <td className="num hide-mobile">{u.activeReminders}</td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} className="muted">No users match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
