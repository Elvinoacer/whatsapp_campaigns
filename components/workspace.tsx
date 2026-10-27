"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BarChart3, CalendarClock, Check,
  CheckCircle2, ChevronRight, CircleHelp, Clock3, ContactRound, FolderPlus,
  LayoutDashboard, ListFilter, LoaderCircle, LockKeyhole, LogOut, Megaphone,
  MessageCircle, Play, Plus, QrCode, RefreshCw, Search, Send, Settings2,
  ShieldCheck, Smartphone, Square, Tags, Trash2, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { parseContactCsv } from "@/lib/csv";
import ContactOrganizer from "./contact-organizer";
import type { ContactFilter, ContactSelection } from "@/lib/contact-selection";
import { dateTimeInZone, zonedDateTimeToIso } from "@/lib/timezone";
import type { SyncState } from "@/lib/sync-state";

type View = "overview" | "sessions" | "contacts" | "groups" | "segments" | "campaigns" | "reports" | "settings";
type Session = { id: string; label: string; phone?: string | null; status: string; error?: string | null; lastSeen?: string | null; sync?: { phase: string; message: string; updatedAt: string } | null; _count?: { contacts: number; groups: number } };
type Contact = { id: string; sessionId: string; whatsappId: string; phone: string | null; name: string | null; consent: string; isMyContact: boolean; session?: { label: string }; segments?: { segment: { id: string; name: string } }[]; _count?: { members: number } };
type Group = { id: string; sessionId: string; whatsappId: string; name: string; participantCount: number; allowPosting: boolean; session: { label: string; status: string }; _count: { members: number }; sync?: SyncState | null };
type Segment = { id: string; name: string; description?: string | null; _count: { members: number } };
type Run = { id: string; campaignId: string; status: string; startedAt: string; finishedAt?: string | null; campaign: { name: string }; deliveries: { status: string; recipient?: string; error?: string | null }[] };
type Campaign = { sendIntervalMs: number; mediaKey?: string | null; mediaMime?: string | null; mediaName?: string | null; id: string; name: string; message: string; sessionId: string; audienceType: string; scheduleType: string; timezone: string; cron?: string | null; scheduledAt?: string | null; status: string; createdAt: string; session: { label: string; status: string }; _count: { contacts: number; groups: number; segments: number; runs: number }; runs: { id: string }[] };
type Overview = { sessions: number; contacts: number; optedIn: number; groups: number; campaigns: number; runs: number; latest: (Run & { deliveries: { status: string }[] })[] };
type ContactPage = { items: Contact[]; total: number; page: number; take: number };
type Health = { database: string; redis: string; workerReady: boolean };
type AudienceExclusions = { missingConsent: number; optedOut: number; unusablePhone: number; unauthorizedGroups: number };
type CampaignAudienceSummary = { count: number; total: number; duplicates: number; excluded: number; exclusions: AudienceExclusions; sample: { label: string }[] };
type CampaignPreview = CampaignAudienceSummary & { durationMs: number; intervalMs: number; limit: number; nextRuns: string[]; scheduleIssue: string | null };
type CampaignForm = { sendIntervalMs: number; mediaKey?: string; mediaMime?: string; mediaName?: string; name: string; message: string; sessionId: string; audienceType: "CONTACTS" | "GROUPS"; contactIds: string[]; segmentIds: string[]; groupIds: string[]; scheduleType: "NOW" | "ONCE" | "CRON"; scheduledAt: string; cron: string; timezone: string };

