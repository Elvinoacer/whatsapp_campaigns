"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bold, Check, CheckCheck, Clock3, FileText, Italic, LoaderCircle, Paperclip, Search, Send, ShieldCheck, Strikethrough, Users, X } from "lucide-react";
import { personalize } from "@/lib/message";
import { zonedDateTimeToIso } from "@/lib/timezone";

export type CampaignForm = { sendIntervalMs: number; mediaKey?: string; mediaMime?: string; mediaName?: string; name: string; message: string; sessionId: string; audienceType: "CONTACTS" | "GROUPS"; contactIds: string[]; segmentIds: string[]; groupIds: string[]; scheduleType: "NOW" | "ONCE" | "CRON"; scheduledAt: string; cron: string; timezone: string };
type Session = { id: string; label: string; status: string };
type Segment = { id: string; name: string; description?: string | null; eligibleCount?: number; _count: { members: number } };
type Group = { id: string; name: string; sessionId: string; allowPosting: boolean; _count: { members: number }; session: { label: string } };
type Contact = { id: string; name: string | null; phone: string | null; whatsappId: string };
type Exclusions = { missingConsent: number; optedOut: number; unusablePhone: number; unauthorizedGroups: number };
type Roster = { count: number; total: number; excluded: number; duplicates: number; exclusions: Exclusions; limit: number; matched: number; take: number; items: { key: string; label: string; phone?: string | null; sources: string[] }[] };
type Preview = { intervalMs: number; durationMs: number; nextRuns: string[]; scheduleIssue: string | null; count: number; limit: number };
type Request = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;
const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];

function MessageText({ text }: { text: string }) {
  return <>{text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g).map((part, index) => part.startsWith("*") && part.endsWith("*") ? <strong key={index}>{part.slice(1, -1)}</strong> : part.startsWith("_") && part.endsWith("_") ? <em key={index}>{part.slice(1, -1)}</em> : part.startsWith("~") && part.endsWith("~") ? <s key={index}>{part.slice(1, -1)}</s> : part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part)}</>;
}

