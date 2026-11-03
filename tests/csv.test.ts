import { describe, expect, it } from "vitest";
import { formatContactCsv, parseContactCsv } from "../lib/csv";

describe("CSV contact import", () => {
  it("supports quoted headers, BOM, commas and escaped quotes", () => {
    expect(parseContactCsv('\uFEFF"phone","name"\r\n"+254700000001","Doe, Jane"\r\n254700000002,"Grace ""G"" Test"')).toEqual([
      { phone: "+254700000001", name: "Doe, Jane" }, { phone: "254700000002", name: 'Grace "G" Test' },
    ]);
  });
  it("supports phone-only rows, blank lines and quoted multiline names", () => {
    expect(parseContactCsv('254700000001\n\n254700000002,"Ada\nTest"')).toEqual([
      { phone: "254700000001", name: "" }, { phone: "254700000002", name: "Ada\nTest" },
    ]);
    expect(parseContactCsv("\n")).toEqual([]);
  });
  it("reports malformed quotes and extra columns", () => {
    expect(() => parseContactCsv('254700000001,"Missing')).toThrow(/closing quote/);
    expect(() => parseContactCsv("254700000001,Doe,Jane")).toThrow(/quote names/);
  });
  it("formats phonebook contacts into escaped CSV rows", () => {
    const csv = formatContactCsv([
      {
        phone: "+254700000001",
        name: 'Doe, "Jane"',
        whatsappId: "254700000001@c.us",
        consent: "OPTED_IN",
        segments: ["VIP", "Nairobi"],
        groups: ["VIP Members"],
        sessions: ["Primary Line"],
      },
      {
        phone: "+254700000002",
        name: "Stop User",
        consent: "OPTED_OUT",
      },
    ]);
    expect(csv).toBe(
      'phone,name,whatsapp_id,status,segments,groups,sessions\n+254700000001,"Doe, ""Jane""",254700000001@c.us,active,VIP; Nairobi,VIP Members,Primary Line\n+254700000002,Stop User,,opted_out,,,\n'
    );
  });
});