const initCampaign: CampaignForm = { sendIntervalMs: 5000, name: "", message: "", sessionId: "", audienceType: "CONTACTS", contactIds: [], segmentIds: [], groupIds: [], scheduleType: "NOW", scheduledAt: "", cron: "0 9 * * 1", timezone: "Africa/Nairobi" };
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
function Flag({ value }: { value: string }) {
  return <span className={`flag flag-${value.toLowerCase().replaceAll("_", "-")}`}><span className="flag-dot" />{value.replaceAll("_", " ").toLowerCase()}</span>;
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
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(selector) || []);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
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
  const [draftPreview, setDraftPreview] = useState<CampaignPreview | null>(null);
  const [draftPreviewError, setDraftPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [campaignForm, setCampaignForm] = useState<CampaignForm>(initCampaign);
  const [inspectedCampaign, setInspectedCampaign] = useState<{
    name: string; message: string; mediaName?: string | null; audienceType: string; segments: { segmentId: string }[]; runs: { id: string; startedAt: string; status: string; error?: string | null; deliveries: { recipient: string; status: string; error: string | null }[] }[];
  } | null>(null);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceSummary | null>(null);
  const [inspectedMembers, setInspectedMembers] = useState<{ group: Group; members: { contact: Contact }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const contactRequest = useRef(0);
  const [campaignContacts, setCampaignContacts] = useState<Contact[]>([]);
  const [campaignContactSearch, setCampaignContactSearch] = useState("");
  const [campaignContactPage, setCampaignContactPage] = useState(1);
  const [campaignContactTotal, setCampaignContactTotal] = useState(0);
  const [campaignContactsLoading, setCampaignContactsLoading] = useState(false);
  const inform = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const loadContacts = useCallback(async (page: number, search: string, consent: string, session: string, group: string) => {
    const request = ++contactRequest.current;
    const query = new URLSearchParams({ page: String(page), take: "40" });
    if (search) query.set("search", search);
    if (consent) query.set("consent", consent);
    if (phoneFilter) query.set("phoneAvailability", phoneFilter);
    if (session) query.set("sessionId", session);
    if (group) query.set("groupId", group);
    if (sourceFilter) query.set("source", sourceFilter);
    if (segmentFilter === "__unsegmented") query.set("unsegmented", "true");
    else if (segmentFilter) query.set("segmentId", segmentFilter);
    const data = await api<ContactPage>("/api/v1/contacts?" + query.toString());
    if (request === contactRequest.current) { setContacts(data.items); setContactTotal(data.total); }
  }, [sourceFilter, segmentFilter, phoneFilter]);
  const loadAll = useCallback(async () => {
    const [overviewData, sessionsData, groupsData, segmentsData, campaignsData, runsData, healthData] = await Promise.all([
      api<Overview>("/api/v1/overview"), api<Session[]>("/api/v1/sessions"), api<Group[]>("/api/v1/groups"),
      api<Segment[]>("/api/v1/segments"), api<Campaign[]>("/api/v1/campaigns"), api<Run[]>("/api/v1/runs"),
      api<Health>("/api/v1/health"),
    ]);
    setOverview(overviewData); setSessions(sessionsData); setGroups(groupsData); setSegments(segmentsData);
    setCampaigns(campaignsData); setRuns(runsData);
    setHealth(healthData);
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
  useEffect(() => { if (auth !== "in") return; const timer = setInterval(() => { void refresh(); }, savingGroupContacts ? 2000 : 12000); return () => clearInterval(timer); }, [auth, refresh, savingGroupContacts]);
  useEffect(() => {
    const expired = () => { setAuth("out"); setSelectedContacts([]); setQrSession(null); setCampaignOpen(false); };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);
  useEffect(() => {
    if (!campaignOpen) return;
    let alive = true;
    const timer = setTimeout(() => {
      setCampaignContactsLoading(true);
      const query = new URLSearchParams({ eligible: "true", take: "40", page: String(campaignContactPage), search: campaignContactSearch });
      void api<ContactPage>("/api/v1/contacts?" + query).then(data => {
        if (alive) { setCampaignContacts(data.items); setCampaignContactTotal(data.total); }
      }).catch(e => { if (alive) inform(String(e), true); }).finally(() => { if (alive) setCampaignContactsLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [campaignOpen, campaignContactSearch, campaignContactPage, inform]);
  useEffect(() => {
    if (!campaignOpen) return;
    let alive = true;
    const timer = setTimeout(() => {
      setDraftPreview(null); setDraftPreviewError(""); setPreviewLoading(true);
      let body;
      try { body = { ...campaignForm, scheduledAt: campaignForm.scheduleType === "ONCE" && campaignForm.scheduledAt ? zonedDateTimeToIso(campaignForm.scheduledAt, campaignForm.timezone) : undefined }; }
      catch (e) { setDraftPreviewError(e instanceof Error ? e.message : "Invalid date"); setPreviewLoading(false); return; }
      if (campaignForm.name.trim().length < 3 || !campaignForm.message.trim() || !campaignForm.sessionId || (campaignForm.audienceType === "CONTACTS" ? !campaignForm.contactIds.length && !campaignForm.segmentIds.length : !campaignForm.groupIds.length)) { setPreviewLoading(false); return; }
      void api<CampaignPreview>("/api/v1/campaigns/preview", { method: "POST", body }).then(data => {
        if (alive) setDraftPreview(data);
      }).catch(e => { if (alive) setDraftPreviewError(e instanceof Error ? e.message : "Preview unavailable"); }).finally(() => { if (alive) setPreviewLoading(false); });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [campaignOpen, campaignForm]);
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
    setContactSearch(""); setConsentFilter(""); setPhoneFilter(""); setSessionFilter(group.sessionId); setGroupFilter(group.id); setSegmentFilter(""); setSourceFilter(""); setAllMatching(false);
    setContactPage(1); setSelectedContacts([]); setInspectedMembers(null); setView("contacts");
    void loadContacts(1, "", "", group.sessionId, group.id).catch(e => inform(String(e), true));
  }
  function openCampaignBuilder() {
    setNotice(null);
    setEditingCampaignId(null);
    setCampaignContactPage(1); setCampaignContactSearch(""); setCampaignContacts([]);
    setMediaFile(null);
    setCampaignForm({ ...initCampaign, sessionId: sessions[0]?.id || "" });
    setCampaignOpen(true);
  }
  async function editCampaign(id: string) {
    try {
      const c = await api<Campaign & {
        contacts: { contactId: string }[]; groups: { groupId: string }[]; segments: { segmentId: string }[];
      }>("/api/v1/campaigns/" + id);
      const localDate = c.scheduledAt ? dateTimeInZone(c.scheduledAt, c.timezone) : "";
      setEditingCampaignId(id); setMediaFile(null); setCampaignContactPage(1); setCampaignContactSearch(""); setCampaignContacts([]);
      setCampaignForm({
        sendIntervalMs: c.sendIntervalMs, name: c.name, message: c.message, sessionId: c.sessionId, audienceType: c.audienceType as "CONTACTS" | "GROUPS",
        contactIds: c.contacts.map(x => x.contactId), segmentIds: c.segments.map(x => x.segmentId),
        groupIds: c.groups.map(x => x.groupId), scheduleType: c.scheduleType as "NOW" | "ONCE" | "CRON",
        scheduledAt: localDate, cron: c.cron || "0 9 * * 1", timezone: c.timezone,
        mediaKey: c.mediaKey || undefined, mediaMime: c.mediaMime || undefined, mediaName: c.mediaName || undefined,
      });
      setCampaignOpen(true);
    } catch (e) { inform(e instanceof Error ? e.message : "Unable to open draft", true); }
  }
  async function inspectCampaign(id: string, knownAudience?: CampaignAudienceSummary) {
    try {
      const [detail, audience] = await Promise.all([
        api<NonNullable<typeof inspectedCampaign>>("/api/v1/campaigns/" + id),
        knownAudience ? Promise.resolve(knownAudience) : api<CampaignAudienceSummary>("/api/v1/campaigns/" + id + "/audience"),
      ]);
      setInspectedCampaign(detail);
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
      await update("POST", "/api/v1/campaigns/" + id + "/action", { action: "launch" }, "Campaign launched or scheduled");
    } catch (e) { inform(e instanceof Error ? e.message : "Launch failed", true); }
  }
  function reviewCampaignContacts(reason: "missingConsent" | "unusablePhone" | "all" = "all") {
    const onlySegment = inspectedCampaign?.audienceType === "CONTACTS" && inspectedCampaign.segments.length === 1
      ? inspectedCampaign.segments[0].segmentId : "";
    setContactSearch(""); setConsentFilter(reason === "missingConsent" ? "UNKNOWN" : "");
    setPhoneFilter(reason === "missingConsent" ? "usable" : reason === "unusablePhone" ? "unavailable" : "");
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
  async function createCampaign() {
    if (!campaignForm.sessionId) { inform("Connect or add a WhatsApp account first", true); return; }
    if (campaignForm.scheduleType === "ONCE" && !campaignForm.scheduledAt) { inform("Choose a schedule date", true); return; }
    setSaving(true);
    try {
      let attachment = {};
      if (mediaFile) {
        const form = new FormData();
        form.set("file", mediaFile);
        const response = await fetch("/api/v1/media", { method: "POST", body: form });
        const uploaded = await response.json();
        if (!response.ok) throw new Error(uploaded.error || "Attachment upload failed");
        attachment = uploaded as { mediaKey: string; mediaMime: string; mediaName: string };
      }
      const body = {
        ...campaignForm, ...attachment,
        scheduledAt: campaignForm.scheduleType === "ONCE" ? zonedDateTimeToIso(campaignForm.scheduledAt, campaignForm.timezone) : undefined,
      };
      const saved = await update(editingCampaignId ? "PATCH" : "POST",
        editingCampaignId ? "/api/v1/campaigns/" + editingCampaignId : "/api/v1/campaigns",
        body, editingCampaignId ? "Draft updated" : "Campaign draft created. Preview the recipients before launch.");
      if (saved) { setCampaignOpen(false); setMediaFile(null); setEditingCampaignId(null); setCampaignForm({ ...initCampaign, sessionId: campaignForm.sessionId }); setView("campaigns"); }
    } catch (e) { inform(e instanceof Error ? e.message : "Campaign save failed", true); } finally { setSaving(false); }
  }
  const directoryFilter: ContactFilter = {
    ...(contactSearch && { search: contactSearch }), ...(consentFilter && { consent: consentFilter as ContactFilter["consent"] }),
    ...(phoneFilter && { phoneAvailability: phoneFilter }),
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
    setContactSearch(""); setConsentFilter(""); setPhoneFilter(""); setSessionFilter(""); setGroupFilter(""); setSourceFilter("");
    setSegmentFilter(segment.id); setContactPage(1); clearSelection(); setView("contacts");
  }
  const eligible = campaignContacts;
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
            <h3>{s.label}</h3><p>{s.phone ? "+" + s.phone : "Connect to see phone number"}</p>
            <div className="session-details"><div><span>Contacts</span><strong>{s._count?.contacts ?? 0}</strong></div><div><span>Groups</span><strong>{s._count?.groups ?? 0}</strong></div><div><span>Last connected</span><strong>{s.lastSeen ? formatDate(s.lastSeen) : "Never"}</strong></div></div>
            {s.error && <div className="tiny-error">{s.error}</div>}
            {s.sync && <p role="status" className={s.sync.phase === "FAILED" ? "tiny-error" : "muted-footnote"}>{s.sync.message} · {formatDate(s.sync.updatedAt)}</p>}
            <div className="session-actions">
              {s.status === "CONNECTED" ? <>
                <button className="btn primary" disabled={saving || s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING"} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/sync", {}, "Sync queued. Progress will appear on this account.")}><RefreshCw size={16}/> {s.sync?.phase === "QUEUED" || s.sync?.phase === "RUNNING" ? "Syncing…" : "Sync contacts & groups"}</button>
                <button className="btn outline" aria-label={"Disconnect " + s.label} disabled={saving} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Disconnect requested")}><WifiOff size={16}/></button>
              </> : <>
                <button className="btn primary" disabled={saving} onClick={() => { setQrSession(s); setQr(null); void update("POST", "/api/v1/sessions/" + s.id + "/connect", {}, s.phone ? "Restoring the saved WhatsApp login…" : "Connection requested; scan the QR code when it appears."); }}><QrCode size={16}/> {s.status === "QR_READY" ? "View QR" : s.phone ? "Restore session" : "Connect"}</button>
                <button className="btn outline" onClick={() => { setQrSession(s); setQr(null); }}><QrCode size={16}/></button>
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
              <select aria-label="WhatsApp phone ID availability" value={phoneFilter} onChange={e => { setPhoneFilter(e.target.value as "" | "usable" | "unavailable"); setContactPage(1); clearSelection(); }}><option value="">All phone IDs</option><option value="usable">Phone number available</option><option value="unavailable">Unresolved IDs (no phone)</option></select>
              <select aria-label="Session filter" title="Account where the contact was discovered; any sending account can reach this contact" value={sessionFilter} onChange={e => { setSessionFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All source accounts</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
              <select aria-label="Filter by group" value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All groups</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              <select aria-label="Filter by contact source" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All contact sources</option><option value="mine">My phone contacts</option><option value="groups">From groups</option><option value="other">Other / imported</option></select>
              <select aria-label="Filter by segment" value={segmentFilter} onChange={e => { setSegmentFilter(e.target.value); setContactPage(1); clearSelection(); }}><option value="">All segments</option><option value="__unsegmented">Not in a segment</option>{segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
            <div className="bulk-toolbar"><div><strong>{selectionCount.toLocaleString()} selected</strong>{allMatching && <span> across all matching pages</span>}</div><div className="action-buttons"><button className="text-button" disabled={!contactTotal} onClick={() => { setAllMatching(true); setSelectedContacts([]); }}>Select all {contactTotal.toLocaleString()} matching</button>{selectionCount > 0 && <button className="text-button" onClick={clearSelection}>Clear selection</button>}</div></div>
            <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select page" ref={node => { if (node) node.indeterminate = !allMatching && contacts.some(c => selectedContacts.includes(c.id)) && !contacts.every(c => selectedContacts.includes(c.id)); }} checked={contacts.length > 0 && (allMatching || contacts.every(c => selectedContacts.includes(c.id)))} onChange={e => { setAllMatching(false); setSelectedContacts(prev => e.target.checked ? [...new Set([...prev, ...contacts.map(c => c.id)])] : prev.filter(id => !contacts.some(c => c.id === id))); }}/></th><th>Contact</th><th>WhatsApp ID</th><th>Source account</th><th>Consent</th><th>Source & segments</th></tr></thead>
              <tbody>{contacts.map(c => <tr key={c.id}><td><input type="checkbox" aria-label={`Select ${c.name || c.whatsappId}`} checked={allMatching || selectedContacts.includes(c.id)} onChange={() => { setAllMatching(false); setSelectedContacts(prev => allMatching ? contacts.filter(x => x.id !== c.id).map(x => x.id) : toggle(prev, c.id)); }}/></td>
                <td><div className="name-cell"><div className="person-avatar">{(c.name || c.phone || "?").charAt(0).toUpperCase()}</div><div><strong>{c.name || "Unnamed contact"}</strong><small>{c.phone ? "+" + c.phone : "No phone exposed"}</small></div></div></td><td><code className="mono">{c.whatsappId}</code></td><td>{c.session?.label || "—"}</td>
                <td><select aria-label={`Consent for ${c.name || c.whatsappId}`} className={`consent-select ${c.consent.toLowerCase()}`} value={c.consent} onChange={event => { const value = event.target.value as "OPTED_IN" | "OPTED_OUT" | "UNKNOWN"; if (value !== c.consent) reviewConsent({ contactIds: [c.id] }, 1, value); }}><option value="UNKNOWN">Unknown</option><option value="OPTED_IN" disabled={!c.phone}>Opted in</option><option value="OPTED_OUT">Opted out</option></select></td><td><div className="contact-tags"><span className="source-tag">{c.isMyContact ? "My phone contact" : c._count?.members ? "From group" : "Other / imported"}</span>{c.segments?.map(({ segment }) => <button className="segment-tag" key={segment.id} onClick={() => { setSegmentFilter(segment.id); setContactPage(1); clearSelection(); }}>{segment.name}</button>)}</div></td></tr>)}</tbody></table></div>
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
          {segments.length ? <div className="segment-grid">{segments.map(s => <section className="segment-card" key={s.id} data-segment-id={s.id}><div className="segment-icon"><Tags size={21}/></div><h3>{s.name}</h3><p>{s.description || "A reusable audience from any contact source."}</p><div className="segment-card-actions"><button className="btn outline" onClick={() => browseSegment(s)}>Browse contacts <ChevronRight size={15}/></button><button className="btn subtle" disabled={!s._count.members} onClick={() => setOrganizer({ selection: { filter: { segmentId: s.id } }, count: s._count.members, sourceSegmentId: s.id })}>Organize all</button><button className="btn subtle" disabled={!s._count.members} onClick={() => { openCampaignBuilder(); setCampaignForm(p => ({ ...p, segmentIds: [s.id] })); }}><Megaphone size={14}/> Campaign</button></div><div className="segment-bottom"><span><Users size={15}/> {s._count.members.toLocaleString()} contacts</span><div><button className="text-button" onClick={() => { setEditingSegmentId(s.id); setNewSegment(s.name); setSegmentDesc(s.description || ""); setSegmentOpen(true); }}>Edit</button><button className="icon-button" title={"Delete " + s.name} disabled={saving} onClick={() => { confirmAction("Delete this segment?", `“${s.name}” will be deleted. Its contact records and group memberships will remain.`, "Delete segment", () => { void update("DELETE", "/api/v1/segments/" + s.id, undefined, "Segment deleted"); }, true); }}><Trash2 size={16}/></button></div></div></section>)}</div> : <Blank icon={Tags} title="No contact segments" desc="Create a segment here, or select contacts in the directory to create and fill one together." action={<button className="btn primary" onClick={() => { setEditingSegmentId(null); setSegmentOpen(true); }}><Plus size={16}/> New segment</button>}/>}
        </>}
        {view === "campaigns" && <>
          <SectionHeading eyebrow="MESSAGE AUTOMATION" title="Campaigns" description="Build campaigns, verify recipients, then schedule or launch delivery." action={<button className="btn primary" onClick={openCampaignBuilder}><Plus size={16}/> Create campaign</button>}/>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Destination</th><th>Schedule</th><th>Status</th><th>Runs</th><th>Actions</th></tr></thead><tbody>{campaigns.map(c => <tr key={c.id}>
            <td><div className="name-cell"><div className="person-avatar orange"><Megaphone size={17}/></div><div><strong>{c.name}</strong><small>{c.session.label} · {formatDate(c.createdAt)}</small></div></div></td>
            <td title="Selected individual contacts and segments, not the number eligible to receive messages">{c.audienceType === "GROUPS" ? `${c._count.groups} groups` : `${c._count.contacts} individual, ${c._count.segments} segments`}</td>
            <td><div className="schedule-cell">{c.scheduleType === "NOW" ? "Send now" : c.scheduleType === "ONCE" ? formatDate(c.scheduledAt) : <><CalendarClock size={15}/><code>{c.cron}</code></>}</div></td><td><Flag value={c.status}/></td><td>{c._count.runs}</td><td><div className="action-buttons">
              <button className="btn subtle" onClick={() => void inspectCampaign(c.id)}>Details</button>
              {c.status === "DRAFT" && <button className="btn subtle" onClick={() => void editCampaign(c.id)}>Edit</button>}
              {c.status === "DRAFT" && <button className="btn mini-primary" disabled={saving} onClick={() => void launchCampaign(c.id)}><Play size={14}/> Launch</button>}
              {["ACTIVE", "SCHEDULED"].includes(c.status) && <button className="btn outline" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "pause" }, "Campaign paused")}><Square size={13}/> Pause</button>}
              {c.status === "PAUSED" && <button className="btn mini-primary" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "resume" }, "Campaign resumed")}><Play size={14}/> Resume</button>}
              {["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status) && <button className="icon-button" title="Cancel" onClick={() => { confirmAction("Cancel campaign?", `Cancel “${c.name}”? Any future scheduled sends will be stopped.`, "Cancel campaign", () => { void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "cancel" }, "Campaign cancelled"); }, true); }}><X size={16}/></button>}
              {c.status === "DRAFT" && <button className="icon-button" title="Delete draft" onClick={() => { confirmAction("Delete draft?", `Delete the draft “${c.name}”? This cannot be undone.`, "Delete draft", () => { void update("DELETE", "/api/v1/campaigns/" + c.id, undefined, "Draft deleted"); }, true); }}><Trash2 size={16}/></button>}
            </div></td>
          </tr>)}</tbody></table></div>{!campaigns.length && <Blank icon={Megaphone} title="Your first campaign starts here" desc="Create a draft, review your audience and schedule messages." action={<button className="btn primary" onClick={openCampaignBuilder}><Plus size={16}/> Create campaign</button>}/>}</section>
        </>}
        {view === "reports" && <>
          <SectionHeading eyebrow="REPORTING" title="Delivery reports" description="Execution history, individual message status, and errors." action={<button className="btn outline" onClick={() => void refresh()}><RefreshCw size={16}/> Refresh</button>}/>
          <div className="kpi-grid reports-grid">{[
            { label: "Campaign runs", n: overview?.runs ?? 0, icon: Activity },
            { label: "Completed runs", n: runs.filter(r => r.status === "COMPLETED").length, icon: CheckCircle2 },
            { label: "Partial runs", n: runs.filter(r => r.status === "PARTIAL").length, icon: ListFilter },
            { label: "Failed runs", n: runs.filter(r => r.status === "FAILED").length, icon: WifiOff },
          ].map(k => <div className="kpi" key={k.label}><div className="kpi-top"><span>{k.label}</span><k.icon size={19}/></div><div className="kpi-value">{k.n}</div></div>)}</div>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Started</th><th>Status</th><th>Messages sent</th><th>Delivered / read</th><th>Failures / uncertain</th></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td><strong>{r.campaign.name}</strong></td><td>{formatDate(r.startedAt)}</td><td><Flag value={r.status}/></td><td>{r.deliveries.filter(d => ["SENT", "DELIVERED", "READ"].includes(d.status)).length}</td><td>{r.deliveries.filter(d => ["DELIVERED", "READ"].includes(d.status)).length}</td><td>{r.deliveries.filter(d => ["FAILED", "UNKNOWN"].includes(d.status)).length}</td></tr>)}</tbody></table></div>{!runs.length && <Blank icon={BarChart3} title="No delivery data yet" desc="Launch a campaign to generate an execution report."/>}</section>
          <p className="muted-footnote">A sent status means WhatsApp accepted the outgoing message, not that someone read it. Delivery and read receipts may be unavailable.</p>
        </>}
        {view === "settings" && <>
          <SectionHeading eyebrow="WORKSPACE CONFIGURATION" title="Settings & help" description="Operational configuration and local deployment guidance."/>
          <div className="info-strip"><div className="info-icon"><Activity size={20}/></div><div><strong>Service status</strong><p>{health ? `Database: ${health.database}. Redis: ${health.redis === "PONG" ? "connected" : health.redis}. Background worker: ${health.workerReady ? "online" : "offline — start npm run dev:all or npm run worker"}.` : "Checking services…"}</p></div></div>
          <div className="settings-grid"><section className="panel settings-panel"><h2><ShieldCheck size={19}/> Safety & privacy</h2><p>Outbound individual campaigns require an explicit OPTED_IN consent status. Incoming STOP or UNSUBSCRIBE automatically suppresses future marketing sends. Group sending must be authorized per group.</p><p>Admin authentication uses a signed HttpOnly cookie and each API operation verifies the session.</p></section>
            <section className="panel settings-panel"><h2><Smartphone size={19}/> Session storage</h2><p>WhatsApp Chromium sessions are stored under <code>SESSION_DIR</code> on the worker&apos;s persistent disk. Do not deploy the worker to serverless environments or commit auth directories to GitHub.</p></section>
            <section className="panel settings-panel"><h2><CalendarClock size={19}/> Background jobs</h2><p>Redis and BullMQ handle scheduled delivery and one-off jobs. The worker must be running at all times for campaigns and QR connections to execute.</p></section>
            <section className="panel settings-panel"><h2><CircleHelp size={19}/> Start locally</h2><p>Run npm run setup to configure services and your admin account, then npm run dev:all. Run npm run doctor to check the configuration. See the README for details.</p></section></div>
        </>}
      </main>
    </div>
    {createSessionOpen && <Modal title="Add WhatsApp account" close={() => setCreateSessionOpen(false)}><div className="modal-body"><p className="modal-help">Give this connection a recognizable name. You can link the device with a QR code afterwards.</p><label>Session name<input value={newSession} maxLength={80} placeholder="e.g. Customer support" onChange={e => setNewSession(e.target.value)}/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setCreateSessionOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={async () => { if (await update("POST", "/api/v1/sessions", { label: newSession }, "Session created")) { setCreateSessionOpen(false); setNewSession(""); } }}>Create session</button></div></Modal>}
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
    {bulkConsentOpen && <Modal title="Record verified opt-in" close={() => setBulkConsentOpen(false)}><div className="modal-body">
      <p className="modal-help"><strong>{selectedContacts.length} selected contact records.</strong> Use this only for people who explicitly agreed to receive your WhatsApp marketing messages. Being in a group or saved in your contacts is not permission.</p>
      <label>How did they opt in?
        <select value={consentMethod} onChange={e => setConsentMethod(e.target.value as typeof consentMethod)}>
          <option value="WHATSAPP_REPLY">Explicit WhatsApp reply</option><option value="WEB_FORM">Website signup / form</option><option value="IN_PERSON">In-person permission</option><option value="OTHER">Other documented permission</option>
        </select>
      </label>
      <label>Evidence (include when and how they consented)
        <textarea rows={4} minLength={10} maxLength={400} placeholder="e.g. Each selected person replied YES to receive Moi Mashinani updates on 27 Oct 2026. Evidence retained in..." value={consentEvidence} onChange={e => setConsentEvidence(e.target.value)}/>
      </label>
      <label className="switch-label"><input type="checkbox" checked={consentConfirmed} onChange={e => setConsentConfirmed(e.target.checked)}/><span>I confirm each selected person explicitly opted in, and I can substantiate this record.</span></label>
      <p className="muted-footnote">Opted-out contacts and unresolved WhatsApp identifiers cannot be bulk-approved. The action updates matching phone records across connected source sessions and writes an audit entry.</p>
    </div><div className="modal-actions">
      <button className="btn outline" onClick={() => setBulkConsentOpen(false)}>Cancel</button>
      <button className="btn primary" disabled={saving || !consentConfirmed || consentEvidence.trim().length < 10} onClick={() => void recordSelectedConsent()}><ShieldCheck size={16}/> Save verified consent</button>
    </div></Modal>}
    {inspectedMembers && <Modal title={inspectedMembers.group.name + " members"} close={() => setInspectedMembers(null)}><div className="modal-body"><p className="modal-help">Showing {inspectedMembers.members.length} of {inspectedMembers.group._count.members} saved contacts. Save all to contacts imports every available group member, including members beyond this preview of up to 500 contacts.</p><div className="member-list">{inspectedMembers.members.map(m => <div className="member-row" key={m.contact.id}><span>{m.contact.name || m.contact.phone || m.contact.whatsappId}</span><Flag value={m.contact.consent}/></div>)}{!inspectedMembers.members.length && <p>Save the group members to add them to your Contacts directory.</p>}</div></div><div className="modal-actions"><button className="btn outline" disabled={!inspectedMembers.group._count.members} onClick={() => viewGroupContacts(inspectedMembers.group)}>View saved contacts</button><button className="btn primary" disabled={saving || syncPending(inspectedMembers.group.sync) || inspectedMembers.group.session.status !== "CONNECTED"} onClick={() => void saveGroupContacts(inspectedMembers.group)}><ContactRound size={15}/> Save all to contacts</button></div></Modal>}
    {inspectedCampaign && <Modal title={inspectedCampaign.name} close={() => { setInspectedCampaign(null); setAudiencePreview(null); }} wide><div className="modal-body"><div className="eyebrow">MESSAGE</div><div className="message-preview">{inspectedCampaign.message}</div>{inspectedCampaign.mediaName && <div className="muted-footnote">Attachment: {inspectedCampaign.mediaName}</div>}<div className="detail-row"><strong>Eligible recipients now</strong><strong>{audiencePreview?.count ?? "…"}</strong></div>
      {audiencePreview && <><p className="muted-footnote">{audiencePreview.total} selected contact/group records · {audiencePreview.duplicates} duplicates removed · {audiencePreview.excluded} ineligible</p>
        {audiencePreview.count === 0 && <div className="notice danger"><strong>No eligible recipients.</strong> Saved contacts are not automatically approved for campaigns.</div>}
        {audiencePreview.exclusions.missingConsent > 0 && <p>{audiencePreview.exclusions.missingConsent} contacts require recorded, explicit opt-in.</p>}
        {audiencePreview.exclusions.unusablePhone > 0 && <p>{audiencePreview.exclusions.unusablePhone} contacts have no usable phone-number WhatsApp ID (for example, an unresolved @lid).</p>}
        {audiencePreview.exclusions.optedOut > 0 && <p>{audiencePreview.exclusions.optedOut} contacts opted out or are suppressed.</p>}
        {audiencePreview.exclusions.unauthorizedGroups > 0 && <p>{audiencePreview.exclusions.unauthorizedGroups} groups have no posting authorization.</p>}
        {inspectedCampaign.audienceType === "CONTACTS" && <div className="action-buttons">
          {audiencePreview.exclusions.missingConsent > 0 && <button className="btn primary" onClick={() => reviewCampaignContacts("missingConsent")}><ShieldCheck size={15}/> Review consent records ({audiencePreview.exclusions.missingConsent})</button>}
          {audiencePreview.exclusions.unusablePhone > 0 && <button className="btn outline" onClick={() => reviewCampaignContacts("unusablePhone")}><ContactRound size={15}/> Review unresolved IDs ({audiencePreview.exclusions.unusablePhone})</button>}
          <button className="btn outline" onClick={() => reviewCampaignContacts("all")}>All selected contacts</button>
        </div>}
        {inspectedCampaign.audienceType === "GROUPS" && audiencePreview.exclusions.unauthorizedGroups > 0 && <button className="btn outline" onClick={() => { setInspectedCampaign(null); setAudiencePreview(null); setView("groups"); }}>Review group authorizations</button>}
      </>}
      <p className="muted-footnote">Sample: {audiencePreview?.sample.map(s => s.label).join(", ") || "None"}</p><h3 className="sub-title">Previous executions</h3>{inspectedCampaign.runs.length ? inspectedCampaign.runs.map(run => <div className="run-detail" key={run.id}><div className="detail-row"><strong>{formatDate(run.startedAt)}</strong><Flag value={run.status}/></div>{run.error && <p className="tiny-error">{run.error}</p>}{run.deliveries.map((d, i) => <div className="detail-row" key={i}><span>{d.recipient}</span><span title={d.error || ""}><Flag value={d.status}/></span></div>)}</div>) : <p className="muted-footnote">No executions yet.</p>}</div></Modal>}
    {campaignOpen && <Modal title={editingCampaignId ? "Edit campaign draft" : "Create a campaign"} close={() => setCampaignOpen(false)} wide><div className="modal-body campaign-builder">
      <div className="form-grid"><label>Campaign name<input value={campaignForm.name} maxLength={100} placeholder="e.g. October customer update" onChange={e => setCampaignForm(p => ({ ...p, name: e.target.value }))}/></label>
        <label>Sending account<select value={campaignForm.sessionId} onChange={e => setCampaignForm(p => ({ ...p, sessionId: e.target.value, groupIds: [] }))}><option value="">Choose account…</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.label} — {s.status.toLowerCase()}</option>)}</select></label></div>
      <label>Message<textarea rows={5} maxLength={4096} placeholder={"Hi {{first_name}}, we have an update for you…"} value={campaignForm.message} onChange={e => setCampaignForm(p => ({ ...p, message: e.target.value }))}/><small>Use {"{{first_name}}"}, {"{{name}}"} or {"{{phone}}"} for contact campaigns.</small></label>
      <label>Attachment (optional: JPEG, PNG, WebP or PDF; maximum 8 MB)
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setMediaFile(e.target.files?.[0] || null)}/>
        {(mediaFile || campaignForm.mediaName) && <small>{mediaFile?.name || campaignForm.mediaName} {campaignForm.mediaName && !mediaFile ? "(existing attachment)" : ""}</small>}
      </label>
      <p className="modal-help">The sending account is independent of your segments. Combine several segments; each eligible phone number receives one message per run.</p>
      <div className="sub-title">1. Choose recipients</div><div className="pill-choice">{(["CONTACTS", "GROUPS"] as const).map(choice => <button key={choice} className={campaignForm.audienceType === choice ? "picked" : ""} onClick={() => setCampaignForm(p => ({ ...p, audienceType: choice }))}>{choice === "CONTACTS" ? <ContactRound size={16}/> : <Users size={16}/>} {choice === "CONTACTS" ? "Opted-in contacts" : "Authorized groups"}</button>)}</div>
      {campaignForm.audienceType === "CONTACTS" ? <><div className="field-caption">CONTACT SEGMENTS · SHARED ACROSS ACCOUNTS</div><div className="selection-grid">{segments.map(s => <label className="check-item" key={s.id}><input type="checkbox" checked={campaignForm.segmentIds.includes(s.id)} onChange={() => setCampaignForm(p => ({ ...p, segmentIds: toggle(p.segmentIds, s.id) }))}/><span>{s.name} <small>({s._count.members})</small></span></label>)}{!segments.length && <span className="muted-footnote">No segments yet. Select individual contacts below or create segments from the Contacts directory.</span>}</div>
        <div className="field-caption">INDIVIDUAL ELIGIBLE CONTACTS ({campaignForm.contactIds.length} selected)</div>
        <input aria-label="Search campaign contacts" placeholder="Search opted-in contacts across all accounts…" value={campaignContactSearch} onChange={e => { setCampaignContactSearch(e.target.value); setCampaignContactPage(1); }}/>
        {campaignContactsLoading && <p className="muted-footnote">Loading contacts…</p>}<div className="selection-grid scroll-selection">{eligible.map(c => <label className="check-item" key={c.id}><input type="checkbox" checked={campaignForm.contactIds.includes(c.id)} onChange={() => setCampaignForm(p => ({ ...p, contactIds: toggle(p.contactIds, c.id) }))}/><span>{c.name || c.phone || c.whatsappId}</span></label>)}</div>
        <div className="table-footer"><span>{campaignContactTotal} eligible contacts</span><div className="pager"><button aria-label="Previous campaign contacts" disabled={campaignContactPage <= 1} onClick={() => setCampaignContactPage(p => p - 1)}><ArrowLeft size={16}/></button><span>Page {campaignContactPage} of {Math.max(1, Math.ceil(campaignContactTotal / 40))}</span><button aria-label="Next campaign contacts" disabled={campaignContactPage * 40 >= campaignContactTotal} onClick={() => setCampaignContactPage(p => p + 1)}><ArrowRight size={16}/></button></div></div></> :
        <div className="selection-grid scroll-selection">{groups.filter(g => g.sessionId === campaignForm.sessionId && g.allowPosting).map(g => <label className="check-item" key={g.id}><input type="checkbox" checked={campaignForm.groupIds.includes(g.id)} onChange={() => setCampaignForm(p => ({ ...p, groupIds: toggle(p.groupIds, g.id) }))}/><span>{g.name}</span></label>)}{!groups.some(g => g.sessionId === campaignForm.sessionId && g.allowPosting) && <span className="muted-footnote">Authorize group announcements from the Groups screen first.</span>}</div>}
      <div className="sub-title">2. Schedule delivery</div><div className="pill-choice">{(["NOW", "ONCE", "CRON"] as const).map(choice => <button key={choice} className={campaignForm.scheduleType === choice ? "picked" : ""} onClick={() => setCampaignForm(p => ({ ...p, scheduleType: choice }))}>{choice === "NOW" ? <Send size={16}/> : <Clock3 size={16}/>} {choice === "NOW" ? "When launched" : choice === "ONCE" ? "Specific date" : "Recurring cron"}</button>)}</div>
      {campaignForm.scheduleType === "CRON" && <label>Repeat preset<select aria-label="Recurring schedule preset" value={["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"].includes(campaignForm.cron) ? campaignForm.cron : "custom"} onChange={e => setCampaignForm(p => ({ ...p, cron: e.target.value === "custom" ? "0 10 * * *" : e.target.value }))}><option value="0 9 * * *">Daily at 09:00</option><option value="0 9 * * 1-5">Weekdays at 09:00</option><option value="0 9 * * 1">Mondays at 09:00</option><option value="0 9 1 * *">First of the month at 09:00</option><option value="custom">Custom cron</option></select></label>}
      <div className="form-grid">{campaignForm.scheduleType === "ONCE" && <label>Date and time in selected timezone<input type="datetime-local" value={campaignForm.scheduledAt} onChange={e => setCampaignForm(p => ({ ...p, scheduledAt: e.target.value }))}/></label>}{campaignForm.scheduleType === "CRON" && <label>Cron expression<input value={campaignForm.cron} onChange={e => setCampaignForm(p => ({ ...p, cron: e.target.value }))} placeholder="0 9 * * 1"/><small>Minute · hour · day · month · weekday</small></label>}{campaignForm.scheduleType !== "NOW" && <label>Schedule timezone<input list="campaign-timezones" value={campaignForm.timezone} onChange={e => setCampaignForm(p => ({ ...p, timezone: e.target.value }))}/><datalist id="campaign-timezones">{["Africa/Nairobi", "UTC", "Europe/London", "America/New_York", "Asia/Dubai", "Asia/Kolkata"].map(zone => <option key={zone} value={zone}/>)}</datalist></label>}</div>
      <label>Interval between messages (seconds)<input type="number" aria-label="Message interval in seconds" min={1.5} max={3600} step={0.5} value={campaignForm.sendIntervalMs / 1000} onChange={e => setCampaignForm(p => ({ ...p, sendIntervalMs: Number(e.target.value) * 1000 }))}/><small>Default: 5 seconds. The workspace minimum also applies. Messages send one at a time.</small></label>
      <div className="audience-preview" aria-live="polite">{previewLoading ? <p>Updating audience and timing…</p> : draftPreview ? <><div className="detail-row"><strong>{draftPreview.count.toLocaleString()} unique eligible recipients</strong><span>Limit: {draftPreview.limit}</span></div><p>{draftPreview.excluded} excluded · {draftPreview.duplicates} duplicate records removed</p>
        {draftPreview.exclusions.missingConsent > 0 && <p>{draftPreview.exclusions.missingConsent} awaiting verified opt-in</p>}
        {draftPreview.exclusions.unusablePhone > 0 && <p>{draftPreview.exclusions.unusablePhone} without a usable phone-number ID</p>}
        {draftPreview.exclusions.optedOut > 0 && <p>{draftPreview.exclusions.optedOut} opted out or suppressed</p>}
        {draftPreview.exclusions.unauthorizedGroups > 0 && <p>{draftPreview.exclusions.unauthorizedGroups} groups without posting authorization</p>}
        {draftPreview.count === 0 && <div className="notice danger">No eligible recipients yet. Review consent and phone availability in Contacts before launch.</div>}<p>At least {Math.max(1, Math.ceil(draftPreview.durationMs / 60000))} minutes per run at {draftPreview.intervalMs / 1000}s between messages. Queue load and network time may add delays.</p><p>Sample: {draftPreview.sample.map(c => c.label).join(", ") || "No eligible recipients"}</p><strong>{campaignForm.scheduleType === "NOW" ? "Starts when you launch" : `Next runs · ${campaignForm.timezone}`}</strong>{campaignForm.scheduleType !== "NOW" && <ol>{draftPreview.nextRuns.slice(0, 3).map(date => <li key={date}>{new Date(date).toLocaleString("en-KE", { timeZone: campaignForm.timezone, dateStyle: "medium", timeStyle: "short" })}</li>)}</ol>}{draftPreview.scheduleIssue && <div className="notice danger">{draftPreview.scheduleIssue}</div>}{draftPreview.count > draftPreview.limit && <div className="notice danger">Reduce the audience before launching; this selection exceeds the campaign limit.</div>}</> : <p>Add a name, message and audience to preview recipients and timing.</p>}{draftPreviewError && <div className="notice danger">{draftPreviewError}</div>}</div>
      <div className="builder-note"><ShieldCheck size={17}/><span>Save as draft first. The server checks current permissions, recipients and your campaign cap at launch.</span></div>
    </div><div className="modal-actions"><button className="btn outline" onClick={() => setCampaignOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void createCampaign()}><Check size={17}/> {editingCampaignId ? "Update draft" : "Save campaign draft"}</button></div></Modal>}
  </div>;
}
