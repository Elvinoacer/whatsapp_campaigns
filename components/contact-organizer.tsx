"use client";

import { useState } from "react";
import { ArrowRight, FolderPlus, LoaderCircle, Search } from "lucide-react";
import type { ContactSelection } from "@/lib/contact-selection";

export type SegmentOption = { id: string; name: string; description?: string | null; _count: { members: number } };
type Props = {
  segments: SegmentOption[];
  selection: ContactSelection;
  count: number;
  sourceSegmentId?: string;
  group?: { id: string; name: string };
  request: <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  close: () => void;
  saved: (message: string) => Promise<void>;
};

export default function ContactOrganizer({ segments, selection, count, sourceSegmentId, group, request, close, saved }: Props) {
  const [action, setAction] = useState<"add" | "move" | "remove">("add");
  const [targets, setTargets] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createdSegments, setCreatedSegments] = useState<SegmentOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = [...createdSegments, ...segments.filter(s => !createdSegments.some(created => created.id === s.id))].filter(s => action !== "move" || s.id !== sourceSegmentId);
  const selected = available.filter(s => targets.includes(s.id));
  const source = segments.find(s => s.id === sourceSegmentId);
  async function save() {
    setBusy(true); setError("");
    try {
      let segmentIds = selected.map(s => s.id);
      if (group) {
        if (createNew) {
          const created = await request<SegmentOption>("/api/v1/segments", { method: "POST", body: { name, description } });
          setCreatedSegments(p => [{ ...created, _count: { members: 0 } }, ...p]);
          segmentIds = [...segmentIds, created.id]; setTargets(segmentIds); setCreateNew(false);
        }
        await request("/api/v1/groups/" + group.id + "/save-contacts", { method: "POST", body: { segmentIds } });
        await saved("Saving every available group contact into the selected segments. Progress appears beside the group.");
      } else {
        const result = await request<{ count: number }>("/api/v1/segments/members", { method: "POST", body: {
          selection, action, segmentIds, ...(action === "move" && sourceSegmentId ? { sourceSegmentId } : {}),
          ...(createNew && action !== "remove" ? { newSegment: { name, description } } : {}),
        } });
        await saved(`${result.count.toLocaleString()} contacts ${action === "add" ? "added to" : action === "move" ? "moved to" : "removed from"} the selected segments.`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to organize contacts"); }
    finally { setBusy(false); }
  }
  return <>
    <div className="modal-body">
      <div className="organizer-summary"><FolderPlus size={23}/><div><strong>{group ? group.name : `${count.toLocaleString()} contacts selected`}</strong><p>{group ? "Discover and save every available member, including those beyond the member preview." : selection.filter ? "Includes every contact matching your filters, across all pages." : "Your selection can include contacts from different sources and accounts."}</p></div></div>
      {!group && <div className="pill-choice" aria-label="Bulk segment action">{(["add", "move", "remove"] as const).map(value => <button key={value} disabled={busy} className={action === value ? "picked" : ""} onClick={() => { setAction(value); setError(""); }}>{value === "add" ? "Add to segments" : value === "move" ? "Move to segments" : "Remove from segments"}</button>)}</div>}
      {action === "move" && <div className="builder-note"><ArrowRight size={17}/><span>{source ? `Move out of “${source.name}” into the destinations below. Other segment memberships stay in place.` : "Replace all current segment memberships with the destinations below."} Contact records and group memberships are kept.</span></div>}
      {action === "remove" && <p className="modal-help">Remove membership only from the segments you choose. Contact records stay in your directory.</p>}
      <div className="search-box"><Search size={17}/><input aria-label="Search destination segments" placeholder="Find a segment…" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <div className="selection-grid organizer-segments">{available.filter(s => s.name.toLowerCase().includes(search.toLowerCase())).map(s => <label className="check-item" key={s.id}><input type="checkbox" disabled={busy} checked={targets.includes(s.id)} onChange={() => setTargets(p => p.includes(s.id) ? p.filter(id => id !== s.id) : [...p, s.id])}/><span>{s.name}<small className="check-description">{s._count.members.toLocaleString()} contacts</small></span></label>)}{!available.length && <p className="modal-help">Create your first destination segment below.</p>}</div>
      {action !== "remove" && <><label className="check-item"><input type="checkbox" disabled={busy} checked={createNew} onChange={e => setCreateNew(e.target.checked)}/><span>Create a new segment with this selection</span></label>{createNew && <div className="form-grid"><label>New segment name<input aria-label="New segment name" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="e.g. October subscribers"/></label><label>Description (optional)<input value={description} maxLength={250} onChange={e => setDescription(e.target.value)}/></label></div>}</>}
      <p className="muted-footnote">{selected.length + (createNew && action !== "remove" ? 1 : 0)} segments selected. Adding is safe to repeat; existing memberships are kept without duplicates. Consent is unchanged.</p>
      {error && <div className="notice danger" role="alert">{error}</div>}
    </div>
    <div className="modal-actions"><button className="btn outline" disabled={busy} onClick={close}>Cancel</button><button className="btn primary" disabled={busy || (!selected.length && !(createNew && name.trim().length >= 2 && action !== "remove")) || (createNew && action !== "remove" && name.trim().length < 2)} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16}/> : <FolderPlus size={16}/>} {group ? "Save group to segments" : action === "add" ? "Add contacts" : action === "move" ? "Move contacts" : "Remove memberships"}</button></div>
  </>;
}
