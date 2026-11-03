"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, LoaderCircle, Play, ShieldCheck, SlidersHorizontal, Square } from "lucide-react";
import type { SendingPolicy } from "@/lib/sending-policy";

type Safety = {
  policy: SendingPolicy;
  holds: { accountKey: string; reason: string; notBefore: string | null; canReview: boolean }[];
  recoveries: { accountKey: string; until: string; reason: string; attempt: number }[];
  used: { last15Minutes: number; lastHour: number; lastDay: number };
  nextSlot: string;
};
type Request = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;

const DAY_LABELS = [
  { day: 0, short: "Sun", full: "Sunday" },
  { day: 1, short: "Mon", full: "Monday" },
  { day: 2, short: "Tue", full: "Tuesday" },
  { day: 3, short: "Wed", full: "Wednesday" },
  { day: 4, short: "Thu", full: "Thursday" },
  { day: 5, short: "Fri", full: "Friday" },
  { day: 6, short: "Sat", full: "Saturday" },
];

type DraftSettings = {
  alwaysOpen: boolean;
  startHour: number;
  endHour: number;
  activeDays: number[];
  timezone: string;
  maxPer15Minutes: number;
  maxPerHour: number;
  maxPerDay: number;
  minimumIntervalSec: number;
  jitterSec: number;
  contactCooldownHours: number;
  autoHoldOnQuality: boolean;
  businessName: string;
};

function policyToDraft(policy: SendingPolicy): DraftSettings {
  return {
    alwaysOpen: policy.alwaysOpen,
    startHour: policy.startHour,
    endHour: policy.endHour,
    activeDays: policy.activeDays?.length ? policy.activeDays : [0, 1, 2, 3, 4, 5, 6],
    timezone: policy.timezone,
    maxPer15Minutes: policy.maxPer15Minutes,
    maxPerHour: policy.maxPerHour,
    maxPerDay: policy.maxPerDay,
    minimumIntervalSec: Math.round((policy.minimumIntervalMs / 1000) * 10) / 10,
    jitterSec: Math.round(((policy.jitterMs ?? 15000) / 1000) * 10) / 10,
    contactCooldownHours: Math.round((policy.contactCooldownMs / 3600000) * 10) / 10,
    autoHoldOnQuality: Boolean(policy.autoHoldOnQuality),
    businessName: policy.businessName || "",
  };
}

