"use client";
import { useState } from "react";
import { api } from "../api";

/** Admin: sign a customer out of every phone and browser (e.g. a stolen phone). */
export function AdminLogoutAll({ userId }: { userId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  async function go() {
    if (!confirm("Sign this customer out of every phone and browser? They can sign in again with their number.")) return;
    try {
      await api(`/api/admin/users/${userId}`, { method: "POST", json: { action: "logout_all", confirm: true } });
      setMsg("Signed out everywhere.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="row mt">
      <button type="button" className="btn btn-secondary btn-sm" onClick={go}>Log out all devices</button>
      {msg && <span className="small" role="status">{msg}</span>}
    </div>
  );
}
