"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BarChart3, CalendarClock, Check,
  CheckCircle2, ChevronRight, CircleHelp, Clock3, ContactRound, Copy, FolderPlus,
  LayoutDashboard, ListFilter, LoaderCircle, LockKeyhole, LogOut, Megaphone,
  MessageCircle, MoreHorizontal, Play, Plus, QrCode, RefreshCw, Search, Send, Settings2,
  ShieldCheck, Smartphone, Square, Tags, Trash2, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

type View = "overview" | "sessions" | "contacts" | "groups" | "segments" | "campaigns" | "reports" | "settings";
type Session = { id: string; label: string; phone?: string | null; status: string; error?: string | null; lastSeen?: string | null; _count?: { contacts: number; groups: number } };
type Contact = { id: string; sessionId: string; whatsappId: string; phone: string | null; name: string | null; consent: string; isMyContact: boolean; session?: { label: string } };
type Group = { id: string; sessionId: string; whatsappId: string; name: string; participantCount: number; allowPosting: boolean; session: { label: string }; _count: { members: number } };
type Segment = { id: string; name: string; description?: string | null; _count: { members: number } };
type Run = { id: string; campaignId: string; status: string; startedAt: string; finishedAt?: string | null; campaign: { name: string }; deliveries: { status: string; recipient?: string; error?: string | null }[] };
type Campaign = { id: string; name: string; message: string; sessionId: string; audienceType: string; scheduleType: string; timezone: string; cron?: string | null; scheduledAt?: string | null; status: string; createdAt: string; session: { label: string; status: string }; _count: { contacts: number; groups: number; segments: number; runs: number }; runs: { id: string }[] };
type Overview = { sessions: number; contacts: number; optedIn: number; groups: number; campaigns: number; runs: number; latest: (Run & { deliveries: { status: string }[] })[] };
type ContactPage = { items: Contact[]; total: number; page: number; take: number };
type CampaignForm = { name: string; message: string; sessionId: string; audienceType: "CONTACTS" | "GROUPS"; contactIds: string[]; segmentIds: string[]; groupIds: string[]; scheduleType: "NOW" | "ONCE" | "CRON"; scheduledAt: string; cron: string; timezone: string };

