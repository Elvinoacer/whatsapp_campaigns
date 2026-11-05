"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleAlert, Clock3, Eye, FastForward, Search, Send, UserMinus, Users } from "lucide-react";
import { deliveryFeedback, deliveryRates, deliveryTotals, isLifecycleSkip, type DeliveryTotals } from "@/lib/reporting";
import "./campaign-results.css";

type Reply = { id: string; body: string; receivedAt: string; attribution: string; author?: string | null; isOptOut: boolean };
type Delivery = { id: string; recipient: string; recipientKey: string; status: string; sentAt?: string | null; deliveredAt?: string | null; readAt?: string | null; optedOutAt?: string | null; error: string | null; _count?: { replies: number }; replies: Reply[] };
export type ResultRun = { id: string; startedAt: string; status: string; error?: string | null; nextAttemptAt?: string | null; messageSnapshot?: string | null; mediaNameSnapshot?: string | null; audienceCount: number; deliveries: Delivery[] };

const date = (value: string) => new Date(value).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
const n = (value: number) => value.toLocaleString();

export function DeliveryStats({
  totals,
  compact = false,
  uniqueRecipientsSent,
  directoryOptedOut,
}: {
  totals: DeliveryTotals & { sending?: number };
  compact?: boolean;
  uniqueRecipientsSent?: number;
  directoryOptedOut?: number;
}) {
  const rates = deliveryRates(totals);
  const metrics = [
    {
      key: "sent",
      label: "Sent",
      value: totals.sent,
      badge: uniqueRecipientsSent !== undefined && uniqueRecipientsSent > 0 ? `${n(uniqueRecipientsSent)} unique` : undefined,
      hint: "Accepted by WhatsApp server (✓)",
      icon: Send,
    },
    {
      key: "delivered",
      label: "Delivered",
      value: totals.delivered,
      badge: totals.sent > 0 ? `${rates.deliveryRate}%` : undefined,
      hint: "Reached recipient device (✓✓)",
      icon: CheckCheck,
    },
    {
      key: "read",
      label: "Read",
      value: totals.read,
      badge: totals.sent > 0 ? `${rates.readRate}%` : undefined,
      hint: "Opened (read receipt ✓✓)",
      icon: Eye,
    },
    {
      key: "replied",
      label: "Replied",
      value: totals.replied,
      badge: totals.replies > 0 ? `${n(totals.replies)} msg${totals.replies === 1 ? "" : "s"}` : totals.sent > 0 ? `${rates.replyRate}%` : undefined,
      hint: `${n(totals.replies)} total incoming reply message(s)`,
      icon: Users,
    },
    {
      key: "optedOut",
      label: "Opted out",
      value: totals.optedOut ?? 0,
      badge: directoryOptedOut !== undefined && directoryOptedOut > (totals.optedOut ?? 0) ? `${n(directoryOptedOut)} in phonebook` : undefined,
      hint: "STOP / unsubscribe replies attributed",
      icon: UserMinus,
    },
    {
      key: "pending",
      label: "Queued / Live",
      value: totals.pending,
      badge: totals.sending ? `${n(totals.sending)} sending` : undefined,
      hint: "Waiting for pacing window or sending now",
      icon: Clock3,
    },
    {
      key: "skipped",
      label: "Skipped",
      value: totals.skipped,
      badge: undefined,
      hint: "Skipped by repeat rule, cooldown or opt-out",
      icon: FastForward,
    },
    {
      key: "failed",
      label: totals.uncertain > 0 ? "Failed / Unconfirmed" : "Failed",
      value: totals.failed + totals.uncertain,
      badge: totals.uncertain > 0 ? `${n(totals.uncertain)} unconfirmed` : undefined,
      hint: `${n(totals.failed)} failed · ${n(totals.uncertain)} awaiting receipt check`,
      icon: CircleAlert,
    },
  ];

  return (
    <div className={`delivery-stats ${compact ? "compact" : ""}`} aria-label="Delivery statistics">
      {metrics.map(metric => (
        <div className={`delivery-stat stat-${metric.key}`} key={metric.key} title={metric.hint}>
          <div className="stat-top-line">
            <span><metric.icon size={14} aria-hidden="true"/>{metric.label}</span>
            {metric.badge && <em className="stat-rate-badge">{metric.badge}</em>}
          </div>
          <strong>{n(metric.value)}</strong>
          {!compact && <small>{metric.hint}</small>}
        </div>
      ))}
    </div>
  );
}

