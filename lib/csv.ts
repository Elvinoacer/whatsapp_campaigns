export function parseContactCsv(source: string): { phone: string; name: string }[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const pushField = () => { row.push(field.trim()); field = ""; closed = false; };
  const pushRow = () => {
    pushField();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > 25001) throw new Error("Import up to 25,000 contacts at a time");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") pushRow();
    else if (char === '"' && !field.trim() && !closed) { field = ""; quoted = true; }
    else if (char === '"' || (closed && char.trim())) throw new Error("Invalid CSV quoting. Use phone,name and quote names containing commas.");
    else field += char;
  }
  if (quoted) throw new Error("A quoted CSV field is missing its closing quote");
  pushRow();
  if (rows[0]?.[0].toLowerCase() === "phone") rows.shift();
  if (rows.length > 25000) throw new Error("Import up to 25,000 contacts at a time");
  return rows.map((columns, index) => {
    if (columns.length > 2) throw new Error(`CSV record ${index + 1}: use phone,name and quote names containing commas`);
    return { phone: columns[0], name: columns[1] || "" };
  });
}

function csvCell(value: string | null | undefined) {
  const text = (value ?? "").replace(/\r\n/g, "\n");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatContactCsv(contacts: {
  phone?: string | null;
  name?: string | null;
  whatsappId?: string;
  consent?: string;
  segments?: string[];
  groups?: string[];
  sessions?: string[];
}[]) {
  const header = ["phone", "name", "whatsapp_id", "status", "segments", "groups", "sessions"];
  const lines = [header.join(",")];
  for (const item of contacts) {
    lines.push([
      csvCell(item.phone || ""),
      csvCell(item.name || ""),
      csvCell(item.whatsappId || ""),
      csvCell(item.consent === "OPTED_OUT" ? "opted_out" : "active"),
      csvCell((item.segments || []).join("; ")),
      csvCell((item.groups || []).join("; ")),
      csvCell((item.sessions || []).join("; ")),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}