const initCampaign: CampaignForm = { name: "", message: "", sessionId: "", audienceType: "CONTACTS", contactIds: [], segmentIds: [], groupIds: [], scheduleType: "NOW", scheduledAt: "", cron: "0 9 * * 1", timezone: "Africa/Nairobi" };
const menu: { key: View; title: string; icon: typeof LayoutDashboard; section: string }[] = [
  { key: "overview", title: "Overview", icon: LayoutDashboard, section: "Workspace" },
  { key: "sessions", title: "WhatsApp sessions", icon: Smartphone, section: "Workspace" },
  { key: "contacts", title: "Contacts", icon: ContactRound, section: "Audience" },
  { key: "groups", title: "Groups", icon: Users, section: "Audience" },
  { key: "segments", title: "Contact lists", icon: Tags, section: "Audience" },
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
async function api<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, { method: options?.method || "GET", headers: options?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: options?.body === undefined ? undefined : JSON.stringify(options.body), cache: "no-store" });
  const body = await res.json().catch(() => ({ error: "Unexpected server response" }));
  if (!res.ok) throw new Error(body.error || "Request failed");
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
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactTotal, setContactTotal] = useState(0);
  const [contactPage, setContactPage] = useState(1);
  const [contactSearch, setContactSearch] = useState("");
  const [consentFilter, setConsentFilter] = useState("");
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
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [newSegment, setNewSegment] = useState("");
  const [segmentDesc, setSegmentDesc] = useState("");
  const [inspectSegment, setInspectSegment] = useState<{ name: string; members: { contact: Contact }[] } | null>(null);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [campaignForm, setCampaignForm] = useState<CampaignForm>(initCampaign);
  const [inspectedCampaign, setInspectedCampaign] = useState<{
    name: string; message: string; runs: { id: string; startedAt: string; status: string; deliveries: { recipient: string; status: string; error: string | null }[] }[];
  } | null>(null);
  const [audiencePreview, setAudiencePreview] = useState<{ count: number; sample: { label: string }[] } | null>(null);
  const [inspectedMembers, setInspectedMembers] = useState<{ name: string; members: { contact: Contact }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const inform = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const loadContacts = useCallback(async (page: number, search: string, consent: string, session: string) => {
    const query = new URLSearchParams({ page: String(page), take: "40" });
    if (search) query.set("search", search);
    if (consent) query.set("consent", consent);
    if (session) query.set("sessionId", session);
    const data = await api<ContactPage>("/api/v1/contacts?" + query.toString());
    setContacts(data.items); setContactTotal(data.total);
  }, []);
  const loadAll = useCallback(async () => {
    const [overviewData, sessionsData, groupsData, segmentsData, campaignsData, runsData] = await Promise.all([
      api<Overview>("/api/v1/overview"), api<Session[]>("/api/v1/sessions"), api<Group[]>("/api/v1/groups"),
      api<Segment[]>("/api/v1/segments"), api<Campaign[]>("/api/v1/campaigns"), api<Run[]>("/api/v1/runs"),
    ]);
    setOverview(overviewData); setSessions(sessionsData); setGroups(groupsData); setSegments(segmentsData);
    setCampaigns(campaignsData); setRuns(runsData);
    setCampaignForm(prev => ({ ...prev, sessionId: prev.sessionId || sessionsData[0]?.id || "" }));
    setLoading(false);
  }, []);
  const signedIn = useCallback(async () => {
    const { user } = await api<{ user: { email: string } }>("/api/auth/me");
    setEmail(user.email); setAuth("in");
    try { await loadAll(); } catch (e) { inform(e instanceof Error ? e.message : "Could not load data", true); }
  }, [inform, loadAll]);
  useEffect(() => { void signedIn().catch(() => { setAuth("out"); setLoading(false); }); }, [signedIn]);
  useEffect(() => { if (auth !== "in") return; void loadContacts(contactPage, contactSearch, consentFilter, sessionFilter).catch(e => inform(String(e), true)); }, [auth, contactPage, contactSearch, consentFilter, sessionFilter, loadContacts, inform]);
  useEffect(() => { if (auth !== "in") return; const timer = setInterval(() => { void loadAll().catch(() => {}); }, 12000); return () => clearInterval(timer); }, [auth, loadAll]);
  useEffect(() => { if (!qrSession) return; let alive = true;
    const poll = () => { void api<{ qr: string | null }>("/api/v1/sessions/" + qrSession.id + "/qr").then(v => { if (alive) setQr(v.qr); }).catch(() => {}); };
    poll(); const timer = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [qrSession]);

  async function update(method: string, path: string, body?: unknown, message = "Changes saved") {
    setSaving(true);
    try { await api(path, { method, body }); await loadAll(); await loadContacts(contactPage, contactSearch, consentFilter, sessionFilter); inform(message); return true; }
    catch (e) { inform(e instanceof Error ? e.message : "Request failed", true); return false; }
    finally { setSaving(false); }
  }
  async function createCampaign() {
    if (!campaignForm.sessionId) { inform("Connect or add a WhatsApp account first", true); return; }
    if (campaignForm.scheduleType === "ONCE" && !campaignForm.scheduledAt) { inform("Choose a schedule date", true); return; }
    const body = { ...campaignForm, scheduledAt: campaignForm.scheduleType === "ONCE" ? new Date(campaignForm.scheduledAt).toISOString() : undefined };
    const saved = await update("POST", "/api/v1/campaigns", body, "Campaign draft created. Preview the recipients before launch.");
    if (saved) { setCampaignOpen(false); setCampaignForm({ ...initCampaign, sessionId: campaignForm.sessionId }); setView("campaigns"); }
  }
  const eligible = useMemo(() => contacts.filter(c => c.consent === "OPTED_IN"), [contacts]);
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
        <button className="icon-button" title="Sign out" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setAuth("out"); }}><LogOut size={17}/></button></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="crumb">Workspace <ChevronRight size={14}/> <strong>{title}</strong></div>
        <div className="top-actions"><span className={`live-label ${activeSessions ? "online" : ""}`}><span className="live-dot"/>{activeSessions} connected</span>
          <button className="icon-button" title="Refresh data" onClick={() => void loadAll()}><RefreshCw size={17}/></button><div className="top-avatar">{email.charAt(0).toUpperCase()}</div></div>
      </header>
      <main className="content">
        {notice && <div role="status" className={`toast ${notice.error ? "toast-error" : ""}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}><X size={16}/></button></div>}
        {loading && <div className="loading-line"><LoaderCircle className="spin" size={19}/> Fetching workspace data…</div>}
        {view === "overview" && <>
          <SectionHeading eyebrow="YOUR WORKSPACE AT A GLANCE" title="Good to have you back." description="Monitor your audiences, connected devices, and campaign activity." action={<button className="btn primary" onClick={() => setCampaignOpen(true)}><Plus size={17}/> New campaign</button>}/>
          <div className="kpi-grid">{[
            { title: "Total contacts", value: overview?.contacts ?? 0, desc: "Synced & imported", icon: ContactRound, tone: "blue" },
            { title: "Opted-in contacts", value: overview?.optedIn ?? 0, desc: "Eligible for campaigns", icon: ShieldCheck, tone: "green" },
            { title: "WhatsApp groups", value: overview?.groups ?? 0, desc: "Across sessions", icon: Users, tone: "purple" },
            { title: "Campaigns", value: overview?.campaigns ?? 0, desc: "Drafts & scheduled", icon: Megaphone, tone: "orange" },
          ].map(item => <div className="kpi" key={item.title}><div className="kpi-top"><span>{item.title}</span><div className={`kpi-icon ${item.tone}`}><item.icon size={19}/></div></div><div className="kpi-value">{item.value.toLocaleString()}</div><div className="kpi-foot">{item.desc}</div></div>)}</div>
          <div className="two-columns"><section className="panel"><div className="panel-title"><div><h2>Recent campaigns</h2><p>The latest activity across your workspace</p></div><button className="text-button" onClick={() => setView("campaigns")}>View all <ArrowRight size={15}/></button></div>
            {campaigns.length ? <div className="compact-list">{campaigns.slice(0, 6).map(c => <div key={c.id} className="compact-row"><div className="list-icon"><Megaphone size={16}/></div><div className="grow"><strong>{c.name}</strong><small>{c.session.label} · {formatDate(c.createdAt)}</small></div><Flag value={c.status}/></div>)}</div> : <Blank icon={Megaphone} title="No campaigns yet" desc="Start with a message and choose your permitted audience." action={<button className="btn outline" onClick={() => setCampaignOpen(true)}>Create first campaign</button>}/>}
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
            <div className="session-actions">
              {s.status === "CONNECTED" ? <>
                <button className="btn primary" disabled={saving} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/sync", {}, "Sync queued. Contacts and groups will update shortly.")}><RefreshCw size={16}/> Sync contacts</button>
                <button className="btn outline" disabled={saving} onClick={() => void update("POST", "/api/v1/sessions/" + s.id + "/disconnect", {}, "Disconnect requested")}><WifiOff size={16}/></button>
              </> : <>
                <button className="btn primary" disabled={saving} onClick={() => { setQrSession(s); setQr(null); void update("POST", "/api/v1/sessions/" + s.id + "/connect", {}, "Connection requested; scan the QR code when it appears."); }}><QrCode size={16}/> {s.status === "QR_READY" ? "View QR" : "Connect"}</button>
                <button className="btn outline" onClick={() => { setQrSession(s); setQr(null); }}><QrCode size={16}/></button>
              </>}
            </div>
          </div>)}</div> : <Blank icon={Smartphone} title="No accounts connected" desc="Add a session, scan the QR code with your phone, then sync your contacts and groups." action={<button className="btn primary" onClick={() => setCreateSessionOpen(true)}><Plus size={16}/> Add a session</button>}/>}
          <div className="info-strip"><div className="info-icon"><Wifi size={20}/></div><div><strong>How pairing works</strong><p>Open WhatsApp → Linked devices → Link a device. Your session runs in the separate Node.js worker and requires that worker to stay online.</p></div></div>
        </>}
        {view === "contacts" && <>
          <SectionHeading eyebrow="AUDIENCE DIRECTORY" title="Contacts" description="Search and organize individual contacts. Only opted-in contacts are eligible for direct campaigns." action={<><button className="btn outline" onClick={() => setImportOpen(true)}><ArrowDownToLine size={16}/> Import CSV</button><button className="btn primary" onClick={() => { if (!selectedContacts.length) return inform("Select contacts first", true); setSegmentOpen(true); }}><FolderPlus size={16}/> Save to list ({selectedContacts.length})</button></>}/>
          <section className="panel table-panel">
            <div className="filterbar"><div className="search-box"><Search size={17}/><input aria-label="Search contacts" placeholder="Search names or numbers…" value={contactSearch} onChange={e => { setContactSearch(e.target.value); setContactPage(1); }}/></div>
              <select aria-label="Consent filter" value={consentFilter} onChange={e => { setConsentFilter(e.target.value); setContactPage(1); }}><option value="">All consent states</option><option value="OPTED_IN">Opted in</option><option value="UNKNOWN">Unknown</option><option value="OPTED_OUT">Opted out</option></select>
              <select aria-label="Session filter" value={sessionFilter} onChange={e => { setSessionFilter(e.target.value); setContactPage(1); }}><option value="">All accounts</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </div>
            <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select page" checked={contacts.length > 0 && contacts.every(c => selectedContacts.includes(c.id))} onChange={e => setSelectedContacts(prev => e.target.checked ? [...new Set([...prev, ...contacts.map(c => c.id)])] : prev.filter(id => !contacts.some(c => c.id === id)))}/></th><th>Contact</th><th>WhatsApp ID</th><th>Account</th><th>Consent</th><th>Saved contact</th></tr></thead>
              <tbody>{contacts.map(c => <tr key={c.id}><td><input type="checkbox" checked={selectedContacts.includes(c.id)} onChange={() => setSelectedContacts(prev => toggle(prev, c.id))}/></td>
                <td><div className="name-cell"><div className="person-avatar">{(c.name || c.phone || "?").charAt(0).toUpperCase()}</div><div><strong>{c.name || "Unnamed contact"}</strong><small>{c.phone ? "+" + c.phone : "No phone exposed"}</small></div></div></td><td><code className="mono">{c.whatsappId}</code></td><td>{c.session?.label || "—"}</td>
                <td><select aria-label={`Consent for ${c.name || c.whatsappId}`} className={`consent-select ${c.consent.toLowerCase()}`} value={c.consent} onChange={event => { const value = event.target.value; if (value === "OPTED_IN" && !window.confirm("Confirm this person explicitly consented to receive your WhatsApp campaigns and that you have recorded the evidence.")) return; void update("PATCH", "/api/v1/contacts/" + c.id, { consent: value, consentNote: value === "OPTED_IN" ? "Confirmed by administrator" : value === "OPTED_OUT" ? "Manually suppressed" : "" }, "Consent updated"); }}><option value="UNKNOWN">Unknown</option><option value="OPTED_IN">Opted in</option><option value="OPTED_OUT">Opted out</option></select></td><td>{c.isMyContact ? "Yes" : "No"}</td></tr>)}</tbody></table></div>
            {!contacts.length && <Blank icon={ContactRound} title="No contacts found" desc="Sync a connected WhatsApp account, import an authorized list or adjust your filters."/>}
            <div className="table-footer"><span>{contactTotal.toLocaleString()} contacts · {selectedContacts.length} selected</span><div className="pager"><button disabled={contactPage <= 1} onClick={() => setContactPage(x => x - 1)}><ArrowLeft size={16}/></button><span>Page {contactPage} of {Math.max(1, Math.ceil(contactTotal / 40))}</span><button disabled={contactPage * 40 >= contactTotal} onClick={() => setContactPage(x => x + 1)}><ArrowRight size={16}/></button></div></div>
          </section>
        </>}
        {view === "groups" && <>
          <SectionHeading eyebrow="COMMUNITIES" title="WhatsApp groups" description="Groups accessible from linked accounts. Inspect available members and choose which groups permit announcements." action={<button className="btn outline" onClick={() => setView("sessions")}><RefreshCw size={16}/> Sync from sessions</button>}/>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Group</th><th>Account</th><th>Members</th><th>Posting authorization</th><th></th></tr></thead><tbody>{groups.map(g => <tr key={g.id}><td><div className="name-cell"><div className="person-avatar purple"><Users size={18}/></div><div><strong>{g.name}</strong><small>{g.whatsappId}</small></div></div></td><td>{g.session.label}</td><td>{g.participantCount}</td>
            <td><label className="switch-label"><input type="checkbox" checked={g.allowPosting} onChange={e => { const checked = e.target.checked; if (checked && !window.confirm("Confirm you are authorized to post campaign announcements in this group.")) return; void update("PATCH", "/api/v1/groups/" + g.id, { allowPosting: checked }, "Group authorization updated"); }}/><span>{g.allowPosting ? "Authorized" : "Not authorized"}</span></label></td>
            <td><button className="btn subtle" onClick={async () => { try { const members = await api<{ contact: Contact }[]>("/api/v1/groups/" + g.id + "/members"); setInspectedMembers({ name: g.name, members }); } catch (e) { inform(String(e), true); } }}>View members <ChevronRight size={15}/></button></td></tr>)}</tbody></table></div>{!groups.length && <Blank icon={Users} title="No groups yet" desc="Connect and sync a WhatsApp account to discover your groups."/>}</section>
          <div className="info-strip"><div className="info-icon"><CircleHelp size={21}/></div><div><strong>Group membership is not consent</strong><p>Group participants are visible for organization only. Campaigns targeting individuals require explicit opt-in; group campaigns post once into each explicitly authorized group.</p></div></div>
        </>}
        {view === "segments" && <>
          <SectionHeading eyebrow="AUDIENCE ORGANIZATION" title="Contact lists" description="Create reusable collections of contacts to target with campaigns." action={<button className="btn primary" onClick={() => setSegmentOpen(true)}><Plus size={16}/> New list</button>}/>
          {segments.length ? <div className="segment-grid">{segments.map(s => <section className="segment-card" key={s.id}><div className="segment-icon"><Tags size={21}/></div><h3>{s.name}</h3><p>{s.description || "A custom audience list."}</p><div className="segment-bottom"><span><Users size={15}/> {s._count.members} contacts</span><div><button className="icon-button" title="Inspect list" onClick={async () => { const detail = await api<{ name: string; members: { contact: Contact }[] }>("/api/v1/segments/" + s.id); setInspectSegment(detail); }}><ChevronRight size={18}/></button><button className="icon-button" title="Delete list" onClick={() => { if (window.confirm("Delete this list? Contacts will not be deleted.")) void update("DELETE", "/api/v1/segments/" + s.id, undefined, "List deleted"); }}><Trash2 size={16}/></button></div></div></section>)}</div> : <Blank icon={Tags} title="No contact lists" desc="Create a reusable list, then add contacts from the directory." action={<button className="btn primary" onClick={() => setSegmentOpen(true)}><Plus size={16}/> New list</button>}/>}
        </>}
        {view === "campaigns" && <>
          <SectionHeading eyebrow="MESSAGE AUTOMATION" title="Campaigns" description="Build campaigns, verify recipients, then schedule or launch delivery." action={<button className="btn primary" onClick={() => setCampaignOpen(true)}><Plus size={16}/> Create campaign</button>}/>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Destination</th><th>Schedule</th><th>Status</th><th>Runs</th><th>Actions</th></tr></thead><tbody>{campaigns.map(c => <tr key={c.id}>
            <td><div className="name-cell"><div className="person-avatar orange"><Megaphone size={17}/></div><div><strong>{c.name}</strong><small>{c.session.label} · {formatDate(c.createdAt)}</small></div></div></td>
            <td>{c.audienceType === "GROUPS" ? `${c._count.groups} groups` : `${c._count.contacts} contacts, ${c._count.segments} lists`}</td>
            <td><div className="schedule-cell">{c.scheduleType === "NOW" ? "Send now" : c.scheduleType === "ONCE" ? formatDate(c.scheduledAt) : <><CalendarClock size={15}/><code>{c.cron}</code></>}</div></td><td><Flag value={c.status}/></td><td>{c._count.runs}</td><td><div className="action-buttons">
              <button className="btn subtle" onClick={async () => { try { const detail = await api<typeof inspectedCampaign>("/api/v1/campaigns/" + c.id); setInspectedCampaign(detail); setAudiencePreview(await api<{ count: number; sample: { label: string }[] }>("/api/v1/campaigns/" + c.id + "/audience")); } catch (e) { inform(String(e), true); } }}>Details</button>
              {c.status === "DRAFT" && <button className="btn mini-primary" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "launch" }, "Campaign launched or scheduled")}><Play size={14}/> Launch</button>}
              {["ACTIVE", "SCHEDULED"].includes(c.status) && <button className="btn outline" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "pause" }, "Campaign paused")}><Square size={13}/> Pause</button>}
              {c.status === "PAUSED" && <button className="btn mini-primary" disabled={saving} onClick={() => void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "resume" }, "Campaign resumed")}><Play size={14}/> Resume</button>}
              {["ACTIVE", "SCHEDULED", "PAUSED"].includes(c.status) && <button className="icon-button" title="Cancel" onClick={() => { if (window.confirm("Cancel this campaign?")) void update("POST", "/api/v1/campaigns/" + c.id + "/action", { action: "cancel" }, "Campaign cancelled"); }}><X size={16}/></button>}
              {c.status === "DRAFT" && <button className="icon-button" title="Delete draft" onClick={() => { if (window.confirm("Delete this campaign draft?")) void update("DELETE", "/api/v1/campaigns/" + c.id, undefined, "Draft deleted"); }}><Trash2 size={16}/></button>}
            </div></td>
          </tr>)}</tbody></table></div>{!campaigns.length && <Blank icon={Megaphone} title="Your first campaign starts here" desc="Create a draft, review your audience and schedule messages." action={<button className="btn primary" onClick={() => setCampaignOpen(true)}><Plus size={16}/> Create campaign</button>}/>}</section>
        </>}
        {view === "reports" && <>
          <SectionHeading eyebrow="REPORTING" title="Delivery reports" description="Execution history, individual message status, and errors." action={<button className="btn outline" onClick={() => void loadAll()}><RefreshCw size={16}/> Refresh</button>}/>
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
          <div className="settings-grid"><section className="panel settings-panel"><h2><ShieldCheck size={19}/> Safety & privacy</h2><p>Outbound individual campaigns require an explicit OPTED_IN consent status. Incoming STOP or UNSUBSCRIBE automatically suppresses future marketing sends. Group sending must be authorized per group.</p><p>Admin authentication uses a signed HttpOnly cookie and each API operation verifies the session.</p></section>
            <section className="panel settings-panel"><h2><Smartphone size={19}/> Session storage</h2><p>WhatsApp Chromium sessions are stored under <code>SESSION_DIR</code> on the worker&apos;s persistent disk. Do not deploy the worker to serverless environments or commit auth directories to GitHub.</p></section>
            <section className="panel settings-panel"><h2><CalendarClock size={19}/> Background jobs</h2><p>Redis and BullMQ handle scheduled delivery and one-off jobs. The worker must be running at all times for campaigns and QR connections to execute.</p></section>
            <section className="panel settings-panel"><h2><CircleHelp size={19}/> Start locally</h2><p>Run Docker Compose, install dependencies, push the schema, create an admin account and launch web + worker. See the repository README for exact commands.</p></section></div>
        </>}
      </main>
    </div>
    {createSessionOpen && <Modal title="Add WhatsApp account" close={() => setCreateSessionOpen(false)}><div className="modal-body"><p className="modal-help">Give this connection a recognizable name. You can link the device with a QR code afterwards.</p><label>Session name<input value={newSession} maxLength={80} placeholder="e.g. Customer support" onChange={e => setNewSession(e.target.value)}/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setCreateSessionOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={async () => { if (await update("POST", "/api/v1/sessions", { label: newSession }, "Session created")) { setCreateSessionOpen(false); setNewSession(""); } }}>Create session</button></div></Modal>}
    {qrSession && <Modal title={"Link " + qrSession.label} close={() => setQrSession(null)}><div className="qr-content"><p>On your phone, open <strong>WhatsApp → Linked devices → Link a device</strong>, then scan this QR code.</p>{qr ? <div className="qr-box"><QRCodeSVG value={qr} size={244}/></div> : <div className="qr-placeholder"><LoaderCircle className="spin" size={34}/><span>Waiting for QR code from the worker…</span></div>}<p className="muted-footnote">The worker must be running. QR codes expire and refresh automatically.</p><button className="btn outline full" onClick={() => { void update("POST", "/api/v1/sessions/" + qrSession.id + "/connect", {}, "Reconnection requested"); }}>Retry connection</button></div></Modal>}
    {importOpen && <Modal title="Import contacts" close={() => setImportOpen(false)} wide><div className="modal-body"><p className="modal-help">Paste CSV as <code>phone,name</code>, one contact per row. Contacts remain unconsented until permission is recorded.</p><label>WhatsApp session<select value={sessionFilter || sessions[0]?.id || ""} onChange={e => setSessionFilter(e.target.value)}>{sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label>CSV data<textarea rows={8} placeholder={"phone,name\n254700000001,Jane Doe\n254700000002,John Doe"} value={importData} onChange={e => setImportData(e.target.value)}/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setImportOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={async () => {
      const rows = importData.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const records = rows.filter((line, i) => !(i === 0 && /^phone\s*,/i.test(line))).map(line => {
        const comma = line.indexOf(","); return { phone: (comma < 0 ? line : line.slice(0, comma)).replaceAll('"', "").trim(), name: comma < 0 ? "" : line.slice(comma + 1).replace(/^"|"$/g, "").trim() };
      });
      if (!records.length) return inform("Add at least one contact", true);
      if (await update("POST", "/api/v1/contacts/import", { sessionId: sessionFilter || sessions[0]?.id, contacts: records }, "Contacts imported; consent remains unknown")) { setImportOpen(false); setImportData(""); }
    }}><ArrowDownToLine size={16}/> Import contacts</button></div></Modal>}
    {segmentOpen && <Modal title="Create a contact list" close={() => setSegmentOpen(false)}><div className="modal-body"><p className="modal-help">{selectedContacts.length ? `${selectedContacts.length} selected contact(s) will be added.` : "Create the list now, then select contacts from the Contacts page."}</p><label>List name<input value={newSegment} placeholder="e.g. Event subscribers" onChange={e => setNewSegment(e.target.value)}/></label><label>Description (optional)<textarea rows={3} value={segmentDesc} onChange={e => setSegmentDesc(e.target.value)} placeholder="What is this audience for?"/></label></div><div className="modal-actions"><button className="btn outline" onClick={() => setSegmentOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={async () => {
      setSaving(true);
      try { const list = await api<Segment>("/api/v1/segments", { method: "POST", body: { name: newSegment, description: segmentDesc } });
        if (selectedContacts.length) await api("/api/v1/segments/" + list.id + "/members", { method: "POST", body: { contactIds: selectedContacts, action: "add" } });
        await loadAll(); setSelectedContacts([]); setNewSegment(""); setSegmentDesc(""); setSegmentOpen(false); inform("Contact list created");
      } catch (e) { inform(e instanceof Error ? e.message : "Unable to create list", true); } finally { setSaving(false); }
    }}>Create list</button></div></Modal>}
    {inspectSegment && <Modal title={inspectSegment.name} close={() => setInspectSegment(null)}><div className="modal-body"><p className="modal-help">{inspectSegment.members.length} members (first 500 shown)</p><div className="member-list">{inspectSegment.members.map(m => <div className="member-row" key={m.contact.id}><span>{m.contact.name || m.contact.phone || m.contact.whatsappId}</span><Flag value={m.contact.consent}/></div>)}</div></div></Modal>}
    {inspectedMembers && <Modal title={inspectedMembers.name + " members"} close={() => setInspectedMembers(null)}><div className="modal-body"><p className="modal-help">Up to 500 available membership records. A group membership alone never grants direct-message consent.</p><div className="member-list">{inspectedMembers.members.map(m => <div className="member-row" key={m.contact.id}><span>{m.contact.name || m.contact.phone || m.contact.whatsappId}</span><Flag value={m.contact.consent}/></div>)}{!inspectedMembers.members.length && <p>No participant data exposed by this session.</p>}</div></div></Modal>}
    {inspectedCampaign && <Modal title={inspectedCampaign.name} close={() => { setInspectedCampaign(null); setAudiencePreview(null); }} wide><div className="modal-body"><div className="eyebrow">MESSAGE</div><div className="message-preview">{inspectedCampaign.message}</div><div className="detail-row"><strong>Eligible recipients now</strong><strong>{audiencePreview?.count ?? "…"}</strong></div><p className="muted-footnote">Sample: {audiencePreview?.sample.map(s => s.label).join(", ") || "None"}</p><h3 className="sub-title">Previous executions</h3>{inspectedCampaign.runs.length ? inspectedCampaign.runs.map(run => <div className="run-detail" key={run.id}><div className="detail-row"><strong>{formatDate(run.startedAt)}</strong><Flag value={run.status}/></div>{run.deliveries.map((d, i) => <div className="detail-row" key={i}><span>{d.recipient}</span><span title={d.error || ""}><Flag value={d.status}/></span></div>)}</div>) : <p className="muted-footnote">No executions yet.</p>}</div></Modal>}
    {campaignOpen && <Modal title="Create a campaign" close={() => setCampaignOpen(false)} wide><div className="modal-body campaign-builder">
      <div className="form-grid"><label>Campaign name<input value={campaignForm.name} maxLength={100} placeholder="e.g. October customer update" onChange={e => setCampaignForm(p => ({ ...p, name: e.target.value }))}/></label>
        <label>Sending account<select value={campaignForm.sessionId} onChange={e => setCampaignForm(p => ({ ...p, sessionId: e.target.value, contactIds: [], groupIds: [] }))}><option value="">Choose account…</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.label} — {s.status.toLowerCase()}</option>)}</select></label></div>
      <label>Message<textarea rows={5} maxLength={4096} placeholder={"Hi {{first_name}}, we have an update for you…"} value={campaignForm.message} onChange={e => setCampaignForm(p => ({ ...p, message: e.target.value }))}/><small>Use {"{{first_name}}"}, {"{{name}}"} or {"{{phone}}"} for contact campaigns.</small></label>
      <div className="sub-title">1. Choose recipients</div><div className="pill-choice">{(["CONTACTS", "GROUPS"] as const).map(choice => <button key={choice} className={campaignForm.audienceType === choice ? "picked" : ""} onClick={() => setCampaignForm(p => ({ ...p, audienceType: choice }))}>{choice === "CONTACTS" ? <ContactRound size={16}/> : <Users size={16}/>} {choice === "CONTACTS" ? "Opted-in contacts" : "Authorized groups"}</button>)}</div>
      {campaignForm.audienceType === "CONTACTS" ? <><div className="field-caption">CONTACT LISTS</div><div className="selection-grid">{segments.map(s => <label className="check-item" key={s.id}><input type="checkbox" checked={campaignForm.segmentIds.includes(s.id)} onChange={() => setCampaignForm(p => ({ ...p, segmentIds: toggle(p.segmentIds, s.id) }))}/><span>{s.name} <small>({s._count.members})</small></span></label>)}{!segments.length && <span className="muted-footnote">No lists created. You can select individual contacts below.</span>}</div>
        <div className="field-caption">INDIVIDUAL ELIGIBLE CONTACTS (CURRENT PAGE)</div><div className="selection-grid scroll-selection">{eligible.filter(c => c.sessionId === campaignForm.sessionId).map(c => <label className="check-item" key={c.id}><input type="checkbox" checked={campaignForm.contactIds.includes(c.id)} onChange={() => setCampaignForm(p => ({ ...p, contactIds: toggle(p.contactIds, c.id) }))}/><span>{c.name || c.phone || c.whatsappId}</span></label>)}</div></> :
        <div className="selection-grid scroll-selection">{groups.filter(g => g.sessionId === campaignForm.sessionId && g.allowPosting).map(g => <label className="check-item" key={g.id}><input type="checkbox" checked={campaignForm.groupIds.includes(g.id)} onChange={() => setCampaignForm(p => ({ ...p, groupIds: toggle(p.groupIds, g.id) }))}/><span>{g.name}</span></label>)}{!groups.some(g => g.sessionId === campaignForm.sessionId && g.allowPosting) && <span className="muted-footnote">Authorize group announcements from the Groups screen first.</span>}</div>}
      <div className="sub-title">2. Schedule delivery</div><div className="pill-choice">{(["NOW", "ONCE", "CRON"] as const).map(choice => <button key={choice} className={campaignForm.scheduleType === choice ? "picked" : ""} onClick={() => setCampaignForm(p => ({ ...p, scheduleType: choice }))}>{choice === "NOW" ? <Send size={16}/> : <Clock3 size={16}/>} {choice === "NOW" ? "When launched" : choice === "ONCE" ? "Specific date" : "Recurring cron"}</button>)}</div>
      {campaignForm.scheduleType === "ONCE" && <label>Local date and time<input type="datetime-local" value={campaignForm.scheduledAt} onChange={e => setCampaignForm(p => ({ ...p, scheduledAt: e.target.value }))}/></label>}
      {campaignForm.scheduleType === "CRON" && <div className="form-grid"><label>Cron expression<input value={campaignForm.cron} onChange={e => setCampaignForm(p => ({ ...p, cron: e.target.value }))} placeholder="0 9 * * 1"/></label><label>Timezone<input value={campaignForm.timezone} onChange={e => setCampaignForm(p => ({ ...p, timezone: e.target.value }))}/></label></div>}
      <div className="builder-note"><ShieldCheck size={17}/><span>Save as draft first. The server checks current permissions, recipients and your campaign cap at launch.</span></div>
    </div><div className="modal-actions"><button className="btn outline" onClick={() => setCampaignOpen(false)}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void createCampaign()}><Check size={17}/> Save campaign draft</button></div></Modal>}
  </div>;
}
