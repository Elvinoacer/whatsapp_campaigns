"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, Clock3, MessageCircle, Search, Send, Users, UserMinus, CircleAlert } from "lucide-react";
import { deliveryFeedback, deliveryTotals, type DeliveryTotals } from "@/lib/reporting";
import "./campaign-results.css";

type Reply = { id: string; body: string; receivedAt: string; attribution: string; author?: string | null; isOptOut: boolean };
type Delivery = { id: string; recipient: string; recipientKey: string; status: string; sentAt?: string | null; error: string | null; _count?: { replies: number }; replies: Reply[] };
export type ResultRun = { id: string; startedAt: string; status: string; error?: string | null; nextAttemptAt?: string | null; messageSnapshot?: string | null; mediaNameSnapshot?: string | null; audienceCount: number; deliveries: Delivery[] };
const date = (value: string) => new Date(value).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
const n = (value: number) => value.toLocaleString();

export function DeliveryStats({ totals, compact = false }: { totals: DeliveryTotals; compact?: boolean }) {
  const metrics = [
    { key: "sent", label: "Sent", value: totals.sent, hint: "Confirmed outgoing messages", icon: Send },
    { key: "delivered", label: "Received", value: totals.delivered, hint: "Received on their device", icon: CheckCheck },
    { key: "read", label: "Read", value: totals.read, hint: "Read receipt received", icon: Check },
    { key: "replied", label: "Replied", value: totals.replied, hint: "Sends with at least one reply", icon: Users },
    { key: "replies", label: "Replies received", value: totals.replies, hint: "Incoming reply messages", icon: MessageCircle },
    { key: "optedOut", label: "Opted out", value: totals.optedOut ?? 0, hint: "Sends followed by an opt-out reply", icon: UserMinus },
    { key: "failed", label: "Failed", value: totals.failed, hint: "Confirmed sending failures", icon: CircleAlert },
    { key: "pending", label: "Pending", value: totals.pending, hint: "Queued or currently sending", icon: Clock3 },
  ];
  return <div className={`delivery-stats ${compact ? "compact" : ""}`} aria-label="Delivery statistics">{metrics.map(metric => <div className={`delivery-stat stat-${metric.key}`} key={metric.key} title={metric.hint}><span><metric.icon size={14}/>{metric.label}</span><strong>{n(metric.value)}</strong>{!compact && <small>{metric.hint}</small>}</div>)}</div>;
}

function DeliveryStatus({ status }: { status: string }) {
  const label = status === "UNKNOWN" ? "Unconfirmed" : status === "SKIPPED" ? "Not sent" : status.replaceAll("_", " ").toLowerCase();
  return <span className={`flag flag-${status.toLowerCase()}`}><span className="flag-dot"/>{label}</span>;
}

