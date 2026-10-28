"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BarChart3, CalendarClock, Check,
  CheckCircle2, ChevronRight, CircleHelp, ContactRound, FolderPlus,
  LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Megaphone,
  MessageCircle, Play, Plus, QrCode, RefreshCw, Search, Send, Settings2,
  ShieldCheck, Smartphone, Square, Tags, Trash2, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { parseContactCsv } from "@/lib/csv";
import ContactOrganizer from "./contact-organizer";
import SendingSafety from "./sending-safety";
import CampaignComposer, { type CampaignForm } from "./campaign-composer";
import CampaignResults, { DeliveryStats, type ResultRun } from "./campaign-results";
import { deliveryTotals, type DeliveryTotals } from "@/lib/reporting";
import { isDirectWhatsAppId } from "@/lib/whatsapp-id";
import type { ContactFilter, ContactSelection } from "@/lib/contact-selection";
import { dateTimeInZone } from "@/lib/timezone";
import type { SyncState } from "@/lib/sync-state";

type View = "overview" | "sessions" | "contacts" | "groups" | "segments" | "campaigns" | "reports" | "settings";
type Session = { publicSenderName?: string | null; accountKey?: string; sendingHold?: { reason: string; notBefore: string | null } | null; id: string; label: string; phone?: string | null; status: string; error?: string | null; lastSeen?: string | null; sync?: { phase: string; message: string; updatedAt: string } | null; _count?: { contacts: number; groups: number } };
type Contact = { id: string; sessionId: string; whatsappId: string; phone: string | null; name: string | null; consent: string; isMyContact: boolean; session?: { label: string }; segments?: { segment: { id: string; name: string } }[]; _count?: { members: number } };
type Group = { id: string; sessionId: string; whatsappId: string; name: string; participantCount: number; allowPosting: boolean; session: { label: string; status: string }; _count: { members: number }; sync?: SyncState | null };
type Segment = { eligibleCount?: number; id: string; name: string; description?: string | null; _count: { members: number } };
type Run = { error?: string | null; messageSnapshot?: string | null; audienceCount?: number; id: string; campaignId: string; status: string; startedAt: string; finishedAt?: string | null; campaign: { name: string }; deliveries: { status: string; recipient?: string; error?: string | null; _count?: { replies: number } }[] };
type Campaign = { summary: DeliveryTotals; sendIntervalMs: number; mediaKey?: string | null; mediaMime?: string | null; mediaName?: string | null; id: string; name: string; message: string; sessionId: string; audienceType: string; scheduleType: string; timezone: string; cron?: string | null; scheduledAt?: string | null; status: string; createdAt: string; session: { label: string; status: string }; _count: { contacts: number; groups: number; segments: number; runs: number }; runs: { id: string; summary: DeliveryTotals }[] };
type Overview = { sessions: number; contacts: number; optedIn: number; groups: number; campaigns: number; runs: number; latest: (Run & { deliveries: { status: string }[] })[] };
type ContactPage = { items: Contact[]; total: number; page: number; take: number };
type Health = { database: string; redis: string; workerReady: boolean };
type AudienceExclusions = { missingConsent: number; optedOut: number; unusablePhone: number; unauthorizedGroups: number };
type CampaignAudienceSummary = { count: number; total: number; duplicates: number; excluded: number; exclusions: AudienceExclusions; sample: { label: string }[] };

