"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, BarChart3, CalendarClock, Check,
  ChevronRight, ContactRound, FolderPlus, Layers,
  LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Megaphone,
  MessageCircle, Play, Plus, QrCode, RefreshCw, Repeat, Search, Send, Settings2,
  ShieldCheck, Smartphone, Sparkles, Square, Tags, Trash2, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { parseContactCsv } from "@/lib/csv";
import ContactOrganizer, { type GroupRef } from "./contact-organizer";
import SendingSafety from "./sending-safety";
import CampaignComposer, { type CampaignForm } from "./campaign-composer";
import CampaignResults, { DeliveryStats, type ResultRun } from "./campaign-results";
import TemplateStudio, { type MessageTemplateRecord } from "./template-studio";
import { deliveryTotals, type DeliveryTotals } from "@/lib/reporting";
import type { ContactFilter, ContactSelection } from "@/lib/contact-selection";
import { dateTimeInZone } from "@/lib/timezone";
import type { SyncState } from "@/lib/sync-state";

type View = "overview" | "sessions" | "contacts" | "groups" | "segments" | "campaigns" | "templates" | "reports" | "settings";
type Session = {
  publicSenderName?: string | null;
  accountKey?: string;
  sendingHold?: { accountKey: string; reason: string; notBefore: string | null } | null;
  id: string;
  label: string;
  phone?: string | null;
  status: string;
  error?: string | null;
  lastSeen?: string | null;
  sync?: { phase: string; message: string; updatedAt: string } | null;
  _count?: { contacts: number; groups: number };
};
type Contact = {
  id: string;
  mergedIds?: string[];
  sessionId: string;
  whatsappId: string;
  phone: string | null;
  name: string | null;
  consent: string;
  isMyContact: boolean;
  session?: { label: string };
  sourceSessions?: string[];
  sourceGroups?: { id: string; name: string }[];
  segments?: { segment: { id: string; name: string } }[];
  _count?: { members: number };
};
type Group = {
  id: string;
  sessionId: string;
  whatsappId: string;
  name: string;
  participantCount: number;
  allowPosting: boolean;
  session: { label: string; status: string };
  _count: { members: number };
  sync?: SyncState | null;
};
type Segment = {
  eligibleCount?: number;
  optedOutCount?: number;
  groupSourcedCount?: number;
  id: string;
  name: string;
  description?: string | null;
  _count: { members: number };
};
type Run = {
  error?: string | null;
  messageSnapshot?: string | null;
  audienceCount?: number;
  id: string;
  campaignId: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  campaign: { name: string; audienceType?: string };
  deliveries: { status: string; optedOutAt?: string | null; recipient?: string; error?: string | null; _count?: { replies: number }; replies?: { isOptOut: boolean }[] }[];
};
type Campaign = {
  summary: DeliveryTotals;
  sendIntervalMs: number;
  mediaKey?: string | null;
  mediaMime?: string | null;
  mediaName?: string | null;
  id: string;
  name: string;
  message: string;
  sessionId: string;
  audienceType: "CONTACTS" | "GROUPS" | "BOTH";
  scheduleType: "NOW" | "ONCE" | "CRON";
  intervalHours?: number | null;
  runImmediately?: boolean;
  repeatPolicy?: "ALLOW_REPEAT" | "COOLDOWN" | "NO_REPEAT";
  repeatCooldownHours?: number;
  includeFooter?: boolean;
  templateId?: string | null;
  timezone: string;
  cron?: string | null;
  scheduledAt?: string | null;
  status: string;
  createdAt: string;
  launchVersion?: number;
  runsCompleted?: boolean;
  session: { label: string; status: string };
  _count: { contacts: number; groups: number; segments: number; runs: number };
  runs: { id: string; summary: DeliveryTotals }[];
};
type Overview = {
  sessions: number;
  contacts: number;
  uniquePeople?: number;
  optedIn: number;
  optedOut?: number;
  segments?: number;
  templates?: number;
  groups: number;
  campaigns: number;
  activeCampaigns?: number;
  runs: number;
  latest: (Run & { deliveries: { status: string }[] })[];
};
type ContactPage = { items: Contact[]; total: number; page: number; take: number };
type Health = { database: string; redis: string; workerReady: boolean };
type HistoryStatus = { phase: string; message?: string; scannedChats?: number; confirmed?: number; replies?: number; unresolved?: number; errors?: number; limited?: boolean };
type AudienceExclusions = { missingConsent: number; optedOut: number; unusablePhone: number; unauthorizedGroups: number };
type CampaignAudienceSummary = { count: number; total: number; duplicates: number; excluded: number; exclusions: AudienceExclusions; sample: { label: string }[] };
type WorkspaceReport = DeliveryTotals & { uniqueRecipientsSent?: number; directoryOptedOut?: number };

const initCampaign: CampaignForm = {
  sendIntervalMs: 15000,
  name: "",
  message: "",
  sessionId: "",
  audienceType: "CONTACTS",
  contactIds: [],
  segmentIds: [],
  groupIds: [],
  scheduleType: "NOW",
  scheduledAt: "",
  cron: "0 9 * * *",
  intervalHours: 3,
  runImmediately: true,
  repeatPolicy: "ALLOW_REPEAT",
  repeatCooldownHours: 0,
  includeFooter: false,
  templateId: null,
  timezone: "Africa/Nairobi",
};

const menu: { key: View; title: string; icon: typeof LayoutDashboard; section: string }[] = [
  { key: "overview", title: "Overview", icon: LayoutDashboard, section: "Workspace" },
  { key: "sessions", title: "WhatsApp sessions", icon: Smartphone, section: "Workspace" },
  { key: "contacts", title: "Phonebook", icon: ContactRound, section: "Audience" },
  { key: "groups", title: "WhatsApp groups", icon: Users, section: "Audience" },
  { key: "segments", title: "Segments", icon: Tags, section: "Audience" },
  { key: "campaigns", title: "Campaigns", icon: Megaphone, section: "Messaging" },
  { key: "templates", title: "Message templates", icon: Sparkles, section: "Messaging" },
  { key: "reports", title: "Delivery reports", icon: BarChart3, section: "Messaging" },
  { key: "settings", title: "Settings & rules", icon: Settings2, section: "System" },
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
}
function toggle(current: string[], value: string) {
  return current.includes(value) ? current.filter(x => x !== value) : [...current, value];
}
function syncPending(sync?: { phase: string } | null) {
  return sync?.phase === "QUEUED" || sync?.phase === "RUNNING";
}
async function api<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: options?.method || "GET",
    headers: options?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ error: "Unexpected server response" }));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("auth-expired"));
    throw new Error(body.error || "Request failed");
  }
  return body as T;
}

function Flag({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`flag flag-${value.toLowerCase().replaceAll("_", "-")}`}>
      <span className="flag-dot"/>
      {label || value.replaceAll("_", " ").toLowerCase()}
    </span>
  );
}
function Blank({ icon: Icon, title, desc, action }: { icon: typeof Smartphone; title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="blank">
      <div className="blank-icon"><Icon size={24} aria-hidden="true"/></div>
      <h3>{title}</h3>
      <p>{desc}</p>
      {action}
    </div>
  );
}
function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="head-actions">{action}</div>}
    </div>
  );
}

function Modal({
  title,
  children,
  close,
  wide,
  lightDismiss = true,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
  lightDismiss?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  useEffect(() => { closeRef.current = close; }, [close]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();

    if (lightDismiss && !("closedBy" in HTMLDialogElement.prototype)) {
      const outside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      const onDown = (e: PointerEvent) => { pressedOutside = outside(e); };
      const onUp = (e: PointerEvent) => { if (pressedOutside && outside(e)) dialog.close(); };
      dialog.addEventListener("pointerdown", onDown);
      dialog.addEventListener("pointerup", onUp);
      return () => {
        dialog.removeEventListener("pointerdown", onDown);
        dialog.removeEventListener("pointerup", onUp);
      };
    }
  }, [lightDismiss]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      closedby={lightDismiss ? "any" : "closerequest"}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onClose={() => closeRef.current()}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close dialog">
          <X size={19} aria-hidden="true"/>
        </button>
      </div>
      {children}
    </dialog>
  );
}

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-symbol"><MessageCircle size={27} aria-hidden="true"/></div>
        <div className="eyebrow">CAMPAIGNDESK</div>
        <h1>Welcome back.</h1>
        <p>Centralized WhatsApp phonebooks, group & DM campaigns, templates, and live delivery analytics.</p>
        <form
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/api/auth/login", { method: "POST", body: { email, password } });
              await onLogin();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Sign-in failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              autoComplete="username"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="admin@example.com"
            />
          </div>
          <div>
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••••••"
            />
          </div>
          {error && <div className="notice danger" role="alert">{error}</div>}
          <button type="submit" className="btn primary full" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} aria-hidden="true"/> : <LockKeyhole size={17} aria-hidden="true"/>} Sign in
          </button>
        </form>
        <div className="auth-footer"><ShieldCheck size={15} aria-hidden="true"/> Private workspace console</div>
      </div>
    </div>
  );
}

