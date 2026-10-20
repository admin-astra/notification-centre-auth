"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// Teams. Every extension user belongs to one; every dashboard login belongs to one.
type Org = "astra" | "clear_nexus" | "credit_deployment";
const ORGS: Org[] = ["astra", "clear_nexus", "credit_deployment"];
const ORG_LABEL: Record<Org, string> = {
  astra: "Astra",
  clear_nexus: "Clear Nexus",
  credit_deployment: "Credit Deployment"
};
const ORG_BADGE: Record<Org, string> = {
  astra: "bg-neutral-400/10 text-neutral-200 border-neutral-500/40",
  clear_nexus: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  credit_deployment: "bg-amber-500/15 text-amber-300 border-amber-500/30"
};

// What the signed-in dashboard login is allowed to do (public.dashboard_me()).
type Me = {
  email: string;
  org: Org;
  can_view_all: boolean;   // sees every team's users
  can_manage_org: boolean; // issues OTPs / signs out anyone in its own team
  view_orgs: Org[];        // extra teams it can see (read-only), on top of its own
  display_name: string | null;
};

// One row per extension user this login may see (public.dashboard_roster()).
// The database decides both lists, so the scoping holds even outside this page.
type RosterRow = {
  email: string;
  display_name: string | null;
  org: Org;
  role: "agent" | "supervisor";
  is_active: boolean;
  last_ping: string | null;
  has_session: boolean;
  can_manage: boolean;
};

const ONLINE_MS = 12 * 60 * 1000; // 12 minutes

// Derive a human name from an email like "abhinandan.srivastava@astraglobal.com"
function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] || "").replace(/[_\-]/g, ".");
  return local
    .split(".")
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// ── Login Screen ──────────────────────────────────────────────────────────────

function LoginScreen() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) setError(err.message);
  }

  const inputCls =
    "w-full bg-neutral-950 border border-neutral-800 text-white rounded-lg px-3 py-2.5 text-sm " +
    "placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 transition-colors";

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
          {/* Co-branding: built by Astra Global for Credit Deployment. Both logos
              have dark lettering, so they sit on a light strip. */}
          <div className="bg-white px-6 py-5 flex items-center justify-center gap-5">
            <img src="/brand/astra-logo.png" alt="Astra Global" className="h-14 w-auto" />
            <span className="h-10 w-px bg-neutral-200" aria-hidden="true" />
            <img src="/brand/cds-logo.png" alt="Credit Deployment" className="h-14 w-auto" />
          </div>

          <form onSubmit={handleSubmit} className="p-7 space-y-4">
            <div className="pb-1">
              <div className="text-[11px] font-semibold tracking-[0.2em] text-neutral-500 uppercase mb-1.5">CDS Notification Centre</div>
              <h1 className="text-white text-xl font-semibold tracking-tight">Supervisor sign-in</h1>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">Email</label>
              <input
                className={inputCls} placeholder="you@company.com"
                type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">Password</label>
              <input
                className={inputCls}
                type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required
              />
            </div>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              className="w-full bg-white hover:bg-neutral-200 disabled:bg-neutral-800 disabled:text-neutral-500 text-neutral-950 font-semibold py-2.5 rounded-lg text-sm transition-colors"
              disabled={loading}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-neutral-600">Developed by Astra Global for Credit Deployment</p>
      </div>
    </div>
  );
}

// ── Signed in, but not set up for this dashboard ──────────────────────────────

