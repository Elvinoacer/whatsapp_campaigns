"use client";

import { useState } from "react";
import { ArrowRight, FolderPlus, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { ContactSelection } from "@/lib/contact-selection";

export type SegmentOption = { id: string; name: string; description?: string | null; _count: { members: number } };
export type GroupRef = { id: string; name: string; sessionConnected?: boolean; savedMembers?: number; participantCount?: number };

type Props = {
  segments: SegmentOption[];
  selection?: ContactSelection;
  count?: number;
  sourceSegmentId?: string;
  group?: GroupRef;
  groups?: GroupRef[];
  request: <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  close: () => void;
  saved: (message: string) => Promise<void>;
};

export default function ContactOrganizer({
  segments,
  selection,
  count = 0,
  sourceSegmentId,
  group,
  groups,
  request,
  close,
  saved,
}: Props) {
  const groupList = groups?.length ? groups : group ? [group] : [];
  const isGroupExport = groupList.length > 0;
  const defaultNewSegment = isGroupExport && segments.length === 0;

  const [action, setAction] = useState<"add" | "move" | "remove">("add");
  const [targets, setTargets] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [createNew, setCreateNew] = useState(defaultNewSegment);
  const [name, setName] = useState(
    isGroupExport && groupList.length === 1 ? `${groupList[0].name} Members`.slice(0, 80) : ""
  );
  const [description, setDescription] = useState(
    isGroupExport
      ? groupList.length === 1
        ? `Exported from WhatsApp group "${groupList[0].name}"`
        : `Combined audience exported from ${groupList.length} WhatsApp groups`
      : ""
  );
  const [syncLive, setSyncLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const available = segments.filter(s => action !== "move" || s.id !== sourceSegmentId);
  const selected = available.filter(s => targets.includes(s.id));
  const source = segments.find(s => s.id === sourceSegmentId);
  const hasConnectedGroup = groupList.some(g => g.sessionConnected !== false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const segmentIds = selected.map(s => s.id);
      if (isGroupExport) {
        const res = await request<{
          addedNow: number;
          queuedGroups: number;
          segmentIds: string[];
          createdSegment: { id: string; name: string } | null;
        }>("/api/v1/groups/export-segment", {
          method: "POST",
          body: {
            groupIds: groupList.map(g => g.id),
            segmentIds,
            syncLive: syncLive && hasConnectedGroup,
            ...(createNew ? { newSegment: { name: name.trim(), description: description.trim() } } : {}),
          },
        });
        const parts: string[] = [];
        if (res.createdSegment) parts.push(`Created segment “${res.createdSegment.name}”`);
        if (res.addedNow > 0) parts.push(`exported ${res.addedNow.toLocaleString()} saved contacts immediately`);
        if (res.queuedGroups > 0) parts.push(`syncing live members from ${res.queuedGroups} connected group${res.queuedGroups === 1 ? "" : "s"}`);
        await saved(parts.length ? parts.join(" · ") + "." : "Group segment export completed.");
      } else if (selection) {
        const result = await request<{ count: number }>("/api/v1/segments/members", {
          method: "POST",
          body: {
            selection,
            action,
            segmentIds,
            ...(action === "move" && sourceSegmentId ? { sourceSegmentId } : {}),
            ...(createNew && action !== "remove" ? { newSegment: { name: name.trim(), description: description.trim() } } : {}),
          },
        });
        await saved(
          `${result.count.toLocaleString()} contacts ${
            action === "add" ? "added to" : action === "move" ? "moved to" : "removed from"
          } the selected segments.`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to organize contacts");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    (selected.length > 0 || (createNew && action !== "remove" && name.trim().length >= 2)) &&
    !(createNew && action !== "remove" && name.trim().length < 2);

  return (
    <form onSubmit={save}>
      <div className="modal-body">
        <div className="organizer-summary">
          <FolderPlus size={23} aria-hidden="true"/>
          <div>
            <strong>
              {isGroupExport
                ? groupList.length === 1
                  ? `Export “${groupList[0].name}” to segment`
                  : `Export ${groupList.length} WhatsApp groups to segment`
                : `${count.toLocaleString()} contacts selected`}
            </strong>
            <p>
              {isGroupExport
                ? "Combine contacts from any number of groups and phone sessions into one reusable segment without duplicates."
                : selection?.filter
                  ? "Includes every contact matching your current directory filters across all pages."
                  : "Combine contacts from multiple sessions, groups, and imports into reusable segments."}
            </p>
          </div>
        </div>

        {!isGroupExport && (
          <div className="pill-choice" role="group" aria-label="Bulk segment action">
            {(["add", "move", "remove"] as const).map(value => (
              <button
                type="button"
                key={value}
                disabled={busy}
                aria-pressed={action === value}
                className={action === value ? "picked" : ""}
                onClick={() => { setAction(value); setError(""); }}
              >
                {value === "add" ? "Add to segments" : value === "move" ? "Move to segments" : "Remove from segments"}
              </button>
            ))}
          </div>
        )}

        {action === "move" && !isGroupExport && (
          <div className="builder-note">
            <ArrowRight size={17} aria-hidden="true"/>
            <span>
              {source
                ? `Move out of “${source.name}” into the destination segments below.`
                : "Replace current segment memberships with the destinations below."}{" "}
              Centralized phonebook records and group memberships stay intact.
            </span>
          </div>
        )}

        {action === "remove" && !isGroupExport && (
          <p className="modal-help">Remove membership only from the segments you choose. Contacts stay in your centralized phonebook.</p>
        )}

        {action !== "remove" && (
          <div className="new-segment-box">
            <label className="check-item" htmlFor="organizer-create-new">
              <input
                id="organizer-create-new"
                type="checkbox"
                disabled={busy}
                checked={createNew}
                onChange={e => setCreateNew(e.target.checked)}
              />
              <span>
                <strong>Create a new segment</strong>
                <small className="check-description">Create a fresh segment and populate it in one step.</small>
              </span>
            </label>
            {createNew && (
              <div className="form-grid" style={{ marginTop: 12 }}>
                <div>
                  <label htmlFor="organizer-segment-name">New segment name</label>
                  <input
                    id="organizer-segment-name"
                    name="segmentName"
                    value={name}
                    maxLength={80}
                    required={createNew}
                    minLength={2}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Nairobi Community VIPs"
                  />
                </div>
                <div>
                  <label htmlFor="organizer-segment-desc">Description (optional)</label>
                  <input
                    id="organizer-segment-desc"
                    name="segmentDescription"
                    value={description}
                    maxLength={250}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Notes about this audience…"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {available.length > 0 && (
          <>
            <div className="field-caption">
              {createNew ? "ALSO ADD TO EXISTING SEGMENTS (OPTIONAL)" : "CHOOSE EXISTING DESTINATION SEGMENTS"}
            </div>
            <div className="search-box">
              <Search size={17} aria-hidden="true"/>
              <input
                aria-label="Search destination segments"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Filter existing segments…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="selection-grid organizer-segments">
              {available
                .filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
                .map(s => (
                  <label className="check-item" key={s.id}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={targets.includes(s.id)}
                      onChange={() => setTargets(p => (p.includes(s.id) ? p.filter(id => id !== s.id) : [...p, s.id]))}
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <small className="check-description">{s._count.members.toLocaleString()} contacts</small>
                    </span>
                  </label>
                ))}
            </div>
          </>
        )}

        {isGroupExport && hasConnectedGroup && (
          <label className="check-item" htmlFor="organizer-sync-live">
            <input
              id="organizer-sync-live"
              type="checkbox"
              disabled={busy}
              checked={syncLive}
              onChange={e => setSyncLive(e.target.checked)}
            />
            <span>
              <strong><RefreshCw size={13} style={{ display: "inline", marginRight: 5 }} aria-hidden="true"/> Also fetch latest live group members from WhatsApp</strong>
              <small className="check-description">Already-saved contacts are added immediately; any newly joined group members sync in the background.</small>
            </span>
          </label>
        )}

        <p className="muted-footnote">
          {selected.length + (createNew && action !== "remove" ? 1 : 0)} destination segment(s) selected · Duplicates across groups and phone sessions are merged automatically.
        </p>

        {error && <div className="notice danger" role="alert">{error}</div>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn outline" disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!canSubmit}>
          {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true"/> : <FolderPlus size={16} aria-hidden="true"/>}
          {isGroupExport ? "Export to segment" : action === "add" ? "Add to segment" : action === "move" ? "Move contacts" : "Remove from segment"}
        </button>
      </div>
    </form>
  );
}
