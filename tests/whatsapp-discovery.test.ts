import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWhatsApp } from "../worker/discovery";

const wid = (id: string) => ({ _serialized: id });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const contacts = [
    { id: wid("254700000001@c.us"), name: "Saved contact", isMyContact: true },
    { id: wid("100@lid"), phoneNumber: wid("254700000001@c.us"), pushname: "Same person" },
    { id: wid("200@lid"), name: "Private number" },
    { id: wid("254700000002@c.us"), name: "Business with broken getter" },
    { id: wid("status@broadcast"), name: "Status" },
  ];
  const participants = [{ id: wid("100@lid") }, { id: wid("200@lid") }];
  const group = { id: wid("123@g.us"), name: "Test group", groupMetadata: { participants: { getModelsArray: () => participants } } };
  const update = vi.fn(async () => {});
  vi.stubGlobal("window", { require: (name: string) => {
    if (name === "WAWebCollections") return {
      Contact: { getModelsArray: () => contacts, get: (id: string) => contacts.find(contact => contact.id._serialized === id) },
      Chat: { getModelsArray: () => [group, { id: wid("123@newsletter"), name: "Channel" }] },
      GroupMetadata: { update },
    };
    if (name === "WAWebFrontendContactGetters") return { getIsMyContact: (contact: typeof contacts[number]) => {
      if (contact.name?.includes("Business")) throw new Error("r");
      return contact.isMyContact === true;
    } };
    if (name === "WAWebLidMigrationUtils") return { toPn: () => undefined };
    throw new Error("Unexpected module " + name);
  } });
  return { update, group };
}

describe("WhatsApp directory discovery", () => {
  it("runs the worker's tsx-serialized discovery in an isolated browser context", async () => {
    fixture();
    // Match the worker's actual loader: its name-preservation transform can
    // introduce helpers that do not exist in Puppeteer's browser context.
    const source = execFileSync(process.execPath, ["--require", "tsx/cjs", "-e",
      'const { discoverWhatsApp } = require("./worker/discovery.ts"); process.stdout.write(discoverWhatsApp.toString());'],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    const result = await runInNewContext(`(${source})()`, { window });
    expect(result.contacts.map((contact: { whatsappId: string }) => contact.whatsappId))
      .toEqual(["254700000001@c.us", "200@lid", "254700000002@c.us"]);
  }, 15000);
  it("imports contacts and groups despite an optional contact getter throwing r", async () => {
    fixture();
    const result = await discoverWhatsApp();
    expect(result.contacts).toHaveLength(3);
    expect(result.contacts.some(contact => contact.name === "Business with broken getter")).toBe(true);
    expect(result.groups).toEqual([{ whatsappId: "123@g.us", name: "Test group", participantCount: 2 }]);
    expect(result.warnings).toBe(1);
  });
  it("keeps private LIDs and merges only known phone mappings", async () => {
    fixture();
    const { contacts } = await discoverWhatsApp();
    expect(contacts.find(contact => contact.whatsappId === "200@lid")?.name).toBe("Private number");
    expect(contacts.filter(contact => contact.whatsappId === "254700000001@c.us")).toHaveLength(1);
    expect(contacts.find(contact => contact.whatsappId === "254700000001@c.us")?.isMyContact).toBe(true);
    expect(contacts.find(contact => contact.whatsappId === "254700000001@c.us")?.aliases)
      .toEqual(expect.arrayContaining(["100@lid", "254700000001@c.us"]));
  });
  it("preserves usable private identities when optional phone mapping is malformed", async () => {
    const contacts = [
      { id: wid("200@lid"), phoneNumber: wid("alice@c.us"), name: "Private contact" },
      { id: wid("alice@lid"), name: "Not a routable private ID" },
    ];
    vi.stubGlobal("window", { require: (name: string) => {
      if (name === "WAWebCollections") return { Contact: { getModelsArray: () => contacts }, Chat: { getModelsArray: () => [] } };
      if (name === "WAWebLidMigrationUtils") return { toPn: () => wid("status@broadcast") };
      throw new Error("Optional module unavailable");
    } });
    const result = await discoverWhatsApp();
    expect(result.contacts).toEqual([{ whatsappId: "200@lid", aliases: ["200@lid"], name: "Private contact", isMyContact: false }]);
  });
  it("refreshes metadata only for the selected group's member sync", async () => {
    const { update } = fixture();
    const result = await discoverWhatsApp("123@g.us");
    expect(update).toHaveBeenCalledExactlyOnceWith(wid("123@g.us"));
    expect(result.participants?.map(member => member.whatsappId)).toEqual(["254700000001@c.us", "200@lid"]);
    expect(result.groups).toEqual([]);
  });
  it("fails an unavailable group before returning a replacement member list", async () => {
    const { update } = fixture();
    update.mockRejectedValueOnce(new Error("Group metadata unavailable"));
    await expect(discoverWhatsApp("123@g.us")).rejects.toThrow("Group metadata unavailable");
  });
});
