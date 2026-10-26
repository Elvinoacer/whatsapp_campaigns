export function parseContactCsv(source: string): { phone: string; name: string }[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const pushField = () => { row.push(field.trim()); field = ""; closed = false; };
  const pushRow = () => {
    pushField();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > 2001) throw new Error("Import up to 2,000 contacts at a time");
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
  if (rows.length > 2000) throw new Error("Import up to 2,000 contacts at a time");
  return rows.map((columns, index) => {
    if (columns.length > 2) throw new Error(`CSV record ${index + 1}: use phone,name and quote names containing commas`);
    return { phone: columns[0], name: columns[1] || "" };
  });
}
