"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Bold, BookmarkPlus, CalendarClock, Check, CheckCheck,
  Clock3, Code2, FileText, Info, Italic, Layers, LoaderCircle, Paperclip, Play,
  RefreshCw, Repeat, Search, Send, ShieldCheck, Sparkles, Strikethrough, Users, X,
} from "lucide-react";
import { personalize, campaignMessage } from "@/lib/message";
import { zonedDateTimeToIso } from "@/lib/timezone";
import type { MessageTemplateRecord } from "./template-studio";
import styles from "./campaign-composer.module.css";

export type CampaignForm = {
  sendIntervalMs: number;
  mediaKey?: string;
  mediaMime?: string;
  mediaName?: string;
  name: string;
  message: string;
  sessionId: string;
  audienceType: "CONTACTS" | "GROUPS" | "BOTH";
  contactIds: string[];
  segmentIds: string[];
  groupIds: string[];
  scheduleType: "NOW" | "ONCE" | "CRON";
  scheduledAt: string;
  cron: string;
  intervalHours: number | null;
  runImmediately: boolean;
  repeatPolicy: "ALLOW_REPEAT" | "COOLDOWN" | "NO_REPEAT";
  repeatCooldownHours: number;
  includeFooter: boolean;
  templateId?: string | null;
  timezone: string;
};

type Session = { sendingHold?: { reason: string } | null; id: string; label: string; publicSenderName?: string | null; status: string };
type Segment = { id: string; name: string; description?: string | null; eligibleCount?: number; _count: { members: number } };
type Group = { id: string; name: string; sessionId: string; allowPosting: boolean; participantCount?: number; _count: { members: number }; session: { label: string } };
type Contact = { consent: string; id: string; name: string | null; phone: string | null; whatsappId: string };
type Exclusions = { missingConsent: number; optedOut: number; invalidDestination?: number; unusablePhone?: number; unauthorizedGroups: number };
type Roster = {
  count: number;
  total: number;
  excluded: number;
  duplicates: number;
  exclusions: Exclusions;
  limit: number;
  matched: number;
  take: number;
  items: { key: string; label: string; phone?: string | null; chatId: string; sources: string[] }[];
};
type Preview = {
  senderName: string | null;
  messagePreview: string;
  safety: {
    policy: { alwaysOpen?: boolean; maxPer15Minutes?: number; maxPerHour: number; maxPerDay: number; timezone: string; startHour: number; endHour: number };
    used: { lastDay: number };
    frequencyLimited: number;
    hold: { accountKey?: string; reason: string } | null;
  };
  intervalMs: number;
  durationMs: number;
  nextRuns: string[];
  scheduleIssue: string | null;
  count: number;
  limit: number;
};
type RequestError = { key: string; message: string };
type Request = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;

const toggle = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
const HOUR_INTERVAL_PRESETS = [1, 2, 3, 4, 5, 6, 8, 12, 24];

function MessageText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g).map((part, index) =>
        part.startsWith("*") && part.endsWith("*") ? (
          <strong key={index}>{part.slice(1, -1)}</strong>
        ) : part.startsWith("_") && part.endsWith("_") ? (
          <em key={index}>{part.slice(1, -1)}</em>
        ) : part.startsWith("~") && part.endsWith("~") ? (
          <s key={index}>{part.slice(1, -1)}</s>
        ) : part.startsWith("`") && part.endsWith("`") ? (
          <code key={index}>{part.slice(1, -1)}</code>
        ) : (
          part
        )
      )}
    </>
  );
}