const initCampaign: CampaignForm = { sendIntervalMs: 30000, name: "", message: "", sessionId: "", audienceType: "CONTACTS", contactIds: [], segmentIds: [], groupIds: [], scheduleType: "NOW", scheduledAt: "", cron: "0 9 * * 1", timezone: "Africa/Nairobi" };
const menu: { key: View; title: string; icon: typeof LayoutDashboard; section: string }[] = [
  { key: "overview", title: "Overview", icon: LayoutDashboard, section: "Workspace" },
  { key: "sessions", title: "WhatsApp sessions", icon: Smartphone, section: "Workspace" },
  { key: "contacts", title: "Contacts", icon: ContactRound, section: "Audience" },
  { key: "groups", title: "Groups", icon: Users, section: "Audience" },
  { key: "segments", title: "Contact segments", icon: Tags, section: "Audience" },
  { key: "campaigns", title: "Campaigns", icon: Megaphone, section: "Messaging" },
  { key: "reports", title: "Delivery reports", icon: BarChart3, section: "Messaging" },
  { key: "settings", title: "Settings & help", icon: Settings2, section: "Workspace" },
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
  const res = await fetch(url, { method: options?.method || "GET", headers: options?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: options?.body === undefined ? undefined : JSON.stringify(options.body), cache: "no-store" });
  const body = await res.json().catch(() => ({ error: "Unexpected server response" }));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("auth-expired"));
    throw new Error(body.error || "Request failed");
  }
  return body as T;
}
function Flag({ value, label }: { value: string; label?: string }) {
  return <span className={`flag flag-${value.toLowerCase().replaceAll("_", "-")}`}><span className="flag-dot" />{label || value.replaceAll("_", " ").toLowerCase()}</span>;
}
function Blank({ icon: Icon, title, desc, action }: { icon: typeof Smartphone; title: string; desc: string; action?: React.ReactNode }) {
  return <div className="blank"><div className="blank-icon"><Icon size={24} /></div><h3>{title}</h3><p>{desc}</p>{action}</div>;
}
function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="section-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="head-actions">{action}</div>}</div>;
}
function Modal({ title, children, close, wide }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
    modalRef.current?.querySelector<HTMLElement>(selector)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(selector) || []).filter(item => item.getClientRects().length > 0);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={modalRef} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close"><X size={19}/></button></div>{children}
  </section></div>;
}
function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="auth-bg"><div className="auth-card">
    <div className="auth-symbol"><MessageCircle size={27}/></div><div className="eyebrow">CAMPAIGNDESK</div>
    <h1>Welcome back.</h1><p>One workspace for your WhatsApp audiences, sessions and campaigns.</p>
    <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/auth/login", { method: "POST", body: { email, password } }); await onLogin(); } catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed"); } finally { setBusy(false); } }}>
      <label>Email address<input autoComplete="username" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="admin@example.com"/></label>
      <label>Password<input autoComplete="current-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••••••"/></label>
      {error && <div className="notice danger">{error}</div>}
      <button className="btn primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <LockKeyhole size={17}/>} Sign in</button>
    </form><div className="auth-footer"><ShieldCheck size={15}/> Private management console</div>
  </div></div>;
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
  const [consentFilter, setConsentFilter] = useState("");
  const [destinationFilter, setDestinationFilter] = useState<"" | "phone" | "private">("");
  const [phoneFilter, setPhoneFilter] = useState<"" | "usable" | "unavailable">("");
  const [groupFilter, setGroupFilter] = useState("");
  const [segmentFilter, setSegmentFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [allMatching, setAllMatching] = useState(false);
  const [organizer, setOrganizer] = useState<{ selection: ContactSelection; count: number; sourceSegmentId?: string; group?: Group } | null>(null);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sessionFilter, setSessionFilter] = useState("");
  const [qrSession, setQrSession] = useState<Session | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [newSession, setNewSession] = useState("");
  const [newPublicSender, setNewPublicSender] = useState("");
  const [editingSession, setEditingSession] = useState<{ id: string; label: string; publicSenderName: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importData, setImportData] = useState("");
  const [importSessionId, setImportSessionId] = useState("");
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [bulkConsentOpen, setBulkConsentOpen] = useState(false);
  const [consentSelection, setConsentSelection] = useState<{ selection: ContactSelection; count: number } | null>(null);
  const [consentStatus, setConsentStatus] = useState<"OPTED_IN" | "OPTED_OUT" | "UNKNOWN">("OPTED_IN");
  const [confirmation, setConfirmation] = useState<{
    title: string; description: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void;
  } | null>(null);
  const [consentMethod, setConsentMethod] = useState<"WHATSAPP_REPLY" | "WEB_FORM" | "IN_PERSON" | "OTHER">("WHATSAPP_REPLY");
  const [consentEvidence, setConsentEvidence] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [newSegment, setNewSegment] = useState("");
  const [segmentDesc, setSegmentDesc] = useState("");
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [campaignHasHistory, setCampaignHasHistory] = useState(false);
  const [reportTotals, setReportTotals] = useState<ReturnType<typeof deliveryTotals> | null>(null);
  const [campaignForm, setCampaignForm] = useState<CampaignForm>(initCampaign);
  const [inspectedCampaign, setInspectedCampaign] = useState<{
    id: string; name: string; message: string; mediaName?: string | null; audienceType: string; segments: { segmentId: string }[];
    summary: DeliveryTotals; _count: { runs: number }; runs: ResultRun[];
  } | null>(null);
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceSummary | null>(null);
  const [inspectedMembers, setInspectedMembers] = useState<{ group: Group; members: { contact: Contact }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const contactRequest = useRef(0);
  const inform = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const loadContacts = useCallback(async (page: number, search: string, consent: string, session: string, group: string) => {
    const request = ++contactRequest.current;
    const query = new URLSearchParams({ page: String(page), take: "40" });
    if (search) query.set("search", search);
    if (consent) query.set("consent", consent);
    if (phoneFilter) query.set("phoneAvailability", phoneFilter);
    if (destinationFilter) query.set("destinationAvailability", destinationFilter);
    if (session) query.set("sessionId", session);
    if (group) query.set("groupId", group);
    if (sourceFilter) query.set("source", sourceFilter);
    if (segmentFilter === "__unsegmented") query.set("unsegmented", "true");
    else if (segmentFilter) query.set("segmentId", segmentFilter);
    const data = await api<ContactPage>("/api/v1/contacts?" + query.toString());
    if (request === contactRequest.current) { setContacts(data.items); setContactTotal(data.total); }
  }, [sourceFilter, segmentFilter, phoneFilter, destinationFilter]);
  const loadAll = useCallback(async () => {
    const [overviewData, sessionsData, groupsData, segmentsData, campaignsData, runsData, healthData, totalsData] = await Promise.all([
      api<Overview>("/api/v1/overview"), api<Session[]>("/api/v1/sessions"), api<Group[]>("/api/v1/groups"),
      api<Segment[]>("/api/v1/segments"), api<Campaign[]>("/api/v1/campaigns"), api<Run[]>("/api/v1/runs"),
      api<Health>("/api/v1/health"), api<ReturnType<typeof deliveryTotals>>("/api/v1/report-summary"),
    ]);
    setOverview(overviewData); setSessions(sessionsData); setGroups(groupsData); setSegments(segmentsData);
    setCampaigns(campaignsData); setRuns(runsData);
    setHealth(healthData); setReportTotals(totalsData);
    setCampaignForm(prev => ({ ...prev, sessionId: prev.sessionId || sessionsData[0]?.id || "" }));
    setLoading(false);
  }, []);
  const signedIn = useCallback(async () => {
    const { user } = await api<{ user: { email: string } }>("/api/auth/me");
    setEmail(user.email); setAuth("in");
    try { await loadAll(); } catch (e) { inform(e instanceof Error ? e.message : "Could not load data", true); } finally { setLoading(false); }
  }, [inform, loadAll]);
  useEffect(() => { const timer = setTimeout(() => { void signedIn().catch(() => { setAuth("out"); setLoading(false); }); }, 0); return () => clearTimeout(timer); }, [signedIn]);
  useEffect(() => { if (auth !== "in") return; const timer = setTimeout(() => { void loadContacts(contactPage, contactSearch, consentFilter, sessionFilter, groupFilter).catch(e => inform(String(e), true)); }, 250); return () => clearTimeout(timer); }, [auth, contactPage, contactSearch, consentFilter, sessionFilter, groupFilter, loadContacts, inform]);
  const refresh = useCallback(async () => {
    try { await Promise.all([loadAll(), loadContacts(contactPage, contactSearch, consentFilter, sessionFilter, groupFilter)]); }
    catch (e) { inform(e instanceof Error ? e.message : "Refresh failed", true); }
    finally { setLoading(false); }
  }, [loadAll, loadContacts, contactPage, contactSearch, consentFilter, sessionFilter, groupFilter, inform]);
  const savingGroupContacts = groups.some(group => syncPending(group.sync));
  useEffect(() => { if (auth !== "in") return; const timer = setInterval(() => { void refresh(); }, savingGroupContacts ? 2000 : runs.some(run => run.status === "RUNNING") ? 3000 : 12000); return () => clearInterval(timer); }, [auth, refresh, savingGroupContacts, runs]);
  useEffect(() => {
    const expired = () => { setAuth("out"); setSelectedContacts([]); setQrSession(null); setCampaignOpen(false); };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);
  const inspectedCampaignId = inspectedCampaign?.id;
  useEffect(() => {
    if (!inspectedCampaignId) return;
    let alive = true;
    const timer = setInterval(() => {
      void Promise.all([
        api<NonNullable<typeof inspectedCampaign>>("/api/v1/campaigns/" + inspectedCampaignId + (inspectedRunId ? "?runId=" + encodeURIComponent(inspectedRunId) : "")),
        api<CampaignAudienceSummary>("/api/v1/campaigns/" + inspectedCampaignId + "/audience"),
      ]).then(([detail, audience]) => { if (alive) { setInspectedCampaign(detail); setAudiencePreview(audience); } }).catch(e => { if (alive) inform(String(e), true); });
    }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [inspectedCampaignId, inspectedRunId, inform]);
  useEffect(() => { if (!qrSession) return; let alive = true;
    const poll = () => { void Promise.all([api<{ qr: string | null }>("/api/v1/sessions/" + qrSession.id + "/qr"), api<Session[]>("/api/v1/sessions")]).then(([value, current]) => {
      if (!alive) return;
      setQr(value.qr); setSessions(current);
      if (current.find(s => s.id === qrSession.id)?.status === "CONNECTED") { setQrSession(null); inform("WhatsApp connected. You can now sync contacts and groups."); }
    }).catch(e => { if (alive) inform(String(e), true); }); };
    poll(); const timer = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [qrSession, inform]);

  async function update(method: string, path: string, body?: unknown, message = "Changes saved") {
    setSaving(true);
    try { await api(path, { method, body }); await loadAll(); await loadContacts(contactPage, contactSearch, consentFilter, sessionFilter, groupFilter); inform(message); return true; }
    catch (e) { inform(e instanceof Error ? e.message : "Request failed", true); return false; }
    finally { setSaving(false); }
  }
  async function signOut() {
    try { await api("/api/auth/logout", { method: "POST" }); setAuth("out"); setSelectedContacts([]); }
    catch (e) { inform(String(e), true); }
  }
  async function saveGroupContacts(group: Group) {
    if (await update("POST", "/api/v1/groups/" + group.id + "/save-contacts", {}, "Saving group contacts. Progress appears beside the group.")) setInspectedMembers(null);
  }
  function viewGroupContacts(group: Group) {
    setContactSearch(""); setConsentFilter(""); setPhoneFilter(""); setDestinationFilter(""); setSessionFilter(group.sessionId); setGroupFilter(group.id); setSegmentFilter(""); setSourceFilter(""); setAllMatching(false);
    setContactPage(1); setSelectedContacts([]); setInspectedMembers(null); setView("contacts");
    void loadContacts(1, "", "", group.sessionId, group.id).catch(e => inform(String(e), true));
  }
  function openCampaignBuilder() {
    setNotice(null);
    setEditingCampaignId(null); setCampaignHasHistory(false);
    setCampaignForm({ ...initCampaign, sessionId: sessions.find(session => session.status === "CONNECTED")?.id || sessions[0]?.id || "" });
    setCampaignOpen(true);
  }
  async function editCampaign(id: string) {
    try {
        const c = await api<Campaign & {
        contacts: { contactId: string }[]; groups: { groupId: string }[]; segments: { segmentId: string }[];
      }>("/api/v1/campaigns/" + id);
      const localDate = c.scheduledAt ? dateTimeInZone(c.scheduledAt, c.timezone) : "";
      const isDraft = c.status === "DRAFT";
      setEditingCampaignId(id); setCampaignHasHistory(c.status !== "DRAFT" || (c.runs?.length || 0) > 0);
      setCampaignForm({
        sendIntervalMs: c.sendIntervalMs, name: c.name, message: c.message, sessionId: c.sessionId, audienceType: c.audienceType as "CONTACTS" | "GROUPS",
        contactIds: c.contacts.map(x => x.contactId), segmentIds: c.segments.map(x => x.segmentId),
        groupIds: c.groups.map(x => x.groupId), scheduleType: (!isDraft && c.scheduleType === "ONCE" ? "NOW" : c.scheduleType) as "NOW" | "ONCE" | "CRON",
        scheduledAt: isDraft ? localDate : "", cron: c.cron || "0 9 * * 1", timezone: c.timezone,
        mediaKey: c.mediaKey || undefined, mediaMime: c.mediaMime || undefined, mediaName: c.mediaName || undefined,
      });
      setCampaignOpen(true);
    } catch (e) { inform(e instanceof Error ? e.message : "Unable to open campaign", true); }
  }
  async function inspectCampaign(id: string, knownAudience?: CampaignAudienceSummary, runId?: string) {
    try {
      const [detail, audience] = await Promise.all([
        api<NonNullable<typeof inspectedCampaign>>("/api/v1/campaigns/" + id + (runId ? "?runId=" + encodeURIComponent(runId) : "")),
        knownAudience ? Promise.resolve(knownAudience) : api<CampaignAudienceSummary>("/api/v1/campaigns/" + id + "/audience"),
      ]);
      setInspectedCampaign(detail); setInspectedRunId(runId || null);
      setAudiencePreview(audience);
    } catch (e) { inform(e instanceof Error ? e.message : "Unable to inspect campaign", true); }
  }
  async function launchCampaign(id: string) {
    try {
      const audience = await api<CampaignAudienceSummary>("/api/v1/campaigns/" + id + "/audience");
      if (!audience.count) {
        await inspectCampaign(id, audience);
        return;
      }
      const start = () => { void update("POST", "/api/v1/campaigns/" + id + "/action", { action: "launch" }, "Campaign launched or scheduled"); };
      if ((campaigns.find(c => c.id === id)?._count.runs || 0) > 0) confirmAction("Start a new campaign run?", `Send the saved message to ${audience.count.toLocaleString()} eligible recipients. Previously messaged contacts may receive it again. Earlier run history is preserved.`, "Launch new run", start);
      else start();
    } catch (e) { inform(e instanceof Error ? e.message : "Launch failed", true); }
  }
  async function relaunchCampaign(id: string) {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api<{ campaignId: string; recipients: number }>("/api/v1/campaigns/" + id + "/relaunch", { method: "POST" });
      await loadAll();
      inform(`Relaunched to ${result.recipients.toLocaleString()} eligible recipients. Earlier delivery reports remain available.`);
    } catch (e) { inform(e instanceof Error ? e.message : "Relaunch failed", true); }
    finally { setSaving(false); }
  }
  function reviewCampaignContacts(reason: "missingConsent" | "unusablePhone" | "all" = "all") {
    const onlySegment = inspectedCampaign?.audienceType === "CONTACTS" && inspectedCampaign.segments.length === 1
      ? inspectedCampaign.segments[0].segmentId : "";
    setContactSearch(""); setConsentFilter(reason === "missingConsent" ? "UNKNOWN" : "");
    setPhoneFilter(""); setDestinationFilter("");
    setSessionFilter(""); setGroupFilter(""); setSourceFilter("");
    setSegmentFilter(onlySegment); setContactPage(1); clearSelection();
    setInspectedCampaign(null); setAudiencePreview(null); setView("contacts");
  }
  function reviewConsent(selection: ContactSelection, count: number, status: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN" = "OPTED_IN") {
    if (!count) return inform("Select contacts first.", true);
    setConsentSelection({ selection, count });
    setConsentStatus(status);
    setConsentEvidence(""); setConsentMethod("WHATSAPP_REPLY"); setConsentConfirmed(false);
    setBulkConsentOpen(true);
  }
  function confirmAction(title: string, description: string, confirmLabel: string, onConfirm: () => void, destructive = false) {
    setConfirmation({ title, description, confirmLabel, onConfirm, destructive });
  }
  async function recordSelectedConsent() {
    if (!consentSelection) return;
    setSaving(true);
    try {
      const result = await api<{ selected: number; uniqueDestinations: number; affectedRecords: number }>("/api/v1/contacts/consent", {
        method: "POST",
        body: {
          selection: consentSelection.selection,
          consent: consentStatus,
          consentMethod: consentStatus === "OPTED_IN" ? consentMethod : undefined,
          consentNote: consentEvidence,
          confirmed: consentConfirmed,
        },
      });
      setBulkConsentOpen(false); setConsentSelection(null); clearSelection();
      await Promise.all([loadAll(), loadContacts(contactPage, contactSearch, consentFilter, sessionFilter, groupFilter)]);
      inform(`Updated ${result.selected.toLocaleString()} selected contacts across ${result.uniqueDestinations.toLocaleString()} unique WhatsApp IDs (${result.affectedRecords.toLocaleString()} records).`);
    } catch (e) { inform(e instanceof Error ? e.message : "Could not update consent", true); }
    finally { setSaving(false); }
  }
  const directoryFilter: ContactFilter = {
    ...(contactSearch && { search: contactSearch }), ...(consentFilter && { consent: consentFilter as ContactFilter["consent"] }),
    ...(phoneFilter && { phoneAvailability: phoneFilter }),
    ...(destinationFilter && { destinationAvailability: destinationFilter }),
    ...(sessionFilter && { sessionId: sessionFilter }), ...(groupFilter && { groupId: groupFilter }),
    ...(sourceFilter && { source: sourceFilter as ContactFilter["source"] }),
    ...(segmentFilter === "__unsegmented" ? { unsegmented: true } : segmentFilter ? { segmentId: segmentFilter } : {}),
  };
  const selectionCount = allMatching ? contactTotal : selectedContacts.length;
  function clearSelection() { setSelectedContacts([]); setAllMatching(false); }
  function organizeSelection() {
    if (!selectionCount) return inform("Select contacts or select all matching results first", true);
    setOrganizer({ selection: allMatching ? { filter: directoryFilter } : { contactIds: selectedContacts }, count: selectionCount,
      ...(segmentFilter && segmentFilter !== "__unsegmented" ? { sourceSegmentId: segmentFilter } : {}) });
  }
  function browseSegment(segment: Segment) {
    setContactSearch(""); setConsentFilter(""); setPhoneFilter(""); setDestinationFilter(""); setSessionFilter(""); setGroupFilter(""); setSourceFilter("");
    setSegmentFilter(segment.id); setContactPage(1); clearSelection(); setView("contacts");
  }
  const activeSessions = sessions.filter(s => s.status === "CONNECTED").length;
  const title = menu.find(m => m.key === view)?.title || "Overview";

  if (auth === "checking") return <div className="splash"><LoaderCircle className="spin" size={28}/> Loading CampaignDesk…</div>;
  if (auth === "out") return <Login onLogin={signedIn} />;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><MessageCircle size={23}/></div><div><strong>campaign<span>desk</span></strong><small>WHATSAPP WORKSPACE</small></div></div>
      <div className="workspace-switch"><div className="workspace-avatar">W</div><div><strong>My workspace</strong><small>Personal account</small></div><ChevronRight size={16}/></div>
      <nav className="nav">
        {menu.map((item, index) => <div key={item.key}>{(index === 0 || menu[index - 1].section !== item.section) && <div className="nav-caption">{item.section}</div>}
          <button className={`nav-item ${view === item.key ? "selected" : ""}`} onClick={() => setView(item.key)}>
            <item.icon size={18} strokeWidth={1.9}/>{item.title}{item.key === "sessions" && <span className="nav-count">{sessions.length}</span>}
          </button>
        </div>)}
      </nav>
      <div className="sidebar-bottom"><div className="help-box"><div className="help-title"><ShieldCheck size={17}/> Permission-first messaging</div>
        <p>Only message opted-in contacts or groups you are authorized to post in.</p></div>
        <div className="signed-user"><div className="user-icon">{email.charAt(0).toUpperCase()}</div><div className="signed-email"><strong>Administrator</strong><small>{email}</small></div>
        <button className="icon-button" title="Sign out" onClick={() => void signOut()}><LogOut size={17}/></button></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="crumb">Workspace <ChevronRight size={14}/> <strong>{title}</strong></div>
        <div className="top-actions"><span className={`live-label ${activeSessions ? "online" : ""}`}><span className="live-dot"/>{activeSessions} connected</span>
          <button className="icon-button" title="Refresh data" onClick={() => void refresh()}><RefreshCw size={17}/></button><div className="top-avatar">{email.charAt(0).toUpperCase()}</div><button className="icon-button mobile-signout" title="Sign out" aria-label="Sign out" onClick={() => void signOut()}><LogOut size={17}/></button></div>
      </header>
      <main className="content">
        {notice && <div role="status" className={`toast ${notice.error ? "toast-error" : ""}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}><X size={16}/></button></div>}
        {loading && <div className="loading-line"><LoaderCircle className="spin" size={19}/> Fetching workspace data…</div>}
        {view === "overview" && <>
          <SectionHeading eyebrow="YOUR WORKSPACE AT A GLANCE" title="Good to have you back." description="Monitor your audiences, connected devices, and campaign activity." action={<button className="btn primary" onClick={openCampaignBuilder}><Plus size={17}/> New campaign</button>}/>
          <div className="kpi-grid">{[
            { title: "Total contacts", value: overview?.contacts ?? 0, desc: "Synced & imported", icon: ContactRound, tone: "blue" },
            { title: "Opted-in contacts", value: overview?.optedIn ?? 0, desc: "Eligible for campaigns", icon: ShieldCheck, tone: "green" },
            { title: "WhatsApp groups", value: overview?.groups ?? 0, desc: "Across sessions", icon: Users, tone: "purple" },
            { title: "Campaigns", value: overview?.campaigns ?? 0, desc: "Drafts & scheduled", icon: Megaphone, tone: "orange" },
          ].map(item => <div className="kpi" key={item.title}><div className="kpi-top"><span>{item.title}</span><div className={`kpi-icon ${item.tone}`}><item.icon size={19}/></div></div><div className="kpi-value">{item.value.toLocaleString()}</div><div className="kpi-foot">{item.desc}</div></div>)}</div>
          <div className="two-columns"><section className="panel"><div className="panel-title"><div><h2>Recent campaigns</h2><p>The latest activity across your workspace</p></div><button className="text-button" onClick={() => setView("campaigns")}>View all <ArrowRight size={15}/></button></div>
            {campaigns.length ? <div className="compact-list">{campaigns.slice(0, 6).map(c => <div key={c.id} className="compact-row"><div className="list-icon"><Megaphone size={16}/></div><div className="grow"><strong>{c.name}</strong><small>{c.session.label} · {formatDate(c.createdAt)}</small></div><Flag value={c.status}/></div>)}</div> : <Blank icon={Megaphone} title="No campaigns yet" desc="Start with a message and choose your permitted audience." action={<button className="btn outline" onClick={openCampaignBuilder}>Create first campaign</button>}/>}
          </section><section className="panel"><div className="panel-title"><div><h2>WhatsApp connections</h2><p>Live session connectivity</p></div><button className="text-button" onClick={() => setView("sessions")}>Manage <ArrowRight size={15}/></button></div>
            {sessions.length ? <div className="compact-list">{sessions.slice(0, 6).map(s => <div key={s.id} className="compact-row"><div className="list-icon"><Smartphone size={17}/></div><div className="grow"><strong>{s.label}</strong><small>{s.phone || "Not paired"} · {s._count?.contacts ?? 0} contacts</small></div><Flag value={s.status}/></div>)}</div> : <Blank icon={Smartphone} title="No sessions" desc="Link a WhatsApp account to start syncing." action={<button className="btn outline" onClick={() => setCreateSessionOpen(true)}>Add session</button>}/>}
          </section></div>
          <div className="info-strip"><div className="info-icon"><ShieldCheck size={20}/></div><div><strong>Respect audience permissions</strong><p>Contact discovery does not grant permission to send individual marketing messages. Set opt-in explicitly and enable group announcements only for groups you administer or have authorization to post in.</p></div></div>
        </>}
        {view === "sessions" && <>
          <SectionHeading eyebrow="ACCOUNT MANAGEMENT" title="WhatsApp sessions" description="Link and monitor the accounts that power your campaigns." action={<button className="btn primary" onClick={() => setCreateSessionOpen(true)}><Plus size={16}/> Add WhatsApp</button>}/>
          {sessions.length ? <div className="session-grid">{sessions.map(s => <div className="session-card" key={s.id}>
            <div className="session-row"><div className="device-icon"><Smartphone size={25}/></div><Flag value={s.status}/></div>
            <div className="session-title-row"><h3>{s.label}</h3><button className="text-button" aria-label={"Edit " + s.label + " account names"} onClick={() => setEditingSession({ id: s.id, label: s.label, publicSenderName: s.publicSenderName || "" })}><Settings2 size={15}/> Edit names</button></div>
            <p>{s.phone ? "+" + s.phone : "Connect to see phone number"}</p>
            <p className="session-public-identity">{s.publicSenderName ? <>Messages signed as <strong>{s.publicSenderName}</strong></> : "Public sender name not set on this account"}</p>
            <div className="session-details"><div><span>Contacts</span><strong>{s._count?.contacts ?? 0}</strong></div><div><span>Groups</span><strong>{s._count?.groups ?? 0}</strong></div><div><span>Last connected</span><strong>{s.lastSeen ? formatDate(s.lastSeen) : "Never"}</strong></div></div>
            {s.error && <div className="tiny-error">{s.error}</div>}{s.status === "CONNECTING" && <p className="muted-footnote" role="status">WhatsApp is reconnecting automatically. Your saved device login is preserved.</p>}{s.sendingHold && <p className="notice danger" role="status"><strong>Campaign sending is on hold.</strong> {s.sendingHold.reason} This does not prevent connection or contact sync. Review in Settings before sending campaigns.</p>}
            {s.sync && <p role="status" className={s.sync.phase === "FAILED" ? "tiny-error" : "muted-footnote"}>{s.sync.message} · {formatDate(s.sync.updatedAt)}</p>}
            <button className="text-button" disabled={saving || !!s.sendingHold} onClick={() => confirmAction("Report a restriction on this account?", "Pause this account’s campaigns and place a local 24-hour hold on sending. Check the actual restriction in WhatsApp. A review is required afterwards; campaigns will stay paused until resumed.", "Report restriction & pause", () => { void update("POST", "/api/v1/safety/hold", { sessionId: s.id, reason: "Administrator reported an account restriction in WhatsApp. Verify account access before resuming campaigns.", restriction: true }, "Account sending held for review."); })}>Report restriction & pause campaigns</button><div className="session-actions">
              {s.status === "CONNECTED" ? <>
                <button className="btn primary" disabled={saving || s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING"} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/sync", {}, "Sync queued. Progress will appear on this account.")}><RefreshCw size={16}/> {s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING" ? "Syncing…" : "Sync contacts & groups"}</button>
                <button className="btn outline" aria-label={"Disconnect " + s.label} disabled={saving} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Disconnect requested")}><WifiOff size={16}/></button>
              </> : s.status === "CONNECTING" ? <>
                <button className="btn primary" disabled><RefreshCw className="spin" size={16}/> Reconnecting…</button>
                <button className="btn outline" aria-label={"Stop reconnecting " + s.label} disabled={saving} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Automatic reconnection stopped for this account.")}><WifiOff size={16}/></button>
              </> : <>
                <button className="btn primary" disabled={saving} onClick={() => { setQrSession(s); setQr(null); if (s.status !== "QR_READY") void update("POST", "/api/v1/sessions/" + s.id + "/connect", {}, s.phone ? "Restoring the saved WhatsApp login…" : "Connection requested; scan the QR code when it appears."); }}><QrCode size={16}/> {s.status === "QR_READY" ? "View QR" : s.status === "DISCONNECTED" ? "Link device" : s.phone ? "Restore session" : "Connect"}</button>
                <button className="btn outline" aria-label={"View QR for " + s.label} onClick={() => { setQrSession(s); setQr(null); }}><QrCode size={16}/></button>
              </>}
            </div>
          </div>)}</div> : <Blank icon={Smartphone} title="No accounts connected" desc="Add a session, scan the QR code with your phone, then sync your contacts and groups." action={<button className="btn primary" onClick={() => setCreateSessionOpen(true)}><Plus size={16}/> Add a session</button>}/>}
          <div className="info-strip"><div className="info-icon"><Wifi size={20}/></div><div><strong>How pairing works</strong><p>Open WhatsApp → Linked devices → Link a device. Your session runs in the separate Node.js worker and requires that worker to stay online.</p></div></div>
        </>}
        {view === "contacts" && <>
          <SectionHeading eyebrow="AUDIENCE DIRECTORY" title="Contacts" description="Select the contacts who granted marketing permission and record that permission with evidence." action={<>
      <button className="btn outline" onClick={() => setImportOpen(true)}><ArrowDownToLine size={16}/> Import CSV</button>
      <button className="btn outline" disabled={!selectionCount || saving} onClick={() => reviewConsent(allMatching ? { filter: directoryFilter } : { contactIds: selectedContacts }, selectionCount)}><ShieldCheck size={16}/> Bulk consent update ({selectionCount.toLocaleString()})</button>
      <button className="btn primary" disabled={!selectionCount} onClick={organizeSelection}><FolderPlus size={16}/> Organize contacts ({selectionCount.toLocaleString()})</button>
    </>}/>
          <section className="panel table-panel">
            <div className="filterbar"><div className="search-box"><Search size={17}/><input aria-label="Search contacts" placeholder="Search names or numbers…" value={contactSearch} onChange={e => { setContactSearch(e.target.value); setContactPage(1); clearSelection(); }}/></div>
              <select aria-label="Consent filter" value={consentFilter} onChange={e => { setConsentFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All consent states</option><option value="OPTED_IN">Opted in</option><option value="UNKNOWN">Unknown</option><option value="OPTED_OUT">Opted out</option></select>
              <select aria-label="WhatsApp identity type" value={destinationFilter} onChange={e => { setDestinationFilter(e.target.value as "" | "phone" | "private"); setContactPage(1); clearSelection(); }}><option value="">All WhatsApp identities</option><option value="phone">Phone-number identity</option><option value="private">Private WhatsApp identity</option></select>
              <select aria-label="WhatsApp phone ID availability" value={phoneFilter} onChange={e => { setPhoneFilter(e.target.value as "" | "usable" | "unavailable"); setContactPage(1); clearSelection(); }}><option value="">All phone visibility</option><option value="usable">Phone number available</option><option value="unavailable">Phone hidden (can still message)</option></select>
              <select aria-label="Session filter" title="Account where the contact was discovered; any sending account can reach this contact" value={sessionFilter} onChange={e => { setSessionFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All source accounts</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
              <select aria-label="Filter by group" value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All groups</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              <select aria-label="Filter by contact source" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All contact sources</option><option value="mine">My phone contacts</option><option value="groups">From groups</option><option value="other">Other / imported</option></select>
              <select aria-label="Filter by segment" value={segmentFilter} onChange={e => { setSegmentFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All segments</option><option value="__unsegmented">Not in a segment</option>{segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
            <div className="bulk-toolbar"><div><strong>{selectionCount.toLocaleString()} selected</strong>{allMatching && <span> across all matching pages</span>}</div><div className="action-buttons"><button className="text-button" disabled={!contactTotal} onClick={() => { setAllMatching(true); setSelectedContacts([]); }}>Select all {contactTotal.toLocaleString()} matching</button>{selectionCount > 0 && <button className="text-button" onClick={clearSelection}>Clear selection</button>}</div></div>
            <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select page" ref={node => { if (node) node.indeterminate = !allMatching && contacts.some(c => selectedContacts.includes(c.id)) && !contacts.every(c => selectedContacts.includes(c.id)); }} checked={contacts.length > 0 && (allMatching || contacts.every(c => selectedContacts.includes(c.id)))} onChange={e => { setAllMatching(false); setSelectedContacts(prev => e.target.checked ? [...new Set([...prev, ...contacts.map(c => c.id)])] : prev.filter(id => !contacts.some(c => c.id === id))); }}/></th><th>Contact</th><th>WhatsApp ID</th><th>Source account</th><th>Consent</th><th>Source & segments</th></tr></thead>
              <tbody>{contacts.map(c => <tr key={c.id}><td><input type="checkbox" aria-label={`Select ${c.name || c.whatsappId}`} checked={allMatching || selectedContacts.includes(c.id)} onChange={() => { setAllMatching(false); setSelectedContacts(prev => allMatching ? contacts.filter(x => x.id !== c.id).map(x => x.id) : toggle(prev, c.id)); }}/></td>
                <td><div className="name-cell"><div className="person-avatar">{(c.name || c.phone || "?").charAt(0).toUpperCase()}</div><div><strong>{c.name || "Unnamed contact"}</strong><small>{c.phone ? "+" + c.phone : "No phone exposed"}</small></div></div></td><td><code className="mono">{c.whatsappId}</code></td><td>{c.session?.label || "—"}</td>
                <td><select aria-label={`Consent for ${c.name || c.whatsappId}`} className={`consent-select ${c.consent.toLowerCase()}`} value={c.consent} onChange={event => { const value = event.target.value as "OPTED_IN" | "OPTED_OUT" | "UNKNOWN"; if (value !== c.consent) reviewConsent({ contactIds: [c.id] }, 1, value); }}><option value="UNKNOWN">Unknown</option><option value="OPTED_IN" disabled={!isDirectWhatsAppId(c.whatsappId)}>Opted in</option><option value="OPTED_OUT">Opted out</option></select></td><td><div className="contact-tags"><span className="source-tag">{c.isMyContact ? "My phone contact" : c._count?.members ? "From group" : "Other / imported"}</span>{c.segments?.map(({ segment }) => <button className="segment-tag" key={segment.id} onClick={() => { setSegmentFilter(segment.id); setContactPage(1); clearSelection(); }}>{segment.name}</button>)}</div></td></tr>)}</tbody></table></div>
            {!contacts.length && <Blank icon={ContactRound} title="No contacts found" desc="Sync a connected WhatsApp account, import an authorized list or adjust your filters."/>}
            <div className="table-footer"><span>{contactTotal.toLocaleString()} contacts · {selectionCount.toLocaleString()} selected</span><div className="pager"><button aria-label="Previous contacts page" disabled={contactPage <= 1} onClick={() => setContactPage(x => x - 1)}><ArrowLeft size={16}/></button><span>Page {contactPage} of {Math.max(1, Math.ceil(contactTotal / 40))}</span><button aria-label="Next contacts page" disabled={contactPage * 40 >= contactTotal} onClick={() => setContactPage(x => x + 1)}><ArrowRight size={16}/></button></div></div>
          </section>
        </>}
        {view === "groups" && <>
          <SectionHeading eyebrow="COMMUNITIES" title="WhatsApp groups" description="Save every available member of a group to your Contacts directory." action={<button className="btn outline" onClick={() => setView("sessions")}><RefreshCw size={16}/> Sync from sessions</button>}/>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Group</th><th>Account</th><th>Members</th><th>Posting authorization</th><th>Contacts</th></tr></thead><tbody>{groups.map(g => <tr key={g.id} data-group-id={g.id}><td><div className="name-cell"><div className="person-avatar purple"><Users size={18}/></div><div><strong>{g.name}</strong><small>{g.whatsappId}</small></div></div></td><td>{g.session.label}</td><td>{g.participantCount}<small className="group-saved-count">{g._count.members} saved in Contacts</small></td>
            <td><label className="switch-label"><input type="checkbox" checked={g.allowPosting} onChange={e => { const checked = e.target.checked; if (checked) confirmAction("Authorize group announcements", `Confirm you have permission to post promotional messages in “${g.name}”. This is separate from permission to message individual members.`, "Authorize posting", () => { void update("PATCH", "/api/v1/groups/" + g.id, { allowPosting: true }, "Group authorization updated"); }); else void update("PATCH", "/api/v1/groups/" + g.id, { allowPosting: false }, "Group authorization removed"); }}/><span>{g.allowPosting ? "Authorized" : "Not authorized"}</span></label></td>
            <td><div className="action-buttons group-contact-actions"><button className="btn primary" disabled={saving || syncPending(g.sync) || g.session.status !== "CONNECTED"} title={g.session.status !== "CONNECTED" ? "Connect this group's WhatsApp account first" : "Save all available group members to Contacts"} onClick={() => void saveGroupContacts(g)}><ContactRound size={14}/> {syncPending(g.sync) ? "Saving…" : "Save all to contacts"}</button><button className="btn outline" disabled={saving || syncPending(g.sync) || g.session.status !== "CONNECTED"} onClick={() => setOrganizer({ group: g, selection: { filter: { groupId: g.id } }, count: g.participantCount })}><Tags size={14}/> Save to segments</button><button className="btn outline" disabled={!g._count.members} onClick={() => viewGroupContacts(g)}>View saved contacts <ChevronRight size={15}/></button><button className="btn subtle" onClick={async () => { try { const members = await api<{ contact: Contact }[]>("/api/v1/groups/" + g.id + "/members"); setInspectedMembers({ group: g, members }); } catch (e) { inform(String(e), true); } }}>View members</button></div>{g.sync && <p role="status" className={`group-save-status ${g.sync.phase === "FAILED" ? "tiny-error" : "muted-footnote"}`}>{g.sync.message}</p>}</td></tr>)}</tbody></table></div>{!groups.length && <Blank icon={Users} title="No groups yet" desc="Connect and sync a WhatsApp account to discover your groups."/>}</section>
          <p className="muted-footnote">Saved members appear in Contacts with their available names and numbers. Saving again updates existing contacts without duplicates.</p>
          <div className="info-strip"><div className="info-icon"><CircleHelp size={21}/></div><div><strong>Group membership is not consent</strong><p>Group participants are visible for organization only. Campaigns targeting individuals require explicit opt-in; group campaigns post once into each explicitly authorized group.</p></div></div>
        </>}
        {view === "segments" && <>
          <SectionHeading eyebrow="AUDIENCE ORGANIZATION" title="Contact segments" description="Shared audiences for every sending account. A contact can belong to several segments." action={<button className="btn primary" onClick={() => { setEditingSegmentId(null); setNewSegment(""); setSegmentDesc(""); setSegmentOpen(true); }}><Plus size={16}/> New segment</button>}/>
          {segments.length ? <div className="segment-grid">{segments.map(s => <section className="segment-card" key={s.id} data-segment-id={s.id}><div className="segment-icon"><Tags size={21}/></div><h3>{s.name}</h3><p>{s.description || "A reusable audience from any contact source."}</p><div className="segment-eligibility"><strong>{s.eligibleCount?.toLocaleString() ?? "—"}</strong><span>eligible to receive messages</span></div><div className="segment-card-actions"><button className="btn outline" onClick={() => browseSegment(s)}>Browse contacts <ChevronRight size={15}/></button><button className="btn subtle" disabled={!s._count.members} onClick={() => setOrganizer({ selection: { filter: { segmentId: s.id } }, count: s._count.members, sourceSegmentId: s.id })}>Organize all</button><button className="btn subtle" disabled={!s._count.members} onClick={() => { browseSegment(s); setConsentFilter("UNKNOWN"); setPhoneFilter(""); }}>Review opt-ins</button><button className="btn subtle" disabled={!s._count.members} onClick={() => { openCampaignBuilder(); setCampaignForm(p => ({ ...p, segmentIds: [s.id] })); }}><Megaphone size={14}/> Campaign</button></div><div className="segment-bottom"><span><Users size={15}/> {s._count.members.toLocaleString()} contacts</span><div><button className="text-button" onClick={() => { setEditingSegmentId(s.id); setNewSegment(s.name); setSegmentDesc(s.description || ""); setSegmentOpen(true); }}>Edit</button><button className="icon-button" title={"Delete " + s.name} disabled={saving} onClick={() => { confirmAction("Delete this segment?", `“${s.name}” will be deleted. Its contact records and group memberships will remain.`, "Delete segment", () => { void update("DELETE", "/api/v1/segments/" + s.id, undefined, "Segment deleted"); }, true); }}><Trash2 size={16}/></button></div></div></section>)}</div> : <Blank icon={Tags} title="No contact segments" desc="Create a segment here, or select contacts in the directory to create and fill one together." action={<button className="btn primary" onClick={() => { setEditingSegmentId(null); setSegmentOpen(true); }}><Plus size={16}/> New segment</button>}/>}
        </>}
        {view === "campaigns" && <>
          <SectionHeading eyebrow="MESSAGE AUTOMATION" title="Campaigns" description="Build campaigns, verify recipients, then schedule or launch delivery." action={<button className="btn primary" onClick={openCampaignBuilder}><Plus size={16}/> Create campaign</button>}/>
          <DeliveryStats totals={reportTotals ?? deliveryTotals([])}/>
          <p className="result-receipt-help">Across all campaign runs. Delivered means received on the recipient’s device. Sent includes delivered and read; replies received counts incoming messages. Updates automatically.</p>
          <div className="campaign-list">{campaigns.map(c => { const totals = c.summary ?? deliveryTotals([]); return <article className="campaign-card" key={c.id}>
            <div className="campaign-card-head"><div className="campaign-card-heading"><div className="person-avatar orange"><Megaphone size={17}/></div><div><h2>{c.name}</h2><p>{c.session.label} · Created {formatDate(c.createdAt)}</p></div></div><Flag value={c.status}/></div>
            <div className="campaign-card-meta"><span><Users size={14}/>{c.audienceType === "GROUPS" ? `${c._count.groups} group destinations` : `${c._count.segments} segments · ${c._count.contacts} selected contacts · ${c._count.groups} member sources`}</span><span><CalendarClock size={14}/>{c.scheduleType === "NOW" ? "On launch" : c.scheduleType === "ONCE" ? formatDate(c.scheduledAt) : `${c.cron} · ${c.timezone}`}</span><span>{c._count.runs} run{c._count.runs === 1 ? "" : "s"}</span></div>
            <p className="campaign-total-context">Results across all runs of this campaign</p><DeliveryStats totals={totals} compact/>
            <div className="campaign-status-summary"><span>{totals.total.toLocaleString()} planned delivery records</span>{totals.skipped > 0 && <span>{totals.skipped.toLocaleString()} not sent</span>}{totals.failed > 0 && <span className="needs-review">{totals.failed.toLocaleString()} failed</span>}{totals.uncertain > 0 && <span className="needs-review">{totals.uncertain.toLocaleString()} unconfirmed — review results</span>}</div>
            <div className="campaign-card-foot"><p>{c.runs[0] ? `Latest run: ${c.runs[0].summary.sent.toLocaleString()} sent · ${c.runs[0].summary.pending.toLocaleString()} pending` : "Draft · No messages sent yet"}</p><div className="action-buttons">
              <button className="btn subtle" onClick={() => void inspectCampaign(c.id)}>Details</button>
              <button className="btn subtle" disabled={saving || ["ACTIVE", "SCHEDULED"].includes(c.status)} title={["ACTIVE", "SCHEDULED"].includes(c.status) ? "Pause before editing" : "Edit this campaign; previous runs stay in its history"} onClick={() => void editCampaign(c.id)}><Settings2 size={14}/> {c.status === "DRAFT" ? "Edit" : "Edit & relaunch"}</button>
              {c.status === "DRAFT" && <button className="btn mini-primary" disabled={saving} onClick={() => void launchCampaign(c.id)}><Play size={14}/> Launch</button>}
              {["COMPLETED", "CANCELLED"].includes(c.status) && <button className="btn mini-primary" disabled={saving} onClick={() => confirmAction("Relaunch this campaign?", `Send “${c.name}” again now using the saved message, audience and sending account. People who received it before may receive it again. A new run will be added to this same campaign. Earlier runs and their messages stay in its history.`, "Relaunch now", () => { void relaunchCampaign(c.id); })}><RefreshCw size={14}/> Relaunch</button>}
              {["ACTIVE", "SCHEDULED"].includes(c.status) && <button className="btn outline" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "pause" }, "Campaign paused")}><Square size={13}/> Pause</button>}
              {c.status === "PAUSED" && <button className="btn mini-primary" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "resume" }, "Campaign resumed")}><Play size={14}/> Resume</button>}
              {["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status) && <button className="icon-button" title="Cancel" disabled={saving} onClick={() => { confirmAction("Cancel campaign?", `Cancel “${c.name}”? Future scheduled sends will be stopped.`, "Cancel campaign", () => { void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "cancel" }, "Campaign cancelled"); }, true); }}><X size={16}/></button>}
              <button className="icon-button" aria-label={`Delete ${c.name}`} title={["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status) ? "Cancel first to delete" : "Delete campaign and its delivery history"} disabled={saving || ["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status)} onClick={() => { confirmAction("Permanently delete this campaign?", `“${c.name}” and all ${c._count.runs} previous run(s) and delivery reports will be deleted permanently. Your saved contacts and segments will remain.`, "Delete campaign", () => { void update("DELETE", "/api/v1/campaigns/" + c.id, undefined, "Campaign deleted"); }, true); }}><Trash2 size={16}/></button>
            </div></div>
          </article>; })}</div>{!campaigns.length && <section className="panel"><Blank icon={Megaphone} title="Your first campaign starts here" desc="Create a draft, review your audience and schedule messages." action={<button className="btn primary" onClick={openCampaignBuilder}><Plus size={16}/> Create campaign</button>}/></section>}

        </>}
        {view === "reports" && <>
          <SectionHeading eyebrow="REPORTING" title="Delivery reports" description="Execution history, individual message status, and errors." action={<button className="btn outline" onClick={() => void refresh()}><RefreshCw size={16}/> Refresh</button>}/>
          <div className="kpi-grid reports-grid">{[
            { label: "Messages sent", n: reportTotals?.sent ?? 0, icon: Send },
            { label: "Delivered", n: reportTotals?.delivered ?? 0, icon: CheckCircle2 },
            { label: "Read", n: reportTotals?.read ?? 0, icon: Check },
            { label: "Replies", n: reportTotals?.replies ?? 0, icon: MessageCircle },
          ].map(k => <div className="kpi" key={k.label}><div className="kpi-top"><span>{k.label}</span><k.icon size={19}/></div><div className="kpi-value">{k.n.toLocaleString()}</div><div className="kpi-foot">Across all campaign runs</div></div>)}</div>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Campaign / started</th><th>Run status</th><th>Pending</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Replies</th><th>Failed / uncertain</th><th></th></tr></thead><tbody>{runs.map(r => { const totals = deliveryTotals(r.deliveries); return <tr key={r.id}><td><strong>{r.campaign.name}</strong><small className="group-saved-count">{formatDate(r.startedAt)}</small></td><td><Flag value={r.status}/>{r.error && <small className="group-saved-count tiny-error">{r.error}</small>}</td><td>{totals.pending}</td><td>{totals.sent}</td><td>{totals.delivered}</td><td>{totals.read}</td><td>{totals.replies} <small>({totals.replied} recipients)</small></td><td>{totals.failed} / {totals.uncertain}</td><td><button className="btn subtle" onClick={() => void inspectCampaign(r.campaignId, undefined, r.id)}>View results</button></td></tr>; })}</tbody></table></div>{!runs.length && <Blank icon={BarChart3} title="No delivery data yet" desc="Launch a campaign to generate an execution report."/>}</section>
          <p className="muted-footnote">Showing the latest 100 runs; totals include all runs. Sent includes delivered and read; delivered includes read. Replies are recorded while the worker is online, from this update onward. Quoted replies match an exact message; other replies are attributed to the latest send from that account within 30 days.</p>
          <p className="muted-footnote">A sent status means WhatsApp accepted the outgoing message, not that someone read it. Delivery and read receipts may be unavailable.</p>
        </>}
        {view === "settings" && <>
          <SectionHeading eyebrow="WORKSPACE CONFIGURATION" title="Settings & help" description="Operational configuration and local deployment guidance."/>
          <div className="info-strip"><div className="info-icon"><Activity size={20}/></div><div><strong>Service status</strong><p>{health ? `Database: ${health.database}. Redis: ${health.redis === "PONG" ? "connected" : health.redis}. Background worker: ${health.workerReady ? "online" : "offline — start npm run dev:all or npm run worker"}.` : "Checking services…"}</p></div></div>
          <SendingSafety request={api} changed={refresh}/><div className="settings-grid"><section className="panel settings-panel"><h2><ShieldCheck size={19}/> Safety & privacy</h2><p>Outbound individual campaigns require an explicit OPTED_IN consent status. Incoming STOP or UNSUBSCRIBE automatically suppresses future marketing sends. Group sending must be authorized per group.</p><p>Admin authentication uses a signed HttpOnly cookie and each API operation verifies the session.</p></section>
            <section className="panel settings-panel"><h2><Smartphone size={19}/> Session storage</h2><p>WhatsApp Chromium sessions are stored under <code>SESSION_DIR</code> on the worker&apos;s persistent disk. Do not deploy the worker to serverless environments or commit auth directories to GitHub.</p></section>
            <section className="panel settings-panel"><h2><CalendarClock size={19}/> Background jobs</h2><p>Redis and BullMQ handle scheduled delivery and one-off jobs. The worker must be running at all times for campaigns and QR connections to execute.</p></section>
            <section className="panel settings-panel"><h2><CircleHelp size={19}/> Start locally</h2><p>Run npm run setup to configure services and your admin account, then npm run dev:all. Run npm run doctor to check the configuration. See the README for details.</p></section></div>
        </>}
      </main>
    </div>
    {createSessionOpen && <Modal title="Add WhatsApp account" close={() => setCreateSessionOpen(false)}><div className="modal-body"><p className="modal-help">Name the connection for your workspace. Choose a separate, recognizable sender identity for direct campaigns.</p><label>Account nickname (private)<input value={newSession} maxLength={80} minLength={2} placeholder="e.g. Moi Mashinani work phone" onChange={e => setNewSession(e.target.value)}/><small>This name is never appended to outgoing messages.</small></label><label>Public sender name (direct campaigns)<input value={newPublicSender} maxLength={80} placeholder="e.g. Moi Mashinani Team" onChange={e => setNewPublicSender(e.target.value)}/><small>Use the actual organization or sender recipients recognize. This appears before the STOP opt-out instructions.</small></label></div><div className="modal-actions"><button className="btn outline" disabled={saving} onClick={() => setCreateSessionOpen(false)}>Cancel</button><button className="btn primary" disabled={saving || newSession.trim().length < 2} onClick={async () => { if (await update("POST", "/api/v1/sessions", { label: newSession, publicSenderName: newPublicSender }, "Session created")) { setCreateSessionOpen(false); setNewSession(""); setNewPublicSender(""); } }}>Create session</button></div></Modal>}
    {editingSession && <Modal title="Edit WhatsApp account" close={() => { if (!saving) setEditingSession(null); }}><div className="modal-body"><p className="modal-help">Renaming this connection does not sign you out, re-pair the device or change its contacts. Your public sender identity is managed separately.</p>
      <label>Account nickname (private)<input aria-label="Account nickname" minLength={2} maxLength={80} value={editingSession.label} onChange={e => setEditingSession(prev => prev && { ...prev, label: e.target.value })}/><small>Shown only in CampaignDesk. Recipients never see this label in the message footer.</small></label>
      <label>Public sender name<input aria-label="Public sender name" maxLength={80} value={editingSession.publicSenderName} placeholder="e.g. Moi Mashinani Team" onChange={e => setEditingSession(prev => prev && { ...prev, publicSenderName: e.target.value })}/><small>For direct-message campaigns. Enter the real business or team name that people know. Leaving this blank uses CAMPAIGN_BUSINESS_NAME, if configured.</small></label>
      <div className="message-preview"><strong>Example message ending</strong><p>...your campaign text</p><p>{editingSession.publicSenderName.trim() || "[Public sender name required if no workspace default]"}</p><p>Reply STOP to unsubscribe.</p></div>
    </div><div className="modal-actions"><button className="btn outline" disabled={saving} onClick={() => setEditingSession(null)}>Cancel</button><button className="btn primary" disabled={saving || editingSession.label.trim().length < 2} onClick={async () => { if (await update("PATCH", "/api/v1/sessions/" + editingSession.id, { label: editingSession.label, publicSenderName: editingSession.publicSenderName }, "WhatsApp account names updated")) setEditingSession(null); }}>{saving ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} Save changes</button></div></Modal>}
    {qrSession && <Modal title={(qrSession.phone ? "Restore " : "Link ") + qrSession.label} close={() => setQrSession(null)}><div className="qr-content"><p>{qrSession.phone && !qr ? "Reopening this account with its saved login. A QR code is needed only if WhatsApp asks you to link the device again." : <>On your phone, open <strong>WhatsApp → Linked devices → Link a device</strong>, then scan this QR code.</>}</p>{qr ? <div className="qr-box"><QRCodeSVG value={qr} size={244}/></div> : <div className="qr-placeholder"><LoaderCircle className="spin" size={34}/><span>{qrSession.phone ? "Restoring the saved session…" : "Waiting for QR code from the worker…"}</span></div>}{sessions.find(s => s.id === qrSession.id)?.error && <div className="notice danger">{sessions.find(s => s.id === qrSession.id)?.error}</div>}<p className="muted-footnote">The worker must be running. QR codes expire and refresh automatically.</p><button className="btn outline full" onClick={() => { void update("POST", "/api/v1/sessions/" + qrSession.id + "/connect", {}, "Reconnection requested"); }}>Retry connection</button></div></Modal>}
    {importOpen && <Modal title="Import contacts" close={() => setImportOpen(false)} wide><div className="modal-body"><p className="modal-help">Paste CSV as <code>phone,name</code>, one contact per row. Contacts remain unconsented until permission is recorded.</p><label>Source account<select value={importSessionId || sessions[0]?.id || ""} onChange={e => setImportSessionId(e.target.value)}>{sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label>CSV data<textarea rows={8} placeholder={"phone,name\n254700000001,Jane Doe\n254700000002,John Doe"} value={importData} onChange={e => setImportData(e.target.value)}/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setImportOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={async () => {
      try {
        const records = parseContactCsv(importData);
        if (!records.length) return inform("Add at least one contact", true);
        if (await update("POST", "/api/v1/contacts/import", { sessionId: importSessionId || sessions[0]?.id, contacts: records }, "Contacts imported; consent remains unknown")) { setImportOpen(false); setImportData(""); }
      } catch (e) { inform(e instanceof Error ? e.message : "Invalid CSV", true); }
    }}><ArrowDownToLine size={16}/> Import contacts</button></div></Modal>}
    {organizer && <Modal title={organizer.group ? "Save group contacts to segments" : "Organize contacts"} close={() => setOrganizer(null)} wide><ContactOrganizer segments={segments} {...organizer} request={api} close={() => setOrganizer(null)} saved={async message => { setOrganizer(null); clearSelection(); await refresh(); inform(message); }}/></Modal>}
    {segmentOpen && <Modal title={editingSegmentId ? "Edit contact segment" : "Create a contact segment"} close={() => setSegmentOpen(false)}><div className="modal-body"><p className="modal-help">Segments are available to all sending accounts.</p><label>Segment name<input value={newSegment} maxLength={80} placeholder="e.g. Event subscribers" onChange={e => setNewSegment(e.target.value)}/></label><label>Description (optional)<textarea rows={3} maxLength={250} value={segmentDesc} onChange={e => setSegmentDesc(e.target.value)}/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setSegmentOpen(false)}>Cancel</button><button className="btn primary" disabled={saving || newSegment.trim().length < 2} onClick={async () => {
      if (await update(editingSegmentId ? "PATCH" : "POST", editingSegmentId ? "/api/v1/segments/" + editingSegmentId : "/api/v1/segments", { name: newSegment, description: segmentDesc }, editingSegmentId ? "Segment updated" : "Segment created")) { setSegmentOpen(false); setEditingSegmentId(null); setNewSegment(""); setSegmentDesc(""); }
    }}>{editingSegmentId ? "Save changes" : "Create segment"}</button></div></Modal>}
    {bulkConsentOpen && consentSelection && <Modal title="Bulk contact consent" close={() => { if (!saving) { setBulkConsentOpen(false); setConsentSelection(null); } }} wide>
      <div className="modal-body consent-workflow">
        <div className="consent-summary"><div className="consent-summary-icon"><Users size={22}/></div><div><div className="eyebrow">AUDIENCE UPDATE</div><strong>{consentSelection.count.toLocaleString()} contact{consentSelection.count === 1 ? "" : "s"} selected</strong><p>{consentSelection.selection.filter ? "All contacts matching your active filters, across every page." : "Only the individual contacts you have selected."}</p></div></div>
        <div><div className="field-caption">CHOOSE A CONSENT STATE</div>
          <div className="consent-options" role="group" aria-label="Bulk consent status">
            {([{status:"OPTED_IN",title:"Opted in",detail:"Document permission",icon:ShieldCheck},{status:"OPTED_OUT",title:"Opted out",detail:"Block future messages",icon:WifiOff},{status:"UNKNOWN",title:"Unknown",detail:"Permission not verified",icon:CircleHelp}] as const).map(choice => {
              const Icon = choice.icon;
              return <button key={choice.status} type="button" className={`consent-option ${consentStatus === choice.status ? "selected" : ""}`} aria-pressed={consentStatus === choice.status} onClick={() => { setConsentStatus(choice.status); setConsentConfirmed(false); }}>
                <Icon size={19}/><span><strong>{choice.title}</strong><small>{choice.detail}</small></span>{consentStatus === choice.status && <Check size={16}/>}
              </button>;
            })}
          </div>
        </div>
        {consentStatus === "OPTED_IN" ? <>
          <div className="notice consent-guidance"><ShieldCheck size={18}/><span>Only mark people who expressly agreed to receive these WhatsApp campaigns. Being saved from a group does not establish permission.</span></div>
          <label>Where was permission given?
            <select value={consentMethod} onChange={e => setConsentMethod(e.target.value as typeof consentMethod)}>
              <option value="WHATSAPP_REPLY">Explicit WhatsApp reply</option><option value="WEB_FORM">Website signup or consent form</option><option value="IN_PERSON">In-person permission</option><option value="OTHER">Other documented permission</option>
            </select>
          </label>
          <label>Consent evidence and date
            <textarea rows={4} maxLength={400} placeholder="Explain when and how every selected person agreed to receive your updates and where their permission can be verified." value={consentEvidence} onChange={e => setConsentEvidence(e.target.value)}/>
            <small>At least 10 characters. This evidence is retained in the audit log.</small>
          </label>
          <p className="muted-footnote">Private WhatsApp IDs can be opted in without a visible phone number. Previously opted-out contacts remain protected.</p>
        </> : <label>Reason (optional)
          <textarea rows={2} maxLength={400} placeholder={consentStatus === "OPTED_OUT" ? "e.g. Requested to stop receiving promotions" : "e.g. Cannot verify consent at this time"} value={consentEvidence} onChange={e => setConsentEvidence(e.target.value)}/>
          <small>Existing opt-outs stay suppressed when changing other contacts to Unknown.</small>
        </label>}
        <label className="consent-confirm"><input type="checkbox" checked={consentConfirmed} onChange={e => setConsentConfirmed(e.target.checked)}/>
          <span>{consentStatus === "OPTED_IN" ? "I confirm every selected recipient explicitly opted in and I can substantiate that permission." : `I understand this change will apply to ${consentSelection.count.toLocaleString()} selected records.`}</span>
        </label>
      </div>
      <div className="modal-actions"><button className="btn outline" disabled={saving} onClick={() => { setBulkConsentOpen(false); setConsentSelection(null); }}>Cancel</button>
        <button className="btn primary" disabled={saving || !consentConfirmed || (consentStatus === "OPTED_IN" && consentEvidence.trim().length < 10)} onClick={() => void recordSelectedConsent()}>
          {saving ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>} {consentStatus === "OPTED_IN" ? "Record verified opt-in" : consentStatus === "OPTED_OUT" ? "Apply opt-out" : "Set to unknown"}
        </button>
      </div>
    </Modal>}
    {confirmation && <Modal title={confirmation.title} close={() => setConfirmation(null)}>
      <div className="modal-body confirm-content"><div className={`confirm-icon ${confirmation.destructive ? "danger" : ""}`}>{confirmation.destructive ? <Trash2 size={23}/> : <ShieldCheck size={23}/>}</div>
        <p>{confirmation.description}</p></div>
      <div className="modal-actions"><button className="btn outline" onClick={() => setConfirmation(null)}>Go back</button>
        <button className={`btn ${confirmation.destructive ? "danger-action" : "primary"}`} onClick={() => { const action = confirmation.onConfirm; setConfirmation(null); action(); }}>{confirmation.confirmLabel}</button>
      </div>
    </Modal>}
    {inspectedMembers && <Modal title={inspectedMembers.group.name + " members"} close={() => setInspectedMembers(null)}><div className="modal-body"><p className="modal-help">Showing {inspectedMembers.members.length} of {inspectedMembers.group._count.members} saved contacts. Save all to contacts imports every available group member, including members beyond this preview of up to 500 contacts.</p><div className="member-list">{inspectedMembers.members.map(m => <div className="member-row" key={m.contact.id}><span>{m.contact.name || m.contact.phone || m.contact.whatsappId}</span><Flag value={m.contact.consent}/></div>)}{!inspectedMembers.members.length && <p>Save the group members to add them to your Contacts directory.</p>}</div></div><div className="modal-actions"><button className="btn outline" disabled={!inspectedMembers.group._count.members} onClick={() => viewGroupContacts(inspectedMembers.group)}>View saved contacts</button><button className="btn primary" disabled={saving || syncPending(inspectedMembers.group.sync) || inspectedMembers.group.session.status !== "CONNECTED"} onClick={() => void saveGroupContacts(inspectedMembers.group)}><ContactRound size={15}/> Save all to contacts</button></div></Modal>}
    {inspectedCampaign && <Modal title={inspectedCampaign.name} close={() => { setInspectedCampaign(null); setAudiencePreview(null); }} wide><div className="modal-body">
      <div><div className="result-scope"><h3>Campaign performance</h3><p>All {inspectedCampaign._count.runs} campaign runs</p></div><DeliveryStats totals={inspectedCampaign.summary}/><p className="result-receipt-help">Delivered = received on their device. Read requires a WhatsApp read receipt. Replied counts sends with replies; replies received counts the incoming messages. A person may appear again in a later run.</p></div>
      <CampaignResults key={inspectedCampaign.id} runs={inspectedCampaign.runs} totalRuns={inspectedCampaign._count.runs} confirmSent={async (deliveryId, note) => {
        await api("/api/v1/campaigns/" + inspectedCampaign.id + "/reconcile", { method: "POST", body: { deliveryId, note, confirmed: true } });
        await inspectCampaign(inspectedCampaign.id, undefined, inspectedRunId ?? undefined); await refresh();
      }}/>
      <details className="campaign-audience-review"><summary>Current audience & saved message</summary><div className="message-preview">{inspectedCampaign.message}</div>{inspectedCampaign.mediaName && <p className="muted-footnote">Attachment: {inspectedCampaign.mediaName}</p>}
      <div className="detail-row"><strong>Eligible recipients now</strong><strong>{audiencePreview?.count ?? "…"}</strong></div>
      {audiencePreview && <><p className="muted-footnote">{audiencePreview.total} selected contact/group records · {audiencePreview.duplicates} duplicates removed · {audiencePreview.excluded} ineligible</p>
        {audiencePreview.count === 0 && <div className="notice danger"><strong>No eligible recipients.</strong> Saved contacts are not automatically approved for campaigns.</div>}
        {audiencePreview.exclusions.missingConsent > 0 && <p>{audiencePreview.exclusions.missingConsent} contacts require recorded, explicit opt-in.</p>}
        {audiencePreview.exclusions.unusablePhone > 0 && <p>{audiencePreview.exclusions.unusablePhone} contacts have invalid WhatsApp destinations. Private @lid IDs do not require a phone number.</p>}
        {audiencePreview.exclusions.optedOut > 0 && <p>{audiencePreview.exclusions.optedOut} contacts opted out or are suppressed.</p>}
        {audiencePreview.exclusions.unauthorizedGroups > 0 && <p>{audiencePreview.exclusions.unauthorizedGroups} groups have no posting authorization.</p>}
        {inspectedCampaign.audienceType === "CONTACTS" && <div className="action-buttons">
          {audiencePreview.exclusions.missingConsent > 0 && <button className="btn primary" onClick={() => reviewCampaignContacts("missingConsent")}><ShieldCheck size={15}/> Review consent records ({audiencePreview.exclusions.missingConsent})</button>}
          {audiencePreview.exclusions.unusablePhone > 0 && <button className="btn outline" onClick={() => reviewCampaignContacts("unusablePhone")}><ContactRound size={15}/> Review WhatsApp IDs ({audiencePreview.exclusions.unusablePhone})</button>}
          <button className="btn outline" onClick={() => reviewCampaignContacts("all")}>All selected contacts</button>
        </div>}
        {inspectedCampaign.audienceType === "GROUPS" && audiencePreview.exclusions.unauthorizedGroups > 0 && <button className="btn outline" onClick={() => { setInspectedCampaign(null); setAudiencePreview(null); setView("groups"); }}>Review group authorizations</button>}
      </>}
      <p className="muted-footnote">Sample: {audiencePreview?.sample.map(s => s.label).join(", ") || "None"}</p></details>
    </div></Modal>}

    {campaignOpen && <Modal title={editingCampaignId ? "Edit campaign" : "Create a campaign"} close={() => { if (!saving) setCampaignOpen(false); }} wide><CampaignComposer initial={campaignForm} campaignId={editingCampaignId} hasHistory={campaignHasHistory} sessions={sessions} segments={segments} groups={groups} request={api} busyChanged={setSaving} close={() => { if (!saving) setCampaignOpen(false); }} saved={async message => { setCampaignOpen(false); setEditingCampaignId(null); await refresh(); setView("campaigns"); inform(message); }}/></Modal>}

  </div>;
}