function NotSetUp({ email }: { email: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950">
      <div className="bg-neutral-900 border border-neutral-800 p-7 rounded-2xl shadow-xl w-96 space-y-4 text-center">
        <h1 className="text-white text-lg font-bold">No dashboard access</h1>
        <p className="text-sm text-neutral-400">
          <span className="font-mono text-neutral-300">{email}</span> isn&apos;t assigned to a team on this dashboard.
          Ask an administrator to add it.
        </p>
        <button
          className="text-sm text-neutral-300 hover:text-white border border-neutral-700 px-3 py-1.5 rounded-lg hover:bg-neutral-800 transition-colors"
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ me }: { me: Me }) {
  const [users, setUsers]         = useState<RosterRow[]>([]);
  const [busy, setBusy]           = useState(false);
  const [pickEmail, setPickEmail] = useState("");
  const [teamFilter, setTeamFilter] = useState<Org | "all">("all");
  const [generated, setGenerated] = useState<{ email: string; otp: string; expires: string } | null>(null);

  // An explicit display_name (set in Supabase) wins over the email-derived one —
  // for shortened addresses like "tanvi.c@" that would otherwise show as "Tanvi C".
  const nameOf = (email: string) =>
    users.find(u => u.email.toLowerCase() === email.toLowerCase())?.display_name || nameFromEmail(email);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("dashboard_roster");
    if (error) { console.error("Roster load failed:", error.message); return; }
    // Team order, then supervisors, then real users alphabetically, test accounts last.
    const isTest = (email: string) => /^test\d*@/i.test(email);
    const sorted = ((data ?? []) as RosterRow[]).slice().sort((a, b) => {
      if (a.org !== b.org) return ORGS.indexOf(a.org) - ORGS.indexOf(b.org);
      if (a.role !== b.role) return a.role === "supervisor" ? -1 : 1;
      const ta = isTest(a.email), tb = isTest(b.email);
      if (ta !== tb) return ta ? 1 : -1;
      return a.email.localeCompare(b.email);
    });
    setUsers(sorted);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  function isOnline(u: RosterRow) {
    return u.last_ping ? (Date.now() - new Date(u.last_ping).getTime()) < ONLINE_MS : false;
  }

  // Who this login can issue OTPs for. A Credit Deployment login only gets itself.
  const issuable = users.filter(u => u.can_manage && u.is_active);
  const selfOnly = !me.can_manage_org;

  // A self-only login has exactly one choice — pick it for them.
  useEffect(() => {
    if (selfOnly && issuable.length === 1 && !pickEmail) setPickEmail(issuable[0].email);
  }, [selfOnly, issuable, pickEmail]);

  async function generateOtp() {
    if (!pickEmail) return;
    setBusy(true); setGenerated(null);
    const { data, error } = await supabase.rpc("generate_otp", { p_email: pickEmail });
    setBusy(false);
    if (error) { alert(error.message); return; }
    if (!data?.ok) { alert(data?.error || "Could not generate OTP."); return; }
    setGenerated({ email: data.email, otp: data.otp, expires: data.expires_at });
    load();
  }

  async function resetAll() {
    const team = ORG_LABEL[me.org];
    if (!confirm(`Invalidate ALL active ${team} OTPs and sessions? ${team} staff will be locked out immediately.`)) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("reset_all_sessions");
    setBusy(false);
    if (error) { alert("Reset failed: " + error.message); return; }
    const count = typeof data === "number" ? data : 0;
    alert(count > 0
      ? `✅ Reset complete — ${count} ${team} session(s)/OTP(s) wiped. ${team} staff are now logged out.`
      : `✅ Reset complete — no active ${team} sessions or OTPs to remove.`
    );
    setGenerated(null);
    load();
  }

  async function resetUser(email: string) {
    if (!confirm(`Sign ${nameOf(email)} out of the extension and revoke any unused OTP?`)) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("reset_user_session", { p_email: email });
    setBusy(false);
    if (error) { alert("Logout failed: " + error.message); return; }
    const count = typeof data === "number" ? data : 0;
    alert(count > 0
      ? `✅ ${nameOf(email)} signed out — ${count} row(s) cleared.`
      : `✅ ${nameOf(email)} had no active session or OTP to clear.`
    );
    load();
  }

  // Teams this login can see; more than one gets the team filter and Team column.
  const visibleOrgs = me.can_view_all
    ? ORGS
    : ORGS.filter(o => o === me.org || (me.view_orgs ?? []).includes(o));
  const multiTeam   = visibleOrgs.length > 1;
  const shown       = multiTeam && teamFilter !== "all" ? users.filter(u => u.org === teamFilter) : users;
  const onlineCount = shown.filter(isOnline).length;
  const scopeLabel  = me.can_view_all ? "All Teams" : visibleOrgs.map(o => ORG_LABEL[o]).join(" & ");
  const myName      = me.display_name || nameFromEmail(me.email);
  const showTeamCol = multiTeam;
  const myRole      = [
    ORG_LABEL[me.org],
    me.can_view_all ? "All teams" : multiTeam ? "Multi-team view" : null,
    me.can_manage_org ? "Supervisor" : "Own OTP only"
  ].filter(Boolean).join(" · ");

  return (
    <div className="min-h-screen bg-neutral-950 p-6">
      <div className="max-w-6xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">{scopeLabel} — Access Control</h1>
            <p className="text-sm text-neutral-400 mt-0.5">
              <span className="text-emerald-400 font-semibold">{onlineCount}</span> of {shown.length} users online
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-sm text-white font-medium">{myName}</div>
              <div className="text-xs text-neutral-500">{myRole}</div>
            </div>
            <button
              className="text-sm text-neutral-400 hover:text-white border border-neutral-700 px-3 py-1.5 rounded-lg hover:bg-neutral-800 transition-colors"
              onClick={() => supabase.auth.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Team filter — only for logins that see more than one team */}
        {multiTeam && (
          <div className="flex flex-wrap gap-2">
            {(["all", ...visibleOrgs] as const).map(key => {
              const inTeam = key === "all" ? users : users.filter(u => u.org === key);
              const active = teamFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => setTeamFilter(key)}
                  className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${active
                    ? "bg-neutral-800 border-neutral-600 text-white"
                    : "border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-900"}`}
                >
                  {key === "all" ? "All teams" : ORG_LABEL[key]}
                  <span className="ml-2 text-xs text-neutral-500">
                    <span className="text-emerald-400">{inTeam.filter(isOnline).length}</span>/{inTeam.length}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Action bar */}
        <div className="bg-neutral-900 rounded-xl border border-neutral-800 shadow-sm p-4 flex flex-wrap gap-3 items-center">
          {selfOnly ? (
            <div className="text-sm text-neutral-300 min-w-64">
              {issuable.length
                ? <>Your extension OTP: <span className="font-mono text-neutral-400">{issuable[0].email}</span></>
                : <span className="text-neutral-500">Your account has no extension access.</span>}
            </div>
          ) : (
            <select
              className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 min-w-64"
              value={pickEmail}
              onChange={e => { setPickEmail(e.target.value); setGenerated(null); }}
            >
              <option value="">— select employee —</option>
              {issuable.map(u => (
                <option key={u.email} value={u.email}>
                  {nameOf(u.email)} ({u.email})
                </option>
              ))}
            </select>
          )}

          <button
            disabled={!pickEmail || busy}
            onClick={generateOtp}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            {selfOnly ? "Generate My OTP" : "Generate Daily OTP"}
          </button>

          {me.can_manage_org && (
            <button
              disabled={busy}
              onClick={resetAll}
              className="ml-auto bg-red-600 hover:bg-red-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Reset All {ORG_LABEL[me.org]} Sessions
            </button>
          )}
        </div>

        {/* Generated OTP banner */}
        {generated && (
          <div className="bg-amber-950/40 border border-amber-700/60 rounded-xl p-4 flex items-start gap-4">
            <div className="flex-1">
              <div className="text-sm text-amber-200 font-medium mb-1">
                OTP for <span className="font-mono">{nameOf(generated.email)}</span>{" "}
                <span className="text-amber-400/70 font-mono">({generated.email})</span>
              </div>
              <div className="font-mono text-4xl tracking-[0.3em] text-amber-300 font-bold">
                {generated.otp}
              </div>
              <div className="text-xs text-amber-400/80 mt-1">
                Valid until {new Date(generated.expires).toLocaleString()} ·{" "}
                {selfOnly ? "Enter this in the extension to sign in" : "Share this directly with the employee"}
              </div>
            </div>
            <button
              className="text-amber-400 hover:text-amber-200 text-xs underline"
              onClick={() => setGenerated(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* User table */}
        <div className="bg-neutral-900 rounded-xl border border-neutral-800 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-800/70 border-b border-neutral-800 text-neutral-400 text-xs font-semibold uppercase tracking-wider">
                <th className="px-4 py-3 text-left w-12">Status</th>
                <th className="px-4 py-3 text-left">Name</th>
                {showTeamCol && <th className="px-4 py-3 text-left">Team</th>}
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Last ping</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {shown.map(u => {
                const lp     = u.last_ping ? new Date(u.last_ping) : null;
                const online = isOnline(u);
                return (
                  <tr key={u.email} className="hover:bg-neutral-800/40 transition-colors">
                    <td className="px-4 py-3">
                      <span
                        title={online ? "Online" : "Offline"}
                        className={`inline-block w-3 h-3 rounded-full ${online ? "bg-emerald-500 shadow-[0_0_8px_#10b981]" : "bg-neutral-600"}`}
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {nameOf(u.email)}
                      {u.role === "supervisor" && (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 border border-neutral-700 rounded px-1.5 py-0.5">
                          Supervisor
                        </span>
                      )}
                      {!u.is_active && (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-red-300 border border-red-800 rounded px-1.5 py-0.5">
                          Inactive
                        </span>
                      )}
                    </td>
                    {showTeamCol && (
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium border rounded-md px-2 py-0.5 ${ORG_BADGE[u.org]}`}>
                          {ORG_LABEL[u.org]}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-3 font-mono text-neutral-400 text-xs">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {lp ? lp.toLocaleString() : <span className="text-neutral-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {u.can_manage ? (
                        <button
                          onClick={() => resetUser(u.email)}
                          disabled={busy || !u.has_session}
                          title={u.has_session
                            ? `Sign ${nameOf(u.email)} out and revoke any unused OTP`
                            : "No active session or OTP to revoke"}
                          className="text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors
                            bg-red-600/15 border-red-700/40 text-red-300
                            hover:bg-red-600/30 hover:text-white hover:border-red-500
                            disabled:bg-neutral-800/40 disabled:border-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed"
                        >
                          Sign out
                        </button>
                      ) : (
                        <span className="text-xs text-neutral-600">View only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={showTeamCol ? 6 : 5} className="px-4 py-8 text-center text-neutral-500 text-sm">
                    No users to show.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function Page() {
  const [authEmail, setAuthEmail] = useState<string | null | undefined>(undefined); // undefined = loading
  const [me, setMe]               = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthEmail(data.session?.user.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setAuthEmail(s?.user.email ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Which team / permissions this login has. Re-read on every sign-in.
  useEffect(() => {
    if (!authEmail) { setMe(authEmail === null ? null : undefined); return; }
    setMe(undefined);
    supabase.rpc("dashboard_me").then(({ data, error }) => {
      if (error) console.error("dashboard_me failed:", error.message);
      setMe((data as Me | null) ?? null);
    });
  }, [authEmail]);

  if (authEmail === undefined || (authEmail && me === undefined)) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading…</div>
      </div>
    );
  }
  if (!authEmail) return <LoginScreen />;
  if (!me) return <NotSetUp email={authEmail} />;
  return <Dashboard key={me.email} me={me} />;
}
