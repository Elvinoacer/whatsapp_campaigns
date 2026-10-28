"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { SendingPolicy } from "@/lib/sending-policy";

type Safety = { policy: SendingPolicy; holds: { accountKey: string; reason: string; notBefore: string | null; canReview: boolean }[]; recoveries: { accountKey: string; until: string; reason: string; attempt: number }[];
  used: { last15Minutes: number; lastHour: number; lastDay: number }; nextSlot: string };
type Request = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;

export default function SendingSafety({ request, changed }: { request: Request; changed: () => Promise<void> }) {
  const [safety, setSafety] = useState<Safety | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => { setSafety(await request<Safety>("/api/v1/safety")); }, [request]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void request<Safety>("/api/v1/safety").then(data => { if (alive) setSafety(data); })
      .catch(error => { if (alive) setError(error instanceof Error ? error.message : "Could not load sending controls"); }); };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [request]);
  async function change(path: string, body: object) {
    setBusy(true); setError(""); setNotice("");
    try { await request(path, { method: "POST", body }); await Promise.all([load(), changed()]);
      setNotice(path.endsWith("review") ? "Hold reviewed. Resume campaigns individually when you are ready. Budgets and recipient cooldowns remain in force." : "Campaign sending is paused across this workspace.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update sending controls"); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-panel sending-safety"><h2><ShieldCheck size={19}/> Campaign sending controls</h2>
    <p>These controls limit workload and repeated contact. They do not guarantee protection from WhatsApp restrictions. This connection cannot read Meta quality scores, recipient blocks or spam reports.</p>
    {error && <p className="notice danger" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {safety ? <>
      <div className="recipient-breakdown"><span><strong>{safety.used.last15Minutes} / {safety.policy.maxPer15Minutes}</strong>attempts / 15 minutes</span><span><strong>{safety.used.lastHour} / {safety.policy.maxPerHour}</strong>attempts / hour</span><span><strong>{safety.used.lastDay} / {safety.policy.maxPerDay}</strong>attempts / rolling 24 hours</span></div>
      <p>Budgets are shared by every account and campaign. Failed and unconfirmed attempts also count. Sending happens between {String(safety.policy.startHour).padStart(2, "0")}:00 and {String(safety.policy.endHour).padStart(2, "0")}:00 ({safety.policy.timezone}), at least {safety.policy.minimumIntervalMs / 1000} seconds apart. Recipient cooldown: {safety.policy.contactCooldownMs / 3600000} hours across all campaigns.</p>
      <p>Large campaigns automatically wait and continue when sending windows close or budgets renew. Technical delivery problems trigger one automatic 15-minute recovery window; uncertain messages are never resent. Repeated failures, actual restrictions and elevated opt-outs still require review.</p>
      {safety.recoveries.map(recovery => <div className="sending-hold" key={recovery.accountKey} role="status">
        <h3>Automatic recovery · {recovery.accountKey.replace(/^(phone|session):/, "")}</h3>
        <p>{recovery.reason} Campaigns remain queued and automatically continue after {new Date(recovery.until).toLocaleString("en-KE", { timeZone: safety.policy.timezone })}, if the account is connected and no other hold applies.</p>
        <p>No action required. Previous unconfirmed attempts will not be sent again. Repeated new failures will stop the campaign for review.</p>
      </div>)}
      <button className="btn outline" disabled={busy || safety.holds.some(hold => hold.accountKey === "workspace")} onClick={() => void change("/api/v1/safety/hold", { reason: "Workspace administrator paused campaign sending for review." })}>Pause all campaign sending</button>
      {safety.holds.map(hold => <div className="sending-hold" key={hold.accountKey}>
        <h3>{hold.accountKey === "workspace" ? "Workspace sending hold" : "Account sending hold: " + hold.accountKey.replace(/^(phone|session):/, "")}</h3><p>{hold.reason}</p>
        {hold.notBefore && <p>Earliest local review: {new Date(hold.notBefore).toLocaleString("en-KE", { timeZone: safety.policy.timezone })}. WhatsApp&apos;s restriction must also have ended.</p>}
        <label>Review notes<textarea aria-label={"Sending review notes for " + hold.accountKey} rows={2} maxLength={500} value={notes[hold.accountKey] || ""} onChange={event => setNotes(previous => ({ ...previous, [hold.accountKey]: event.target.value }))} placeholder="What did you verify or correct in the account, permissions, audience and message?"/></label>
        <label className="check-item"><input type="checkbox" checked={!!confirmed[hold.accountKey]} onChange={event => setConfirmed(previous => ({ ...previous, [hold.accountKey]: event.target.checked }))}/><span>I checked WhatsApp for restrictions and reviewed consent, relevance and sending frequency.</span></label>
        <button className="btn primary" disabled={busy || !confirmed[hold.accountKey] || (notes[hold.accountKey]?.trim().length || 0) < 10 || !hold.canReview}
          onClick={() => void change("/api/v1/safety/review", { accountKey: hold.accountKey, confirmed: true, note: notes[hold.accountKey] })}>Complete review</button>
      </div>)}
    </> : <p>Loading sending controls…</p>}
    <p>For ongoing bulk campaigns, move to the official WhatsApp Business Platform and its approved templates and account limits. <a href="https://business.whatsapp.com/policy" target="_blank" rel="noreferrer">Read WhatsApp&apos;s business policy</a>.</p>
  </section>;
}