export default function CampaignComposer({ initial, campaignId, hasHistory, sessions, segments, groups, request, close, saved, busyChanged }: {
  initial: CampaignForm; campaignId: string | null; hasHistory: boolean; sessions: Session[]; segments: Segment[]; groups: Group[]; request: Request; close: () => void; saved: (message: string) => Promise<void>; busyChanged: (busy: boolean) => void;
}) {
  const [form, setForm] = useState(initial);
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"segments" | "contacts" | "members">(initial.segmentIds.length || !initial.contactIds.length && !initial.groupIds.length ? "segments" : initial.contactIds.length ? "contacts" : "members");
  const [search, setSearch] = useState("");
  const [peoplePage, setPeoplePage] = useState(1);
  const [peopleResult, setPeopleResult] = useState<{ key: string; items: Contact[]; total: number } | null>(null);
  const [peopleError, setPeopleError] = useState("");
  const [rosterResult, setRosterResult] = useState<{ key: string; data: Roster } | null>(null);
  const [rosterError, setRosterError] = useState("");
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterPage, setRosterPage] = useState(1);
  const [previewResult, setPreviewResult] = useState<{ key: string; data: Preview } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState(campaignId);
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const audienceKey = JSON.stringify({ sessionId: form.sessionId, audienceType: form.audienceType, segmentIds: form.segmentIds, contactIds: form.contactIds, groupIds: form.groupIds });
  const rosterKey = JSON.stringify({ audienceKey, search: rosterSearch, page: rosterPage });
  const peopleKey = JSON.stringify({ search, page: peoplePage });
  const formKey = JSON.stringify(form);
  const roster = rosterResult?.key === rosterKey ? rosterResult.data : null;
  const preview = previewResult?.key === formKey ? previewResult.data : null;
  const people = peopleResult?.key === peopleKey ? peopleResult : null;
  const hasTargets = form.audienceType === "GROUPS" ? form.groupIds.length > 0 : form.segmentIds.length + form.contactIds.length + form.groupIds.length > 0;
  const audienceReady = !!(form.sessionId && hasTargets && roster && roster.count > 0 && roster.count <= roster.limit);
  const messageReady = form.name.trim().length >= 3 && form.message.trim().length > 0 && form.message.length <= 4096;
  const sender = sessions.find(session => session.id === form.sessionId);
  const launchReady = audienceReady && messageReady && !!preview && !preview.scheduleIssue && sender?.status === "CONNECTED" && (!hasHistory || resendConfirmed);

  useEffect(() => {
    if (!hasTargets || !form.sessionId) return;
    let alive = true;
    const timer = setTimeout(() => {
      setRosterError("");
      void request<Roster>("/api/v1/campaigns/recipients", { method: "POST", body: { ...JSON.parse(audienceKey), search: rosterSearch, page: rosterPage, take: 10 } })
        .then(data => { if (alive) setRosterResult({ key: rosterKey, data }); })
        .catch(e => { if (alive) setRosterError(e instanceof Error ? e.message : "Unable to check recipients"); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [audienceKey, rosterKey, rosterSearch, rosterPage, hasTargets, form.sessionId, request]);
  useEffect(() => {
    if (source !== "contacts" || form.audienceType !== "CONTACTS") return;
    let alive = true;
    const timer = setTimeout(() => {
      setPeopleError("");
      void request<{ items: Contact[]; total: number }>("/api/v1/contacts?" + new URLSearchParams({ eligible: "true", search, page: String(peoplePage), take: "40" }))
        .then(data => { if (alive) setPeopleResult({ key: peopleKey, ...data }); })
        .catch(e => { if (alive) setPeopleError(e instanceof Error ? e.message : "Unable to load contacts"); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [peopleKey, peoplePage, search, source, form.audienceType, request]);
  useEffect(() => {
    if (!hasTargets || !messageReady || !form.sessionId) return;
    let alive = true;
    const timer = setTimeout(() => {
      setPreviewError("");
      try {
        const body = { ...JSON.parse(formKey), scheduledAt: form.scheduleType === "ONCE" ? zonedDateTimeToIso(form.scheduledAt, form.timezone) : undefined };
        void request<Preview>("/api/v1/campaigns/preview", { method: "POST", body }).then(data => { if (alive) setPreviewResult({ key: formKey, data }); })
          .catch(e => { if (alive) setPreviewError(e instanceof Error ? e.message : "Unable to validate delivery"); });
      } catch (e) { setPreviewError(e instanceof Error ? e.message : "Choose a valid date and time"); }
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [formKey, form.scheduleType, form.scheduledAt, form.timezone, form.sessionId, messageReady, hasTargets, request]);
  function change(patch: Partial<CampaignForm>) { setForm(previous => ({ ...previous, ...patch })); setError(""); }
  function choose(patch: Partial<CampaignForm>) { change(patch); setRosterPage(1); }
  function go(next: number) { setStep(next); bodyRef.current?.scrollTo({ top: 0 }); }
  function insert(before: string, after = "") {
    const field = editor.current;
    if (!field) return;
    const start = field.selectionStart; const end = field.selectionEnd;
    const selected = form.message.slice(start, end);
    const replacement = before + selected + after;
    if (form.message.length - selected.length + replacement.length > 4096) return;
    change({ message: form.message.slice(0, start) + replacement + form.message.slice(end) });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }
  async function save(launch: boolean) {
    if (busy) return;
    setBusy(true); busyChanged(true); setError("");
    try {
      let attachment = {};
      if (mediaFile) {
        const upload = new FormData(); upload.set("file", mediaFile);
        const response = await fetch("/api/v1/media", { method: "POST", body: upload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Attachment upload failed");
        attachment = result;
        setForm(previous => ({ ...previous, ...attachment })); setMediaFile(null);
      }
      const draft = await request<{ id: string }>(savedId ? "/api/v1/campaigns/" + savedId : "/api/v1/campaigns", { method: savedId ? "PATCH" : "POST", body: {
        ...form, ...attachment, scheduledAt: form.scheduleType === "ONCE" ? zonedDateTimeToIso(form.scheduledAt, form.timezone) : undefined,
      } });
      setSavedId(draft.id);
      if (launch) {
        try { await request("/api/v1/campaigns/" + draft.id + "/action", { method: "POST", body: { action: "launch" } }); }
        catch (e) { throw new Error(`Your changes are saved as a draft. ${e instanceof Error ? e.message : "Launch failed"}`); }
      }
      await saved(launch ? form.scheduleType === "NOW" ? "Campaign launched. Follow its progress in delivery reports." : "Campaign scheduled. Follow its runs in delivery reports." : "Campaign saved as a draft. Your previous runs are preserved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save campaign"); }
    finally { setBusy(false); busyChanged(false); }
  }
  const selectedNames = segments.filter(segment => form.segmentIds.includes(segment.id));
  const previewText = form.audienceType === "CONTACTS" ? personalize(form.message, { name: "Alex Morgan", phone: "254700000000" }) : form.message;
  const availableGroups = groups.filter(group => form.audienceType === "GROUPS" ? group.sessionId === form.sessionId && group.allowPosting : group._count.members > 0);
  return <>
    <nav className="composer-steps" aria-label="Campaign steps">{["Audience", "Message", "Review & delivery"].map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={busy || index > step && (index > 0 && !audienceReady || index > 1 && !messageReady)} onClick={() => go(index)}><span>{index < step ? <Check size={15}/> : index + 1}</span><strong>{label}</strong></button>)}</nav>
    <div className="modal-body composer-body" ref={bodyRef}>
      <fieldset disabled={busy} className="composer-layout">
        <div className="composer-main">
          {step === 0 && <>
            <div className="composer-heading"><div className="eyebrow">01 / YOUR AUDIENCE</div><h3>Who’s this message for?</h3><p>Select a segment to include every eligible contact. There’s no need to select its members one by one.</p></div>
            <label>Sending account<select aria-label="Campaign sending account" value={form.sessionId} onChange={e => choose({ sessionId: e.target.value, ...(form.audienceType === "GROUPS" ? { groupIds: [] } : {}) })}><option value="">Choose a WhatsApp account</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.label} · {session.status.toLowerCase()}</option>)}</select><small>Any sending account can use your shared contact segments.</small></label>
            <div className="pill-choice audience-mode" aria-label="Message destination"><button aria-pressed={form.audienceType === "CONTACTS"} className={form.audienceType === "CONTACTS" ? "picked" : ""} onClick={() => { if (form.audienceType !== "CONTACTS") choose({ audienceType: "CONTACTS", groupIds: [] }); }}>Direct messages</button><button aria-pressed={form.audienceType === "GROUPS"} className={form.audienceType === "GROUPS" ? "picked" : ""} onClick={() => { if (form.audienceType !== "GROUPS") choose({ audienceType: "GROUPS", contactIds: [], segmentIds: [], groupIds: [] }); }}>Group announcements</button></div>
            {form.audienceType === "CONTACTS" && <div className="source-tabs" aria-label="Contact source">{([['segments', 'Segments'], ['contacts', 'Individual contacts'], ['members', 'Saved group members']] as const).map(([value, label]) => <button key={value} aria-pressed={source === value} className={source === value ? "active" : ""} onClick={() => { setSource(value); setSearch(""); setPeoplePage(1); }}>{label}</button>)}</div>}
            <div className="search-box"><Search size={16}/><input aria-label={source === "contacts" ? "Search campaign contacts" : "Search audience sources"} placeholder={form.audienceType === "GROUPS" ? "Find an authorized group…" : source === "segments" ? "Find a segment…" : source === "contacts" ? "Find an opted-in name or number…" : "Find a saved group…"} value={search} onChange={e => { setSearch(e.target.value); setPeoplePage(1); }}/></div>
            {form.audienceType === "CONTACTS" && source === "segments" && <div className="source-list">{segments.filter(segment => segment.name.toLowerCase().includes(search.toLowerCase())).map(segment => <label className={`audience-card ${form.segmentIds.includes(segment.id) ? "selected" : ""}`} key={segment.id}><input type="checkbox" aria-label={`Select all opted-in contacts from ${segment.name}`} checked={form.segmentIds.includes(segment.id)} onChange={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })}/><span><strong>{segment.name}</strong><small>{segment.description || "Includes all eligible members, across every page"}</small></span><span className="audience-card-count"><strong>{segment.eligibleCount?.toLocaleString() ?? "—"}</strong><small>eligible / {segment._count.members.toLocaleString()} saved</small></span></label>)}{!segments.length && <div className="composer-empty"><Users size={26}/><strong>Your segments will appear here</strong><p>Save group contacts into a segment from Groups, or organize selected contacts from the directory.</p></div>}{segments.length > 0 && !segments.some(segment => segment.name.toLowerCase().includes(search.toLowerCase())) && <p className="modal-help">No segments match your search.</p>}</div>}
            {form.audienceType === "CONTACTS" && source === "contacts" && <><div className="detail-row"><span>{form.contactIds.length} individually selected</span><button className="text-button" disabled={!people?.items.length} onClick={() => choose({ contactIds: [...new Set([...form.contactIds, ...people!.items.map(person => person.id)])] })}>Select this page</button></div>{peopleError && <div className="notice danger">{peopleError}</div>}{!people && !peopleError && <p className="modal-help">Loading eligible contacts…</p>}<div className="selection-grid scroll-selection">{people?.items.map(person => <label className="check-item" key={person.id}><input type="checkbox" checked={form.contactIds.includes(person.id)} onChange={() => choose({ contactIds: toggle(form.contactIds, person.id) })}/><span>{person.name || person.phone}<small className="check-description">+{person.phone || person.whatsappId.split("@")[0]}</small></span></label>)}</div>{people && <div className="table-footer"><span>{people.total} eligible records</span><div className="pager"><button aria-label="Previous campaign contacts" disabled={peoplePage <= 1} onClick={() => setPeoplePage(p => p - 1)}><ArrowLeft size={15}/></button><span>{peoplePage} / {Math.max(1, Math.ceil(people.total / 40))}</span><button aria-label="Next campaign contacts" disabled={peoplePage * 40 >= people.total} onClick={() => setPeoplePage(p => p + 1)}><ArrowRight size={15}/></button></div></div>}</>}
            {(form.audienceType === "GROUPS" || source === "members") && <><p className="modal-help">{form.audienceType === "GROUPS" ? "One announcement per selected group. These groups are authorized for posting from your sending account." : "Includes saved members with verified opt-in. Group membership alone does not give permission to message someone."}</p><div className="source-list">{availableGroups.filter(group => group.name.toLowerCase().includes(search.toLowerCase())).map(group => <label className={`audience-card ${form.groupIds.includes(group.id) ? "selected" : ""}`} key={group.id}><input type="checkbox" checked={form.groupIds.includes(group.id)} onChange={() => choose({ groupIds: toggle(form.groupIds, group.id) })}/><span><strong>{group.name}</strong><small>{group._count.members} saved contacts · {group.session.label}</small></span></label>)}{!availableGroups.length && <p className="modal-help">{form.audienceType === "GROUPS" ? "No authorized groups for this account. Enable posting permission in Groups first." : "Save group members in Groups to use this source."}</p>}</div></>}
          </>}
          {step === 1 && <>
            <div className="composer-heading"><div className="eyebrow">02 / MAKE IT PERSONAL</div><h3>A message worth opening.</h3><p>Write your message and check how it will look before sending.</p></div>
            <label>Campaign name<input aria-label="Campaign name" maxLength={100} value={form.name} placeholder="e.g. October community update" onChange={e => change({ name: e.target.value })}/><small>For your workspace. Recipients won’t see this name.</small></label>
            <label htmlFor="campaign-message">Message</label>
            <div className="message-editor"><div className="editor-toolbar">{[{ label: "Bold", marker: "*", icon: Bold }, { label: "Italic", marker: "_", icon: Italic }, { label: "Strikethrough", marker: "~", icon: Strikethrough }].map(tool => <button type="button" key={tool.label} title={tool.label} aria-label={tool.label} onClick={() => insert(tool.marker, tool.marker)}><tool.icon size={16}/></button>)}<span>WhatsApp formatting</span></div><textarea id="campaign-message" ref={editor} rows={9} maxLength={4096} value={form.message} placeholder="Hi {{first_name}}, we have something to share…" onChange={e => change({ message: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && ["b", "i"].includes(e.key)) { e.preventDefault(); insert(e.key === "b" ? "*" : "_", e.key === "b" ? "*" : "_"); } }}/><div className="editor-bottom"><span>Select text to format it</span><span>{form.message.length.toLocaleString()} / 4,096</span></div></div>
            {form.audienceType === "CONTACTS" && <div className="personalize-tools"><span>Personalize:</span>{["first_name", "name", "phone"].map(token => <button className="token-button" key={token} onClick={() => insert("{{" + token + "}}")}>{"{{" + token + "}}"}</button>)}<small>Missing names use “there”.</small></div>}
            <label className="attachment-picker"><Paperclip size={18}/><span><strong>{mediaFile?.name || form.mediaName || "Add an image or PDF"}</strong><small>JPEG, PNG, WebP or PDF · up to 8 MB</small></span><input aria-label="Campaign attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const file = e.target.files?.[0]; if (file && (!file.size || file.size > 8 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type))) { setError("Choose a JPEG, PNG, WebP or PDF up to 8 MB."); e.target.value = ""; return; } setMediaFile(file || null); setError(""); }}/></label>{(mediaFile || form.mediaKey) && <button className="text-button" onClick={() => { setMediaFile(null); change({ mediaKey: undefined, mediaMime: undefined, mediaName: undefined }); }}>Remove attachment</button>}
          </>}
          {step === 2 && <>
            <div className="composer-heading"><div className="eyebrow">03 / READY WHEN YOU ARE</div><h3>Review. Then make it happen.</h3><p>{hasHistory ? "The next launch starts a new run in this campaign. Your earlier messages and results stay in its history." : "Save a draft, launch now, or choose a time that suits your audience."}</p></div>
            <div className="pill-choice">{([['NOW', 'Launch now'], ['ONCE', 'Schedule once'], ['CRON', 'Repeat']] as const).map(([value, label]) => <button key={value} aria-pressed={form.scheduleType === value} className={form.scheduleType === value ? "picked" : ""} onClick={() => change({ scheduleType: value })}><Clock3 size={15}/>{label}</button>)}</div>
            {form.scheduleType === "ONCE" && <label>Send date and time<input aria-label="Campaign date and time" type="datetime-local" value={form.scheduledAt} onChange={e => change({ scheduledAt: e.target.value })}/></label>}
            {form.scheduleType === "CRON" && <><label>Repeat schedule<select aria-label="Recurring schedule preset" value={["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"].includes(form.cron) ? form.cron : "custom"} onChange={e => change({ cron: e.target.value === "custom" ? "0 10 * * *" : e.target.value })}><option value="0 9 * * *">Every day at 09:00</option><option value="0 9 * * 1-5">Weekdays at 09:00</option><option value="0 9 * * 1">Every Monday at 09:00</option><option value="0 9 1 * *">First of the month at 09:00</option><option value="custom">Custom schedule…</option></select></label>{!["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"].includes(form.cron) && <label>Cron expression<input value={form.cron} onChange={e => change({ cron: e.target.value })}/><small>Minute · hour · day · month · weekday</small></label>}</>}
            {form.scheduleType !== "NOW" && <label>Timezone<input list="campaign-timezones" value={form.timezone} onChange={e => change({ timezone: e.target.value })}/><datalist id="campaign-timezones">{["Africa/Nairobi", "UTC", "Europe/London", "America/New_York", "Asia/Dubai"].map(zone => <option key={zone} value={zone}/>)}</datalist></label>}
            <label>Time between messages (seconds)<input aria-label="Message interval in seconds" type="number" min={1.5} max={3600} step={0.5} value={form.sendIntervalMs / 1000} onChange={e => change({ sendIntervalMs: Number(e.target.value) * 1000 })}/><small>Sent one at a time. Your workspace minimum also applies.</small></label>
            <div className="delivery-plan" aria-live="polite">{preview ? <><strong>{preview.count.toLocaleString()} recipients · at least {Math.max(1, Math.ceil(preview.durationMs / 60000))} min</strong><p>{preview.intervalMs / 1000} seconds between messages. Queue and network delays may add time.</p>{form.scheduleType !== "NOW" && <><strong>Upcoming · {form.timezone}</strong><ol>{preview.nextRuns.slice(0, 3).map(date => <li key={date}>{new Date(date).toLocaleString("en-KE", { timeZone: form.timezone, dateStyle: "medium", timeStyle: "short" })}</li>)}</ol></>}{preview.scheduleIssue && <div className="notice danger">{preview.scheduleIssue}</div>}</> : <p>{previewError || "Checking your delivery plan…"}</p>}</div>
            {sender?.status !== "CONNECTED" && <div className="notice danger">Connect the sending account before launching. You can save your draft now.</div>}
            {hasHistory && <label className="check-item resend-confirmation"><input type="checkbox" checked={resendConfirmed} onChange={e => setResendConfirmed(e.target.checked)}/><span>I’m starting a new run. Previously messaged contacts may receive this campaign again.</span></label>}
          </>}
        </div>
        <aside className="composer-aside">
          <section className="audience-summary" aria-label="Selected campaign audience"><div className="summary-label"><ShieldCheck size={16}/> YOUR AUDIENCE</div><div className="summary-number" aria-live="polite">{!hasTargets ? "0" : roster ? roster.count.toLocaleString() : "…"}</div><strong>{form.audienceType === "CONTACTS" ? "eligible people" : "authorized groups"}</strong><p>Each destination receives one message per run.</p><div className="selected-sources">{selectedNames.map(segment => <button key={segment.id} onClick={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })} aria-label={"Remove segment " + segment.name}>{segment.name}<X size={12}/></button>)}{form.contactIds.length > 0 && <button onClick={() => choose({ contactIds: [] })}>{form.contactIds.length} individual contacts<X size={12}/></button>}{form.groupIds.length > 0 && <button onClick={() => choose({ groupIds: [] })}>{form.groupIds.length} {form.audienceType === "GROUPS" ? "groups" : "group sources"}<X size={12}/></button>}</div>{roster && <><div className="summary-line"><span>Selected records</span><strong>{roster.total}</strong></div><div className="summary-line"><span>Excluded</span><strong>{roster.excluded}</strong></div><div className="summary-line"><span>Duplicate records removed</span><strong>{roster.duplicates}</strong></div>{roster.excluded > 0 && <details className="exclusion-details"><summary>Why are contacts excluded?</summary>{roster.exclusions.missingConsent > 0 && <p>{roster.exclusions.missingConsent} awaiting opt-in</p>}{roster.exclusions.optedOut > 0 && <p>{roster.exclusions.optedOut} opted out / suppressed</p>}{roster.exclusions.unusablePhone > 0 && <p>{roster.exclusions.unusablePhone} without a usable phone</p>}{roster.exclusions.unauthorizedGroups > 0 && <p>{roster.exclusions.unauthorizedGroups} groups without posting permission</p>}</details>}{roster.count > roster.limit && <div className="notice danger">This selection exceeds the {roster.limit}-recipient limit. Choose a smaller audience.</div>}{roster.count === 0 && <div className="notice danger">No eligible recipients. Check the segment’s consent records in Contacts.</div>}</>}{rosterError && <div className="notice danger">{rosterError}</div>}<small className="summary-footnote">Consent is checked again before each send. Segment membership is refreshed for every run.</small></section>
          {step > 0 && <section className="phone-preview"><div className="phone-preview-header"><span className="person-avatar">A</span><div><strong>{sender?.label || "Your WhatsApp account"}</strong><small>Message preview</small></div></div><div className="phone-preview-chat"><div className="chat-bubble">{(mediaFile || form.mediaName) && <div className="preview-attachment"><FileText size={19}/>{mediaFile?.name || form.mediaName}</div>}<MessageText text={previewText || "Your message will appear here…"}/><span className="bubble-time">09:41 <CheckCheck size={14}/></span></div></div><p>{form.audienceType === "CONTACTS" ? "Example contact: Alex Morgan. Names and numbers are replaced for each recipient." : "One message appears in each selected group."}</p></section>}
        </aside>
      </fieldset>
      {hasTargets && <details className="included-recipients"><summary>View included recipients {roster ? `(${roster.count.toLocaleString()})` : ""}</summary><div className="search-box"><Search size={15}/><input aria-label="Search included campaign recipients" placeholder="Search included names or numbers…" value={rosterSearch} onChange={e => { setRosterSearch(e.target.value); setRosterPage(1); }}/></div>{roster ? <><div className="recipient-roster-list">{roster.items.map(person => <div className="recipient-roster-entry" key={person.key}><Check size={15}/><div className="recipient-roster-identity"><strong>{person.label}</strong><small>{person.phone ? "+" + person.phone : ""} · {person.sources.join(", ")}</small></div></div>)}{!roster.items.length && <p className="modal-help">No recipients match this search.</p>}</div><div className="table-footer"><span>{roster.matched} matching recipients</span><div className="pager"><button aria-label="Previous included recipients page" disabled={rosterPage <= 1} onClick={() => setRosterPage(p => p - 1)}><ArrowLeft size={15}/></button><span>{rosterPage} / {Math.max(1, Math.ceil(roster.matched / 10))}</span><button aria-label="Next included recipients page" disabled={rosterPage * 10 >= roster.matched} onClick={() => setRosterPage(p => p + 1)}><ArrowRight size={15}/></button></div></div></> : <p className="modal-help">Checking recipients…</p>}</details>}
      {error && <div className="notice danger" role="alert">{error}</div>}
    </div>
    <div className="modal-actions composer-actions"><span className="composer-progress">Step {step + 1} of 3</span><button className="btn outline" disabled={busy} onClick={() => step ? go(step - 1) : close()}>{step ? "Back" : "Cancel"}</button>{step < 2 ? <button className="btn primary" disabled={busy || (step === 0 ? !audienceReady : !messageReady)} onClick={() => go(step + 1)}>Continue <ArrowRight size={16}/></button> : <><button className="btn outline" disabled={busy || !audienceReady || !messageReady || !preview || !!preview.scheduleIssue} onClick={() => void save(false)}>{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} Save draft</button><button className="btn primary" disabled={busy || !launchReady} onClick={() => void save(true)}>{busy ? <LoaderCircle className="spin" size={15}/> : <Send size={15}/>} {form.scheduleType === "NOW" ? hasHistory ? "Save & relaunch" : "Launch campaign" : "Schedule campaign"}</button></>}</div>
  </>;
}