function RecipientResults({ run, confirmSent }: { run: ResultRun; confirmSent: (deliveryId: string, note: string) => Promise<void> }) {
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const totals = useMemo(() => deliveryTotals(run.deliveries), [run.deliveries]);
  const matches = useMemo(() => run.deliveries.filter(delivery => {
    if (search && !`${delivery.recipient} ${delivery.recipientKey}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "OPTED_OUT") return delivery.replies.some(reply => reply.isOptOut);
    if (filter === "REPLIED") return (delivery._count?.replies ?? delivery.replies.length) > 0;
    if (filter === "SENT") return ["SENT", "DELIVERED", "READ"].includes(delivery.status);
    if (filter === "DELIVERED") return ["DELIVERED", "READ"].includes(delivery.status);
    if (filter === "PENDING") return ["QUEUED", "SENDING"].includes(delivery.status);
    return filter === "ALL" || delivery.status === filter;
  }), [run.deliveries, search, filter]);
  const pages = Math.max(1, Math.ceil(matches.length / 25));
  const currentPage = Math.min(page, pages);
  const tabs = [{ key: "ALL", label: "All", count: totals.total }, { key: "SENT", label: "Sent", count: totals.sent }, { key: "DELIVERED", label: "Received", count: totals.delivered }, { key: "READ", label: "Read", count: totals.read }, { key: "REPLIED", label: "Replied", count: totals.replied }, { key: "OPTED_OUT", label: "Opted out", count: totals.optedOut }, { key: "PENDING", label: "Pending", count: totals.pending }, { key: "UNKNOWN", label: "Unconfirmed", count: totals.uncertain }, { key: "FAILED", label: "Failed", count: totals.failed }, { key: "SKIPPED", label: "Not sent", count: totals.skipped }];
  return <>
    <div className="result-filters" role="group" aria-label="Filter recipients by result">{tabs.map(tab => <button key={tab.key} className={filter === tab.key ? "selected" : ""} aria-pressed={filter === tab.key} onClick={() => { setFilter(tab.key); setPage(1); }}>{tab.label}<span>{n(tab.count)}</span></button>)}</div>
    <label className="search-box result-search"><Search size={16}/><input aria-label="Search delivery recipients" placeholder="Search by name, phone or WhatsApp ID" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
    <div className="recipient-results">{matches.slice((currentPage - 1) * 25, currentPage * 25).map(delivery => <article className="recipient-result" key={delivery.id}>
      <div className="recipient-result-head"><div><strong>{delivery.recipient}</strong><small>{delivery.recipientKey.replace(/^(contact|group):/, "")}{delivery.sentAt ? ` · Sent ${date(delivery.sentAt)}` : ""}</small></div><DeliveryStatus status={delivery.status}/></div>
      {deliveryFeedback(delivery) && <p className={delivery.status === "FAILED" ? "tiny-error" : "result-note"}>{deliveryFeedback(delivery)}</p>}
      {delivery.status === "UNKNOWN" && <>
        {confirmId === delivery.id ? <div className="receipt-confirmation"><strong>Confirm this message was sent</strong><p>Check this recipient’s conversation in WhatsApp. This records a sent message only; delivered and read still require receipts. No message will be resent.</p><label>What did you verify?<textarea rows={2} maxLength={500} value={note} placeholder="e.g. I checked the outgoing campaign message in this conversation." onChange={event => setNote(event.target.value)}/></label>{error && <p className="tiny-error" role="alert">{error}</p>}<div className="head-actions"><button className="btn outline" disabled={busy} onClick={() => setConfirmId(null)}>Cancel</button><button className="btn primary" disabled={busy || note.trim().length < 10} onClick={async () => { setBusy(true); setError(""); try { await confirmSent(delivery.id, note.trim()); setConfirmId(null); setNote(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not confirm this send"); } finally { setBusy(false); } }}>{busy ? "Saving…" : "I verified it was sent"}</button></div></div> : <button className="text-button" onClick={() => { setConfirmId(delivery.id); setNote(""); setError(""); }}>Confirm sent in WhatsApp</button>}
      </>}
      {delivery.replies.length > 0 && <details className="recipient-replies"><summary>{n(delivery.replies.length)} repl{delivery.replies.length === 1 ? "y" : "ies"} received</summary>{delivery.replies.map(reply => <div className={`reply-bubble ${reply.isOptOut ? "reply-opt-out" : ""}`} key={reply.id}><p>{reply.body}</p>{reply.author && <small>From: {reply.author.split("@")[0]}</small>}<small>{date(reply.receivedAt)} · {reply.attribution === "QUOTED" ? "Quoted this message" : "Attributed to latest campaign send"}{reply.isOptOut ? " · Opted out" : ""}</small></div>)}</details>}
    </article>)}</div>
    {!matches.length && <p className="result-empty">No recipients match this filter.</p>}
    <div className="table-footer"><span>{n(matches.length)} matching recipients · {n(Math.min((currentPage - 1) * 25 + 1, matches.length))}–{n(Math.min(currentPage * 25, matches.length))} shown</span><div className="pager"><button aria-label="Previous delivery recipients" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={15}/></button><span>{currentPage} / {pages}</span><button aria-label="Next delivery recipients" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}><ArrowRight size={15}/></button></div></div>
  </>;
}

export default function CampaignResults({ runs, totalRuns, confirmSent }: { runs: ResultRun[]; totalRuns: number; confirmSent: (deliveryId: string, note: string) => Promise<void> }) {
  const [selected, setSelected] = useState(runs[0]?.id ?? "");
  const run = runs.find(item => item.id === selected) ?? runs[0];
  if (!run) return <p className="result-empty">No runs yet. Launch this campaign after reviewing its audience.</p>;
  const totals = deliveryTotals(run.deliveries);
  return <section className="campaign-results">
    <div className="result-run-heading"><div><h3>Run results & replies</h3><p>Each recipient’s progress in this run</p></div><label>Campaign run<select aria-label="Select campaign run" value={run.id} onChange={event => setSelected(event.target.value)}>{runs.map((item, i) => <option value={item.id} key={item.id}>{date(item.startedAt)}{i === 0 && runs.length > 1 ? " · Latest" : ""}</option>)}</select></label></div>
    {totalRuns > runs.length && <p className="muted-footnote">Showing {runs.length} of {totalRuns} runs. Open Delivery reports for other recent runs.</p>}
    <div className="run-state"><DeliveryStatus status={run.status}/><span>{n(run.audienceCount || totals.total)} planned · {n(totals.skipped)} not sent · {n(totals.failed)} failed · {n(totals.uncertain)} unconfirmed</span></div>
    {run.error && <p className="result-note">{run.error}</p>}
    {run.nextAttemptAt && <p className="result-note">Continues at {date(run.nextAttemptAt)}</p>}
    <DeliveryStats totals={totals} compact/>
    {totals.uncertain > 0 && <div className="result-advisory"><strong>{n(totals.uncertain)} sends need confirmation</strong><p>WhatsApp has not confirmed these results. They are kept separate from sent messages and excluded from automatic retries to avoid duplicates. Check the conversation before confirming a send.</p></div>}
    {run.messageSnapshot && <details className="run-message"><summary>Message used in this run</summary><p className="message-preview">{run.messageSnapshot}</p>{run.mediaNameSnapshot && <small>Attachment: {run.mediaNameSnapshot}</small>}</details>}
    <RecipientResults key={run.id} run={run} confirmSent={confirmSent}/>
  </section>;
}