export default function SendingSafety({ request, changed }: { request: Request; changed: () => Promise<void> }) {
  const [safety, setSafety] = useState<Safety | null>(null);
  const [draft, setDraft] = useState<DraftSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (syncDraft = false) => {
    const data = await request<Safety>("/api/v1/safety");
    setSafety(data);
    setDraft(prev => (!prev || syncDraft ? policyToDraft(data.policy) : prev));
  }, [request]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void request<Safety>("/api/v1/safety")
        .then(data => {
          if (!alive) return;
          setSafety(data);
          setDraft(prev => prev ?? policyToDraft(data.policy));
        })
        .catch(err => {
          if (alive) setError(err instanceof Error ? err.message : "Could not load sending controls");
        });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [request]);

  function patchDraft(patch: Partial<DraftSettings>) {
    setDraft(prev => prev ? { ...prev, ...patch } : prev);
    setDirty(true);
    setError("");
    setNotice("");
  }

  function toggleDay(day: number) {
    if (!draft) return;
    const has = draft.activeDays.includes(day);
    if (has && draft.activeDays.length === 1) return;
    const next = has ? draft.activeDays.filter(d => d !== day) : [...draft.activeDays, day].sort((a, b) => a - b);
    patchDraft({ activeDays: next });
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/api/v1/safety", {
        method: "PATCH",
        body: {
          alwaysOpen: draft.alwaysOpen,
          startHour: draft.startHour,
          endHour: draft.endHour,
          activeDays: draft.activeDays,
          timezone: draft.timezone.trim() || "UTC",
          maxPer15Minutes: draft.maxPer15Minutes,
          maxPerHour: draft.maxPerHour,
          maxPerDay: draft.maxPerDay,
          minimumIntervalMs: Math.round(draft.minimumIntervalSec * 1000),
          jitterMs: Math.round(draft.jitterSec * 1000),
          contactCooldownHours: draft.contactCooldownHours,
          autoHoldOnQuality: draft.autoHoldOnQuality,
          businessName: (draft.businessName || "").trim(),
        },
      });
      setDirty(false);
      await Promise.all([load(true), changed()]);
      setNotice("Operating hours and sending rules saved. Active and queued campaigns immediately follow these rules.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save sending rules");
    } finally {
      setBusy(false);
    }
  }

  async function holdAction(path: string, body: object, successMessage: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(path, { method: "POST", body });
      await Promise.all([load(false), changed()]);
      setNotice(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update hold state");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel sending-safety">
      <div className="safety-header-row">
        <div>
          <h2><ShieldCheck size={19} aria-hidden="true"/> Operating hours & sending rules</h2>
          <p>Control when campaigns are allowed to send (including 24/7), per-15-minute pacing, jitter, and automatic safety thresholds—without repetitive manual approvals.</p>
        </div>
        {safety && (
          safety.holds.some(h => h.accountKey === "workspace") ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void holdAction("/api/v1/safety/review", { accountKey: "workspace", confirmed: true, force: true }, "Workspace sending resumed.")}>
              <Play size={15} aria-hidden="true"/> Resume workspace sending
            </button>
          ) : (
            <button type="button" className="btn outline" disabled={busy} onClick={() => void holdAction("/api/v1/safety/hold", { reason: "Paused manually by administrator." }, "Workspace sending paused.")}>
              <Square size={14} aria-hidden="true"/> Pause all sending
            </button>
          )
        )}
      </div>

      {error && <p className="notice danger" role="alert">{error}</p>}
      {notice && <p className="notice success-notice" role="status">{notice}</p>}

      {safety && draft ? (
        <>
          <div className="recipient-breakdown">
            <span>
              <strong>{safety.used.last15Minutes} / {safety.policy.maxPer15Minutes}</strong>
              attempts / 15 min
            </span>
            <span>
              <strong>{safety.used.lastHour} / {safety.policy.maxPerHour}</strong>
              attempts / hour
            </span>
            <span>
              <strong>{safety.used.lastDay} / {safety.policy.maxPerDay}</strong>
              attempts / 24 hours
            </span>
            <span>
              <strong>{safety.policy.alwaysOpen ? "24/7 Open" : `${String(safety.policy.startHour).padStart(2, "0")}:00–${String(safety.policy.endHour).padStart(2, "0")}:00`}</strong>
              {safety.policy.timezone} · {safety.policy.activeDays?.length === 7 ? "Every day" : `${safety.policy.activeDays?.length || 7} days/wk`}
            </span>
          </div>

          {safety.holds.map(hold => (
            <div className="sending-hold" key={hold.accountKey} role="status">
              <div className="sending-hold-head">
                <div>
                  <h3>{hold.accountKey === "workspace" ? "Workspace sending paused" : "Account hold · " + hold.accountKey.replace(/^(phone|session):/, "")}</h3>
                  <p>{hold.reason}</p>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void holdAction("/api/v1/safety/review", { accountKey: hold.accountKey, confirmed: true, force: true }, "Hold cleared. You can continue or launch campaigns immediately.")}
                >
                  <Play size={14} aria-hidden="true"/> Clear hold now
                </button>
              </div>
            </div>
          ))}

          {safety.recoveries.map(recovery => (
            <div className="sending-hold recovery-banner" key={recovery.accountKey} role="status">
              <h3>Automatic 15-minute cooldown · {recovery.accountKey.replace(/^(phone|session):/, "")}</h3>
              <p>{recovery.reason} Continues automatically at {new Date(recovery.until).toLocaleString("en-KE", { timeZone: safety.policy.timezone })}.</p>
            </div>
          ))}

          <form onSubmit={saveSettings} className="safety-form">
            <fieldset className="safety-fieldset">
              <legend><Clock3 size={16} aria-hidden="true"/> Operating hours & active days</legend>
              <div className="pill-choice" role="group" aria-label="Operating hours presets">
                <button
                  type="button"
                  aria-pressed={draft.alwaysOpen && draft.activeDays.length === 7}
                  className={draft.alwaysOpen && draft.activeDays.length === 7 ? "picked" : ""}
                  onClick={() => patchDraft({ alwaysOpen: true, activeDays: [0, 1, 2, 3, 4, 5, 6] })}
                >
                  24 hours / Every day (24/7)
                </button>
                <button
                  type="button"
                  aria-pressed={!draft.alwaysOpen && draft.startHour === 6 && draft.endHour === 22}
                  className={!draft.alwaysOpen && draft.startHour === 6 && draft.endHour === 22 ? "picked" : ""}
                  onClick={() => patchDraft({ alwaysOpen: false, startHour: 6, endHour: 22 })}
                >
                  Extended (06:00–22:00)
                </button>
                <button
                  type="button"
                  aria-pressed={!draft.alwaysOpen && draft.startHour === 8 && draft.endHour === 18}
                  className={!draft.alwaysOpen && draft.startHour === 8 && draft.endHour === 18 ? "picked" : ""}
                  onClick={() => patchDraft({ alwaysOpen: false, startHour: 8, endHour: 18 })}
                >
                  Daytime (08:00–18:00)
                </button>
                <button
                  type="button"
                  aria-pressed={!draft.alwaysOpen && !(draft.startHour === 6 && draft.endHour === 22) && !(draft.startHour === 8 && draft.endHour === 18)}
                  className={!draft.alwaysOpen && !(draft.startHour === 6 && draft.endHour === 22) && !(draft.startHour === 8 && draft.endHour === 18) ? "picked" : ""}
                  onClick={() => patchDraft({ alwaysOpen: false })}
                >
                  Custom window
                </button>
              </div>

              {!draft.alwaysOpen && (
                <div className="form-grid safety-grid-3">
                  <div>
                    <label htmlFor="safety-start-hour">Window opens</label>
                    <select
                      id="safety-start-hour"
                      name="startHour"
                      value={draft.startHour}
                      onChange={e => {
                        const startHour = Number(e.target.value);
                        patchDraft({ startHour, ...(startHour === draft.endHour ? { endHour: startHour === 23 ? 24 : startHour + 1 } : {}) });
                      }}
                    >
                      {Array.from({ length: 24 }, (_, hour) => (
                        <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="safety-end-hour">Window closes</label>
                    <select
                      id="safety-end-hour"
                      name="endHour"
                      value={draft.endHour}
                      onChange={e => patchDraft({ endHour: Number(e.target.value) })}
                    >
                      {Array.from({ length: 24 }, (_, idx) => idx + 1).filter(hour => hour !== draft.startHour).map(hour => (
                        <option key={hour} value={hour}>{hour === 24 ? "24:00 (Midnight)" : `${String(hour).padStart(2, "0")}:00`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="safety-timezone">Workspace timezone</label>
                    <input
                      id="safety-timezone"
                      name="timezone"
                      list="safety-timezones"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={draft.timezone}
                      onChange={e => patchDraft({ timezone: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {draft.alwaysOpen && (
                <div className="safety-inline-tz">
                  <label htmlFor="safety-timezone">Workspace timezone</label>
                  <input
                    id="safety-timezone"
                    name="timezone"
                    list="safety-timezones"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={draft.timezone}
                    onChange={e => patchDraft({ timezone: e.target.value })}
                  />
                </div>
              )}

              <datalist id="safety-timezones">
                {["Africa/Nairobi", "UTC", "Europe/London", "America/New_York", "Asia/Dubai", "Asia/Kolkata", "Africa/Lagos", "Africa/Johannesburg"].map(tz => (
                  <option key={tz} value={tz}/>
                ))}
              </datalist>

              <div className="day-selector-block">
                <span className="field-caption">ACTIVE SENDING DAYS</span>
                <div className="day-pills" role="group" aria-label="Active days of the week">
                  {DAY_LABELS.map(item => {
                    const active = draft.activeDays.includes(item.day);
                    return (
                      <button
                        type="button"
                        key={item.day}
                        aria-pressed={active}
                        aria-label={item.full}
                        className={`day-pill ${active ? "active" : ""}`}
                        onClick={() => toggleDay(item.day)}
                      >
                        {item.short}
                      </button>
                    );
                  })}
                </div>
              </div>
            </fieldset>

            <fieldset className="safety-fieldset">
              <legend><SlidersHorizontal size={16} aria-hidden="true"/> Rate limits & anti-ban pacing (per account)</legend>
              <div className="pill-choice" role="group" aria-label="Rate limit profiles">
                <button
                  type="button"
                  className={draft.maxPer15Minutes === 3 && draft.maxPerHour === 12 ? "picked" : ""}
                  onClick={() => patchDraft({ maxPer15Minutes: 3, maxPerHour: 12, maxPerDay: 90, minimumIntervalSec: 45, jitterSec: 15 })}
                >
                  Strict Safe (3 / 15 min)
                </button>
                <button
                  type="button"
                  className={draft.maxPer15Minutes === 10 && draft.maxPerHour === 30 ? "picked" : ""}
                  onClick={() => patchDraft({ maxPer15Minutes: 10, maxPerHour: 30, maxPerDay: 180, minimumIntervalSec: 25, jitterSec: 10 })}
                >
                  Balanced (10 / 15 min)
                </button>
                <button
                  type="button"
                  className={draft.maxPer15Minutes === 25 && draft.maxPerHour === 80 ? "picked" : ""}
                  onClick={() => patchDraft({ maxPer15Minutes: 25, maxPerHour: 80, maxPerDay: 500, minimumIntervalSec: 8, jitterSec: 4 })}
                >
                  Fast / Group Heavy (25 / 15 min)
                </button>
              </div>

              <div className="form-grid safety-grid-3">
                <div>
                  <label htmlFor="safety-per-15m">Max per 15 minutes</label>
                  <input id="safety-per-15m" name="maxPer15Minutes" type="number" min={1} max={300} value={draft.maxPer15Minutes} onChange={e => patchDraft({ maxPer15Minutes: Math.max(1, Number(e.target.value) || 1) })}/>
                </div>
                <div>
                  <label htmlFor="safety-per-hour">Max per hour</label>
                  <input id="safety-per-hour" name="maxPerHour" type="number" min={1} max={1000} value={draft.maxPerHour} onChange={e => patchDraft({ maxPerHour: Math.max(1, Number(e.target.value) || 1) })}/>
                </div>
                <div>
                  <label htmlFor="safety-per-day">Max per 24 hours</label>
                  <input id="safety-per-day" name="maxPerDay" type="number" min={1} max={10000} value={draft.maxPerDay} onChange={e => patchDraft({ maxPerDay: Math.max(1, Number(e.target.value) || 1) })}/>
                </div>
                <div>
                  <label htmlFor="safety-min-gap">Minimum gap (seconds)</label>
                  <input id="safety-min-gap" name="minimumIntervalSec" type="number" min={1.5} max={3600} step={0.5} value={draft.minimumIntervalSec} onChange={e => patchDraft({ minimumIntervalSec: Math.max(1.5, Number(e.target.value) || 1.5) })}/>
                </div>
                <div>
                  <label htmlFor="safety-jitter">Random jitter (0–N sec)</label>
                  <input id="safety-jitter" name="jitterSec" type="number" min={0} max={300} step={1} value={draft.jitterSec} onChange={e => patchDraft({ jitterSec: Math.max(0, Number(e.target.value) || 0) })}/>
                </div>
                <div>
                  <label htmlFor="safety-cooldown">Global DM floor cooldown (hours)</label>
                  <input id="safety-cooldown" name="contactCooldownHours" type="number" min={0} max={720} step={1} value={draft.contactCooldownHours} onChange={e => patchDraft({ contactCooldownHours: Math.max(0, Number(e.target.value) || 0) })}/>
                  <small className="field-hint">Set 0 to manage repeat/standby rules per campaign.</small>
                </div>
              </div>

              <div className="form-grid">
                <div>
                  <label htmlFor="safety-business-name">Default sender signature (optional)</label>
                  <input id="safety-business-name" name="businessName" maxLength={80} placeholder="e.g. Acme Updates" value={draft.businessName} onChange={e => patchDraft({ businessName: e.target.value })}/>
                  <small className="field-hint">Used only when “Include sender & STOP footer” is enabled on a campaign.</small>
                </div>
                <div className="safety-checkbox-wrap">
                  <label className="check-item" htmlFor="safety-auto-hold">
                    <input id="safety-auto-hold" name="autoHoldOnQuality" type="checkbox" checked={draft.autoHoldOnQuality} onChange={e => patchDraft({ autoHoldOnQuality: e.target.checked })}/>
                    <span>
                      <strong>Auto-pause on elevated failures</strong>
                      <small className="check-description">Off by default so campaigns continue smoothly without manual review lockouts.</small>
                    </span>
                  </label>
                </div>
              </div>
            </fieldset>

            <div className="safety-submit-bar">
              <span className="muted-footnote">{dirty ? "Unsaved rule changes" : "All rules synced with worker"}</span>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Check size={15} aria-hidden="true"/>}
                Save sending rules
              </button>
            </div>
          </form>
        </>
      ) : (
        <p className="loading-line"><LoaderCircle size={16} className="spin" aria-hidden="true"/> Loading sending controls…</p>
      )}
    </section>
  );
}
