"use client";

import { useRef, useState } from "react";
import { Bold, Check, CheckCheck, Code2, Copy, FileText, Italic, LoaderCircle, Megaphone, Paperclip, Pencil, Plus, Search, Sparkles, Strikethrough, Trash2 } from "lucide-react";
import { campaignMessage, personalize } from "@/lib/message";

export type MessageTemplateRecord = {
  id: string;
  name: string;
  category: string;
  body: string;
  mediaKey?: string | null;
  mediaMime?: string | null;
  mediaName?: string | null;
  includeFooter: boolean;
  updatedAt: string;
  _count?: { campaigns: number };
};

type Request = <T>(url: string, options?: { method?: string; body?: unknown }) => Promise<T>;

export function FormattedWhatsAppText({ text }: { text: string }) {
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

const CATEGORIES = ["General", "Groups", "Outreach", "Promotions", "Events"];
const TOKENS = [
  { key: "first_name", label: "First name" },
  { key: "name", label: "Full name" },
  { key: "phone", label: "Phone" },
  { key: "group_name", label: "Group name" },
  { key: "date", label: "Today's date" },
];

export default function TemplateStudio({
  templates,
  request,
  refresh,
  inform,
  onUseTemplate,
}: {
  templates: MessageTemplateRecord[];
  request: Request;
  refresh: () => Promise<void>;
  inform: (text: string, error?: boolean) => void;
  onUseTemplate: (template: MessageTemplateRecord) => void;
}) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("General");
  const [body, setBody] = useState("");
  const [includeFooter, setIncludeFooter] = useState(false);
  const [mediaMeta, setMediaMeta] = useState<{ mediaKey?: string | null; mediaMime?: string | null; mediaName?: string | null }>({});
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  function startNew() {
    setEditingId("new");
    setName("");
    setCategory("General");
    setBody("Hi {{first_name}}! 👋\n\n");
    setIncludeFooter(false);
    setMediaMeta({});
    setMediaFile(null);
    setError("");
  }

  function startEdit(template: MessageTemplateRecord, duplicate = false) {
    setEditingId(duplicate ? "new" : template.id);
    setName(duplicate ? `${template.name} (Copy)`.slice(0, 100) : template.name);
    setCategory(template.category || "General");
    setBody(template.body);
    setIncludeFooter(template.includeFooter);
    setMediaMeta({ mediaKey: template.mediaKey, mediaMime: template.mediaMime, mediaName: template.mediaName });
    setMediaFile(null);
    setError("");
  }

  function insertFormat(before: string, after = "") {
    const field = editorRef.current;
    if (!field) {
      setBody(prev => (prev + before + after).slice(0, 4096));
      return;
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = body.slice(start, end);
    const replacement = before + selected + after;
    if (body.length - selected.length + replacement.length > 4096) return;
    setBody(body.slice(0, start) + replacement + body.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  async function saveTemplate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || name.trim().length < 2 || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      let attachment = { ...mediaMeta };
      if (mediaFile) {
        const upload = new FormData();
        upload.set("file", mediaFile);
        const response = await fetch("/api/v1/media", { method: "POST", body: upload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Attachment upload failed");
        attachment = result;
      }
      const isCreate = editingId === "new";
      await request(isCreate ? "/api/v1/templates" : `/api/v1/templates/${editingId}`, {
        method: isCreate ? "POST" : "PATCH",
        body: {
          name: name.trim(),
          category: category.trim() || "General",
          body,
          includeFooter,
          mediaKey: attachment.mediaKey ?? null,
          mediaMime: attachment.mediaMime ?? null,
          mediaName: attachment.mediaName ?? null,
        },
      });
      await refresh();
      setEditingId(null);
      setMediaFile(null);
      inform(isCreate ? "Message template created" : "Message template updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save template");
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(template: MessageTemplateRecord) {
    setBusy(true);
    try {
      await request(`/api/v1/templates/${template.id}`, { method: "DELETE" });
      await refresh();
      if (editingId === template.id) setEditingId(null);
      inform(`Deleted template “${template.name}”`);
    } catch (e) {
      inform(e instanceof Error ? e.message : "Could not delete template", true);
    } finally {
      setBusy(false);
    }
  }

  const visible = templates.filter(t => {
    if (categoryFilter !== "ALL" && t.category.toLowerCase() !== categoryFilter.toLowerCase()) return false;
    if (search && !`${t.name} ${t.category} ${t.body}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const previewRendered = personalize(
    campaignMessage(body || "Design your reusable campaign message…", "Your Brand", true, includeFooter),
    { name: "Alex Morgan", phone: "254712345678", groupName: "VIP Community" }
  );

  return (
    <div className="template-studio-wrap">
      {editingId && (
        <section className="panel template-editor-panel">
          <div className="panel-title">
            <div>
              <h2><Sparkles size={18} aria-hidden="true"/> {editingId === "new" ? "Design new message template" : "Edit message template"}</h2>
              <p>Use WhatsApp formatting, dynamic tokens for DMs & groups, and optional media attachments.</p>
            </div>
            <button type="button" className="btn outline" disabled={busy} onClick={() => setEditingId(null)}>Close designer</button>
          </div>

          <form onSubmit={saveTemplate} className="template-designer-grid">
            <div className="template-designer-fields">
              <div className="form-grid">
                <div>
                  <label htmlFor="tpl-name">Template name</label>
                  <input id="tpl-name" name="name" required minLength={2} maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Hourly Flash Promo"/>
                </div>
                <div>
                  <label htmlFor="tpl-category">Category</label>
                  <input id="tpl-category" name="category" list="tpl-categories" maxLength={50} value={category} onChange={e => setCategory(e.target.value)}/>
                  <datalist id="tpl-categories">
                    {CATEGORIES.map(c => <option key={c} value={c}/>)}
                  </datalist>
                </div>
              </div>

              <div>
                <label htmlFor="tpl-body">Template message</label>
                <div className="message-editor" style={{ marginTop: 6 }}>
                  <div className="editor-toolbar">
                    <button type="button" aria-label="Bold" onClick={() => insertFormat("*", "*")}><Bold size={15} aria-hidden="true"/></button>
                    <button type="button" aria-label="Italic" onClick={() => insertFormat("_", "_")}><Italic size={15} aria-hidden="true"/></button>
                    <button type="button" aria-label="Strikethrough" onClick={() => insertFormat("~", "~")}><Strikethrough size={15} aria-hidden="true"/></button>
                    <button type="button" aria-label="Monospace" onClick={() => insertFormat("`", "`")}><Code2 size={15} aria-hidden="true"/></button>
                    <span>WhatsApp rich text</span>
                  </div>
                  <textarea
                    id="tpl-body"
                    ref={editorRef}
                    rows={8}
                    required
                    maxLength={4096}
                    value={body}
                    placeholder="Hi {{first_name}}, here is our update for {{group_name}}…"
                    onChange={e => setBody(e.target.value)}
                  />
                  <div className="editor-bottom">
                    <span>Supports emojis, links & variables</span>
                    <span>{body.length.toLocaleString()} / 4,096</span>
                  </div>
                </div>
              </div>

              <div className="personalize-tools">
                <span>Insert variable:</span>
                {TOKENS.map(token => (
                  <button type="button" className="token-button" key={token.key} onClick={() => insertFormat(`{{${token.key}}}`)}>
                    {`{{${token.key}}}`}
                  </button>
                ))}
              </div>

              <div className="form-grid">
                <label className="attachment-picker" htmlFor="tpl-media">
                  <Paperclip size={18} aria-hidden="true"/>
                  <span>
                    <strong>{mediaFile?.name || mediaMeta.mediaName || "Attach image or PDF (optional)"}</strong>
                    <small>JPEG, PNG, WebP or PDF · up to 8 MB</small>
                  </span>
                  <input
                    id="tpl-media"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file && (file.size > 8 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type))) {
                        setError("Choose a JPEG, PNG, WebP or PDF up to 8 MB.");
                        e.target.value = "";
                        return;
                      }
                      setMediaFile(file || null);
                      setError("");
                    }}
                  />
                </label>

                <label className="check-item" htmlFor="tpl-footer">
                  <input id="tpl-footer" type="checkbox" checked={includeFooter} onChange={e => setIncludeFooter(e.target.checked)}/>
                  <span>
                    <strong>Append STOP opt-out footer on DMs</strong>
                    <small className="check-description">Optional. Uncheck to send exact custom copy without a footer.</small>
                  </span>
                </label>
              </div>

              {(mediaFile || mediaMeta.mediaKey) && (
                <div>
                  <button type="button" className="text-button" onClick={() => { setMediaFile(null); setMediaMeta({ mediaKey: null, mediaMime: null, mediaName: null }); }}>
                    Remove attachment
                  </button>
                </div>
              )}

              {error && <div className="notice danger" role="alert">{error}</div>}

              <div className="head-actions">
                <button type="submit" className="btn primary" disabled={busy || name.trim().length < 2 || !body.trim()}>
                  {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Check size={15} aria-hidden="true"/>}
                  {editingId === "new" ? "Save template" : "Save changes"}
                </button>
                <button type="button" className="btn outline" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
              </div>
            </div>

            <aside className="phone-preview">
              <div className="phone-preview-header">
                <span className="person-avatar">W</span>
                <div>
                  <strong>Live WhatsApp Preview</strong>
                  <small>Variables rendered with sample values</small>
                </div>
              </div>
              <div className="phone-preview-chat">
                <div className="chat-bubble">
                  {(mediaFile || mediaMeta.mediaName) && (
                    <div className="preview-attachment">
                      <FileText size={18} aria-hidden="true"/>
                      {mediaFile?.name || mediaMeta.mediaName}
                    </div>
                  )}
                  <FormattedWhatsAppText text={previewRendered}/>
                  <span className="bubble-time">14:20 <CheckCheck size={14} aria-hidden="true"/></span>
                </div>
              </div>
              <p>Ready for 1-click insertion in single, recurring interval, or group campaigns.</p>
            </aside>
          </form>
        </section>
      )}

      <div className="campaign-toolbar">
        <div className="search-box">
          <Search size={17} aria-hidden="true"/>
          <input
            aria-label="Search message templates"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Search templates by name, category or text…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select aria-label="Filter templates by category" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
          <option value="ALL">All categories ({templates.length})</option>
          {[...new Set([...CATEGORIES, ...templates.map(t => t.category)])].map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        {!editingId && (
          <button type="button" className="btn primary" onClick={startNew}>
            <Plus size={16} aria-hidden="true"/> New template
          </button>
        )}
      </div>

      <div className="template-grid">
        {visible.map(tpl => (
          <article className="segment-card template-card" key={tpl.id}>
            <div className="template-card-top">
              <span className="flag">{tpl.category}</span>
              {tpl.includeFooter && <span className="source-tag">+ STOP footer</span>}
              {tpl.mediaName && <span className="source-tag">📎 {tpl.mediaName}</span>}
            </div>
            <h3>{tpl.name}</h3>
            <div className="template-snippet">
              <FormattedWhatsAppText text={tpl.body.length > 220 ? tpl.body.slice(0, 220) + "…" : tpl.body}/>
            </div>
            <div className="segment-card-actions" style={{ marginTop: "auto" }}>
              <button type="button" className="btn primary" onClick={() => onUseTemplate(tpl)}>
                <Megaphone size={14} aria-hidden="true"/> Use in campaign
              </button>
              <button type="button" className="btn outline" onClick={() => startEdit(tpl)}>
                <Pencil size={13} aria-hidden="true"/> Edit
              </button>
              <button type="button" className="btn subtle" aria-label={`Duplicate ${tpl.name}`} onClick={() => startEdit(tpl, true)}>
                <Copy size={13} aria-hidden="true"/> Duplicate
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${tpl.name}`} disabled={busy} onClick={() => void removeTemplate(tpl)}>
                <Trash2 size={15} aria-hidden="true"/>
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