export default function CampaignComposer({
  initial,
  campaignId,
  hasHistory,
  canContinue = false,
  sentCount = 0,
  sessions,
  segments,
  groups,
  templates = [],
  onTemplatesChanged,
  request,
  close,
  saved,
  busyChanged,
}: {
  initial: CampaignForm;
  campaignId: string | null;
  hasHistory: boolean;
  canContinue?: boolean;
  sentCount?: number;
  sessions: Session[];
  segments: Segment[];
  groups: Group[];
  templates?: MessageTemplateRecord[];
  onTemplatesChanged?: () => Promise<void>;
  request: Request;
  close: () => void;
  saved: (message: string) => Promise<void>;
  busyChanged: (busy: boolean) => void;
}) {
  const [form, setForm] = useState<CampaignForm>(initial);
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"segments" | "contacts" | "groups">(
    initial.audienceType === "GROUPS"
      ? "groups"
      : initial.segmentIds.length || (!initial.contactIds.length && !initial.groupIds.length)
        ? "segments"
        : initial.contactIds.length
          ? "contacts"
          : "groups"
  );
  const [cronStyle, setCronStyle] = useState<"interval" | "calendar">(
    initial.intervalHours && initial.intervalHours > 0 ? "interval" : "calendar"
  );
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
  const [restartAll, setRestartAll] = useState(false);
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplCategory, setTplCategory] = useState("General");
  const [tplNotice, setTplNotice] = useState("");

  const editor = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);

  const audienceKey = JSON.stringify({
    sessionId: form.sessionId,
    audienceType: form.audienceType,
    segmentIds: form.segmentIds,
    contactIds: form.contactIds,
    groupIds: form.groupIds,
  });
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

  const hasTargets =
    form.audienceType === "GROUPS"
      ? form.groupIds.length > 0
      : form.segmentIds.length + form.contactIds.length + form.groupIds.length > 0;
  const audienceReady = !!(form.sessionId && hasTargets && audience && audience.count > 0 && audience.count <= audience.limit);
  const messageReady = form.name.trim().length >= 3 && form.message.trim().length > 0 && form.message.length <= 4096;
  const intervalReady = Number.isInteger(form.sendIntervalMs) && form.sendIntervalMs >= 1500 && form.sendIntervalMs <= 3600000;
  const sender = sessions.find(session => session.id === form.sessionId);
  const audienceSelected = !!(form.sessionId && hasTargets && audience && audience.total > 0);
  const draftReady = !!form.sessionId && hasTargets && messageReady && intervalReady;
  const launchReady =
    draftReady &&
    audienceReady &&
    !!preview &&
    !preview.scheduleIssue &&
    sender?.status === "CONNECTED" &&
    !sender.sendingHold &&
    !preview.safety.hold;

  useEffect(() => {
    if (!hasTargets || !form.sessionId) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<Roster>("/api/v1/campaigns/recipients", {
        method: "POST",
        body: { ...JSON.parse(audienceKey), page: 1, take: 10 },
      })
        .then(data => {
          if (alive) {
            setAudienceResult({ key: audienceKey, data });
            setAudienceFailure(null);
          }
        })
        .catch(e => {
          if (alive) setAudienceFailure({ key: audienceKey, message: e instanceof Error ? e.message : "Unable to check recipients" });
        });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [audienceKey, audienceRetry, hasTargets, form.sessionId, request]);

  useEffect(() => {
    if (!rosterOpen || !hasTargets || !form.sessionId || (!rosterSearch && rosterPage === 1 && !rosterRetry)) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<Roster>("/api/v1/campaigns/recipients", {
        method: "POST",
        body: { ...JSON.parse(audienceKey), search: rosterSearch, page: rosterPage, take: 10 },
      })
        .then(data => {
          if (alive) {
            setRosterResult({ key: rosterKey, data });
            setRosterFailure(null);
          }
        })
        .catch(e => {
          if (alive) setRosterFailure({ key: rosterKey, message: e instanceof Error ? e.message : "Unable to load recipients" });
        });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [audienceKey, rosterKey, rosterSearch, rosterPage, rosterOpen, rosterRetry, hasTargets, form.sessionId, request]);

  useEffect(() => {
    if (source !== "contacts" || form.audienceType === "GROUPS") return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<{ items: Contact[]; total: number }>(
        "/api/v1/contacts?" +
          new URLSearchParams({
            search,
            page: String(peoplePage),
            take: "40",
            ...(identityFilter !== "all" ? { destinationAvailability: identityFilter } : {}),
          })
      )
        .then(data => {
          if (alive) {
            setPeopleResult({ key: peopleKey, ...data });
            setPeopleFailure(null);
          }
        })
        .catch(e => {
          if (alive) setPeopleFailure({ key: peopleKey, message: e instanceof Error ? e.message : "Unable to load contacts" });
        });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [peopleKey, peoplePage, peopleRetry, search, identityFilter, source, form.audienceType, request]);

  useEffect(() => {
    if (!hasTargets || !messageReady || !form.sessionId || !intervalReady) return;
    let alive = true;
    const timer = setTimeout(() => {
      try {
        const body = {
          ...JSON.parse(formKey),
          scheduledAt: form.scheduleType === "ONCE" ? zonedDateTimeToIso(form.scheduledAt, form.timezone) : undefined,
        };
        void request<Preview>("/api/v1/campaigns/preview", { method: "POST", body })
          .then(data => {
            if (alive) {
              setPreviewResult({ key: formKey, data });
              setPreviewFailure(null);
            }
          })
          .catch(e => {
            if (alive) setPreviewFailure({ key: formKey, message: e instanceof Error ? e.message : "Unable to validate delivery" });
          });
      } catch (e) {
        if (alive) setPreviewFailure({ key: formKey, message: e instanceof Error ? e.message : "Choose a valid date and time" });
      }
    }, 280);
    return () => { alive = false; clearTimeout(timer); };
  }, [formKey, previewRetry, form.scheduleType, form.scheduledAt, form.timezone, form.sessionId, messageReady, intervalReady, hasTargets, request]);

  function change(patch: Partial<CampaignForm>) {
    setForm(previous => ({ ...previous, ...patch }));
    setError("");
  }

  function choose(patch: Partial<CampaignForm>) {
    change(patch);
    setRosterPage(1);
  }

  function changeMode(mode: CampaignForm["audienceType"]) {
    if (mode === form.audienceType) return;
    if (mode === "GROUPS") {
      setSource("groups");
      choose({
        audienceType: mode,
        contactIds: [],
        segmentIds: [],
        groupIds: form.groupIds.filter(id => groups.some(g => g.id === id && g.sessionId === form.sessionId)),
      });
    } else if (mode === "BOTH") {
      setSource(form.groupIds.length ? "groups" : "segments");
      choose({
        audienceType: mode,
        groupIds: form.groupIds.filter(id => groups.some(g => g.id === id && g.sessionId === form.sessionId)),
      });
    } else {
      if (source === "groups" && form.audienceType === "GROUPS") setSource("segments");
      choose({ audienceType: mode });
    }
    setSearch("");
    setRosterSearch("");
    setPeoplePage(1);
  }

  function go(next: number) {
    setStep(next);
    bodyRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function insert(before: string, after = "") {
    const field = editor.current;
    if (!field) {
      change({ message: (form.message + before + after).slice(0, 4096) });
      return;
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = form.message.slice(start, end);
    const replacement = before + selected + after;
    if (form.message.length - selected.length + replacement.length > 4096) return;
    change({ message: form.message.slice(0, start) + replacement + form.message.slice(end) });
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  function applyTemplate(templateId: string) {
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) {
      change({ templateId: null });
      return;
    }
    setMediaFile(null);
    change({
      templateId: tpl.id,
      message: tpl.body,
      includeFooter: tpl.includeFooter,
      mediaKey: tpl.mediaKey || undefined,
      mediaMime: tpl.mediaMime || undefined,
      mediaName: tpl.mediaName || undefined,
      ...(!form.name.trim() ? { name: tpl.name } : {}),
    });
    setTplNotice(`Applied template “${tpl.name}”`);
  }

  async function saveCurrentAsTemplate() {
    if (!tplName.trim() || !form.message.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await request<{ id: string; name: string }>("/api/v1/templates", {
        method: "POST",
        body: {
          name: tplName.trim(),
          category: tplCategory.trim() || "General",
          body: form.message,
          includeFooter: form.includeFooter,
          mediaKey: form.mediaKey ?? null,
          mediaMime: form.mediaMime ?? null,
          mediaName: form.mediaName ?? null,
        },
      });
      change({ templateId: created.id });
      setSaveTplOpen(false);
      setTplName("");
      setTplNotice(`Saved “${created.name}” to Templates`);
      await onTemplatesChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save template");
    } finally {
      setBusy(false);
    }
  }

  async function enableGroupPosting(groupId: string) {
    try {
      await request("/api/v1/groups/" + groupId, { method: "PATCH", body: { allowPosting: true } });
      await onTemplatesChanged?.();
      setAudienceRetry(v => v + 1);
      setPreviewRetry(v => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enable group posting");
    }
  }

  async function clearHoldInline() {
    const accountKey = preview?.safety.hold?.accountKey || "workspace";
    setBusy(true);
    try {
      await request("/api/v1/safety/review", { method: "POST", body: { accountKey, confirmed: true, force: true } });
      await onTemplatesChanged?.();
      setPreviewRetry(v => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear sending hold");
    } finally {
      setBusy(false);
    }
  }

  async function save(launch: boolean, resumeMode = false) {
    if (savingRef.current || !draftReady || (launch && !launchReady && !resumeMode)) return;
    savingRef.current = true;
    setBusy(true);
    busyChanged(true);
    setError("");
    try {
      let attachment = {};
      if (mediaFile) {
        const upload = new FormData();
        upload.set("file", mediaFile);
        const response = await fetch("/api/v1/media", { method: "POST", body: upload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Attachment upload failed");
        attachment = result;
        setForm(previous => ({ ...previous, ...attachment }));
        setMediaFile(null);
      }
      const payload = {
        ...form,
        ...attachment,
        intervalHours: form.scheduleType === "CRON" && cronStyle === "interval" ? (form.intervalHours || 1) : null,
        scheduledAt: form.scheduleType === "ONCE" ? zonedDateTimeToIso(form.scheduledAt, form.timezone) : undefined,
      };
      const draft = await request<{ id: string }>(savedId ? "/api/v1/campaigns/" + savedId : "/api/v1/campaigns", {
        method: savedId ? "PATCH" : "POST",
        body: payload,
      });
      setSavedId(draft.id);
      if (launch) {
        try {
          await request("/api/v1/campaigns/" + draft.id + "/action", {
            method: "POST",
            body: { action: resumeMode ? "resume" : "launch" },
          });
        } catch (e) {
          throw new Error(`Saved as draft, but launch failed: ${e instanceof Error ? e.message : "Unknown error"}`);
        }
      }
      await saved(
        launch
          ? resumeMode
            ? "Campaign resumed for remaining recipients."
            : form.scheduleType === "NOW"
              ? "Campaign launched! Live delivery updates are streaming in Reports."
              : form.scheduleType === "CRON" && cronStyle === "interval"
                ? `Recurring campaign active (every ${form.intervalHours || 1}h).`
                : "Campaign scheduled."
          : "Campaign draft saved."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save campaign");
    } finally {
      savingRef.current = false;
      setBusy(false);
      busyChanged(false);
    }
  }

  const selectedNames = segments.filter(segment => form.segmentIds.includes(segment.id));
  const publicName = preview?.senderName || sender?.publicSenderName?.trim() || "";
  const placeholderPreview =
    form.audienceType === "GROUPS"
      ? form.message
      : campaignMessage(form.message, publicName, true, form.includeFooter);
  const previewText = personalize(preview?.messagePreview || placeholderPreview, {
    name: "Alex Morgan",
    phone: privatePreview ? null : "254700000000",
    groupName: "VIP Community",
  });

  const sessionGroups = groups.filter(group => group.sessionId === form.sessionId);
  const availableGroups = form.audienceType === "CONTACTS"
    ? groups.filter(group => group._count.members > 0)
    : sessionGroups;
  const selectedGroups = groups.filter(group => form.groupIds.includes(group.id));
  const invalidDestinationCount = audience?.exclusions.invalidDestination ?? audience?.exclusions.unusablePhone ?? 0;

  const sourceOptions =
    form.audienceType === "BOTH"
      ? ([
          { value: "groups", label: "Group chats (Post in group)", count: form.groupIds.length },
          { value: "segments", label: "DM Segments", count: form.segmentIds.length },
          { value: "contacts", label: "Individual DMs", count: form.contactIds.length },
        ] as const)
      : ([
          { value: "segments", label: "Segments", count: form.segmentIds.length },
          { value: "contacts", label: "Phonebook DMs", count: form.contactIds.length },
          { value: "groups", label: "Group members (DMs)", count: form.groupIds.length },
        ] as const);

  const continueIssue =
    step === 0
      ? !form.sessionId
        ? "Choose a sending WhatsApp session to continue."
        : !hasTargets
          ? "Select at least one segment, contact, or group."
          : audienceError
            ? "Retry the audience check to continue."
            : !audience
              ? "Resolving recipients…"
              : !audienceSelected
                ? "The selected sources do not have any recipients yet."
                : ""
      : step === 1
        ? form.name.trim().length < 3
          ? "Give your campaign a name (at least 3 characters)."
          : !form.message.trim()
            ? "Write a message or choose a template to continue."
            : ""
        : "";

  const launchIssue = !audienceReady
    ? "No active recipients in this selection (or exceeds limit). You can still save a draft."
    : !intervalReady
      ? "Choose a message gap between 1.5 and 3,600 seconds."
      : previewError ||
        preview?.scheduleIssue ||
        (!preview
          ? "Validating schedule and pacing…"
          : sender?.status !== "CONNECTED"
            ? "Connect this WhatsApp session in Sessions before launching (or save a draft now)."
            : sender.sendingHold?.reason || preview.safety.hold?.reason || "");

  const pageSelected = !!people?.items.length && people.items.every(person => form.contactIds.includes(person.id));
  const pageSelection = [...new Set([...form.contactIds, ...(people?.items.map(person => person.id) || [])])];
  const allGroupsSelected = availableGroups.length > 0 && availableGroups.every(g => form.groupIds.includes(g.id));

  return (
    <>
      <nav className="composer-steps" aria-label="Campaign steps">
        {["1. Destinations & audience", "2. Message & templates", "3. Schedule, repeat & launch"].map((label, index) => (
          <button
            type="button"
            key={label}
            aria-current={step === index ? "step" : undefined}
            disabled={busy || (index > step && ((index > 0 && !audienceSelected) || (index > 1 && !messageReady)))}
            onClick={() => go(index)}
          >
            <span>{index < step ? <Check size={15} aria-hidden="true"/> : index + 1}</span>
            <strong>{label}</strong>
          </button>
        ))}
      </nav>

      <div className="modal-body composer-body" ref={bodyRef}>
        <fieldset disabled={busy} className="composer-layout">
          <div className="composer-main">
            {step === 0 && (
              <>
                <div className="composer-heading">
                  <div className="eyebrow">01 / AUDIENCE & CHANNELS</div>
                  <h3 ref={heading} tabIndex={-1}>Choose where this campaign sends</h3>
                  <p>Send to contact segments, individual phonebook DMs, WhatsApp groups your session is in, or both simultaneously.</p>
                </div>

                <div>
                  <label htmlFor="composer-session">Sending WhatsApp session</label>
                  <select
                    id="composer-session"
                    value={form.sessionId}
                    onChange={e =>
                      choose({
                        sessionId: e.target.value,
                        ...(form.audienceType !== "CONTACTS"
                          ? { groupIds: form.groupIds.filter(id => groups.some(g => g.id === id && g.sessionId === e.target.value)) }
                          : {}),
                      })
                    }
                  >
                    <option value="">Choose a WhatsApp session</option>
                    {sessions.map(session => (
                      <option key={session.id} value={session.id}>
                        {session.label} · {session.status.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>

                {!sessions.length && (
                  <div className="notice danger">Add and link a WhatsApp session in Accounts first.</div>
                )}

                <div className={`pill-choice audience-mode ${styles.destinationChoice}`} role="group" aria-label="Campaign destination mode">
                  <button
                    type="button"
                    aria-pressed={form.audienceType === "CONTACTS"}
                    className={form.audienceType === "CONTACTS" ? "picked" : ""}
                    onClick={() => changeMode("CONTACTS")}
                  >
                    <Users size={17} aria-hidden="true"/>
                    <span>
                      <strong>Direct Messages (DMs)</strong>
                      <small>Segments, phonebook contacts & group members</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={form.audienceType === "GROUPS"}
                    className={form.audienceType === "GROUPS" ? "picked" : ""}
                    onClick={() => changeMode("GROUPS")}
                  >
                    <Send size={17} aria-hidden="true"/>
                    <span>
                      <strong>WhatsApp Groups</strong>
                      <small>Post inside groups this session belongs to</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={form.audienceType === "BOTH"}
                    className={form.audienceType === "BOTH" ? "picked" : ""}
                    onClick={() => changeMode("BOTH")}
                  >
                    <Layers size={17} aria-hidden="true"/>
                    <span>
                      <strong>Groups + DMs</strong>
                      <small>Post in groups AND send private DMs</small>
                    </span>
                  </button>
                </div>

                {form.audienceType !== "GROUPS" && (
                  <div className="source-tabs" role="group" aria-label="Audience source tabs">
                    {sourceOptions.map(option => (
                      <button
                        type="button"
                        key={option.value}
                        aria-pressed={source === option.value}
                        className={source === option.value ? "active" : ""}
                        onClick={() => { setSource(option.value); setSearch(""); setPeoplePage(1); }}
                      >
                        {option.label}
                        {option.count > 0 && <span className={styles.tabCount}>{option.count}</span>}
                      </button>
                    ))}
                  </div>
                )}

                <div className="search-box">
                  <Search size={16} aria-hidden="true"/>
                  <input
                    maxLength={120}
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-label="Search audience sources"
                    placeholder={
                      form.audienceType === "GROUPS" || source === "groups"
                        ? "Search WhatsApp groups…"
                        : source === "segments"
                          ? "Search segments…"
                          : "Search centralized phonebook by name, phone or ID…"
                    }
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPeoplePage(1); }}
                  />
                </div>

                {form.audienceType !== "GROUPS" && source === "segments" && (
                  <div className="source-list">
                    {segments
                      .filter(segment => segment.name.toLowerCase().includes(search.toLowerCase()))
                      .map(segment => (
                        <label className={`audience-card ${form.segmentIds.includes(segment.id) ? "selected" : ""}`} key={segment.id}>
                          <input
                            type="checkbox"
                            checked={form.segmentIds.includes(segment.id)}
                            onChange={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })}
                          />
                          <span>
                            <strong>{segment.name}</strong>
                            <small>{segment.description || "Combined phonebook & group contacts · deduplicated automatically"}</small>
                          </span>
                          <span className="audience-card-count">
                            <strong>{(segment.eligibleCount ?? segment._count.members).toLocaleString()}</strong>
                            <small>active contacts</small>
                          </span>
                        </label>
                      ))}
                    {!segments.length && (
                      <div className="composer-empty">
                        <Users size={26} aria-hidden="true"/>
                        <strong>No segments created yet</strong>
                        <p>Export group members to a segment from Groups, or select contacts directly in the Phonebook DMs tab.</p>
                        <button type="button" className="btn outline" onClick={() => { setSource("contacts"); setSearch(""); }}>
                          Browse Phonebook DMs
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {form.audienceType !== "GROUPS" && source === "contacts" && (
                  <>
                    <div className={styles.selectionToolbar}>
                      <span><strong>{form.contactIds.length.toLocaleString()}</strong> individual DMs selected</span>
                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        <select
                          aria-label="Filter contact identity"
                          value={identityFilter}
                          onChange={e => { setIdentityFilter(e.target.value as typeof identityFilter); setPeoplePage(1); }}
                          style={{ padding: "5px 9px", fontSize: 11 }}
                        >
                          <option value="all">All identities</option>
                          <option value="phone">With phone number</option>
                          <option value="private">Private @lid ID</option>
                        </select>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!people?.items.length || (!pageSelected && pageSelection.length > 50000)}
                          onClick={() =>
                            choose({
                              contactIds: pageSelected
                                ? form.contactIds.filter(id => !people?.items.some(person => person.id === id))
                                : pageSelection,
                            })
                          }
                        >
                          {pageSelected ? "Deselect" : "Select"} page ({people?.items.length || 0})
                        </button>
                      </div>
                    </div>

                    {peopleError && (
                      <div className={`notice danger ${styles.retryNotice}`} role="alert">
                        <span>{peopleError}</span>
                        <button type="button" className="text-button" onClick={() => { setPeopleFailure(null); setPeopleRetry(v => v + 1); }}>
                          <RefreshCw size={13} aria-hidden="true"/> Retry
                        </button>
                      </div>
                    )}
                    {!people && !peopleError && (
                      <p className={styles.loading}><LoaderCircle size={15} className="spin" aria-hidden="true"/> Loading phonebook…</p>
                    )}

                    <div className={`selection-grid scroll-selection ${styles.contactChoices}`}>
                      {people?.items.map(person => (
                        <label
                          className={`check-item ${form.contactIds.includes(person.id) ? styles.checkedContact : ""}`}
                          key={person.id}
                        >
                          <input
                            type="checkbox"
                            disabled={person.consent === "OPTED_OUT" || (!form.contactIds.includes(person.id) && form.contactIds.length >= 50000)}
                            checked={form.contactIds.includes(person.id)}
                            onChange={() => choose({ contactIds: toggle(form.contactIds, person.id) })}
                          />
                          <span>
                            <strong>{person.name || person.phone || "WhatsApp Contact"}</strong>
                            <small className="check-description">{person.phone ? "+" + person.phone : person.whatsappId}</small>
                            {person.consent === "OPTED_OUT" && (
                              <small className="tiny-error" style={{ margin: "3px 0 0", display: "block" }}>Opted out · suppressed</small>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>

                    {people && people.total > 0 && (
                      <div className="table-footer">
                        <span>{people.total.toLocaleString()} contacts in phonebook</span>
                        <div className="pager">
                          <button type="button" aria-label="Previous contacts page" disabled={peoplePage <= 1} onClick={() => setPeoplePage(p => p - 1)}>
                            <ArrowLeft size={15} aria-hidden="true"/>
                          </button>
                          <span>{peoplePage} / {Math.max(1, Math.ceil(people.total / 40))}</span>
                          <button type="button" aria-label="Next contacts page" disabled={peoplePage * 40 >= people.total} onClick={() => setPeoplePage(p => p + 1)}>
                            <ArrowRight size={15} aria-hidden="true"/>
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {(form.audienceType === "GROUPS" || source === "groups") && (
                  <>
                    <div className={styles.selectionToolbar}>
                      <span>
                        {form.audienceType === "CONTACTS"
                          ? "Send private DMs to saved members of selected groups"
                          : `Groups belonging to ${sender?.label || "selected session"}`}
                      </span>
                      {availableGroups.length > 0 && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            choose({
                              groupIds: allGroupsSelected
                                ? form.groupIds.filter(id => !availableGroups.some(g => g.id === id))
                                : [...new Set([...form.groupIds, ...availableGroups.map(g => g.id)])],
                            })
                          }
                        >
                          {allGroupsSelected ? "Deselect all" : `Select all (${availableGroups.length})`}
                        </button>
                      )}
                    </div>

                    <div className="source-list">
                      {availableGroups
                        .filter(group => group.name.toLowerCase().includes(search.toLowerCase()))
                        .map(group => (
                          <div className={`audience-card ${form.groupIds.includes(group.id) ? "selected" : ""}`} key={group.id}>
                            <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 12, flex: 1, cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={form.groupIds.includes(group.id)}
                                onChange={() => choose({ groupIds: toggle(form.groupIds, group.id) })}
                              />
                              <span>
                                <strong>{group.name}</strong>
                                <small>
                                  {form.audienceType === "CONTACTS"
                                    ? `${group._count.members.toLocaleString()} saved members · ${group.session.label}`
                                    : `${group.participantCount ?? group._count.members} participants · ${group.allowPosting ? "Ready to post" : "Posting paused"}`}
                                </small>
                              </span>
                            </label>
                            {form.audienceType !== "CONTACTS" && !group.allowPosting && (
                              <button type="button" className="btn mini-primary" onClick={() => void enableGroupPosting(group.id)}>
                                Enable posting
                              </button>
                            )}
                          </div>
                        ))}
                      {!availableGroups.length && (
                        <div className="composer-empty">
                          <Users size={25} aria-hidden="true"/>
                          <strong>
                            {form.sessionId ? "No groups found for this session" : "Select a sending session above"}
                          </strong>
                          <p>Sync your connected WhatsApp session in Accounts to load all groups you belong to.</p>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {step === 1 && (
              <>
                <div className="composer-heading">
                  <div className="eyebrow">02 / MESSAGE & TEMPLATES</div>
                  <h3 ref={heading} tabIndex={-1}>Compose or pick a custom template</h3>
                  <p>Load any saved template in one click, personalize with variables, or save your message as a new reusable template.</p>
                </div>

                <div className="form-grid">
                  <div>
                    <label htmlFor="campaign-name">Campaign name</label>
                    <input
                      id="campaign-name"
                      minLength={3}
                      maxLength={100}
                      value={form.name}
                      placeholder="e.g. Afternoon Group Broadcast"
                      onChange={e => change({ name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor="campaign-template-select"><Sparkles size={13} style={{ display: "inline", marginRight: 4 }} aria-hidden="true"/> Load custom template</label>
                    <select
                      id="campaign-template-select"
                      value={form.templateId || ""}
                      onChange={e => applyTemplate(e.target.value)}
                    >
                      <option value="">— Write custom / choose template —</option>
                      {templates.map(tpl => (
                        <option key={tpl.id} value={tpl.id}>
                          [{tpl.category}] {tpl.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {tplNotice && <p className={styles.consentSuccess} role="status">{tplNotice}</p>}

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label htmlFor="campaign-message">Message body</label>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!form.message.trim()}
                      onClick={() => {
                        setSaveTplOpen(v => !v);
                        if (!tplName && form.name) setTplName(form.name);
                      }}
                    >
                      <BookmarkPlus size={14} aria-hidden="true"/> Save as reusable template
                    </button>
                  </div>

                  {saveTplOpen && (
                    <div className="inline-template-save">
                      <input
                        aria-label="New template name"
                        placeholder="Template name (e.g. Daily Offer)"
                        value={tplName}
                        maxLength={100}
                        onChange={e => setTplName(e.target.value)}
                      />
                      <input
                        aria-label="Template category"
                        placeholder="Category"
                        value={tplCategory}
                        maxLength={40}
                        onChange={e => setTplCategory(e.target.value)}
                        style={{ maxWidth: 140 }}
                      />
                      <button type="button" className="btn mini-primary" disabled={!tplName.trim() || busy} onClick={() => void saveCurrentAsTemplate()}>
                        Save
                      </button>
                      <button type="button" className="btn outline" onClick={() => setSaveTplOpen(false)}>
                        Cancel
                      </button>
                    </div>
                  )}

                  <div className="message-editor" style={{ marginTop: 4 }}>
                    <div className="editor-toolbar">
                      {[
                        { label: "Bold", marker: "*", icon: Bold },
                        { label: "Italic", marker: "_", icon: Italic },
                        { label: "Strikethrough", marker: "~", icon: Strikethrough },
                        { label: "Code", marker: "`", icon: Code2 },
                      ].map(tool => (
                        <button type="button" key={tool.label} aria-label={tool.label} onClick={() => insert(tool.marker, tool.marker)}>
                          <tool.icon size={15} aria-hidden="true"/>
                        </button>
                      ))}
                      <span>WhatsApp formatting</span>
                    </div>
                    <textarea
                      id="campaign-message"
                      ref={editor}
                      rows={9}
                      maxLength={4096}
                      value={form.message}
                      placeholder="Hi {{first_name}}, here is today's update…"
                      onChange={e => change({ message: e.target.value })}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing) return;
                        if ((e.ctrlKey || e.metaKey) && ["b", "i"].includes(e.key)) {
                          e.preventDefault();
                          insert(e.key === "b" ? "*" : "_", e.key === "b" ? "*" : "_");
                        }
                      }}
                    />
                    <div className="editor-bottom">
                      <span>Select text or click variables below</span>
                      <span>{form.message.length.toLocaleString()} / 4,096</span>
                    </div>
                  </div>
                </div>

                <div className="personalize-tools">
                  <span>Personalize:</span>
                  {["first_name", "name", "phone", "group_name", "date"].map(token => (
                    <button type="button" className="token-button" key={token} onClick={() => insert("{{" + token + "}}")}>
                      {"{{" + token + "}}"}
                    </button>
                  ))}
                </div>

                {form.audienceType !== "GROUPS" && (
                  <label className="check-item" htmlFor="campaign-include-footer">
                    <input
                      id="campaign-include-footer"
                      type="checkbox"
                      checked={form.includeFooter}
                      onChange={e => change({ includeFooter: e.target.checked })}
                    />
                    <span>
                      <strong>Append sender signature & “Reply STOP to unsubscribe” footer on DMs</strong>
                      <small className="check-description">
                        Optional. Leave unchecked to send your exact template text{publicName ? ` (Sender if enabled: ${publicName})` : ""}. Inbound STOP replies always opt out automatically either way.
                      </small>
                    </span>
                  </label>
                )}

                <label className="attachment-picker" htmlFor="campaign-attachment">
                  <Paperclip size={18} aria-hidden="true"/>
                  <span>
                    <strong>{mediaFile?.name || form.mediaName || "Attach image or PDF (optional)"}</strong>
                    <small>JPEG, PNG, WebP or PDF · up to 8 MB</small>
                  </span>
                  <input
                    id="campaign-attachment"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (
                        file &&
                        (!file.size || file.size > 8 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type))
                      ) {
                        setError("Choose a JPEG, PNG, WebP or PDF up to 8 MB.");
                        e.target.value = "";
                        return;
                      }
                      setMediaFile(file || null);
                      setError("");
                    }}
                  />
                </label>
                {(mediaFile || form.mediaKey) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => { setMediaFile(null); change({ mediaKey: undefined, mediaMime: undefined, mediaName: undefined }); }}
                  >
                    Remove attachment
                  </button>
                )}
              </>
            )}

            {step === 2 && (
              <>
                <div className="composer-heading">
                  <div className="eyebrow">03 / SCHEDULE, REPEAT RULES & LAUNCH</div>
                  <h3 ref={heading} tabIndex={-1}>Configure timing, repeat policy & launch</h3>
                  <p>Choose instant, scheduled, or hourly interval crons (1h, 2h, 3h, 4h, 5h, 6h…) and control whether standby/recurring campaigns repeat recipients.</p>
                </div>

                <div className={styles.deliveryHeading}>
                  <Clock3 size={17} aria-hidden="true"/>
                  <h4>1. When should this campaign run?</h4>
                </div>

                <div className={`pill-choice ${styles.scheduleChoice}`} role="group" aria-label="Campaign schedule mode">
                  {([
                    { value: "NOW", label: "Send now", description: "Start immediately on launch" },
                    { value: "ONCE", label: "Schedule once", description: "Run at a specific date & time" },
                    { value: "CRON", label: "Recurring / Interval Cron", description: "Every 1h, 2h, 3h, 4h, 6h or daily" },
                  ] as const).map(option => (
                    <button
                      type="button"
                      key={option.value}
                      aria-pressed={form.scheduleType === option.value}
                      className={form.scheduleType === option.value ? "picked" : ""}
                      onClick={() =>
                        change({
                          scheduleType: option.value,
                          ...(option.value === "CRON" && cronStyle === "interval" && !form.intervalHours ? { intervalHours: 3 } : {}),
                        })
                      }
                    >
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  ))}
                </div>

                {form.scheduleType === "ONCE" && (
                  <div className="form-grid">
                    <div>
                      <label htmlFor="composer-scheduled-at">Send date and time</label>
                      <input
                        id="composer-scheduled-at"
                        type="datetime-local"
                        value={form.scheduledAt}
                        onChange={e => change({ scheduledAt: e.target.value })}
                      />
                    </div>
                    <div>
                      <label htmlFor="composer-tz-once">Timezone</label>
                      <input
                        id="composer-tz-once"
                        list="campaign-timezones"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        value={form.timezone}
                        onChange={e => change({ timezone: e.target.value })}
                      />
                    </div>
                  </div>
                )}

                {form.scheduleType === "CRON" && (
                  <div className="cron-studio-box">
                    <div className="pill-choice" role="group" aria-label="Recurring schedule type">
                      <button
                        type="button"
                        aria-pressed={cronStyle === "interval"}
                        className={cronStyle === "interval" ? "picked" : ""}
                        onClick={() => { setCronStyle("interval"); change({ intervalHours: form.intervalHours || 3 }); }}
                      >
                        <Repeat size={14} aria-hidden="true"/> Fixed Hour Interval (1h, 2h, 3h, 4h, 5h, 6h…)
                      </button>
                      <button
                        type="button"
                        aria-pressed={cronStyle === "calendar"}
                        className={cronStyle === "calendar" ? "picked" : ""}
                        onClick={() => { setCronStyle("calendar"); change({ intervalHours: null }); }}
                      >
                        <CalendarClock size={14} aria-hidden="true"/> Calendar Cron
                      </button>
                    </div>

                    {cronStyle === "interval" ? (
                      <>
                        <div className="hour-pills" role="group" aria-label="Hour interval presets">
                          {HOUR_INTERVAL_PRESETS.map(hours => (
                            <button
                              type="button"
                              key={hours}
                              aria-pressed={form.intervalHours === hours}
                              className={`day-pill ${form.intervalHours === hours ? "active" : ""}`}
                              onClick={() => change({ intervalHours: hours })}
                            >
                              Every {hours}h
                            </button>
                          ))}
                        </div>
                        <div className="form-grid">
                          <div>
                            <label htmlFor="composer-interval-hours">Custom interval (hours)</label>
                            <input
                              id="composer-interval-hours"
                              type="number"
                              min={1}
                              max={720}
                              step={1}
                              value={form.intervalHours ?? 3}
                              onChange={e => change({ intervalHours: Math.max(1, Math.min(720, Math.round(Number(e.target.value) || 1))) })}
                            />
                          </div>
                          <div>
                            <label htmlFor="composer-tz-cron">Timezone</label>
                            <input
                              id="composer-tz-cron"
                              list="campaign-timezones"
                              autoCorrect="off"
                              autoCapitalize="off"
                              spellCheck={false}
                              value={form.timezone}
                              onChange={e => change({ timezone: e.target.value })}
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="form-grid">
                        <div>
                          <label htmlFor="composer-cron-preset">Calendar preset</label>
                          <select
                            id="composer-cron-preset"
                            value={["0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 */4 * * *"].includes(form.cron) ? form.cron : "custom"}
                            onChange={e => change({ cron: e.target.value === "custom" ? "0 10 * * *" : e.target.value })}
                          >
                            <option value="0 9 * * *">Every day at 09:00</option>
                            <option value="0 9 * * 1-5">Weekdays at 09:00</option>
                            <option value="0 9 * * 1">Every Monday at 09:00</option>
                            <option value="0 */4 * * *">Every 4th clock hour (00:00, 04:00…)</option>
                            <option value="custom">Custom 5-field cron…</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="composer-cron-expr">Cron expression</label>
                          <input
                            id="composer-cron-expr"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            value={form.cron}
                            onChange={e => change({ cron: e.target.value })}
                          />
                        </div>
                      </div>
                    )}

                    <label className="check-item" htmlFor="composer-run-immediately">
                      <input
                        id="composer-run-immediately"
                        type="checkbox"
                        checked={form.runImmediately}
                        onChange={e => change({ runImmediately: e.target.checked })}
                      />
                      <span>
                        <strong>Send first run immediately upon launch</strong>
                        <small className="check-description">Then automatically repeat on every scheduled interval.</small>
                      </span>
                    </label>
                  </div>
                )}

                <datalist id="campaign-timezones">
                  {["Africa/Nairobi", "UTC", "Europe/London", "America/New_York", "Asia/Dubai", "Africa/Lagos"].map(zone => (
                    <option key={zone} value={zone}/>
                  ))}
                </datalist>

                <div className={styles.deliveryHeading}>
                  <Repeat size={17} aria-hidden="true"/>
                  <h4>2. Repeat & standby campaign behavior</h4>
                </div>

                <div className={`pill-choice ${styles.scheduleChoice}`} role="group" aria-label="Recipient repeat rule">
                  {([
                    {
                      value: "ALLOW_REPEAT",
                      label: "Allow repeats",
                      description: "Send every run, even if messaged by other campaigns",
                    },
                    {
                      value: "NO_REPEAT",
                      label: "Do not repeat",
                      description: "Skip anyone already messaged by a standby/prior campaign",
                    },
                    {
                      value: "COOLDOWN",
                      label: "Cooldown window",
                      description: "Skip if messaged within N hours",
                    },
                  ] as const).map(opt => (
                    <button
                      type="button"
                      key={opt.value}
                      aria-pressed={form.repeatPolicy === opt.value}
                      className={form.repeatPolicy === opt.value ? "picked" : ""}
                      onClick={() =>
                        change({
                          repeatPolicy: opt.value,
                          ...(opt.value === "COOLDOWN" && !form.repeatCooldownHours ? { repeatCooldownHours: 24 } : {}),
                        })
                      }
                    >
                      <span>
                        <strong>{opt.label}</strong>
                        <small>{opt.description}</small>
                      </span>
                    </button>
                  ))}
                </div>

                {form.repeatPolicy === "COOLDOWN" && (
                  <div className="form-grid">
                    <div>
                      <label htmlFor="composer-cooldown-hours">Skip if messaged within (hours)</label>
                      <input
                        id="composer-cooldown-hours"
                        type="number"
                        min={0.5}
                        max={8760}
                        step={0.5}
                        value={form.repeatCooldownHours || 24}
                        onChange={e => change({ repeatCooldownHours: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, flexWrap: "wrap" }}>
                      {[6, 12, 24, 72, 168].map(h => (
                        <button
                          type="button"
                          key={h}
                          className={`day-pill ${form.repeatCooldownHours === h ? "active" : ""}`}
                          onClick={() => change({ repeatCooldownHours: h })}
                        >
                          {h}h
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="composer-gap-sec">Minimum seconds between messages in this campaign</label>
                  <input
                    id="composer-gap-sec"
                    type="number"
                    min={1.5}
                    max={3600}
                    step={0.5}
                    value={Number.isFinite(form.sendIntervalMs) ? form.sendIntervalMs / 1000 : ""}
                    onChange={e => change({ sendIntervalMs: e.target.value === "" ? 0 : Math.round(Number(e.target.value) * 1000) })}
                  />
                  <small className="field-hint">Workspace pacing rules (e.g. 3 or 10 messages / 15 min + jitter) also protect your session automatically.</small>
                </div>

                <div className="delivery-plan" aria-live="polite">
                  {preview ? (
                    <>
                      <strong>
                        {preview.count.toLocaleString()}{" "}
                        {form.audienceType === "GROUPS" ? "groups" : form.audienceType === "BOTH" ? "groups & DMs" : "recipients"} · ~
                        {Math.max(1, Math.ceil(preview.durationMs / 60000)).toLocaleString()} min minimum run time
                      </strong>
                      <div className={styles.policyDetails}>
                        <span>Operating hours</span>
                        <strong>
                          {preview.safety.policy.alwaysOpen
                            ? `24/7 (All day, every day) · ${preview.safety.policy.timezone}`
                            : `${String(preview.safety.policy.startHour).padStart(2, "0")}:00–${String(preview.safety.policy.endHour).padStart(2, "0")}:00 · ${preview.safety.policy.timezone}`}
                        </strong>
                        <span>Account rate caps</span>
                        <strong>
                          {preview.safety.policy.maxPer15Minutes ?? "—"}/15m · {preview.safety.policy.maxPerHour.toLocaleString()}/hr · {preview.safety.policy.maxPerDay.toLocaleString()}/24h
                        </strong>
                        <span>Repeat rule</span>
                        <strong>
                          {form.repeatPolicy === "ALLOW_REPEAT"
                            ? "Send every run (Allow repeat)"
                            : form.repeatPolicy === "NO_REPEAT"
                              ? "Never repeat prior recipients"
                              : `${form.repeatCooldownHours}h cooldown`}
                        </strong>
                      </div>
                      {preview.safety.frequencyLimited > 0 && form.repeatPolicy !== "ALLOW_REPEAT" && (
                        <p className={styles.cooldownNote}>
                          {preview.safety.frequencyLimited.toLocaleString()} recipient(s) were already messaged and will be skipped under your {form.repeatPolicy === "NO_REPEAT" ? "Do-not-repeat" : "cooldown"} rule.
                        </p>
                      )}
                      {form.scheduleType !== "NOW" && preview.nextRuns.length > 0 && (
                        <>
                          <strong>Upcoming scheduled runs ({form.timezone})</strong>
                          <ol>
                            {preview.nextRuns.slice(0, 3).map(date => (
                              <li key={date}>
                                {new Date(date).toLocaleString("en-KE", { timeZone: form.timezone, dateStyle: "medium", timeStyle: "short" })}
                              </li>
                            ))}
                          </ol>
                        </>
                      )}
                      {preview.scheduleIssue && <div className="notice danger">{preview.scheduleIssue}</div>}
                    </>
                  ) : previewError ? (
                    <div className={styles.retryNotice}>
                      <span>{previewError}</span>
                      <button type="button" className="text-button" onClick={() => { setPreviewFailure(null); setPreviewRetry(v => v + 1); }}>
                        <RefreshCw size={13} aria-hidden="true"/> Retry check
                      </button>
                    </div>
                  ) : (
                    <p className={styles.loading}>
                      <LoaderCircle size={15} className="spin" aria-hidden="true"/>
                      {intervalReady ? "Calculating delivery plan…" : "Choose an interval from 1.5 to 3,600 seconds."}
                    </p>
                  )}
                </div>

                {(preview?.safety.hold || sender?.sendingHold) && (
                  <div className="notice danger" role="alert" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <span>Paused: {preview?.safety.hold?.reason || sender?.sendingHold?.reason}</span>
                    <button type="button" className="btn mini-primary" disabled={busy} onClick={() => void clearHoldInline()}>
                      Clear hold now
                    </button>
                  </div>
                )}

                {sender?.status !== "CONNECTED" && (
                  <div className="notice danger">Connect this WhatsApp session before launching (or save as draft).</div>
                )}

                {canContinue && (
                  <div className="notice" role="status" style={{ marginTop: 8 }}>
                    <strong>In-progress run ({sentCount.toLocaleString()} already sent)</strong>
                    <p>Click <strong>Continue campaign</strong> to finish unattempted recipients, or check below to start a brand-new full run.</p>
                    <label className="check-item" style={{ marginTop: 8 }} htmlFor="composer-restart-all">
                      <input id="composer-restart-all" type="checkbox" checked={restartAll} onChange={e => setRestartAll(e.target.checked)}/>
                      <span>Start a brand-new run for all {audience?.count.toLocaleString() ?? "selected"} destinations</span>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          <aside className="composer-aside">
            <section className="audience-summary" aria-label="Selected campaign audience">
              <div className="summary-label"><ShieldCheck size={16} aria-hidden="true"/> READY DESTINATIONS</div>
              <div className="summary-number" aria-live="polite">
                {!hasTargets ? "0" : audience ? audience.count.toLocaleString() : "…"}
              </div>
              <strong>
                {form.audienceType === "GROUPS"
                  ? "WhatsApp groups ready"
                  : form.audienceType === "BOTH"
                    ? "total groups + DM contacts"
                    : "unique DM contacts ready"}
              </strong>
              <p>
                {form.audienceType === "GROUPS"
                  ? "One message posted in each selected group per run."
                  : form.audienceType === "BOTH"
                    ? "Posts in selected groups AND sends deduplicated DMs."
                    : "Automatically deduplicated across segments, phonebooks & groups."}
              </p>

              {hasTargets && (
                <div className={styles.selectedHeading}>
                  <span>Selected sources</span>
                  <button type="button" className="text-button" onClick={() => choose({ segmentIds: [], contactIds: [], groupIds: [] })}>
                    Clear all
                  </button>
                </div>
              )}

              <div className="selected-sources">
                {selectedNames.map(segment => (
                  <button type="button" key={segment.id} onClick={() => choose({ segmentIds: toggle(form.segmentIds, segment.id) })} aria-label={"Remove segment " + segment.name}>
                    {segment.name}<X size={12} aria-hidden="true"/>
                  </button>
                ))}
                {form.contactIds.length > 0 && (
                  <button type="button" onClick={() => choose({ contactIds: [] })} aria-label="Remove individually selected contacts">
                    {form.contactIds.length.toLocaleString()} DMs<X size={12} aria-hidden="true"/>
                  </button>
                )}
                {selectedGroups.map(group => (
                  <button type="button" key={group.id} onClick={() => choose({ groupIds: toggle(form.groupIds, group.id) })} aria-label={"Remove group " + group.name}>
                    {group.name}{form.audienceType === "CONTACTS" ? " (members)" : ""}<X size={12} aria-hidden="true"/>
                  </button>
                ))}
              </div>

              {audience && (
                <>
                  <div className="summary-line"><span>Total records matched</span><strong>{audience.total.toLocaleString()}</strong></div>
                  <div className="summary-line"><span>Duplicates merged</span><strong>{audience.duplicates.toLocaleString()}</strong></div>
                  <div className="summary-line"><span>Suppressed / excluded</span><strong>{audience.excluded.toLocaleString()}</strong></div>
                  {audience.excluded > 0 && (
                    <details className="exclusion-details">
                      <summary>Exclusion breakdown</summary>
                      {audience.exclusions.optedOut > 0 && <p>{audience.exclusions.optedOut.toLocaleString()} opted out (STOP)</p>}
                      {invalidDestinationCount > 0 && <p>{invalidDestinationCount.toLocaleString()} invalid WhatsApp IDs</p>}
                      {audience.exclusions.unauthorizedGroups > 0 && <p>{audience.exclusions.unauthorizedGroups.toLocaleString()} groups with posting disabled</p>}
                    </details>
                  )}
                </>
              )}

              {audienceError && (
                <div className={`notice danger ${styles.retryNotice}`} role="alert">
                  <span>{audienceError}</span>
                  <button type="button" className="text-button" onClick={() => { setAudienceFailure(null); setAudienceRetry(v => v + 1); }}>
                    <RefreshCw size={13} aria-hidden="true"/> Retry
                  </button>
                </div>
              )}
            </section>

            {step > 0 && (
              <section className="phone-preview">
                <div className="phone-preview-header">
                  <span className="person-avatar">W</span>
                  <div>
                    <strong>{sender?.label || "WhatsApp Preview"}</strong>
                    <small>Live rendered preview</small>
                  </div>
                </div>
                {form.audienceType !== "GROUPS" && (
                  <div className={styles.previewControls}>
                    <button type="button" aria-pressed={!privatePreview} onClick={() => setPrivatePreview(false)}>With phone</button>
                    <button type="button" aria-pressed={privatePreview} onClick={() => setPrivatePreview(true)}>Hidden phone (@lid)</button>
                  </div>
                )}
                <div className="phone-preview-chat">
                  <div className="chat-bubble">
                    {(mediaFile || form.mediaName) && (
                      <div className="preview-attachment">
                        <FileText size={19} aria-hidden="true"/>
                        {mediaFile?.name || form.mediaName}
                      </div>
                    )}
                    <MessageText text={previewText || "Your message preview appears here…"}/>
                    <span className="bubble-time">09:41 <CheckCheck size={14} aria-hidden="true"/></span>
                  </div>
                </div>
              </section>
            )}
          </aside>
        </fieldset>

        {hasTargets && (
          <details className="included-recipients" open={rosterOpen} onToggle={event => setRosterOpen(event.currentTarget.open)}>
            <summary>Inspect resolved recipients {audience ? `(${audience.count.toLocaleString()})` : ""}</summary>
            <div className="search-box">
              <Search size={15} aria-hidden="true"/>
              <input
                disabled={busy}
                maxLength={120}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label="Search resolved recipients"
                placeholder="Search name, phone, group or source…"
                value={rosterSearch}
                onChange={e => { setRosterSearch(e.target.value); setRosterPage(1); }}
              />
            </div>
            {rosterError ? (
              <div className={`notice danger ${styles.retryNotice}`}>
                <span>{rosterError}</span>
                <button type="button" disabled={busy} className="text-button" onClick={() => { setRosterFailure(null); setRosterRetry(v => v + 1); }}>
                  <RefreshCw size={13} aria-hidden="true"/> Retry
                </button>
              </div>
            ) : roster ? (
              <>
                <div className="recipient-roster-list">
                  {roster.items.map(person => (
                    <div className="recipient-roster-entry" key={person.key}>
                      <Check size={15} aria-hidden="true"/>
                      <div className="recipient-roster-identity">
                        <strong>{person.label}</strong>
                        <small>{[person.phone ? "+" + person.phone : person.chatId.endsWith("@g.us") ? "WhatsApp Group" : "Saved WhatsApp ID", ...person.sources].join(" · ")}</small>
                      </div>
                    </div>
                  ))}
                  {!roster.items.length && <p className="modal-help" style={{ padding: 12 }}>No recipients match this search.</p>}
                </div>
                <div className="table-footer">
                  <span>{roster.matched.toLocaleString()} matching destinations</span>
                  <div className="pager">
                    <button type="button" disabled={busy || rosterPage <= 1} aria-label="Previous recipients page" onClick={() => setRosterPage(p => p - 1)}>
                      <ArrowLeft size={15} aria-hidden="true"/>
                    </button>
                    <span>{rosterPage} / {Math.max(1, Math.ceil(roster.matched / 10))}</span>
                    <button type="button" disabled={busy || rosterPage * 10 >= roster.matched} aria-label="Next recipients page" onClick={() => setRosterPage(p => p + 1)}>
                      <ArrowRight size={15} aria-hidden="true"/>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p className={styles.loading}><LoaderCircle size={15} className="spin" aria-hidden="true"/> Resolving recipients…</p>
            )}
          </details>
        )}

        {error && <div className="notice danger" role="alert">{error}</div>}
        {(continueIssue || (step === 2 && launchIssue)) && (
          <p className={styles.nextHint} role="status">
            <Info size={15} aria-hidden="true"/>
            {continueIssue || launchIssue}
          </p>
        )}
      </div>

      <div className="modal-actions composer-actions">
        <span className="composer-progress">Step {step + 1} of 3</span>
        <button type="button" className="btn outline" disabled={busy} onClick={() => (step ? go(step - 1) : close())}>
          {step ? "Back" : "Cancel"}
        </button>
        {step < 2 ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy || (step === 0 ? !audienceSelected : !messageReady)}
            onClick={() => go(step + 1)}
          >
            {step === 0 ? "Next: Message & Template" : "Next: Schedule & Launch"} <ArrowRight size={16} aria-hidden="true"/>
          </button>
        ) : (
          <>
            <button type="button" className="btn outline" disabled={busy || !draftReady} onClick={() => void save(false)}>
              {busy ? <LoaderCircle className="spin" size={15} aria-hidden="true"/> : <Check size={15} aria-hidden="true"/>} Save draft
            </button>
            {canContinue && !restartAll ? (
              <button type="button" className="btn primary" disabled={busy || !launchReady} onClick={() => void save(true, true)}>
                {busy ? <LoaderCircle className="spin" size={15} aria-hidden="true"/> : <Play size={15} aria-hidden="true"/>} Continue campaign
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={busy || !launchReady} onClick={() => void save(true, false)}>
                {busy ? <LoaderCircle className="spin" size={15} aria-hidden="true"/> : <Send size={15} aria-hidden="true"/>}{" "}
                {form.scheduleType === "NOW" ? (hasHistory ? "Launch new run" : "Launch now") : "Activate schedule"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