export default function Workspace() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [email, setEmail] = useState("");
  const [view, setView] = useState<View>("overview");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactTotal, setContactTotal] = useState(0);
  const [contactPage, setContactPage] = useState(1);
  const [contactSearch, setContactSearch] = useState("");
  const [deduplicatePhonebook, setDeduplicatePhonebook] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "opted_out">("");
  const [destinationFilter, setDestinationFilter] = useState<"" | "phone" | "private">("");
  const [phoneFilter, setPhoneFilter] = useState<"" | "usable" | "unavailable">("");
  const [groupFilter, setGroupFilter] = useState("");
  const [segmentFilter, setSegmentFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [allMatching, setAllMatching] = useState(false);
  const [organizer, setOrganizer] = useState<{
    selection?: ContactSelection;
    count?: number;
    sourceSegmentId?: string;
    group?: GroupRef;
    groups?: GroupRef[];
  } | null>(null);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateRecord[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [qrSession, setQrSession] = useState<Session | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [newSession, setNewSession] = useState("");
  const [newPublicSender, setNewPublicSender] = useState("");
  const [editingSession, setEditingSession] = useState<{ id: string; label: string; publicSenderName: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importData, setImportData] = useState("");
  const [importSessionId, setImportSessionId] = useState("");
  const [importSegmentId, setImportSegmentId] = useState("");
  const [importNewSegment, setImportNewSegment] = useState("");
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [newSegment, setNewSegment] = useState("");
  const [segmentDesc, setSegmentDesc] = useState("");
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignStatusFilter, setCampaignStatusFilter] = useState("ALL");
  const [contactFiltersOpen, setContactFiltersOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [campaignHasHistory, setCampaignHasHistory] = useState(false);
  const [campaignCanContinue, setCampaignCanContinue] = useState(false);
  const [campaignSentCount, setCampaignSentCount] = useState(0);
  const [reportTotals, setReportTotals] = useState<WorkspaceReport | null>(null);
  const [historyStatuses, setHistoryStatuses] = useState<Record<string, HistoryStatus>>({});
  const [historyRequesting, setHistoryRequesting] = useState<string | null>(null);
  const historyLastPhase = useRef<Record<string, string>>({});
  const [campaignForm, setCampaignForm] = useState<CampaignForm>(initCampaign);
  const [inspectedCampaign, setInspectedCampaign] = useState<{
    id: string;
    name: string;
    message: string;
    mediaName?: string | null;
    audienceType: string;
    segments: { segmentId: string }[];
    summary: DeliveryTotals;
    _count: { runs: number };
    runs: ResultRun[];
  } | null>(null);
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceSummary | null>(null);
  const [inspectedMembers, setInspectedMembers] = useState<{ group: Group; members: { contact: Contact }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const contactRequest = useRef(0);
  const inform = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const buildContactQuery = useCallback(
    (page: number) => {
      const query = new URLSearchParams({ page: String(page), take: "40" });
      if (deduplicatePhonebook) query.set("deduplicate", "true");
      if (contactSearch) query.set("search", contactSearch);
      if (statusFilter) query.set("status", statusFilter);
      if (phoneFilter) query.set("phoneAvailability", phoneFilter);
      if (destinationFilter) query.set("destinationAvailability", destinationFilter);
      if (sessionFilter) query.set("sessionId", sessionFilter);
      if (groupFilter) query.set("groupId", groupFilter);
      if (sourceFilter) query.set("source", sourceFilter);
      if (segmentFilter === "__unsegmented") query.set("unsegmented", "true");
      else if (segmentFilter) query.set("segmentId", segmentFilter);
      return query;
    },
    [deduplicatePhonebook, contactSearch, statusFilter, phoneFilter, destinationFilter, sessionFilter, groupFilter, sourceFilter, segmentFilter]
  );

  const loadContacts = useCallback(
    async (page: number) => {
      const reqId = ++contactRequest.current;
      const query = buildContactQuery(page);
      const data = await api<ContactPage>("/api/v1/contacts?" + query.toString());
      if (reqId === contactRequest.current) {
        setContacts(data.items);
        setContactTotal(data.total);
      }
    },
    [buildContactQuery]
  );

  const loadAll = useCallback(async () => {
    const [overviewData, sessionsData, groupsData, segmentsData, templatesData, campaignsData, runsData, healthData, totalsData] =
      await Promise.all([
        api<Overview>("/api/v1/overview"),
        api<Session[]>("/api/v1/sessions"),
        api<Group[]>("/api/v1/groups"),
        api<Segment[]>("/api/v1/segments"),
        api<MessageTemplateRecord[]>("/api/v1/templates"),
        api<Campaign[]>("/api/v1/campaigns"),
        api<Run[]>("/api/v1/runs"),
        api<Health>("/api/v1/health"),
        api<WorkspaceReport>("/api/v1/report-summary"),
      ]);
    setOverview(overviewData);
    setSessions(sessionsData);
    setGroups(groupsData);
    setSegments(segmentsData);
    setTemplates(templatesData);
    setCampaigns(campaignsData);
    setRuns(runsData);
    setHealth(healthData);
    setReportTotals(totalsData);
    setCampaignForm(prev => ({
      ...prev,
      sessionId: prev.sessionId || sessionsData.find(s => s.status === "CONNECTED")?.id || sessionsData[0]?.id || "",
    }));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (auth !== "in" || (view !== "campaigns" && view !== "reports")) return;
    let alive = true;
    const poll = async () => {
      const unique = [...new Set(campaigns.map(item => item.sessionId))];
      await Promise.all(
        unique.map(async sessionId => {
          try {
            const status = await api<HistoryStatus>("/api/v1/sessions/" + sessionId + "/reconcile-history");
            if (!alive) return;
            const previousPhase = historyLastPhase.current[sessionId];
            historyLastPhase.current[sessionId] = status.phase;
            if (previousPhase && ["QUEUED", "RUNNING"].includes(previousPhase) && status.phase === "COMPLETED") {
              void loadAll().catch(() => {});
            }
            setHistoryStatuses(prev =>
              prev[sessionId]?.phase === status.phase && prev[sessionId]?.message === status.message
                ? prev
                : { ...prev, [sessionId]: status }
            );
          } catch {
            /* Background history check status polling is best-effort. */
          }
        })
      );
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [auth, view, campaigns, loadAll]);

  const signedIn = useCallback(async () => {
    const { user } = await api<{ user: { email: string } }>("/api/auth/me");
    setEmail(user.email);
    setAuth("in");
    try {
      await loadAll();
    } catch (e) {
      inform(e instanceof Error ? e.message : "Could not load data", true);
    } finally {
      setLoading(false);
    }
  }, [inform, loadAll]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void signedIn().catch(() => {
        setAuth("out");
        setLoading(false);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [signedIn]);

  useEffect(() => {
    if (auth !== "in") return;
    const timer = setTimeout(() => {
      void loadContacts(contactPage).catch(e => inform(String(e), true));
    }, 220);
    return () => clearTimeout(timer);
  }, [auth, contactPage, loadContacts, inform]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadAll(), loadContacts(contactPage)]);
    } catch (e) {
      inform(e instanceof Error ? e.message : "Refresh failed", true);
    } finally {
      setLoading(false);
    }
  }, [loadAll, loadContacts, contactPage, inform]);

  const savingGroupContacts = groups.some(group => syncPending(group.sync));
  useEffect(() => {
    if (auth !== "in") return;
    const timer = setInterval(
      () => { void refresh(); },
      savingGroupContacts ? 2000 : runs.some(run => run.status === "RUNNING") ? 3000 : 12000
    );
    return () => clearInterval(timer);
  }, [auth, refresh, savingGroupContacts, runs]);

  useEffect(() => {
    const expired = () => {
      setAuth("out");
      setSelectedContacts([]);
      setQrSession(null);
      setCampaignOpen(false);
    };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);

  const inspectedCampaignId = inspectedCampaign?.id;
  useEffect(() => {
    if (!inspectedCampaignId) return;
    let alive = true;
    const timer = setInterval(() => {
      void Promise.all([
        api<NonNullable<typeof inspectedCampaign>>(
          "/api/v1/campaigns/" + inspectedCampaignId + (inspectedRunId ? "?runId=" + encodeURIComponent(inspectedRunId) : "")
        ),
        api<CampaignAudienceSummary>("/api/v1/campaigns/" + inspectedCampaignId + "/audience"),
      ])
        .then(([detail, audience]) => {
          if (alive) {
            setInspectedCampaign(detail);
            setAudiencePreview(audience);
          }
        })
        .catch(e => {
          if (alive) inform(String(e), true);
        });
    }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [inspectedCampaignId, inspectedRunId, inform]);

  useEffect(() => {
    if (!qrSession) return;
    let alive = true;
    const poll = () => {
      void Promise.all([api<{ qr: string | null }>("/api/v1/sessions/" + qrSession.id + "/qr"), api<Session[]>("/api/v1/sessions")])
        .then(([value, current]) => {
          if (!alive) return;
          setQr(value.qr);
          setSessions(current);
          if (current.find(s => s.id === qrSession.id)?.status === "CONNECTED") {
            setQrSession(null);
            inform("WhatsApp connected! Syncing contacts and groups in the background.");
          }
        })
        .catch(e => {
          if (alive) inform(String(e), true);
        });
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [qrSession, inform]);

  async function update(method: string, path: string, body?: unknown, message = "Changes saved") {
    setSaving(true);
    try {
      await api(path, { method, body });
      await Promise.all([loadAll(), loadContacts(contactPage)]);
      inform(message);
      return true;
    } catch (e) {
      inform(e instanceof Error ? e.message : "Request failed", true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setAuth("out");
      setSelectedContacts([]);
    } catch (e) {
      inform(String(e), true);
    }
  }

  async function setContactReachability(selection: ContactSelection, optIn: boolean) {
    setSaving(true);
    try {
      const res = await api<{ uniqueDestinations: number }>("/api/v1/contacts/consent", {
        method: "POST",
        body: {
          selection,
          consent: optIn ? "OPTED_IN" : "OPTED_OUT",
          consentMethod: "OTHER",
          confirmed: true,
          includeOptedOut: optIn,
          reoptInConfirmed: optIn,
        },
      });
      clearSelection();
      await Promise.all([loadAll(), loadContacts(contactPage)]);
      inform(
        optIn
          ? `${res.uniqueDestinations.toLocaleString()} contact(s) marked Active in phonebook.`
          : `${res.uniqueDestinations.toLocaleString()} contact(s) suppressed (Opted out).`
      );
    } catch (e) {
      inform(e instanceof Error ? e.message : "Could not update contact status", true);
    } finally {
      setSaving(false);
    }
  }

  async function saveGroupContacts(group: Group) {
    if (await update("POST", "/api/v1/groups/" + group.id + "/save-contacts", {}, "Syncing group contacts to centralized phonebook…")) {
      setInspectedMembers(null);
    }
  }

  function viewGroupContacts(group: Group) {
    setContactSearch("");
    setStatusFilter("");
    setPhoneFilter("");
    setDestinationFilter("");
    setSessionFilter("");
    setGroupFilter(group.id);
    setSegmentFilter("");
    setSourceFilter("");
    setAllMatching(false);
    setContactPage(1);
    setSelectedContacts([]);
    setInspectedMembers(null);
    setView("contacts");
  }

  function openCampaignBuilder(overrides?: Partial<CampaignForm>) {
    setNotice(null);
    setEditingCampaignId(null);
    setCampaignHasHistory(false);
    setCampaignCanContinue(false);
    setCampaignSentCount(0);
    const defaultSession =
      overrides?.sessionId ||
      sessions.find(session => session.status === "CONNECTED")?.id ||
      sessions[0]?.id ||
      "";
    setCampaignForm({ ...initCampaign, sessionId: defaultSession, ...overrides });
    setCampaignOpen(true);
  }

  async function editCampaign(id: string) {
    try {
      const c = await api<
        Campaign & {
          contacts: { contactId: string }[];
          groups: { groupId: string }[];
          segments: { segmentId: string }[];
          summary?: { sent: number };
        }
      >("/api/v1/campaigns/" + id);
      const localDate = c.scheduledAt ? dateTimeInZone(c.scheduledAt, c.timezone) : "";
      const isDraft = c.status === "DRAFT";
      const hasRuns = (c.runs?.length || 0) > 0 || (c._count?.runs || 0) > 0;
      const canCont = c.status === "PAUSED" || (c.status === "DRAFT" && (c.launchVersion ?? 0) > 0 && !c.runsCompleted && hasRuns);
      setEditingCampaignId(id);
      setCampaignHasHistory(c.status !== "DRAFT" || hasRuns);
      setCampaignCanContinue(canCont);
      setCampaignSentCount(c.summary?.sent ?? 0);
      setCampaignForm({
        sendIntervalMs: c.sendIntervalMs,
        name: c.name,
        message: c.message,
        sessionId: c.sessionId,
        audienceType: (c.audienceType || "CONTACTS") as "CONTACTS" | "GROUPS" | "BOTH",
        contactIds: c.contacts.map(x => x.contactId),
        segmentIds: c.segments.map(x => x.segmentId),
        groupIds: c.groups.map(x => x.groupId),
        scheduleType: (!isDraft && c.scheduleType === "ONCE" ? "NOW" : c.scheduleType) as "NOW" | "ONCE" | "CRON",
        scheduledAt: isDraft ? localDate : "",
        cron: c.cron || "0 9 * * *",
        intervalHours: c.intervalHours ?? null,
        runImmediately: c.runImmediately ?? true,
        repeatPolicy: c.repeatPolicy ?? "ALLOW_REPEAT",
        repeatCooldownHours: c.repeatCooldownHours ?? 0,
        includeFooter: c.includeFooter ?? false,
        templateId: c.templateId ?? null,
        timezone: c.timezone,
        mediaKey: c.mediaKey || undefined,
        mediaMime: c.mediaMime || undefined,
        mediaName: c.mediaName || undefined,
      });
      setCampaignOpen(true);
    } catch (e) {
      inform(e instanceof Error ? e.message : "Unable to open campaign", true);
    }
  }

  async function inspectCampaign(id: string, knownAudience?: CampaignAudienceSummary, runId?: string) {
    try {
      const [detail, audience] = await Promise.all([
        api<NonNullable<typeof inspectedCampaign>>("/api/v1/campaigns/" + id + (runId ? "?runId=" + encodeURIComponent(runId) : "")),
        knownAudience ? Promise.resolve(knownAudience) : api<CampaignAudienceSummary>("/api/v1/campaigns/" + id + "/audience"),
      ]);
      setInspectedCampaign(detail);
      setInspectedRunId(runId || null);
      setAudiencePreview(audience);
    } catch (e) {
      inform(e instanceof Error ? e.message : "Unable to inspect campaign", true);
    }
  }

  async function launchCampaign(id: string) {
    await update("POST", "/api/v1/campaigns/" + id + "/action", { action: "launch" }, "Campaign launched");
  }

  async function relaunchCampaign(id: string) {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api<{ campaignId: string; recipients: number }>("/api/v1/campaigns/" + id + "/relaunch", { method: "POST" });
      await loadAll();
      inform(`Relaunched to ${result.recipients.toLocaleString()} recipients.`);
    } catch (e) {
      inform(e instanceof Error ? e.message : "Relaunch failed", true);
    } finally {
      setSaving(false);
    }
  }

  async function reconcileHistory(sessionId: string) {
    if (historyRequesting) return;
    setHistoryRequesting(sessionId);
    try {
      const result = await api<{ queued: boolean; message: string }>("/api/v1/sessions/" + sessionId + "/reconcile-history", { method: "POST", body: {} });
      setHistoryStatuses(prev => ({ ...prev, [sessionId]: { phase: "QUEUED", message: result.message } }));
      inform("Syncing WhatsApp receipts and recent reply history…");
    } catch (error) {
      inform(error instanceof Error ? error.message : "Could not queue history reconciliation", true);
    } finally {
      setHistoryRequesting(null);
    }
  }

  function confirmAction(title: string, description: string, confirmLabel: string, onConfirm: () => void, destructive = false) {
    setConfirmation({ title, description, confirmLabel, onConfirm, destructive });
  }

  const directoryFilter: ContactFilter = {
    ...(contactSearch && { search: contactSearch }),
    ...(statusFilter && { status: statusFilter }),
    ...(phoneFilter && { phoneAvailability: phoneFilter }),
    ...(destinationFilter && { destinationAvailability: destinationFilter }),
    ...(sessionFilter && { sessionId: sessionFilter }),
    ...(groupFilter && { groupId: groupFilter }),
    ...(sourceFilter && { source: sourceFilter as ContactFilter["source"] }),
    ...(segmentFilter === "__unsegmented" ? { unsegmented: true } : segmentFilter ? { segmentId: segmentFilter } : {}),
  };

  function resolveSelectedContactIds(): string[] {
    if (!deduplicatePhonebook) return selectedContacts;
    const expanded = new Set<string>();
    for (const id of selectedContacts) {
      const row = contacts.find(c => c.id === id);
      if (row?.mergedIds?.length) row.mergedIds.forEach(m => expanded.add(m));
      else expanded.add(id);
    }
    return [...expanded];
  }

  const selectionCount = allMatching ? contactTotal : selectedContacts.length;
  function clearSelection() {
    setSelectedContacts([]);
    setAllMatching(false);
  }
  function organizeSelection() {
    if (!selectionCount) return inform("Select contacts first", true);
    setOrganizer({
      selection: allMatching ? { filter: directoryFilter } : { contactIds: resolveSelectedContactIds() },
      count: selectionCount,
      ...(segmentFilter && segmentFilter !== "__unsegmented" ? { sourceSegmentId: segmentFilter } : {}),
    });
  }
  function browseSegment(segment: Segment) {
    setContactSearch("");
    setStatusFilter("");
    setPhoneFilter("");
    setDestinationFilter("");
    setSessionFilter("");
    setGroupFilter("");
    setSourceFilter("");
    setSegmentFilter(segment.id);
    setContactPage(1);
    clearSelection();
    setView("contacts");
  }
  function exportCsvUrl(extra?: Record<string, string>) {
    const q = buildContactQuery(1);
    q.delete("page");
    q.delete("take");
    if (extra) Object.entries(extra).forEach(([k, v]) => q.set(k, v));
    return "/api/v1/contacts/export?" + q.toString();
  }

  const visibleCampaigns = campaigns.filter(
    c =>
      (!campaignSearch || `${c.name} ${c.session.label}`.toLowerCase().includes(campaignSearch.toLowerCase())) &&
      (campaignStatusFilter === "ALL" ||
        (campaignStatusFilter === "ATTENTION" && (c.status === "PAUSED" || c.summary?.failed > 0 || c.summary?.uncertain > 0)) ||
        c.status === campaignStatusFilter)
  );
  const visibleGroups = groups.filter(g => !groupSearch || `${g.name} ${g.session.label}`.toLowerCase().includes(groupSearch.toLowerCase()));
  const hasContactFilters = Object.keys(directoryFilter).length > 0;

  function resetContactFilters() {
    setContactSearch("");
    setStatusFilter("");
    setPhoneFilter("");
    setDestinationFilter("");
    setSessionFilter("");
    setGroupFilter("");
    setSegmentFilter("");
    setSourceFilter("");
    setContactPage(1);
    clearSelection();
  }

  const activeSessions = sessions.filter(s => s.status === "CONNECTED").length;
  const title = menu.find(m => m.key === view)?.title || "Overview";

  if (auth === "checking") {
    return (
      <div className="splash">
        <LoaderCircle className="spin" size={28} aria-hidden="true"/> Loading CampaignDesk…
      </div>
    );
  }
  if (auth === "out") return <Login onLogin={signedIn}/>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><MessageCircle size={23} aria-hidden="true"/></div>
          <div>
            <strong>campaign<span>desk</span></strong>
            <small>WHATSAPP AUTOMATION</small>
          </div>
        </div>
        <nav className="nav" aria-label="Workspace">
          {menu.map((item, index) => (
            <div key={item.key}>
              {(index === 0 || menu[index - 1].section !== item.section) && (
                <div className="nav-caption">{item.section}</div>
              )}
              <button
                type="button"
                className={`nav-item ${view === item.key ? "selected" : ""}`}
                onClick={() => setView(item.key)}
              >
                <item.icon size={18} strokeWidth={1.9} aria-hidden="true"/>
                {item.title}
                {item.key === "sessions" && <span className="nav-count">{sessions.length}</span>}
                {item.key === "contacts" && overview && <span className="nav-count">{(overview.uniquePeople ?? overview.contacts).toLocaleString()}</span>}
                {item.key === "groups" && <span className="nav-count">{groups.length}</span>}
                {item.key === "segments" && <span className="nav-count">{segments.length}</span>}
                {item.key === "templates" && <span className="nav-count">{templates.length}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-box">
            <div className="help-title"><ShieldCheck size={17} aria-hidden="true"/> Centralized & automated</div>
            <p>Combine sessions & groups into segments, design templates, and schedule hourly or standby campaigns.</p>
          </div>
          <div className="signed-user">
            <div className="user-icon">{email.charAt(0).toUpperCase()}</div>
            <div className="signed-email">
              <strong>Administrator</strong>
              <small>{email}</small>
            </div>
            <button type="button" className="icon-button" aria-label="Sign out" onClick={() => void signOut()}>
              <LogOut size={17} aria-hidden="true"/>
            </button>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="crumb">
            Workspace <ChevronRight size={14} aria-hidden="true"/> <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <span className={`live-label ${activeSessions ? "online" : ""}`}>
              <span className="live-dot"/>
              {activeSessions} session{activeSessions === 1 ? "" : "s"} online
            </span>
            <button type="button" className="icon-button" aria-label="Refresh workspace data" onClick={() => void refresh()}>
              <RefreshCw size={17} aria-hidden="true"/>
            </button>
            <div className="top-avatar">{email.charAt(0).toUpperCase()}</div>
            <button type="button" className="icon-button mobile-signout" aria-label="Sign out" onClick={() => void signOut()}>
              <LogOut size={17} aria-hidden="true"/>
            </button>
          </div>
        </header>

        <main className="content">
          {notice && (
            <div role="status" className={`toast ${notice.error ? "toast-error" : ""}`}>
              <span>{notice.text}</span>
              <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
                <X size={16} aria-hidden="true"/>
              </button>
            </div>
          )}
          {loading && (
            <div className="loading-line">
              <LoaderCircle className="spin" size={19} aria-hidden="true"/> Loading workspace…
            </div>
          )}

          {view === "overview" && (
            <>
              <SectionHeading
                eyebrow="COMMAND CENTER"
                title="CampaignDesk Overview"
                description="One centralized phonebook, multi-group segment exports, custom message templates, and automated group & DM campaigns."
                action={
                  <>
                    <button type="button" className="btn outline" onClick={() => setView("templates")}>
                      <Sparkles size={16} aria-hidden="true"/> Templates
                    </button>
                    <button type="button" className="btn primary" onClick={() => openCampaignBuilder()}>
                      <Plus size={17} aria-hidden="true"/> New campaign
                    </button>
                  </>
                }
              />

              <div className="kpi-grid">
                {[
                  {
                    title: "Centralized phonebook",
                    value: overview?.uniquePeople ?? overview?.contacts ?? 0,
                    desc: `${(overview?.optedOut ?? 0).toLocaleString()} opted out · across ${sessions.length} session(s)`,
                    icon: ContactRound,
                    tone: "blue",
                    target: "contacts" as View,
                  },
                  {
                    title: "Segments & groups",
                    value: segments.length,
                    desc: `${groups.length.toLocaleString()} WhatsApp groups ready`,
                    icon: Tags,
                    tone: "green",
                    target: "segments" as View,
                  },
                  {
                    title: "Campaigns",
                    value: overview?.campaigns ?? 0,
                    desc: `${campaigns.filter(c => ["ACTIVE", "SCHEDULED"].includes(c.status)).length} active / scheduled`,
                    icon: Megaphone,
                    tone: "orange",
                    target: "campaigns" as View,
                  },
                  {
                    title: "Messages sent",
                    value: reportTotals?.sent ?? 0,
                    desc: `${(reportTotals?.delivered ?? 0).toLocaleString()} delivered · ${(reportTotals?.replied ?? 0).toLocaleString()} replied`,
                    icon: Send,
                    tone: "purple",
                    target: "reports" as View,
                  },
                ].map(item => (
                  <button
                    type="button"
                    className="kpi kpi-clickable"
                    key={item.title}
                    onClick={() => setView(item.target)}
                  >
                    <div className="kpi-top">
                      <span>{item.title}</span>
                      <div className={`kpi-icon ${item.tone}`}>
                        <item.icon size={19} aria-hidden="true"/>
                      </div>
                    </div>
                    <div className="kpi-value">{item.value.toLocaleString()}</div>
                    <div className="kpi-foot">{item.desc}</div>
                  </button>
                ))}
              </div>

              {reportTotals && (
                <DeliveryStats
                  totals={reportTotals}
                  uniqueRecipientsSent={reportTotals.uniqueRecipientsSent}
                  directoryOptedOut={reportTotals.directoryOptedOut}
                />
              )}

              <div className="two-columns">
                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>Recent & scheduled campaigns</h2>
                      <p>Active crons, standby campaigns, and recent runs</p>
                    </div>
                    <button type="button" className="text-button" onClick={() => setView("campaigns")}>
                      View all <ArrowRight size={15} aria-hidden="true"/>
                    </button>
                  </div>
                  {campaigns.length ? (
                    <div className="compact-list">
                      {campaigns.slice(0, 6).map(c => (
                        <div key={c.id} className="compact-row">
                          <div className="list-icon"><Megaphone size={16} aria-hidden="true"/></div>
                          <div className="grow">
                            <strong>{c.name}</strong>
                            <small>
                              {c.session.label} · {c.audienceType === "GROUPS" ? "Groups" : c.audienceType === "BOTH" ? "Groups + DMs" : "DMs"} ·{" "}
                              {c.scheduleType === "CRON"
                                ? c.intervalHours
                                  ? `Every ${c.intervalHours}h`
                                  : c.cron
                                : formatDate(c.createdAt)}
                            </small>
                          </div>
                          <Flag value={c.status}/>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Blank
                      icon={Megaphone}
                      title="No campaigns yet"
                      desc="Launch a DM, WhatsApp group, or recurring interval campaign in seconds."
                      action={<button type="button" className="btn outline" onClick={() => openCampaignBuilder()}>Create campaign</button>}
                    />
                  )}
                </section>

                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>WhatsApp sessions</h2>
                      <p>Connected phones feeding your phonebook & groups</p>
                    </div>
                    <button type="button" className="text-button" onClick={() => setView("sessions")}>
                      Manage <ArrowRight size={15} aria-hidden="true"/>
                    </button>
                  </div>
                  {sessions.length ? (
                    <div className="compact-list">
                      {sessions.slice(0, 6).map(s => (
                        <div key={s.id} className="compact-row">
                          <div className="list-icon"><Smartphone size={17} aria-hidden="true"/></div>
                          <div className="grow">
                            <strong>{s.label}</strong>
                            <small>
                              {s.phone ? "+" + s.phone : "Not paired"} · {s._count?.contacts ?? 0} contacts · {s._count?.groups ?? 0} groups
                            </small>
                          </div>
                          <Flag value={s.status}/>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Blank
                      icon={Smartphone}
                      title="No sessions linked"
                      desc="Add a WhatsApp session to sync contacts and groups."
                      action={<button type="button" className="btn outline" onClick={() => setCreateSessionOpen(true)}>Add session</button>}
                    />
                  )}
                </section>
              </div>
            </>
          )}

          {view === "sessions" && (
            <>
              <SectionHeading
                eyebrow="CONNECTED DEVICES"
                title="WhatsApp sessions"
                description="Link multiple WhatsApp phones. Contacts and groups from every session merge into your centralized phonebook."
                action={
                  <button type="button" className="btn primary" onClick={() => setCreateSessionOpen(true)}>
                    <Plus size={16} aria-hidden="true"/> Add WhatsApp session
                  </button>
                }
              />
              {sessions.length ? (
                <div className="session-grid">
                  {sessions.map(s => (
                    <div className="session-card" key={s.id}>
                      <div className="session-row">
                        <div className="device-icon"><Smartphone size={25} aria-hidden="true"/></div>
                        <Flag value={s.status}/>
                      </div>
                      <div className="session-title-row">
                        <h3>{s.label}</h3>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={"Edit " + s.label}
                          onClick={() => setEditingSession({ id: s.id, label: s.label, publicSenderName: s.publicSenderName || "" })}
                        >
                          <Settings2 size={15} aria-hidden="true"/> Edit
                        </button>
                      </div>
                      <p>{s.phone ? "+" + s.phone : "Scan QR code to link phone"}</p>
                      <p className="session-public-identity">
                        {s.publicSenderName ? <>Optional footer name: <strong>{s.publicSenderName}</strong></> : "No footer signature set (optional)"}
                      </p>
                      <div className="session-details">
                        <div><span>Synced contacts</span><strong>{(s._count?.contacts ?? 0).toLocaleString()}</strong></div>
                        <div><span>WhatsApp groups</span><strong>{(s._count?.groups ?? 0).toLocaleString()}</strong></div>
                        <div><span>Last active</span><strong>{s.lastSeen ? formatDate(s.lastSeen) : "Never"}</strong></div>
                      </div>
                      {s.error && <div className="tiny-error">{s.error}</div>}
                      {s.sendingHold && (
                        <div className="notice danger" role="status" style={{ marginBottom: 10 }}>
                          <strong>Sending paused:</strong> {s.sendingHold.reason}{" "}
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void update("POST", "/api/v1/safety/review", { accountKey: s.accountKey || "session:" + s.id, confirmed: true, force: true }, "Session hold cleared")}
                          >
                            Clear hold
                          </button>
                        </div>
                      )}
                      {s.sync && (
                        <p role="status" className={s.sync.phase === "FAILED" ? "tiny-error" : "muted-footnote"}>
                          {s.sync.message} · {formatDate(s.sync.updatedAt)}
                        </p>
                      )}
                      <div className="session-actions" style={{ marginTop: 14 }}>
                        {s.status === "CONNECTED" ? (
                          <>
                            <button
                              type="button"
                              className="btn primary"
                              disabled={saving || s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING"}
                              onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/sync", {}, "Syncing contacts & groups…")}
                            >
                              <RefreshCw size={16} aria-hidden="true"/>{" "}
                              {s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING" ? "Syncing…" : "Sync phonebook & groups"}
                            </button>
                            <button
                              type="button"
                              className="btn outline"
                              aria-label={"Disconnect " + s.label}
                              disabled={saving}
                              onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Disconnect requested")}
                            >
                              <WifiOff size={16} aria-hidden="true"/>
                            </button>
                          </>
                        ) : s.status === "CONNECTING" ? (
                          <>
                            <button type="button" className="btn primary" disabled>
                              <RefreshCw className="spin" size={16} aria-hidden="true"/> Reconnecting…
                            </button>
                            <button
                              type="button"
                              className="btn outline"
                              aria-label={"Stop reconnecting " + s.label}
                              disabled={saving}
                              onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Stopped reconnecting")}
                            >
                              <WifiOff size={16} aria-hidden="true"/>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn primary"
                              disabled={saving}
                              onClick={() => {
                                setQrSession(s);
                                setQr(null);
                                if (s.status !== "QR_READY") {
                                  void update("POST", "/api/v1/sessions/" + s.id + "/connect", {}, s.phone ? "Restoring saved session…" : "Generating QR code…");
                                }
                              }}
                            >
                              <QrCode size={16} aria-hidden="true"/>{" "}
                              {s.status === "QR_READY" ? "Show QR" : s.phone ? "Restore session" : "Link device"}
                            </button>
                            <button
                              type="button"
                              className="btn outline"
                              aria-label={"Delete " + s.label}
                              disabled={saving}
                              onClick={() =>
                                confirmAction(
                                  `Delete session “${s.label}”?`,
                                  "This removes the linked session and its local login profile.",
                                  "Delete session",
                                  () => { void update("DELETE", "/api/v1/sessions/" + s.id, undefined, "Session deleted"); },
                                  true
                                )
                              }
                            >
                              <Trash2 size={16} aria-hidden="true"/>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Blank
                  icon={Smartphone}
                  title="No WhatsApp sessions yet"
                  desc="Add a session and scan the QR code with WhatsApp → Linked devices."
                  action={<button type="button" className="btn primary" onClick={() => setCreateSessionOpen(true)}><Plus size={16} aria-hidden="true"/> Add session</button>}
                />
              )}
              <div className="info-strip">
                <div className="info-icon"><Wifi size={20} aria-hidden="true"/></div>
                <div>
                  <strong>Automatic phonebook & group discovery</strong>
                  <p>As soon as you link a phone, CampaignDesk syncs all your contacts and WhatsApp groups into your centralized phonebook.</p>
                </div>
              </div>
            </>
          )}

          {view === "contacts" && (
            <>
              <SectionHeading
                eyebrow="CENTRALIZED AUDIENCE"
                title="Centralized Phonebook"
                description="One unified directory of contacts synced from your phones, extracted from WhatsApp groups, and imported via CSV."
                action={
                  <>
                    <a className="btn outline" href={exportCsvUrl()} download>
                      <ArrowUpFromLine size={16} aria-hidden="true"/> Export CSV
                    </a>
                    <button type="button" className="btn outline" onClick={() => setImportOpen(true)}>
                      <ArrowDownToLine size={16} aria-hidden="true"/> Import CSV
                    </button>
                    <button type="button" className="btn primary" onClick={() => setView("groups")}>
                      <Users size={16} aria-hidden="true"/> Export from groups
                    </button>
                  </>
                }
              />

              <section className="panel table-panel">
                <div className="filterbar">
                  <div className="search-box">
                    <Search size={17} aria-hidden="true"/>
                    <input
                      aria-label="Search centralized phonebook"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="Search names, phone numbers, or WhatsApp IDs…"
                      value={contactSearch}
                      onChange={e => { setContactSearch(e.target.value); setContactPage(1); clearSelection(); }}
                    />
                  </div>
                  <button
                    type="button"
                    aria-pressed={deduplicatePhonebook}
                    className={`btn ${deduplicatePhonebook ? "subtle filters-active" : "outline"}`}
                    onClick={() => { setDeduplicatePhonebook(v => !v); setContactPage(1); clearSelection(); }}
                  >
                    <Layers size={15} aria-hidden="true"/> {deduplicatePhonebook ? "Unified Phonebook" : "Per-session rows"}
                  </button>
                  <select
                    aria-label="Reachability filter"
                    value={statusFilter}
                    onChange={e => { setStatusFilter(e.target.value as typeof statusFilter); setContactPage(1); clearSelection(); }}
                  >
                    <option value="">All contacts</option>
                    <option value="active">Active (Reachable)</option>
                    <option value="opted_out">Opted out (Suppressed)</option>
                  </select>
                  <button
                    type="button"
                    className={`btn outline ${hasContactFilters ? "filters-active" : ""}`}
                    aria-expanded={contactFiltersOpen}
                    aria-controls="contact-filters"
                    onClick={() => setContactFiltersOpen(v => !v)}
                  >
                    <Settings2 size={15} aria-hidden="true"/> Filters{hasContactFilters ? ` (${Object.keys(directoryFilter).length})` : ""}
                  </button>
                  {hasContactFilters && (
                    <button type="button" className="text-button" onClick={resetContactFilters}>
                      Clear filters
                    </button>
                  )}
                </div>

                {contactFiltersOpen && (
                  <div className="directory-filters" id="contact-filters">
                    <select aria-label="Filter by segment" value={segmentFilter} onChange={e => { setSegmentFilter(e.target.value); setContactPage(1); clearSelection(); }}>
                      <option value="">All segments</option>
                      <option value="__unsegmented">Not in any segment</option>
                      {segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <select aria-label="Filter by group" value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setContactPage(1); clearSelection(); }}>
                      <option value="">All WhatsApp groups</option>
                      {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <select aria-label="Filter by source session" value={sessionFilter} onChange={e => { setSessionFilter(e.target.value); setContactPage(1); clearSelection(); }}>
                      <option value="">All phone sessions</option>
                      {sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                    <select aria-label="Filter by origin" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setContactPage(1); clearSelection(); }}>
                      <option value="">All origins</option>
                      <option value="mine">Phone address book</option>
                      <option value="groups">Extracted from groups</option>
                      <option value="other">CSV / Other</option>
                    </select>
                    <select aria-label="Filter by phone visibility" value={phoneFilter} onChange={e => { setPhoneFilter(e.target.value as "" | "usable" | "unavailable"); setContactPage(1); clearSelection(); }}>
                      <option value="">All phone visibility</option>
                      <option value="usable">Phone number visible</option>
                      <option value="unavailable">Hidden phone (@lid)</option>
                    </select>
                    <select aria-label="Filter by WhatsApp ID type" value={destinationFilter} onChange={e => { setDestinationFilter(e.target.value as "" | "phone" | "private"); setContactPage(1); clearSelection(); }}>
                      <option value="">All identity types</option>
                      <option value="phone">Phone JID (@c.us)</option>
                      <option value="private">Private JID (@lid)</option>
                    </select>
                  </div>
                )}

                <div className="bulk-toolbar">
                  <div>
                    <strong>{selectionCount.toLocaleString()} selected</strong>
                    {allMatching && <span> across all matching pages</span>}
                  </div>
                  <div className="action-buttons">
                    {selectionCount > 0 && (
                      <>
                        <button type="button" className="btn mini-primary" disabled={saving} onClick={organizeSelection}>
                          <FolderPlus size={14} aria-hidden="true"/> Add / Move to segment
                        </button>
                        {!allMatching && (
                          <button
                            type="button"
                            className="btn outline"
                            disabled={saving}
                            onClick={() => openCampaignBuilder({ audienceType: "CONTACTS", contactIds: resolveSelectedContactIds() })}
                          >
                            <Megaphone size={14} aria-hidden="true"/> Send DM campaign
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn outline"
                          disabled={saving}
                          onClick={() => void setContactReachability(allMatching ? { filter: directoryFilter } : { contactIds: resolveSelectedContactIds() }, true)}
                        >
                          <Check size={14} aria-hidden="true"/> Mark Active
                        </button>
                        <button
                          type="button"
                          className="btn outline"
                          disabled={saving}
                          onClick={() => void setContactReachability(allMatching ? { filter: directoryFilter } : { contactIds: resolveSelectedContactIds() }, false)}
                        >
                          Suppress
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={!contactTotal}
                      onClick={() => { setAllMatching(true); setSelectedContacts([]); }}
                    >
                      Select all {contactTotal.toLocaleString()} matching
                    </button>
                    {selectionCount > 0 && (
                      <button type="button" className="text-button" onClick={clearSelection}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div tabIndex={0} role="region" aria-label="Centralized phonebook contacts" className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">
                          <input
                            type="checkbox"
                            aria-label="Select page contacts"
                            ref={node => {
                              if (node) {
                                node.indeterminate =
                                  !allMatching &&
                                  contacts.some(c => selectedContacts.includes(c.id)) &&
                                  !contacts.every(c => selectedContacts.includes(c.id));
                              }
                            }}
                            checked={contacts.length > 0 && (allMatching || contacts.every(c => selectedContacts.includes(c.id)))}
                            onChange={e => {
                              setAllMatching(false);
                              setSelectedContacts(prev =>
                                e.target.checked
                                  ? [...new Set([...prev, ...contacts.map(c => c.id)])]
                                  : prev.filter(id => !contacts.some(c => c.id === id))
                              );
                            }}
                          />
                        </th>
                        <th scope="col">Contact</th>
                        <th scope="col">Sessions & groups</th>
                        <th scope="col">Segments</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.map(c => {
                        const isSuppressed = c.consent === "OPTED_OUT";
                        const groupBadges = c.sourceGroups || [];
                        return (
                          <tr key={c.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${c.name || c.phone || c.whatsappId}`}
                                checked={allMatching || selectedContacts.includes(c.id)}
                                onChange={() => {
                                  setAllMatching(false);
                                  setSelectedContacts(prev =>
                                    allMatching ? contacts.filter(x => x.id !== c.id).map(x => x.id) : toggle(prev, c.id)
                                  );
                                }}
                              />
                            </td>
                            <td>
                              <div className="name-cell">
                                <div className="person-avatar">{(c.name || c.phone || "?").charAt(0).toUpperCase()}</div>
                                <div>
                                  <strong>{c.name || (c.phone ? "+" + c.phone : "WhatsApp Contact")}</strong>
                                  <small>{c.phone ? "+" + c.phone : c.whatsappId}</small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <div className="contact-tags">
                                {(c.sourceSessions?.length ? c.sourceSessions : [c.session?.label || "Session"]).map(lbl => (
                                  <span className="source-tag" key={lbl}>{lbl}</span>
                                ))}
                                {c.isMyContact && <span className="source-tag">Phonebook</span>}
                                {groupBadges.slice(0, 2).map(g => (
                                  <button
                                    type="button"
                                    key={g.id}
                                    className="source-tag"
                                    onClick={() => { setGroupFilter(g.id); setContactPage(1); clearSelection(); }}
                                  >
                                    👥 {g.name}
                                  </button>
                                ))}
                                {groupBadges.length > 2 && <span className="source-tag">+{groupBadges.length - 2} groups</span>}
                                {!groupBadges.length && (c._count?.members ?? 0) > 0 && (
                                  <span className="source-tag">{c._count?.members} group(s)</span>
                                )}
                              </div>
                            </td>
                            <td>
                              <div className="contact-tags">
                                {c.segments?.length ? (
                                  c.segments.map(({ segment }) => (
                                    <button
                                      type="button"
                                      className="segment-tag"
                                      key={segment.id}
                                      onClick={() => { setSegmentFilter(segment.id); setContactPage(1); clearSelection(); }}
                                    >
                                      {segment.name}
                                    </button>
                                  ))
                                ) : (
                                  <span className="mono">—</span>
                                )}
                              </div>
                            </td>
                            <td>
                              <button
                                type="button"
                                className={`flag ${isSuppressed ? "flag-opted-out" : "flag-opted-in"}`}
                                title={isSuppressed ? "Click to re-enable contact" : "Active for campaigns (click to suppress)"}
                                disabled={saving}
                                onClick={() =>
                                  void setContactReachability({ contactIds: c.mergedIds?.length ? c.mergedIds : [c.id] }, isSuppressed)
                                }
                              >
                                <span className="flag-dot"/>
                                {isSuppressed ? "Opted out" : "Active"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {!contacts.length && (
                  <Blank
                    icon={ContactRound}
                    title="No contacts match"
                    desc="Sync a connected WhatsApp session, export contacts from your groups, or import a CSV."
                  />
                )}

                <div className="table-footer">
                  <span>
                    {contactTotal.toLocaleString()} {deduplicatePhonebook ? "unique people" : "contact records"} · {selectionCount.toLocaleString()} selected
                  </span>
                  <div className="pager">
                    <button type="button" aria-label="Previous contacts page" disabled={contactPage <= 1} onClick={() => setContactPage(x => x - 1)}>
                      <ArrowLeft size={16} aria-hidden="true"/>
                    </button>
                    <span>Page {contactPage} of {Math.max(1, Math.ceil(contactTotal / 40))}</span>
                    <button type="button" aria-label="Next contacts page" disabled={contactPage * 40 >= contactTotal} onClick={() => setContactPage(x => x + 1)}>
                      <ArrowRight size={16} aria-hidden="true"/>
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {view === "groups" && (
            <>
              <SectionHeading
                eyebrow="COMMUNITIES & GROUP EXTRACTION"
                title="WhatsApp groups"
                description="Send campaigns directly to groups your session belongs to, or export contacts from one or multiple groups into reusable segments."
                action={
                  <>
                    <button
                      type="button"
                      className="btn outline"
                      onClick={() => setView("sessions")}
                    >
                      <RefreshCw size={16} aria-hidden="true"/> Sync sessions
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!groups.length}
                      onClick={() => {
                        const chosen = selectedGroupIds.length ? groups.filter(g => selectedGroupIds.includes(g.id)) : groups;
                        const sessionId = chosen[0]?.sessionId || sessions[0]?.id || "";
                        openCampaignBuilder({
                          audienceType: "GROUPS",
                          sessionId,
                          groupIds: chosen.filter(g => g.sessionId === sessionId).map(g => g.id),
                        });
                      }}
                    >
                      <Send size={16} aria-hidden="true"/> Send group campaign
                    </button>
                  </>
                }
              />

              <section className="panel table-panel">
                <div className="filterbar">
                  <div className="search-box">
                    <Search size={17} aria-hidden="true"/>
                    <input
                      aria-label="Search WhatsApp groups"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="Filter groups by name or session…"
                      value={groupSearch}
                      onChange={e => setGroupSearch(e.target.value)}
                    />
                  </div>
                  {selectedGroupIds.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() =>
                          setOrganizer({
                            groups: groups
                              .filter(g => selectedGroupIds.includes(g.id))
                              .map(g => ({
                                id: g.id,
                                name: g.name,
                                sessionConnected: g.session.status === "CONNECTED",
                                savedMembers: g._count.members,
                                participantCount: g.participantCount,
                              })),
                          })
                        }
                      >
                        <Tags size={15} aria-hidden="true"/> Export {selectedGroupIds.length} group(s) to segment
                      </button>
                      <button
                        type="button"
                        className="btn outline"
                        onClick={() => {
                          const chosen = groups.filter(g => selectedGroupIds.includes(g.id));
                          const sessionId = chosen[0]?.sessionId || "";
                          openCampaignBuilder({
                            audienceType: "GROUPS",
                            sessionId,
                            groupIds: chosen.filter(g => g.sessionId === sessionId).map(g => g.id),
                          });
                        }}
                      >
                        <Megaphone size={15} aria-hidden="true"/> Campaign to selected
                      </button>
                      <a
                        className="btn outline"
                        href={`/api/v1/contacts/export?groupIds=${encodeURIComponent(selectedGroupIds.join(","))}&deduplicate=true`}
                        download
                      >
                        <ArrowUpFromLine size={15} aria-hidden="true"/> Export CSV
                      </a>
                      <button type="button" className="text-button" onClick={() => setSelectedGroupIds([])}>
                        Clear ({selectedGroupIds.length})
                      </button>
                    </>
                  )}
                </div>

                <div tabIndex={0} role="region" aria-label="WhatsApp groups" className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">
                          <input
                            type="checkbox"
                            aria-label="Select all visible groups"
                            checked={visibleGroups.length > 0 && visibleGroups.every(g => selectedGroupIds.includes(g.id))}
                            onChange={e =>
                              setSelectedGroupIds(
                                e.target.checked
                                  ? [...new Set([...selectedGroupIds, ...visibleGroups.map(g => g.id)])]
                                  : selectedGroupIds.filter(id => !visibleGroups.some(g => g.id === id))
                              )
                            }
                          />
                        </th>
                        <th scope="col">Group</th>
                        <th scope="col">Session</th>
                        <th scope="col">Members</th>
                        <th scope="col">Group sending</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGroups.map(g => (
                        <tr key={g.id} data-group-id={g.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select group ${g.name}`}
                              checked={selectedGroupIds.includes(g.id)}
                              onChange={() => setSelectedGroupIds(prev => toggle(prev, g.id))}
                            />
                          </td>
                          <td>
                            <div className="name-cell">
                              <div className="person-avatar purple"><Users size={18} aria-hidden="true"/></div>
                              <div>
                                <strong>{g.name}</strong>
                                <small>{g.whatsappId}</small>
                              </div>
                            </div>
                          </td>
                          <td>{g.session.label}</td>
                          <td>
                            <strong>{g.participantCount.toLocaleString()}</strong>
                            <small className="group-saved-count">{g._count.members.toLocaleString()} saved in phonebook</small>
                          </td>
                          <td>
                            <label className="switch-label">
                              <input
                                type="checkbox"
                                checked={g.allowPosting}
                                onChange={e => {
                                  void update(
                                    "PATCH",
                                    "/api/v1/groups/" + g.id,
                                    { allowPosting: e.target.checked },
                                    e.target.checked ? "Group enabled for campaigns" : "Group excluded from group posts"
                                  );
                                }}
                              />
                              <span>{g.allowPosting ? "Enabled" : "Paused"}</span>
                            </label>
                          </td>
                          <td>
                            <div className="action-buttons group-contact-actions">
                              <button
                                type="button"
                                className="btn primary"
                                disabled={saving}
                                onClick={() =>
                                  setOrganizer({
                                    group: {
                                      id: g.id,
                                      name: g.name,
                                      sessionConnected: g.session.status === "CONNECTED",
                                      savedMembers: g._count.members,
                                      participantCount: g.participantCount,
                                    },
                                  })
                                }
                              >
                                <Tags size={14} aria-hidden="true"/> Export to segment
                              </button>
                              <button
                                type="button"
                                className="btn outline"
                                onClick={() => openCampaignBuilder({ audienceType: "GROUPS", sessionId: g.sessionId, groupIds: [g.id] })}
                              >
                                <Send size={14} aria-hidden="true"/> Post in group
                              </button>
                              <button
                                type="button"
                                className="btn outline"
                                disabled={saving || syncPending(g.sync) || g.session.status !== "CONNECTED"}
                                onClick={() => void saveGroupContacts(g)}
                              >
                                <ContactRound size={14} aria-hidden="true"/> {syncPending(g.sync) ? "Syncing…" : "Sync to phonebook"}
                              </button>
                              <button
                                type="button"
                                className="btn subtle"
                                disabled={!g._count.members}
                                onClick={() => viewGroupContacts(g)}
                              >
                                View ({g._count.members})
                              </button>
                            </div>
                            {g.sync && (
                              <p role="status" className={`group-save-status ${g.sync.phase === "FAILED" ? "tiny-error" : "muted-footnote"}`}>
                                {g.sync.message}
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {!groups.length && (
                  <Blank
                    icon={Users}
                    title="No WhatsApp groups discovered yet"
                    desc="Connect and sync a WhatsApp session to load every group you belong to."
                  />
                )}
              </section>
            </>
          )}

          {view === "segments" && (
            <>
              <SectionHeading
                eyebrow="REUSABLE AUDIENCES"
                title="Contact segments"
                description="Combine contacts from multiple WhatsApp groups, phone sessions, and CSV imports into high-capacity segments."
                action={
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setEditingSegmentId(null);
                      setNewSegment("");
                      setSegmentDesc("");
                      setSegmentOpen(true);
                    }}
                  >
                    <Plus size={16} aria-hidden="true"/> New segment
                  </button>
                }
              />

              {segments.length ? (
                <div className="segment-grid">
                  {segments.map(s => (
                    <section className="segment-card" key={s.id} data-segment-id={s.id}>
                      <div className="segment-icon"><Tags size={21} aria-hidden="true"/></div>
                      <h3>{s.name}</h3>
                      <p>{s.description || "Combined phonebook & group audience."}</p>
                      <div className="segment-eligibility">
                        <strong>{(s.eligibleCount ?? s._count.members).toLocaleString()}</strong>
                        <span>active unique contacts ready</span>
                      </div>
                      <div className="contact-tags" style={{ marginBottom: 14 }}>
                        {(s.groupSourcedCount ?? 0) > 0 && <span className="source-tag">👥 {s.groupSourcedCount?.toLocaleString()} from groups</span>}
                        {(s.optedOutCount ?? 0) > 0 && <span className="source-tag">{s.optedOutCount?.toLocaleString()} opted out</span>}
                      </div>
                      <div className="segment-card-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={!s._count.members}
                          onClick={() => openCampaignBuilder({ audienceType: "CONTACTS", segmentIds: [s.id] })}
                        >
                          <Megaphone size={14} aria-hidden="true"/> Send campaign
                        </button>
                        <button type="button" className="btn outline" onClick={() => browseSegment(s)}>
                          Browse <ChevronRight size={15} aria-hidden="true"/>
                        </button>
                        <button
                          type="button"
                          className="btn subtle"
                          disabled={!s._count.members}
                          onClick={() => setOrganizer({ selection: { filter: { segmentId: s.id } }, count: s._count.members, sourceSegmentId: s.id })}
                        >
                          Combine / Move
                        </button>
                        <a className="btn subtle" href={`/api/v1/contacts/export?segmentId=${encodeURIComponent(s.id)}&deduplicate=true`} download>
                          CSV
                        </a>
                      </div>
                      <div className="segment-bottom">
                        <span><Users size={15} aria-hidden="true"/> {s._count.members.toLocaleString()} total records</span>
                        <div>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setEditingSegmentId(s.id);
                              setNewSegment(s.name);
                              setSegmentDesc(s.description || "");
                              setSegmentOpen(true);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={"Delete " + s.name}
                            disabled={saving}
                            onClick={() =>
                              confirmAction(
                                "Delete this segment?",
                                `“${s.name}” will be removed, while all contacts remain safe in your centralized phonebook.`,
                                "Delete segment",
                                () => { void update("DELETE", "/api/v1/segments/" + s.id, undefined, "Segment deleted"); },
                                true
                              )
                            }
                          >
                            <Trash2 size={16} aria-hidden="true"/>
                          </button>
                        </div>
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <Blank
                  icon={Tags}
                  title="No segments yet"
                  desc="Create a segment here, or export contacts directly from one or multiple WhatsApp groups."
                  action={
                    <button type="button" className="btn primary" onClick={() => { setEditingSegmentId(null); setSegmentOpen(true); }}>
                      <Plus size={16} aria-hidden="true"/> New segment
                    </button>
                  }
                />
              )}
            </>
          )}

          {view === "templates" && (
            <>
              <SectionHeading
                eyebrow="MESSAGE DESIGN STUDIO"
                title="Custom message templates"
                description="Design reusable messages with WhatsApp formatting, personalization tokens, and media for 1-click campaign creation."
              />
              <TemplateStudio
                templates={templates}
                request={api}
                refresh={loadAll}
                inform={inform}
                onUseTemplate={tpl => {
                  openCampaignBuilder({
                    templateId: tpl.id,
                    message: tpl.body,
                    includeFooter: tpl.includeFooter,
                    mediaKey: tpl.mediaKey || undefined,
                    mediaMime: tpl.mediaMime || undefined,
                    mediaName: tpl.mediaName || undefined,
                    audienceType: tpl.category.toLowerCase() === "groups" ? "GROUPS" : "CONTACTS",
                  });
                }}
              />
            </>
          )}

          {view === "campaigns" && (
            <>
              <SectionHeading
                eyebrow="AUTOMATION & BROADCASTS"
                title="Campaigns"
                description="Send instant, scheduled, or hourly interval campaigns (1h, 2h, 3h, 4h, 5h, 6h…) to segments, individual DMs, or WhatsApp groups."
                action={
                  <button type="button" className="btn primary" onClick={() => openCampaignBuilder()}>
                    <Plus size={16} aria-hidden="true"/> Create campaign
                  </button>
                }
              />

              <div className="automation-health">
                <span className={health?.workerReady && activeSessions ? "automation-online" : "automation-offline"}>
                  <Activity size={16} aria-hidden="true"/>
                  {health?.workerReady
                    ? activeSessions
                      ? "Worker & WhatsApp online · Hands-free auto-recovery active"
                      : "Worker online · Connect a WhatsApp session to send"
                    : "Background worker is offline"}
                </span>
                <span>Automatic pacing · Self-healing continuations · Live receipts</span>
                {(!activeSessions || !health?.workerReady) && (
                  <button type="button" className="text-button" onClick={() => setView(!activeSessions ? "sessions" : "settings")}>
                    {!activeSessions ? "Connect WhatsApp" : "Check service status"} <ArrowRight size={14} aria-hidden="true"/>
                  </button>
                )}
              </div>

              {[...new Map(sessions.filter(s => s.sendingHold).map(s => [s.sendingHold!.accountKey, { session: s, hold: s.sendingHold! }])).values()].map(({ session: s, hold }) => (
                <div className="sending-hold" key={hold.accountKey} role="status" style={{ marginBottom: 16 }}>
                  <div className="sending-hold-head">
                    <div>
                      <h3>{hold.accountKey === "workspace" ? "Workspace sending paused" : `Sending hold · ${s.label}`}</h3>
                      <p>{hold.reason}</p>
                    </div>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={saving}
                      onClick={() => void update("POST", "/api/v1/safety/review", { accountKey: hold.accountKey, confirmed: true, force: true }, "Sending hold cleared")}
                    >
                      <Play size={14} aria-hidden="true"/> Clear hold now
                    </button>
                  </div>
                </div>
              ))}

              <DeliveryStats
                totals={reportTotals ?? deliveryTotals([])}
                uniqueRecipientsSent={reportTotals?.uniqueRecipientsSent}
                directoryOptedOut={reportTotals?.directoryOptedOut}
              />

              <div className="campaign-toolbar">
                <div className="search-box">
                  <Search size={17} aria-hidden="true"/>
                  <input
                    aria-label="Search campaigns"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="Find a campaign or sending session…"
                    value={campaignSearch}
                    onChange={event => setCampaignSearch(event.target.value)}
                  />
                </div>
                <select aria-label="Campaign status filter" value={campaignStatusFilter} onChange={event => setCampaignStatusFilter(event.target.value)}>
                  <option value="ALL">All campaigns ({campaigns.length})</option>
                  <option value="ACTIVE">Running ({campaigns.filter(c => c.status === "ACTIVE").length})</option>
                  <option value="SCHEDULED">Scheduled / Recurring ({campaigns.filter(c => c.status === "SCHEDULED").length})</option>
                  <option value="PAUSED">Paused / Standby ({campaigns.filter(c => c.status === "PAUSED").length})</option>
                  <option value="DRAFT">Drafts ({campaigns.filter(c => c.status === "DRAFT").length})</option>
                  <option value="COMPLETED">Completed ({campaigns.filter(c => c.status === "COMPLETED").length})</option>
                </select>
              </div>

              {campaigns.length > 0 && !visibleCampaigns.length && (
                <Blank icon={Search} title="No matching campaigns" desc="Try clearing your search or status filter."/>
              )}

              <div className="campaign-list">
                {visibleCampaigns.map(c => {
                  const totals = c.summary ?? deliveryTotals([]);
                  const scheduleLabel =
                    c.scheduleType === "NOW"
                      ? "Instant launch"
                      : c.scheduleType === "ONCE"
                        ? `Once · ${formatDate(c.scheduledAt)}`
                        : c.intervalHours
                          ? `Every ${c.intervalHours} hour${c.intervalHours === 1 ? "" : "s"}`
                          : `Cron (${c.cron}) · ${c.timezone}`;
                  const repeatLabel =
                    c.repeatPolicy === "NO_REPEAT"
                      ? "Do not repeat across campaigns"
                      : c.repeatPolicy === "COOLDOWN"
                        ? `${c.repeatCooldownHours ?? 24}h cooldown`
                        : "Allow repeat";

                  return (
                    <article className="campaign-card" key={c.id}>
                      <div className="campaign-card-head">
                        <div className="campaign-card-heading">
                          <div className="person-avatar orange"><Megaphone size={17} aria-hidden="true"/></div>
                          <div>
                            <h2>{c.name}</h2>
                            <p>{c.session.label} · Created {formatDate(c.createdAt)}</p>
                          </div>
                        </div>
                        <Flag value={c.status}/>
                      </div>

                      <div className="campaign-card-meta">
                        <span>
                          <Users size={14} aria-hidden="true"/>
                          {c.audienceType === "GROUPS"
                            ? `${c._count.groups} WhatsApp group(s)`
                            : c.audienceType === "BOTH"
                              ? `${c._count.groups} group(s) + ${c._count.segments} segment(s) / ${c._count.contacts} DMs`
                              : `${c._count.segments} segment(s) · ${c._count.contacts} DMs · ${c._count.groups} group source(s)`}
                        </span>
                        <span><CalendarClock size={14} aria-hidden="true"/>{scheduleLabel}</span>
                        <span><Repeat size={14} aria-hidden="true"/>{repeatLabel}</span>
                        <span>{c._count.runs} run{c._count.runs === 1 ? "" : "s"}</span>
                      </div>

                      <DeliveryStats totals={totals} compact/>

                      {historyStatuses[c.sessionId] && ["QUEUED", "RUNNING", "FAILED"].includes(historyStatuses[c.sessionId].phase) && (
                        <p className="muted-footnote" role="status">
                          <strong>Receipt sync ({historyStatuses[c.sessionId].phase.toLowerCase()}):</strong> {historyStatuses[c.sessionId].message}
                        </p>
                      )}

                      <div className="campaign-card-foot">
                        <p>
                          {c.runs[0]
                            ? c.scheduleType !== "CRON" && c._count.runs > 1 && c.runs[0].summary.sent === 0 && c.runs[0].summary.pending === 0 && totals.sent > 0
                              ? `Cumulative (${c._count.runs} runs): ${totals.sent.toLocaleString()} sent · ${totals.delivered.toLocaleString()} delivered · ${totals.read.toLocaleString()} read`
                              : `Latest run: ${c.runs[0].summary.sent.toLocaleString()} sent · ${c.runs[0].summary.delivered.toLocaleString()} delivered · ${c.runs[0].summary.pending.toLocaleString()} queued`
                            : "Draft · Ready to launch"}
                        </p>
                        <div className="action-buttons">
                          <button type="button" className="btn outline" onClick={() => void inspectCampaign(c.id)}>
                            Results & replies
                          </button>
                          <button
                            type="button"
                            className="btn outline"
                            disabled={
                              c.session.status !== "CONNECTED" ||
                              !!historyRequesting ||
                              ["QUEUED", "RUNNING"].includes(historyStatuses[c.sessionId]?.phase || "")
                            }
                            onClick={() => void reconcileHistory(c.sessionId)}
                          >
                            <RefreshCw size={14} aria-hidden="true"/>{" "}
                            {["QUEUED", "RUNNING"].includes(historyStatuses[c.sessionId]?.phase || "") ? "Syncing…" : "Sync receipts"}
                          </button>
                          <button
                            type="button"
                            className="btn subtle"
                            disabled={saving || ["ACTIVE", "SCHEDULED"].includes(c.status)}
                            title={["ACTIVE", "SCHEDULED"].includes(c.status) ? "Pause first to edit" : "Edit campaign"}
                            onClick={() => void editCampaign(c.id)}
                          >
                            <Settings2 size={14} aria-hidden="true"/> Edit
                          </button>
                          {c.status === "DRAFT" && (c.launchVersion ?? 0) > 0 && !c.runsCompleted && (
                            <button
                              type="button"
                              className="btn mini-primary"
                              disabled={saving}
                              onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "resume" }, "Campaign resumed")}
                            >
                              <Play size={14} aria-hidden="true"/> Continue
                            </button>
                          )}
                          {c.status === "DRAFT" && (
                            <button
                              type="button"
                              className={(c.launchVersion ?? 0) > 0 && !c.runsCompleted ? "btn outline" : "btn mini-primary"}
                              disabled={saving}
                              onClick={() => void launchCampaign(c.id)}
                            >
                              <Play size={14} aria-hidden="true"/> {(c.launchVersion ?? 0) > 0 && !c.runsCompleted ? "New run" : "Launch"}
                            </button>
                          )}
                          {["COMPLETED", "CANCELLED"].includes(c.status) && (
                            <button type="button" className="btn mini-primary" disabled={saving} onClick={() => void relaunchCampaign(c.id)}>
                              <RefreshCw size={14} aria-hidden="true"/> Relaunch now
                            </button>
                          )}
                          {["ACTIVE", "SCHEDULED"].includes(c.status) && (
                            <button
                              type="button"
                              className="btn outline"
                              disabled={saving}
                              onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "pause" }, "Campaign paused")}
                            >
                              <Square size={13} aria-hidden="true"/> Pause
                            </button>
                          )}
                          {c.status === "PAUSED" && (
                            <button
                              type="button"
                              className="btn mini-primary"
                              disabled={saving}
                              onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "resume" }, "Campaign resumed")}
                            >
                              <Play size={14} aria-hidden="true"/> Resume
                            </button>
                          )}
                          {["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status) && (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Cancel ${c.name}`}
                              disabled={saving}
                              onClick={() =>
                                confirmAction(
                                  "Cancel campaign?",
                                  `Stop future runs of “${c.name}”?`,
                                  "Cancel campaign",
                                  () => { void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "cancel" }, "Campaign cancelled"); },
                                  true
                                )
                              }
                            >
                              <X size={16} aria-hidden="true"/>
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Delete ${c.name}`}
                            disabled={saving || ["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status)}
                            onClick={() =>
                              confirmAction(
                                "Delete campaign?",
                                `Permanently delete “${c.name}” and its run logs? Contacts and segments stay untouched.`,
                                "Delete campaign",
                                () => { void update("DELETE", "/api/v1/campaigns/" + c.id, undefined, "Campaign deleted"); },
                                true
                              )
                            }
                          >
                            <Trash2 size={16} aria-hidden="true"/>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              {!campaigns.length && (
                <section className="panel">
                  <Blank
                    icon={Megaphone}
                    title="Your first campaign starts here"
                    desc="Send to contact segments, individual DMs, or WhatsApp groups—instantly or on an hourly cron."
                    action={
                      <button type="button" className="btn primary" onClick={() => openCampaignBuilder()}>
                        <Plus size={16} aria-hidden="true"/> Create campaign
                      </button>
                    }
                  />
                </section>
              )}
            </>
          )}

          {view === "reports" && (
            <>
              <SectionHeading
                eyebrow="ACCURATE TELEMETRY"
                title="Delivery reports"
                description="Verified WhatsApp server receipts (Sent ✓), device delivery receipts (Delivered ✓✓), Read receipts, Replies, and Opt-outs."
                action={
                  <button type="button" className="btn outline" onClick={() => void refresh()}>
                    <RefreshCw size={16} aria-hidden="true"/> Refresh
                  </button>
                }
              />

              <DeliveryStats
                totals={reportTotals ?? deliveryTotals([])}
                uniqueRecipientsSent={reportTotals?.uniqueRecipientsSent}
                directoryOptedOut={reportTotals?.directoryOptedOut}
              />

              <section className="panel table-panel">
                <div tabIndex={0} role="region" aria-label="Campaign delivery runs" className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Campaign / started</th>
                        <th scope="col">Status</th>
                        <th scope="col">Queued</th>
                        <th scope="col">Sent (✓)</th>
                        <th scope="col">Delivered (✓✓)</th>
                        <th scope="col">Read</th>
                        <th scope="col">Replied</th>
                        <th scope="col">Opted out</th>
                        <th scope="col">Skipped</th>
                        <th scope="col">Failed / Unconf.</th>
                        <th scope="col">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map(r => {
                        const totals = deliveryTotals(r.deliveries);
                        return (
                          <tr key={r.id}>
                            <td>
                              <strong>{r.campaign.name}</strong>
                              <small className="group-saved-count">{formatDate(r.startedAt)}</small>
                            </td>
                            <td>
                              <Flag value={r.status}/>
                              {r.error && <small className="group-saved-count tiny-error">{r.error}</small>}
                            </td>
                            <td>{totals.pending.toLocaleString()}</td>
                            <td><strong>{totals.sent.toLocaleString()}</strong></td>
                            <td>{totals.delivered.toLocaleString()}</td>
                            <td>{totals.read.toLocaleString()}</td>
                            <td>
                              {totals.replied.toLocaleString()}{" "}
                              {totals.replies > 0 && <small>({totals.replies} msg)</small>}
                            </td>
                            <td>{totals.optedOut.toLocaleString()}</td>
                            <td>{totals.skipped.toLocaleString()}</td>
                            <td>{totals.failed} / {totals.uncertain}</td>
                            <td>
                              <button type="button" className="btn subtle" onClick={() => void inspectCampaign(r.campaignId, undefined, r.id)}>
                                Inspect
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!runs.length && (
                  <Blank icon={BarChart3} title="No runs recorded yet" desc="Launch a campaign to track live delivery receipts and replies."/>
                )}
              </section>
            </>
          )}

          {view === "settings" && (
            <>
              <SectionHeading
                eyebrow="WORKSPACE RULES"
                title="Settings & operating hours"
                description="Choose 24/7 or custom sending hours, tune per-15-minute rate caps, and check background worker connectivity."
              />
              <div className="info-strip" style={{ marginTop: 0, marginBottom: 20 }}>
                <div className="info-icon"><Activity size={20} aria-hidden="true"/></div>
                <div>
                  <strong>Live service health</strong>
                  <p>
                    {health
                      ? `PostgreSQL: ${health.database} · Redis: ${health.redis === "PONG" ? "connected" : health.redis} · Worker: ${
                          health.workerReady ? "online & processing jobs" : "offline (run npm run dev:all or npm run worker)"
                        }`
                      : "Checking services…"}
                  </p>
                </div>
              </div>
              <SendingSafety request={api} changed={refresh}/>
              <div className="settings-grid">
                <section className="panel settings-panel">
                  <h2><ShieldCheck size={19} aria-hidden="true"/> Automatic STOP suppression</h2>
                  <p>Contacts are active by default when synced or exported from groups. Anyone who replies STOP or UNSUBSCRIBE is immediately marked Opted Out across all future DM campaigns.</p>
                </section>
                <section className="panel settings-panel">
                  <h2><CalendarClock size={19} aria-hidden="true"/> Interval & standby engine</h2>
                  <p>BullMQ powers exact fixed-hour crons (1h, 2h, 3h, 4h, 5h, 6h…) and calendar schedules while respecting your per-15-minute pacing and per-campaign repeat policy.</p>
                </section>
              </div>
            </>
          )}
        </main>
      </div>

      {createSessionOpen && (
        <Modal title="Add WhatsApp session" close={() => setCreateSessionOpen(false)}>
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (await update("POST", "/api/v1/sessions", { label: newSession, publicSenderName: newPublicSender }, "Session created")) {
                setCreateSessionOpen(false);
                setNewSession("");
                setNewPublicSender("");
              }
            }}
          >
            <div className="modal-body">
              <p className="modal-help">Name this phone connection for your workspace.</p>
              <div>
                <label htmlFor="new-session-label">Session nickname</label>
                <input
                  id="new-session-label"
                  required
                  minLength={2}
                  maxLength={80}
                  value={newSession}
                  placeholder="e.g. Main Sales Phone"
                  onChange={e => setNewSession(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="new-session-sender">Optional sender signature (only used if footer enabled)</label>
                <input
                  id="new-session-sender"
                  maxLength={80}
                  value={newPublicSender}
                  placeholder="e.g. Acme Team (optional)"
                  onChange={e => setNewPublicSender(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn outline" disabled={saving} onClick={() => setCreateSessionOpen(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || newSession.trim().length < 2}>Create session</button>
            </div>
          </form>
        </Modal>
      )}

      {editingSession && (
        <Modal title="Edit WhatsApp session" close={() => { if (!saving) setEditingSession(null); }}>
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!editingSession) return;
              if (
                await update(
                  "PATCH",
                  "/api/v1/sessions/" + editingSession.id,
                  { label: editingSession.label, publicSenderName: editingSession.publicSenderName },
                  "Session updated"
                )
              ) {
                setEditingSession(null);
              }
            }}
          >
            <div className="modal-body">
              <div>
                <label htmlFor="edit-session-label">Session nickname (internal)</label>
                <input
                  id="edit-session-label"
                  required
                  minLength={2}
                  maxLength={80}
                  value={editingSession.label}
                  onChange={e => setEditingSession(prev => prev && { ...prev, label: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="edit-session-sender">Optional sender signature</label>
                <input
                  id="edit-session-sender"
                  maxLength={80}
                  value={editingSession.publicSenderName}
                  placeholder="Optional business/team name"
                  onChange={e => setEditingSession(prev => prev && { ...prev, publicSenderName: e.target.value })}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn outline" disabled={saving} onClick={() => setEditingSession(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || editingSession.label.trim().length < 2}>
                {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>} Save
              </button>
            </div>
          </form>
        </Modal>
      )}

      {qrSession && (
        <Modal title={(qrSession.phone ? "Restore " : "Link ") + qrSession.label} close={() => setQrSession(null)}>
          <div className="qr-content">
            <p>
              {qrSession.phone && !qr ? (
                "Reopening saved WhatsApp login…"
              ) : (
                <>On your phone, open <strong>WhatsApp → Linked devices → Link a device</strong> and scan this QR code.</>
              )}
            </p>
            {qr ? (
              <div className="qr-box"><QRCodeSVG value={qr} size={244}/></div>
            ) : (
              <div className="qr-placeholder">
                <LoaderCircle className="spin" size={34} aria-hidden="true"/>
                <span>{qrSession.phone ? "Restoring session…" : "Waiting for QR code from worker…"}</span>
              </div>
            )}
            {sessions.find(s => s.id === qrSession.id)?.error && (
              <div className="notice danger">{sessions.find(s => s.id === qrSession.id)?.error}</div>
            )}
            <button
              type="button"
              className="btn outline full"
              onClick={() => { void update("POST", "/api/v1/sessions/" + qrSession.id + "/connect", {}, "Reconnection requested"); }}
            >
              Retry connection
            </button>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="Import contacts to phonebook" close={() => setImportOpen(false)} wide>
          <form
            onSubmit={async e => {
              e.preventDefault();
              try {
                const records = parseContactCsv(importData);
                if (!records.length) return inform("Add at least one contact row", true);
                if (
                  await update(
                    "POST",
                    "/api/v1/contacts/import",
                    {
                      sessionId: importSessionId || sessions[0]?.id,
                      contacts: records,
                      ...(importSegmentId && importSegmentId !== "__new" ? { segmentIds: [importSegmentId] } : {}),
                      ...(importSegmentId === "__new" && importNewSegment.trim().length >= 2
                        ? { newSegment: { name: importNewSegment.trim() } }
                        : {}),
                    },
                    `Imported ${records.length.toLocaleString()} contacts into your centralized phonebook.`
                  )
                ) {
                  setImportOpen(false);
                  setImportData("");
                  setImportNewSegment("");
                }
              } catch (err) {
                inform(err instanceof Error ? err.message : "Invalid CSV", true);
              }
            }}
          >
            <div className="modal-body">
              <p className="modal-help">
                Paste <code>phone,name</code> rows or upload a CSV file. Imported contacts are active immediately unless previously opted out.
              </p>
              <div className="form-grid">
                <div>
                  <label htmlFor="import-session">Associate with session</label>
                  <select
                    id="import-session"
                    value={importSessionId || sessions[0]?.id || ""}
                    onChange={e => setImportSessionId(e.target.value)}
                  >
                    {sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="import-segment">Also add to segment (optional)</label>
                  <select id="import-segment" value={importSegmentId} onChange={e => setImportSegmentId(e.target.value)}>
                    <option value="">Phonebook only</option>
                    <option value="__new">+ Create new segment…</option>
                    {segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              {importSegmentId === "__new" && (
                <div>
                  <label htmlFor="import-new-segment">New segment name</label>
                  <input
                    id="import-new-segment"
                    required
                    minLength={2}
                    maxLength={80}
                    value={importNewSegment}
                    placeholder="e.g. Imported Leads"
                    onChange={e => setImportNewSegment(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label htmlFor="import-csv-file">Load from .csv file (optional)</label>
                <input
                  id="import-csv-file"
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={async e => {
                    const file = e.target.files?.[0];
                    if (file) setImportData(await file.text());
                  }}
                />
              </div>
              <div>
                <label htmlFor="import-csv-text">CSV rows</label>
                <textarea
                  id="import-csv-text"
                  rows={7}
                  placeholder={"phone,name\n254700000001,Jane Doe\n254700000002,John Doe"}
                  value={importData}
                  onChange={e => setImportData(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn outline" onClick={() => setImportOpen(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || !sessions.length}>
                <ArrowDownToLine size={16} aria-hidden="true"/> Import contacts
              </button>
            </div>
          </form>
        </Modal>
      )}

      {organizer && (
        <Modal
          title={organizer.groups?.length || organizer.group ? "Export group contacts to segment" : "Organize contacts into segments"}
          close={() => setOrganizer(null)}
          wide
        >
          <ContactOrganizer
            segments={segments}
            {...organizer}
            request={api}
            close={() => setOrganizer(null)}
            saved={async message => {
              setOrganizer(null);
              clearSelection();
              setSelectedGroupIds([]);
              await refresh();
              inform(message);
            }}
          />
        </Modal>
      )}

      {segmentOpen && (
        <Modal title={editingSegmentId ? "Edit segment" : "Create segment"} close={() => setSegmentOpen(false)}>
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (
                await update(
                  editingSegmentId ? "PATCH" : "POST",
                  editingSegmentId ? "/api/v1/segments/" + editingSegmentId : "/api/v1/segments",
                  { name: newSegment, description: segmentDesc },
                  editingSegmentId ? "Segment updated" : "Segment created"
                )
              ) {
                setSegmentOpen(false);
                setEditingSegmentId(null);
                setNewSegment("");
                setSegmentDesc("");
              }
            }}
          >
            <div className="modal-body">
              <p className="modal-help">Segments are shared across all sending sessions and can hold contacts from any group or phonebook.</p>
              <div>
                <label htmlFor="segment-modal-name">Segment name</label>
                <input
                  id="segment-modal-name"
                  required
                  minLength={2}
                  maxLength={80}
                  value={newSegment}
                  placeholder="e.g. All Community Members"
                  onChange={e => setNewSegment(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="segment-modal-desc">Description (optional)</label>
                <textarea
                  id="segment-modal-desc"
                  rows={3}
                  maxLength={250}
                  value={segmentDesc}
                  onChange={e => setSegmentDesc(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn outline" onClick={() => setSegmentOpen(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || newSegment.trim().length < 2}>
                {editingSegmentId ? "Save changes" : "Create segment"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirmation && (
        <Modal title={confirmation.title} close={() => setConfirmation(null)}>
          <div className="modal-body confirm-content">
            <div className={`confirm-icon ${confirmation.destructive ? "danger" : ""}`}>
              {confirmation.destructive ? <Trash2 size={23} aria-hidden="true"/> : <ShieldCheck size={23} aria-hidden="true"/>}
            </div>
            <p>{confirmation.description}</p>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn outline" autoFocus onClick={() => setConfirmation(null)}>Cancel</button>
            <button
              type="button"
              className={`btn ${confirmation.destructive ? "danger-action" : "primary"}`}
              onClick={() => {
                const action = confirmation.onConfirm;
                setConfirmation(null);
                action();
              }}
            >
              {confirmation.confirmLabel}
            </button>
          </div>
        </Modal>
      )}

      {inspectedMembers && (
        <Modal title={inspectedMembers.group.name + " members"} close={() => setInspectedMembers(null)}>
          <div className="modal-body">
            <p className="modal-help">
              Showing {inspectedMembers.members.length} of {inspectedMembers.group._count.members} saved contacts.
            </p>
            <div className="member-list">
              {inspectedMembers.members.map(m => (
                <div className="member-row" key={m.contact.id}>
                  <span>{m.contact.name || m.contact.phone || m.contact.whatsappId}</span>
                  <Flag value={m.contact.consent === "OPTED_OUT" ? "OPTED_OUT" : "ACTIVE"}/>
                </div>
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn outline" disabled={!inspectedMembers.group._count.members} onClick={() => viewGroupContacts(inspectedMembers.group)}>
              Open in Phonebook
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const grp = inspectedMembers.group;
                setInspectedMembers(null);
                setOrganizer({
                  group: {
                    id: grp.id,
                    name: grp.name,
                    sessionConnected: grp.session.status === "CONNECTED",
                    savedMembers: grp._count.members,
                    participantCount: grp.participantCount,
                  },
                });
              }}
            >
              <Tags size={15} aria-hidden="true"/> Export to segment
            </button>
          </div>
        </Modal>
      )}

      {inspectedCampaign && (
        <Modal title={inspectedCampaign.name} close={() => { setInspectedCampaign(null); setAudiencePreview(null); }} wide>
          <div className="modal-body">
            <div>
              <div className="result-scope">
                <h3>Cumulative campaign metrics</h3>
                <p>Across {inspectedCampaign._count.runs} run(s)</p>
              </div>
              <DeliveryStats totals={inspectedCampaign.summary}/>
            </div>
            <CampaignResults
              key={inspectedCampaign.id + ":" + (inspectedRunId || "all")}
              runs={inspectedCampaign.runs}
              totalRuns={inspectedCampaign._count.runs}
              initialRunId={inspectedRunId}
              confirmSent={async (deliveryId, note) => {
                await api("/api/v1/campaigns/" + inspectedCampaign.id + "/reconcile", {
                  method: "POST",
                  body: { deliveryId, note, confirmed: true },
                });
                await inspectCampaign(inspectedCampaign.id, undefined, inspectedRunId ?? undefined);
                await refresh();
              }}
            />
            <details className="campaign-audience-review">
              <summary>Saved message & current target resolution</summary>
              <div className="message-preview" style={{ marginTop: 10 }}>{inspectedCampaign.message}</div>
              {inspectedCampaign.mediaName && <p className="muted-footnote">Attachment: {inspectedCampaign.mediaName}</p>}
              <div className="detail-row">
                <strong>Active destinations right now</strong>
                <strong>{audiencePreview?.count.toLocaleString() ?? "…"}</strong>
              </div>
              {audiencePreview && (
                <p className="muted-footnote">
                  {audiencePreview.total.toLocaleString()} selected records · {audiencePreview.duplicates.toLocaleString()} duplicates merged · {audiencePreview.excluded.toLocaleString()} excluded/opted-out
                </p>
              )}
            </details>
          </div>
        </Modal>
      )}

      {campaignOpen && (
        <Modal
          title={editingCampaignId ? "Edit campaign" : "Create campaign"}
          close={() => { if (!saving) setCampaignOpen(false); }}
          wide
          lightDismiss={false}
        >
          <CampaignComposer
            initial={campaignForm}
            campaignId={editingCampaignId}
            hasHistory={campaignHasHistory}
            canContinue={campaignCanContinue}
            sentCount={campaignSentCount}
            sessions={sessions}
            segments={segments}
            groups={groups}
            templates={templates}
            onTemplatesChanged={loadAll}
            request={api}
            busyChanged={setSaving}
            close={() => { if (!saving) setCampaignOpen(false); }}
            saved={async message => {
              setCampaignOpen(false);
              setEditingCampaignId(null);
              await refresh();
              setView("campaigns");
              inform(message);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