function DeliveryStatus({ status }: { status: string }) {
  const label = status === "UNKNOWN" ? "Unconfirmed" : status === "SKIPPED" ? "Skipped" : status.replaceAll("_", " ").toLowerCase();
  return <span className={`flag flag-${status.toLowerCase()}`}><span className="flag-dot"/>{label}</span>;
}

function statusRank(status: string) {
  switch (status) {
    case "READ": return 8;
    case "DELIVERED": return 7;
    case "SENT": return 6;
    case "SENDING": return 5;
    case "UNKNOWN": return 4;
    case "QUEUED": return 3;
    case "FAILED": return 2;
    case "SKIPPED": return 1;
    default: return 0;
  }
}

function combineRuns(runs: ResultRun[]): ResultRun {
  const byRecipient = new Map<string, Delivery>();
  for (const run of runs) {
    for (const delivery of run.deliveries) {
      if (delivery.status === "SKIPPED" && isLifecycleSkip(delivery.error)) continue;
      const existing = byRecipient.get(delivery.recipientKey);
      if (!existing) {
        byRecipient.set(delivery.recipientKey, {
          ...delivery,
          replies: [...delivery.replies],
          _count: { replies: delivery._count?.replies ?? delivery.replies.length },
        });
        continue;
      }
      const replyMap = new Map<string, Reply>();
      for (const r of [...existing.replies, ...delivery.replies]) replyMap.set(r.id, r);
      const mergedReplies = [...replyMap.values()].sort(
        (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
      );
      const winner = statusRank(delivery.status) > statusRank(existing.status) ? delivery : existing;
      byRecipient.set(delivery.recipientKey, {
        ...winner,
        sentAt: winner.sentAt ?? existing.sentAt ?? delivery.sentAt,
        optedOutAt: existing.optedOutAt ?? delivery.optedOutAt ?? null,
        replies: mergedReplies,
        _count: { replies: Math.max(mergedReplies.length, (existing._count?.replies ?? 0) + (delivery._count?.replies ?? 0)) },
      });
    }
  }
  const latest = runs[0];
  return {
    id: "__all__",
    startedAt: latest.startedAt,
    status: runs.some(r => r.status === "RUNNING") ? "RUNNING" : latest.status,
    error: runs.find(r => r.status === "RUNNING")?.error ?? null,
    nextAttemptAt: runs.find(r => r.nextAttemptAt)?.nextAttemptAt ?? null,
    messageSnapshot: runs.find(r => r.messageSnapshot)?.messageSnapshot ?? null,
    mediaNameSnapshot: runs.find(r => r.mediaNameSnapshot)?.mediaNameSnapshot ?? null,
    audienceCount: Math.max(...runs.map(r => r.audienceCount || 0), byRecipient.size),
    deliveries: [...byRecipient.values()],
  };
}

function RecipientResults({ run, confirmSent }: { run: ResultRun; confirmSent: (deliveryId: string, note: string) => Promise<void> }) {
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const activeDeliveries = useMemo(
    () =>
      run.deliveries
        .filter(delivery => !(delivery.status === "SKIPPED" && isLifecycleSkip(delivery.error)))
        .sort((a, b) => {
          const aReplies = a._count?.replies ?? a.replies.length;
          const bReplies = b._count?.replies ?? b.replies.length;
          if ((bReplies > 0) !== (aReplies > 0)) return bReplies > 0 ? 1 : -1;
          const aTime = a.sentAt ? new Date(a.sentAt).getTime() : 0;
          const bTime = b.sentAt ? new Date(b.sentAt).getTime() : 0;
          if (bTime !== aTime) return bTime - aTime;
          return statusRank(b.status) - statusRank(a.status);
        }),
    [run.deliveries],
  );
  const unreachedCount = run.deliveries.length - activeDeliveries.length;
  const totals = useMemo(() => deliveryTotals(activeDeliveries), [activeDeliveries]);
  const hasGroupDeliveries = useMemo(() => activeDeliveries.some(d => d.recipientKey.startsWith("group:")), [activeDeliveries]);

  const matches = useMemo(
    () =>
      activeDeliveries.filter(delivery => {
        if (search && !`${delivery.recipient} ${delivery.recipientKey}`.toLowerCase().includes(search.toLowerCase())) return false;
        if (filter === "OPTED_OUT") return !!delivery.optedOutAt || delivery.replies.some(reply => reply.isOptOut);
        if (filter === "REPLIED") return (delivery._count?.replies ?? delivery.replies.length) > 0;
        if (filter === "SENT") return ["SENT", "DELIVERED", "READ"].includes(delivery.status);
        if (filter === "DELIVERED") return ["DELIVERED", "READ"].includes(delivery.status);
        if (filter === "PENDING") return ["QUEUED", "SENDING"].includes(delivery.status);
        return filter === "ALL" || delivery.status === filter;
      }),
    [activeDeliveries, search, filter]
  );

  const pages = Math.max(1, Math.ceil(matches.length / 25));
  const currentPage = Math.min(page, pages);

  const tabs = [
    { key: "ALL", label: "All", count: totals.total },
    { key: "SENT", label: "Sent", count: totals.sent },
    { key: "DELIVERED", label: "Delivered", count: totals.delivered },
    { key: "READ", label: "Read", count: totals.read },
    { key: "REPLIED", label: "Replied", count: totals.replied },
    { key: "OPTED_OUT", label: "Opted out", count: totals.optedOut },
    { key: "PENDING", label: "Queued", count: totals.pending },
    { key: "SKIPPED", label: "Skipped", count: totals.skipped },
    { key: "UNKNOWN", label: "Unconfirmed", count: totals.uncertain },
    { key: "FAILED", label: "Failed", count: totals.failed },
  ];

  return (
    <>
      {hasGroupDeliveries && (
        <p className="muted-footnote">
          Note on WhatsApp Groups: Group posts count as <strong>Sent</strong> immediately when accepted by WhatsApp; WhatsApp only emits group <strong>Delivered</strong> / <strong>Read</strong> receipts once every participant in the group receives or opens the post.
        </p>
      )}
      {unreachedCount > 0 && (
        <p className="muted-footnote">
          {n(unreachedCount)} remaining recipient{unreachedCount === 1 ? "" : "s"} in this partial run had not been sent yet when the run paused and remain eligible on resume.
        </p>
      )}
      <div className="result-filters" role="group" aria-label="Filter recipients by result">
        {tabs.map(tab => (
          <button
            type="button"
            key={tab.key}
            className={filter === tab.key ? "selected" : ""}
            aria-pressed={filter === tab.key}
            onClick={() => { setFilter(tab.key); setPage(1); }}
          >
            {tab.label}<span>{n(tab.count)}</span>
          </button>
        ))}
      </div>

      <div className="search-box result-search">
        <Search size={16} aria-hidden="true"/>
        <input
          aria-label="Search delivery recipients"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Search by name, group, phone or WhatsApp ID…"
          value={search}
          onChange={event => { setSearch(event.target.value); setPage(1); }}
        />
      </div>

      {error && <p className="tiny-error" role="alert">{error}</p>}

      <div className="recipient-results">
        {matches.slice((currentPage - 1) * 25, currentPage * 25).map(delivery => (
          <article className="recipient-result" key={delivery.id}>
            <div className="recipient-result-head">
              <div>
                <strong>{delivery.recipient}</strong>
                <small>
                  {delivery.recipientKey.startsWith("group:") ? "WhatsApp Group · " : ""}
                  {delivery.recipientKey.replace(/^(contact|group):/, "")}
                  {delivery.sentAt ? ` · Sent ${date(delivery.sentAt)}` : ""}
                  {delivery.deliveredAt ? ` · Delivered ${date(delivery.deliveredAt)}` : ""}
                  {delivery.readAt ? ` · Read ${date(delivery.readAt)}` : ""}
                </small>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {delivery.status === "UNKNOWN" && (
                  <button
                    type="button"
                    className="btn outline"
                    style={{ padding: "5px 9px", fontSize: 11 }}
                    disabled={busyId === delivery.id}
                    onClick={async () => {
                      setBusyId(delivery.id);
                      setError("");
                      try {
                        await confirmSent(delivery.id, "Confirmed sent from delivery inspector.");
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Could not confirm send");
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    <Check size={13} aria-hidden="true"/> {busyId === delivery.id ? "Confirming…" : "Mark sent"}
                  </button>
                )}
                <DeliveryStatus status={delivery.status}/>
              </div>
            </div>
            {delivery.optedOutAt && <p className="result-note">Opted out on {date(delivery.optedOutAt)}</p>}
            {deliveryFeedback(delivery) && (
              <p className={delivery.status === "FAILED" ? "tiny-error" : "result-note"}>{deliveryFeedback(delivery)}</p>
            )}
            {delivery.replies.length > 0 && (
              <details className="recipient-replies">
                <summary>{n(delivery.replies.length)} repl{delivery.replies.length === 1 ? "y" : "ies"} received</summary>
                {delivery.replies.map(reply => (
                  <div className={`reply-bubble ${reply.isOptOut ? "reply-opt-out" : ""}`} key={reply.id}>
                    <p>{reply.body}</p>
                    {reply.author && <small>From: {reply.author.split("@")[0]}</small>}
                    <small>
                      {date(reply.receivedAt)} · {reply.attribution === "QUOTED" ? "Quoted this campaign message" : "Matched to recent campaign send"}
                      {reply.isOptOut ? " · Unsubscribed (STOP)" : ""}
                    </small>
                  </div>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>

      {!matches.length && <p className="result-empty">No recipients match this filter.</p>}

      <div className="table-footer">
        <span>
          {n(matches.length)} matching · {n(Math.min((currentPage - 1) * 25 + 1, matches.length))}–{n(Math.min(currentPage * 25, matches.length))} shown
        </span>
        <div className="pager">
          <button type="button" aria-label="Previous delivery recipients" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
            <ArrowLeft size={15} aria-hidden="true"/>
          </button>
          <span>{currentPage} / {pages}</span>
          <button type="button" aria-label="Next delivery recipients" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>
            <ArrowRight size={15} aria-hidden="true"/>
          </button>
        </div>
      </div>
    </>
  );
}

export default function CampaignResults({
  runs,
  totalRuns,
  initialRunId,
  confirmSent,
}: {
  runs: ResultRun[];
  totalRuns: number;
  initialRunId?: string | null;
  confirmSent: (deliveryId: string, note: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(
    initialRunId || (runs.length > 1 ? "__all__" : runs[0]?.id ?? ""),
  );
  const combinedRun = useMemo(() => (runs.length > 1 ? combineRuns(runs) : null), [runs]);
  const run = selected === "__all__" && combinedRun
    ? combinedRun
    : runs.find(item => item.id === selected) ?? combinedRun ?? runs[0];
  if (!run) return <p className="result-empty">No runs yet. Launch this campaign when ready.</p>;
  const totals = deliveryTotals(run.deliveries);

  return (
    <section className="campaign-results">
      <div className="result-run-heading">
        <div>
          <h3>Run breakdown & replies</h3>
          <p>Live per-recipient delivery receipts and incoming replies</p>
        </div>
        <div>
          <label htmlFor="select-campaign-run">Select run</label>
          <select id="select-campaign-run" value={run.id} onChange={event => setSelected(event.target.value)}>
            {combinedRun && (
              <option value="__all__">All {runs.length} runs combined (Deduplicated)</option>
            )}
            {runs.map((item, i) => (
              <option value={item.id} key={item.id}>
                {date(item.startedAt)}{i === 0 && runs.length > 1 ? " · Latest" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {totalRuns > runs.length && (
        <p className="muted-footnote">Showing latest {runs.length} of {totalRuns} runs.</p>
      )}

      <div className="run-state">
        <DeliveryStatus status={run.status}/>
        <span>
          {n(run.audienceCount || totals.total)} planned · {n(totals.sent)} sent · {n(totals.delivered)} delivered · {n(totals.skipped)} skipped
        </span>
      </div>

      {run.error && <p className="result-note">{run.error}</p>}
      {run.nextAttemptAt && <p className="result-note">Next scheduled send slot: {date(run.nextAttemptAt)}</p>}

      <DeliveryStats totals={totals} compact/>

      {run.messageSnapshot && (
        <details className="run-message">
          <summary>Message sent in this run</summary>
          <p className="message-preview">{run.messageSnapshot}</p>
          {run.mediaNameSnapshot && <small>Attachment: {run.mediaNameSnapshot}</small>}
        </details>
      )}

      <RecipientResults key={run.id} run={run} confirmSent={confirmSent}/>
    </section>
  );
}
