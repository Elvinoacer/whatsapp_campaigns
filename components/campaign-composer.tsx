"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bold, Check, CheckCheck, Clock3, FileText, Info, Italic, LoaderCircle, Paperclip, RefreshCw, Search, Send, ShieldCheck, Strikethrough, Users, X } from "lucide-react";
import { personalize, campaignMessage } from "@/lib/message";
import { zonedDateTimeToIso } from "@/lib/timezone";
import styles from "./campaign-composer.module.css";

export type CampaignForm = { sendIntervalMs: number; mediaKey?: string; mediaMime?: string; mediaName?: string; name: string; message: string; sessionId: string; audienceType: "CONTACTS" | "GROUPS"; contactIds: string[]; segmentIds: string[]; groupIds: string[]; scheduleType: "NOW" | "ONCE" | "CRON"; scheduledAt: string; cron: string; timezone: string };
type Session = { sendingHold?: { reason: string } | null; id: string; label: string; publicSenderName?: string | null; status: string };
type Segment = { id: string; name: string; description?: string | null; eligibleCount?: number; _count: { members: number } };
type Group = { id: string; name: string; sessionId: string; allowPosting: boolean; _count: { members: number }; session: { label: string } };
type Contact = { id: string; name: string | null; phone: string | null; whatsappId: string };
type Exclusions = { missingConsent: number; optedOut: number; invalidDestination?: number; unusablePhone?: number; unauthorizedGroups: number };
type Roster = { count: number; total: number; excluded: number; duplicates: number; exclusions: Exclusions; limit: number; matched: number; take: number; items: { key: string; label: string; phone?: string | null; chatId: string; sources: string[] }[] };
type Preview = { senderName: string | null; messagePreview: string; safety: { policy: { maxPerHour: number; maxPerDay: number; timezone: string; startHour: number; endHour: number }; used: { lastDay: number }; frequencyLimited: number; hold: { reason: string } | null }; intervalMs: number; durationMs: number; nextRuns: string[]; scheduleIssue: string | null; count: number; limit: number };
type RequestError = { key: string; message: string };
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
  const [identityFilter, setIdentityFilter] = useState<"all" | "phone" | "private">("all");
  const [peopleResult, setPeopleResult] = useState<{ key: string; items: Contact[]; total: number } | null>(null);
  const [peopleFailure, setPeopleFailure] = useState<RequestError | null>(null);
  const [peopleRetry, setPeopleRetry] = useState(0);
  const [audienceResult, setAudienceResult] = useState<{ key: string; data: Roster } | null>(null);
  const [audienceFailure, setAudienceFailure] = useState<RequestError | null>(null);
  const [audienceRetry, setAudienceRetry] = useState(0);
  const [rosterResult, setRosterResult] = useState<{ key: string; data: Roster } | null>(null);
  const [rosterFailure, setRosterFailure] = useState<RequestError | null>(null);
  const [rosterRetry, setRosterRetry] = useState(0);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterPage, setRosterPage] = useState(1);
  const [previewResult, setPreviewResult] = useState<{ key: string; data: Preview } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<RequestError | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [privatePreview, setPrivatePreview] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState(campaignId);
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  const directSelection = useRef({ contactIds: initial.audienceType === "CONTACTS" ? initial.contactIds : [], segmentIds: initial.audienceType === "CONTACTS" ? initial.segmentIds : [], groupIds: initial.audienceType === "CONTACTS" ? initial.groupIds : [] });
  const groupSelection = useRef(initial.audienceType === "GROUPS" ? initial.groupIds : []);
  const audienceKey = JSON.stringify({ sessionId: form.sessionId, audienceType: form.audienceType, segmentIds: form.segmentIds, contactIds: form.contactIds, groupIds: form.groupIds });
  const rosterKey = JSON.stringify({ audienceKey, search: rosterSearch, page: rosterPage });
  const peopleKey = JSON.stringify({ search, page: peoplePage, identityFilter });
  const formKey = JSON.stringify(form);
  const audience = audienceResult?.key === audienceKey ? audienceResult.data : null;
  const roster = rosterResult?.key === rosterKey ? rosterResult.data : !rosterSearch && rosterPage === 1 ? audience : null;
  const audienceError = audienceFailure?.key === audienceKey ? audienceFailure.message : "";
  const rosterError = rosterFailure?.key === rosterKey ? rosterFailure.message : "";
  const peopleError = peopleFailure?.key === peopleKey ? peopleFailure.message : "";
  const previewError = previewFailure?.key === formKey ? previewFailure.message : "";
  const preview = previewResult?.key === formKey ? previewResult.data : null;
  const people = peopleResult?.key === peopleKey ? peopleResult : null;
  const hasTargets = form.audienceType === "GROUPS" ? form.groupIds.length > 0 : form.segmentIds.length + form.contactIds.length + form.groupIds.length > 0;
  const audienceReady = !!(form.sessionId && hasTargets && audience && audience.count > 0 && audience.count <= audience.limit);
  const messageReady = form.name.trim().length >= 3 && form.message.trim().length > 0 && form.message.length <= 4096;
  const intervalReady = Number.isInteger(form.sendIntervalMs) && form.sendIntervalMs >= 1500 && form.sendIntervalMs <= 3600000;
  const sender = sessions.find(session => session.id === form.sessionId);
  const draftReady = audienceReady && messageReady && intervalReady && !!preview;
  const launchReady = draftReady && !!preview && !preview.scheduleIssue && sender?.status === "CONNECTED" && !sender.sendingHold && !preview.safety.hold && (!hasHistory || resendConfirmed);

  useEffect(() => {
    if (!hasTargets || !form.sessionId) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<Roster>("/api/v1/campaigns/recipients", { method: "POST", body: { ...JSON.parse(audienceKey), page: 1, take: 10 } })
        .then(data => { if (alive) { setAudienceResult({ key: audienceKey, data }); setAudienceFailure(null); } })
        .catch(e => { if (alive) setAudienceFailure({ key: audienceKey, message: e instanceof Error ? e.message : "Unable to check recipients" }); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [audienceKey, audienceRetry, hasTargets, form.sessionId, request]);
  useEffect(() => {
    if (!rosterOpen || !hasTargets || !form.sessionId || !rosterSearch && rosterPage === 1 && !rosterRetry) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<Roster>("/api/v1/campaigns/recipients", { method: "POST", body: { ...JSON.parse(audienceKey), search: rosterSearch, page: rosterPage, take: 10 } })
        .then(data => { if (alive) { setRosterResult({ key: rosterKey, data }); setRosterFailure(null); } })
        .catch(e => { if (alive) setRosterFailure({ key: rosterKey, message: e instanceof Error ? e.message : "Unable to load recipients" }); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [audienceKey, rosterKey, rosterSearch, rosterPage, rosterOpen, rosterRetry, hasTargets, form.sessionId, request]);
  useEffect(() => {
    if (source !== "contacts" || form.audienceType !== "CONTACTS") return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<{ items: Contact[]; total: number }>("/api/v1/contacts?" + new URLSearchParams({ eligible: "true", search, page: String(peoplePage), take: "40", ...(identityFilter !== "all" ? { destinationAvailability: identityFilter } : {}) }))
        .then(data => { if (alive) { setPeopleResult({ key: peopleKey, ...data }); setPeopleFailure(null); } })
        .catch(e => { if (alive) setPeopleFailure({ key: peopleKey, message: e instanceof Error ? e.message : "Unable to load contacts" }); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [peopleKey, peoplePage, peopleRetry, search, identityFilter, source, form.audienceType, request]);
  useEffect(() => {
    if (!hasTargets || !messageReady || !form.sessionId || !intervalReady) return;
    let alive = true;
    const timer = setTimeout(() => {
      try {
        const body = { ...JSON.parse(formKey), scheduledAt: form.scheduleType === "ONCE" ? zonedDateTimeToIso(form.scheduledAt, form.timezone) : undefined };
        void request<Preview>("/api/v1/campaigns/preview", { method: "POST", body }).then(data => { if (alive) { setPreviewResult({ key: formKey, data }); setPreviewFailure(null); } })
          .catch(e => { if (alive) setPreviewFailure({ key: formKey, message: e instanceof Error ? e.message : "Unable to validate delivery" }); });
      } catch (e) { if (alive) setPreviewFailure({ key: formKey, message: e instanceof Error ? e.message : "Choose a valid date and time" }); }
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [formKey, previewRetry, form.scheduleType, form.scheduledAt, form.timezone, form.sessionId, messageReady, intervalReady, hasTargets, request]);
  function change(patch: Partial<CampaignForm>) { setForm(previous => ({ ...previous, ...patch })); setError(""); setResendConfirmed(false); }
  function choose(patch: Partial<CampaignForm>) { change(patch); setRosterPage(1); }
  function changeMode(mode: CampaignForm["audienceType"]) {
    if (mode === form.audienceType) return;
    if (mode === "GROUPS") {
      directSelection.current = { contactIds: form.contactIds, segmentIds: form.segmentIds, groupIds: form.groupIds };
      choose({ audienceType: mode, contactIds: [], segmentIds: [], groupIds: groupSelection.current.filter(id => groups.some(group => group.id === id && group.sessionId === form.sessionId)) });
    } else {
      groupSelection.current = form.groupIds;
      choose({ audienceType: mode, ...directSelection.current });
    }
    setSearch(""); setRosterSearch(""); setPeoplePage(1);
  }
  function go(next: number) {
    setStep(next); bodyRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
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
    if (savingRef.current || !draftReady || launch && !launchReady) return;
    savingRef.current = true;
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
    finally { savingRef.current = false; setBusy(false); busyChanged(false); }
  }
  const selectedNames = segments.filter(segment => form.segmentIds.includes(segment.id));
  const publicName = preview?.senderName || sender?.publicSenderName?.trim() || "";
  const placeholderPreview = form.audienceType === "CONTACTS"
    ? publicName ? campaignMessage(form.message, publicName) : form.message.trim() + "\n\n[Public sender name required]\nReply STOP to unsubscribe."
    : form.message;
  const previewText = personalize(preview?.messagePreview || placeholderPreview, { name: "Alex Morgan", phone: privatePreview ? null : "254700000000" });
  const availableGroups = groups.filter(group => form.audienceType === "GROUPS" ? group.sessionId === form.sessionId && group.allowPosting : group._count.members > 0);
  const invalidDestinationCount = audience?.exclusions.invalidDestination ?? audience?.exclusions.unusablePhone ?? 0;
  const selectedGroups = groups.filter(group => form.groupIds.includes(group.id));
  const sourceOptions = [
    { value: "segments", label: "Segments", count: form.segmentIds.length },
    { value: "contacts", label: "Opted-in contacts", count: form.contactIds.length },
    { value: "members", label: "Saved group members", count: form.groupIds.length },
  ] as const;
  const sourceHelp = source === "segments"
    ? "Select a segment once to include all its eligible members, across every page."
    : source === "contacts"
      ? "These contacts already have recorded opt-in. Select the people you want to include."
      : "Choose a saved group to include its opted-in members in private messages.";
  const continueIssue = step === 0
    ? !form.sessionId ? "Choose a sending account to continue." : !hasTargets ? "Select at least one audience source." : audienceError ? "Retry the audience check to continue." : !audience ? "Checking consent and WhatsApp destinations…" : !audienceReady ? "Your audience needs at least one eligible recipient and must fit the campaign limit." : ""
    : step === 1 ? form.name.trim().length < 3 ? "Give your campaign a name of at least 3 characters." : !form.message.trim() ? "Add your message to continue." : "" : "";
  const launchIssue = !intervalReady ? "Choose an interval from 1.5 to 3,600 seconds." : previewError || preview?.scheduleIssue || (!preview ? "Checking your delivery plan…" : sender?.status !== "CONNECTED" ? "Connect this WhatsApp account before launching; you can save a draft." : sender.sendingHold?.reason || preview.safety.hold?.reason || (hasHistory && !resendConfirmed ? "Confirm the new run below before launching." : ""));
  const pageSelected = !!people?.items.length && people.items.every(person => form.contactIds.includes(person.id));
  const pageSelection = [...new Set([...form.contactIds, ...(people?.items.map(person => person.id) || [])])];
  return <>
    <nav className="composer-steps" aria-label="Campaign steps">
      {["Choose audience", "Write message", "Review & launch"].map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={busy || index > step && (index > 0 && !audienceReady || index > 1 && !messageReady)} onClick={() => go(index)}><span>{index < step ? <Check size={15}/> : index + 1}</span><strong>{label}</strong></button>)}
    </nav>
    <div className="modal-body composer-body" ref={bodyRef}>
      <fieldset disabled={busy} className="composer-layout">
        <div className="composer-main">
          {step === 0 && <>
            <div className="composer-heading"><div className="eyebrow">01 / YOUR AUDIENCE</div><h3 ref={heading} tabIndex={-1}>Choose who receives your message</h3><p>Build your audience from opted-in contacts. We check consent, combine your selections and remove duplicate destinations.</p></div>
            <label>Sending account<select aria-label="Campaign sending account" value={form.sessionId} onChange={e => choose({ sessionId: e.target.value, ...(form.audienceType === "GROUPS" ? { groupIds: [] } : {}) })}><option value="">Choose a WhatsApp account</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.label} · {session.status.toLowerCase()}</option>)}</select><small>Contact segments are shared across your sending accounts. Account labels are private and never appended to sent messages.</small></label>
            {!sessions.length && <div className="notice danger">Add a WhatsApp account in Accounts before creating a campaign.</div>}
            <div className={`pill-choice audience-mode ${styles.destinationChoice}`} aria-label="Message destination">
              <button aria-pressed={form.audienceType === "CONTACTS"} className={form.audienceType === "CONTACTS" ? "picked" : ""} onClick={() => changeMode("CONTACTS")}><Users size={17}/><span><strong>Direct messages</strong><small>One private message per person</small></span></button>
              <button aria-pressed={form.audienceType === "GROUPS"} className={form.audienceType === "GROUPS" ? "picked" : ""} onClick={() => changeMode("GROUPS")}><Send size={17}/><span><strong>Group announcements</strong><small>One message in each group</small></span></button>
            </div>
            {form.audienceType === "CONTACTS" && <>
              <div className={styles.identityNote}><ShieldCheck size={18}/><div><strong>A phone number is optional</strong><p>People using usernames or hidden phone numbers can opt in too. Sending uses their saved WhatsApp identity, including private WhatsApp IDs.</p></div></div>
              <div className="source-tabs" aria-label="Contact source">{sourceOptions.map(option => <button key={option.value} aria-pressed={source === option.value} className={source === option.value ? "active" : ""} onClick={() => { setSource(option.value); setSearch(""); setPeoplePage(1); }}>{option.label}{option.count > 0 && <span className={styles.tabCount}>{option.count}</span>}</button>)}</div>
              <div className={styles.sourceHelp}><strong>{sourceHelp}</strong><p>You can combine all three sources. Switching tabs keeps your selections; overlapping people receive one message per run.</p></div>
            </>}
            <div className="search-box"><Search size={16}/><input maxLength={120} aria-label={source === "contacts" ? "Search campaign contacts" : "Search audience sources"} placeholder={form.audienceType === "GROUPS" ? "Find an authorized group…" : source === "segments" ? "Find a segment…" : source === "contacts" ? "Search name, phone or WhatsApp ID…" : "Find a saved group…"} value={search} onChange={e => { setSearch(e.target.value); setPeoplePage(1); }}/></div>
            {form.audienceType === "CONTACTS" && source === "segments" && <div className="source-list">
              {segments.filter(segment => segment.name.toLowerCase().includes(search.toLowerCase())).map(segment => <label className={`audience-card ${form.segmentIds.includes(segment.id) ? "selected" : ""}`} key={segment.id}><input type="checkbox" aria-label={`Select all opted-in contacts from ${segment.name}`} checked={form.segmentIds.includes(segment.id)} onChange={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })}/><span><strong>{segment.name}</strong><small>{segment.description || "All eligible members are included automatically"}</small></span><span className="audience-card-count"><strong>{segment.eligibleCount?.toLocaleString() ?? "—"}</strong><small>eligible of {segment._count.members.toLocaleString()} saved</small></span></label>)}
              {!segments.length && <div className="composer-empty"><Users size={26}/><strong>No segments yet</strong><p>Choose opted-in contacts in the next tab, or create a segment from Contacts to reuse your audience.</p><button type="button" className="btn outline" onClick={() => { setSource("contacts"); setSearch(""); }}>Choose opted-in contacts</button></div>}
              {segments.length > 0 && !segments.some(segment => segment.name.toLowerCase().includes(search.toLowerCase())) && <p className="modal-help">No segments match your search.</p>}
            </div>}
            {form.audienceType === "CONTACTS" && source === "contacts" && <>
              <label className={styles.identityFilter}>Show<select aria-label="Campaign contact identity type" value={identityFilter} onChange={e => { setIdentityFilter(e.target.value as typeof identityFilter); setPeoplePage(1); }}><option value="all">All WhatsApp identities</option><option value="phone">Phone identities</option><option value="private">Private WhatsApp IDs</option></select></label>
              <div className={styles.selectionToolbar}><span><strong>{form.contactIds.length.toLocaleString()}</strong> individually selected</span><button className="text-button" disabled={!people?.items.length || !pageSelected && pageSelection.length > 1500} onClick={() => choose({ contactIds: pageSelected ? form.contactIds.filter(id => !people?.items.some(person => person.id === id)) : pageSelection })}>{pageSelected ? "Deselect" : "Select"} this page{people?.items.length ? ` (${people.items.length})` : ""}</button></div>
              {peopleError && <div className={`notice danger ${styles.retryNotice}`} role="alert"><span>{peopleError}</span><button className="text-button" onClick={() => { setPeopleFailure(null); setPeopleRetry(value => value + 1); }}><RefreshCw size={13}/> Retry</button></div>}
              {!people && !peopleError && <p className={styles.loading} role="status"><LoaderCircle size={15} className="spin"/> Loading opted-in contacts…</p>}
              <div className={`selection-grid scroll-selection ${styles.contactChoices}`}>
                {people?.items.map(person => <label className={`check-item ${form.contactIds.includes(person.id) ? styles.checkedContact : ""}`} key={person.id}><input type="checkbox" disabled={!form.contactIds.includes(person.id) && form.contactIds.length >= 1500} checked={form.contactIds.includes(person.id)} onChange={() => choose({ contactIds: toggle(form.contactIds, person.id) })}/><span><strong>{person.name || person.phone || "Private WhatsApp contact"}</strong><small className="check-description">{person.phone ? "+" + person.phone : "Private WhatsApp ID · phone hidden"}</small><small className={styles.optIn}><ShieldCheck size={11}/> Verified opt-in</small></span></label>)}
              </div>
              {people?.total === 0 && <div className="composer-empty"><Users size={25}/><strong>{search || identityFilter !== "all" ? "No opted-in contacts match" : "No eligible contacts yet"}</strong><p>{search || identityFilter !== "all" ? "Try another search or choose all WhatsApp identities." : "Record opt-in evidence in Contacts first. A phone number is optional when a saved WhatsApp ID is available."}</p></div>}
              {people && people.total > 0 && <div className="table-footer"><span>{people.total.toLocaleString()} eligible records</span><div className="pager"><button aria-label="Previous campaign contacts" disabled={peoplePage <= 1} onClick={() => setPeoplePage(p => p - 1)}><ArrowLeft size={15}/></button><span>{peoplePage} / {Math.max(1, Math.ceil(people.total / 40))}</span><button aria-label="Next campaign contacts" disabled={peoplePage * 40 >= people.total} onClick={() => setPeoplePage(p => p + 1)}><ArrowRight size={15}/></button></div></div>}
              <p className={styles.pageHint}>Selections stay selected across pages and searches. Select a segment to include all its eligible members at once.{form.contactIds.length >= 1500 && " You’ve reached the 1,500 individually selected records limit; use a segment for a larger audience."}</p>
            </>}
            {(form.audienceType === "GROUPS" || source === "members") && <>
              <p className="modal-help">{form.audienceType === "GROUPS" ? "Only groups with posting permission for this sending account appear here. Recipients will see one announcement in the group." : "Only saved members with verified opt-in will receive a direct message. Group membership does not record opt-in."}</p>
              <div className="source-list">{availableGroups.filter(group => group.name.toLowerCase().includes(search.toLowerCase())).map(group => <label className={`audience-card ${form.groupIds.includes(group.id) ? "selected" : ""}`} key={group.id}><input type="checkbox" checked={form.groupIds.includes(group.id)} onChange={() => choose({ groupIds: toggle(form.groupIds, group.id) })}/><span><strong>{group.name}</strong><small>{group._count.members.toLocaleString()} saved members · {group.session.label}</small></span>{form.audienceType === "GROUPS" && <ShieldCheck size={17}/>}</label>)}
                {!availableGroups.length && <div className="composer-empty"><Users size={25}/><strong>{form.audienceType === "GROUPS" ? form.sessionId ? "No authorized groups for this account" : "Choose a sending account first" : "No saved group members yet"}</strong><p>{form.audienceType === "GROUPS" ? "Enable posting permission in Groups for the account you want to use." : "Save members from Groups first, then record their opt-in in Contacts."}</p></div>}
                {availableGroups.length > 0 && !availableGroups.some(group => group.name.toLowerCase().includes(search.toLowerCase())) && <p className="modal-help">No groups match your search.</p>}
              </div>
            </>}
          </>}
          {step === 1 && <>
            <div className="composer-heading"><div className="eyebrow">02 / YOUR MESSAGE</div><h3 ref={heading} tabIndex={-1}>Write and preview your message</h3><p>Personalize your message and check the final text, including the sender and opt-out instructions.</p></div>
            <label>Campaign name<input aria-label="Campaign name" minLength={3} maxLength={100} value={form.name} placeholder="e.g. October community update" onChange={e => change({ name: e.target.value })}/><small>For your workspace. Recipients won’t see this name.</small></label>
            <label htmlFor="campaign-message">Message</label>
            <div className="message-editor"><div className="editor-toolbar">{[{ label: "Bold", marker: "*", icon: Bold }, { label: "Italic", marker: "_", icon: Italic }, { label: "Strikethrough", marker: "~", icon: Strikethrough }].map(tool => <button type="button" key={tool.label} title={tool.label} aria-label={tool.label} onClick={() => insert(tool.marker, tool.marker)}><tool.icon size={16}/></button>)}<span>WhatsApp formatting</span></div><textarea id="campaign-message" ref={editor} rows={9} maxLength={4096} value={form.message} placeholder="Hi {{first_name}}, we have something to share…" onChange={e => change({ message: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && ["b", "i"].includes(e.key)) { e.preventDefault(); insert(e.key === "b" ? "*" : "_", e.key === "b" ? "*" : "_"); } }}/><div className="editor-bottom"><span>Select text to format it</span><span>{form.message.length.toLocaleString()} / 4,096</span></div></div>
            {form.audienceType === "CONTACTS" && <div className="personalize-tools"><span>Personalize:</span>{["first_name", "name", "phone"].map(token => <button className="token-button" key={token} onClick={() => insert("{{" + token + "}}")}>{"{{" + token + "}}"}</button>)}<small>Missing names use “there”. The phone token is blank for contacts with hidden numbers. Only the configured public sender name and STOP instructions are added, never the internal account label.</small></div>}
            {preview?.scheduleIssue?.includes("Shorten the message") && <div className="notice danger" role="alert">{preview.scheduleIssue}</div>}
            {form.audienceType === "CONTACTS" && <div className={publicName ? "muted-footnote" : "notice danger"} role="status">{publicName ? `Public sender identity: ${publicName}` : "No public sender identity is configured. Go to WhatsApp sessions → Edit account, then enter the real business name before launching."}</div>}
            <label className="attachment-picker"><Paperclip size={18}/><span><strong>{mediaFile?.name || form.mediaName || "Add an image or PDF"}</strong><small>JPEG, PNG, WebP or PDF · up to 8 MB</small></span><input aria-label="Campaign attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const file = e.target.files?.[0]; if (file && (!file.size || file.size > 8 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type))) { setError("Choose a JPEG, PNG, WebP or PDF up to 8 MB."); e.target.value = ""; return; } setMediaFile(file || null); setResendConfirmed(false); setError(""); }}/></label>{(mediaFile || form.mediaKey) && <button className="text-button" onClick={() => { setMediaFile(null); change({ mediaKey: undefined, mediaMime: undefined, mediaName: undefined }); }}>Remove attachment</button>}
          </>}
          {step === 2 && <>
            <div className="composer-heading"><div className="eyebrow">03 / FINAL REVIEW</div><h3 ref={heading} tabIndex={-1}>{hasHistory ? "Review your new campaign run" : "Review your campaign"}</h3><p>{hasHistory ? "Launching creates a new run. Previously messaged contacts can receive this message again; earlier results stay in the campaign history." : "Check the audience, message and timing before you launch. Saving a draft does not send any messages."}</p></div>
            <section className={styles.reviewSummary} aria-label="Campaign review">
              <div><span>Campaign</span><strong>{form.name}</strong><button className="text-button" onClick={() => go(1)}>Edit message</button></div>
              <div><span>Sending from</span><strong>{sender?.label || "Choose an account"}</strong><small className={sender?.status === "CONNECTED" ? styles.connected : styles.disconnected}>{sender?.status === "CONNECTED" ? "Connected" : "Connection needed"}</small>{form.audienceType === "CONTACTS" && <small>Visible to recipients: {publicName || "Not configured"}</small>}</div>
              <div><span>Recipients per run</span><strong>{audience?.count.toLocaleString() ?? "…"} {form.audienceType === "GROUPS" ? "groups" : "people"}</strong><button className="text-button" onClick={() => go(0)}>Edit audience</button></div>
              <div><span>Attachment</span><strong>{mediaFile?.name || form.mediaName || "Text message only"}</strong></div>
            </section>
            <div className={styles.deliveryHeading}><Clock3 size={17}/><h4>When should it send?</h4></div>
            <div className={`pill-choice ${styles.scheduleChoice}`} aria-label="Campaign timing">{([{ value: "NOW", label: "Launch now", description: "As soon as sending hours allow" }, { value: "ONCE", label: "Schedule once", description: "Pick a date and time" }, { value: "CRON", label: "Repeat", description: "A new run at each scheduled time" }] as const).map(option => <button key={option.value} aria-pressed={form.scheduleType === option.value} className={form.scheduleType === option.value ? "picked" : ""} onClick={() => change({ scheduleType: option.value })}><span><strong>{option.label}</strong><small>{option.description}</small></span></button>)}</div>
            {form.scheduleType === "ONCE" && <label>Send date and time<input aria-label="Campaign date and time" type="datetime-local" value={form.scheduledAt} onChange={e => change({ scheduledAt: e.target.value })}/><small>Interpreted in {form.timezone}. Sending hours can defer delivery.</small></label>}
            {form.scheduleType === "CRON" && <><label>Repeat schedule<select aria-label="Recurring schedule preset" value={["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"].includes(form.cron) ? form.cron : "custom"} onChange={e => change({ cron: e.target.value === "custom" ? "0 10 * * *" : e.target.value })}><option value="0 9 * * *">Every day at 09:00</option><option value="0 9 * * 1-5">Weekdays at 09:00</option><option value="0 9 * * 1">Every Monday at 09:00</option><option value="0 9 1 * *">First of the month at 09:00</option><option value="custom">Custom schedule…</option></select></label>{!["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"].includes(form.cron) && <label>Cron expression<input aria-label="Custom recurring cron expression" value={form.cron} onChange={e => change({ cron: e.target.value })}/><small>Minute · hour · day · month · weekday</small></label>}<p className={styles.repeatNote}><Info size={15}/> Each scheduled run checks current segment members and consent again. People may receive this campaign more than once, subject to recipient cooldowns.</p></>}
            {form.scheduleType !== "NOW" && <label>Timezone<input aria-label="Campaign timezone" list="campaign-timezones" value={form.timezone} onChange={e => change({ timezone: e.target.value })}/><datalist id="campaign-timezones">{["Africa/Nairobi", "UTC", "Europe/London", "America/New_York", "Asia/Dubai"].map(zone => <option key={zone} value={zone}/>)}</datalist></label>}
            <label>Time between messages (seconds)<input aria-label="Message interval in seconds" type="number" min={1.5} max={3600} step={0.5} value={Number.isFinite(form.sendIntervalMs) ? form.sendIntervalMs / 1000 : ""} onChange={e => change({ sendIntervalMs: e.target.value === "" ? 0 : Number(e.target.value) * 1000 })}/><small>One message at a time. The workspace’s minimum interval and sending budgets also apply.</small></label>
            <div className="delivery-plan" aria-live="polite">{preview ? <>
              <strong>{preview.count.toLocaleString()} {form.audienceType === "GROUPS" ? "groups" : "people"} · at least {Math.max(1, Math.ceil(preview.durationMs / 60000)).toLocaleString()} min</strong>
              <p>{preview.intervalMs / 1000} seconds between messages. Sending hours and shared budgets can extend a large campaign over several days. Unsent recipients stay queued.</p>
              <div className={styles.policyDetails}><span>Sending window</span><strong>{String(preview.safety.policy.startHour).padStart(2, "0")}:00–{String(preview.safety.policy.endHour).padStart(2, "0")}:00 · {preview.safety.policy.timezone}</strong><span>Shared budget</span><strong>{preview.safety.policy.maxPerHour.toLocaleString()}/hour · {preview.safety.policy.maxPerDay.toLocaleString()}/24h</strong><span>Used in last 24h</span><strong>{preview.safety.used.lastDay.toLocaleString()} attempts</strong></div>
              {preview.safety.frequencyLimited > 0 && <p className={styles.cooldownNote}>{preview.safety.frequencyLimited.toLocaleString()} recipients are in a cooldown and would currently be skipped. They are included in the audience count above.</p>}
              {form.scheduleType !== "NOW" && <><strong>Upcoming runs · {form.timezone}</strong><ol>{preview.nextRuns.slice(0, 3).map(date => <li key={date}>{new Date(date).toLocaleString("en-KE", { timeZone: form.timezone, dateStyle: "medium", timeStyle: "short" })}</li>)}</ol></>}
              {preview.scheduleIssue && <div className="notice danger">{preview.scheduleIssue}</div>}
            </> : previewError ? <div className={styles.retryNotice}><span>{previewError}</span><button className="text-button" onClick={() => { setPreviewFailure(null); setPreviewRetry(value => value + 1); }}><RefreshCw size={13}/> Retry check</button></div> : <p className={styles.loading}><LoaderCircle size={15} className="spin"/>{intervalReady ? "Checking your delivery plan…" : "Choose an interval from 1.5 to 3,600 seconds."}</p>}</div>
            {(preview?.safety.hold || sender?.sendingHold) && <div className="notice danger" role="alert">Sending is on hold: {preview?.safety.hold?.reason || sender?.sendingHold?.reason} Review in Settings. You can still save a draft.</div>}
            {sender?.status !== "CONNECTED" && <div className="notice danger">Connect the sending account before launching. You can save your draft now.</div>}
            {hasHistory && <label className="check-item resend-confirmation"><input type="checkbox" checked={resendConfirmed} onChange={e => setResendConfirmed(e.target.checked)}/><span>I’m starting a new run for {audience?.count.toLocaleString() ?? "these"} {form.audienceType === "GROUPS" ? "groups" : "people"}. Previously messaged recipients may receive this campaign again.</span></label>}
          </>}
        </div>
        <aside className="composer-aside">
          <section className="audience-summary" aria-label="Selected campaign audience">
            <div className="summary-label"><ShieldCheck size={16}/> YOUR AUDIENCE</div>
            <div className="summary-number" aria-live="polite">{!hasTargets ? "0" : audience ? audience.count.toLocaleString() : "…"}</div><strong>{form.audienceType === "CONTACTS" ? "eligible people" : "authorized groups"}</strong><p>{form.audienceType === "CONTACTS" ? "One direct message per unique WhatsApp destination, per run." : "One announcement in each selected group, per run."}</p>
            {hasTargets && <div className={styles.selectedHeading}><span>Selected sources</span><button className="text-button" onClick={() => choose({ segmentIds: [], contactIds: [], groupIds: [] })}>Clear all</button></div>}
            <div className="selected-sources">{selectedNames.map(segment => <button key={segment.id} onClick={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })} aria-label={"Remove segment " + segment.name}>{segment.name}<X size={12}/></button>)}{form.contactIds.length > 0 && <button onClick={() => choose({ contactIds: [] })} aria-label="Remove all individually selected contacts">{form.contactIds.length.toLocaleString()} individual contacts<X size={12}/></button>}{selectedGroups.map(group => <button key={group.id} onClick={() => choose({ groupIds: toggle(form.groupIds, group.id) })} aria-label={"Remove group source " + group.name}>{group.name}{form.audienceType === "CONTACTS" ? " members" : ""}<X size={12}/></button>)}</div>
            {!hasTargets && <p>Choose a segment, individual contacts or {form.audienceType === "GROUPS" ? "authorized groups" : "saved group members"} to see your recipient count.</p>}
            {hasTargets && form.sessionId && !audience && !audienceError && <p className={styles.loading}><LoaderCircle size={14} className="spin"/> Checking consent and destinations…</p>}
            {audience && <>
              <div className="summary-line"><span>Selected records</span><strong>{audience.total.toLocaleString()}</strong></div><div className="summary-line"><span>Not eligible</span><strong>{audience.excluded.toLocaleString()}</strong></div><div className="summary-line"><span>Duplicate records removed</span><strong>{audience.duplicates.toLocaleString()}</strong></div>
              {audience.excluded > 0 && <details className="exclusion-details" open><summary>Why are contacts excluded?</summary>{audience.exclusions.missingConsent > 0 && <p>{audience.exclusions.missingConsent.toLocaleString()} without recorded opt-in evidence</p>}{audience.exclusions.optedOut > 0 && <p>{audience.exclusions.optedOut.toLocaleString()} opted out or suppressed</p>}{invalidDestinationCount > 0 && <p>{invalidDestinationCount.toLocaleString()} without a usable saved WhatsApp identity</p>}{audience.exclusions.unauthorizedGroups > 0 && <p>{audience.exclusions.unauthorizedGroups.toLocaleString()} groups without posting permission</p>}</details>}
              {audience.count > audience.limit && <div className="notice danger">This selection exceeds the {audience.limit.toLocaleString()}-recipient limit. Choose a smaller audience.</div>}
              {audience.count === 0 && <div className="notice danger">No eligible recipients. Review opt-in evidence and saved WhatsApp identities in Contacts. A hidden phone number alone does not exclude someone.</div>}
            </>}
            {audienceError && <div className={`notice danger ${styles.retryNotice}`} role="alert"><span>{audienceError}</span><button className="text-button" onClick={() => { setAudienceFailure(null); setAudienceRetry(value => value + 1); }}><RefreshCw size={13}/> Retry</button></div>}
            <small className="summary-footnote">Consent is checked again before each send. Segment membership is refreshed for every run.</small>
          </section>
          {step > 0 && <section className="phone-preview">
            <div className="phone-preview-header"><span className="person-avatar">A</span><div><strong>{sender?.label || "Your WhatsApp account"}</strong><small>Message preview · internal account label is not sent</small></div></div>
            {form.audienceType === "CONTACTS" && <div className={styles.previewControls}><button aria-pressed={!privatePreview} onClick={() => setPrivatePreview(false)}>With phone</button><button aria-pressed={privatePreview} onClick={() => setPrivatePreview(true)}>Phone hidden</button></div>}
            <div className="phone-preview-chat"><div className="chat-bubble">{(mediaFile || form.mediaName) && <div className="preview-attachment"><FileText size={19}/>{mediaFile?.name || form.mediaName}</div>}<MessageText text={previewText || "Your message will appear here…"}/><span className="bubble-time">09:41 <CheckCheck size={14}/></span></div></div>
            <p>{form.audienceType === "CONTACTS" ? privatePreview ? "Example: Alex Morgan with a private WhatsApp ID. The phone token is blank; the message can still be sent using the saved identity." : "Example: Alex Morgan. Personalization is replaced for each recipient." : "One message appears in each selected group."}</p>
          </section>}
        </aside>
      </fieldset>
      {hasTargets && <details className="included-recipients" open={rosterOpen} onToggle={event => setRosterOpen(event.currentTarget.open)}>
        <summary>Inspect included recipients {audience ? `(${audience.count.toLocaleString()})` : ""}</summary>
        <p className={styles.pageHint}>These are the eligible WhatsApp destinations in this selection. Consent and recipient cooldowns are checked again when sending.</p>
        <div className="search-box"><Search size={15}/><input disabled={busy} maxLength={120} aria-label="Search included campaign recipients" placeholder="Search name, phone, WhatsApp ID or source…" value={rosterSearch} onChange={e => { setRosterSearch(e.target.value); setRosterPage(1); }}/></div>
        {rosterError ? <div className={`notice danger ${styles.retryNotice}`}><span>{rosterError}</span><button disabled={busy} className="text-button" onClick={() => { setRosterFailure(null); setRosterRetry(value => value + 1); }}><RefreshCw size={13}/> Retry</button></div> : roster ? <>
          <div className="recipient-roster-list">{roster.items.map(person => <div className="recipient-roster-entry" key={person.key}><Check size={15}/><div className="recipient-roster-identity"><strong>{person.label}</strong><small>{[person.phone ? "+" + person.phone : form.audienceType === "CONTACTS" ? "Phone hidden · saved WhatsApp ID" : "Group", ...person.sources].join(" · ")}</small></div></div>)}{!roster.items.length && <p className="modal-help">No recipients match this search.</p>}</div>
          <div className="table-footer"><span>{roster.matched.toLocaleString()} matching recipients</span><div className="pager"><button disabled={busy || rosterPage <= 1} aria-label="Previous included recipients page" onClick={() => setRosterPage(p => p - 1)}><ArrowLeft size={15}/></button><span>{rosterPage} / {Math.max(1, Math.ceil(roster.matched / 10))}</span><button disabled={busy || rosterPage * 10 >= roster.matched} aria-label="Next included recipients page" onClick={() => setRosterPage(p => p + 1)}><ArrowRight size={15}/></button></div></div>
        </> : <p className={styles.loading} role="status"><LoaderCircle size={15} className="spin"/> Checking recipients…</p>}
      </details>}
      {error && <div className="notice danger" role="alert">{error}</div>}
      {(continueIssue || step === 2 && launchIssue) && <p className={styles.nextHint} role="status"><Info size={15}/>{continueIssue || launchIssue}</p>}
    </div>
    <div className="modal-actions composer-actions"><span className="composer-progress">Step {step + 1} of 3</span><button className="btn outline" disabled={busy} onClick={() => step ? go(step - 1) : close()}>{step ? "Back" : "Cancel"}</button>{step < 2 ? <button className="btn primary" disabled={busy || (step === 0 ? !audienceReady : !messageReady)} onClick={() => go(step + 1)}>{step === 0 ? "Write message" : "Review campaign"} <ArrowRight size={16}/></button> : <><button className="btn outline" disabled={busy || !draftReady} onClick={() => void save(false)}>{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} Save draft</button><button className="btn primary" disabled={busy || !launchReady} onClick={() => void save(true)}>{busy ? <LoaderCircle className="spin" size={15}/> : <Send size={15}/>} {form.scheduleType === "NOW" ? hasHistory ? "Launch new run" : "Launch campaign" : "Schedule campaign"}</button></>}</div>
  </>;
}
