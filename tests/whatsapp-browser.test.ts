import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "whatsapp-web.js";
import { readWhatsApp } from "../worker/browser";

const require = createRequire(import.meta.url);
const { Client: SDKClient } = require("whatsapp-web.js");
const puppeteer = require("puppeteer");
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const main = { url: () => "https://web.whatsapp.com/" };
  const page = Object.assign(new EventEmitter(), {
    mainFrame: () => main, isClosed: () => false,
    goto: vi.fn(async () => {}), setUserAgent: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
  });
  vi.spyOn(puppeteer, "launch").mockResolvedValue({ pages: async () => [page] });
  const client = new SDKClient();
  vi.spyOn(client, "initWebVersionCache").mockResolvedValue(undefined);
  const inject = vi.spyOn(client, "inject").mockResolvedValue(undefined);
  return { client, page, main, inject };
}

describe("patched WhatsApp browser lifecycle", () => {
  it("ignores iframe navigation and serializes main-frame injection", async () => {
    const { client, page, main, inject } = fixture();
    await client.initialize();
    page.emit("framenavigated", { url: () => "https://other.example/" });
    await Promise.resolve();
    expect(inject).toHaveBeenCalledTimes(1);
    let release!: () => void;
    inject.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    page.emit("framenavigated", main);
    page.emit("framenavigated", main);
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(3));
  });

  it("retains the browser handle when page setup fails, so cleanup can close it", async () => {
    const { client } = fixture();
    const close = vi.fn(async () => {});
    vi.mocked(puppeteer.launch).mockResolvedValue({ pages: async () => { throw new Error("Page setup failed"); }, isConnected: () => true, close });
    await expect(client.initialize()).rejects.toThrow("Page setup failed");
    await client.destroy();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports navigation failure to the session without an unhandled rejection", async () => {
    const { client, page, main, inject } = fixture();
    await client.initialize();
    const failure = new Error("WhatsApp module unavailable");
    const error = vi.fn();
    client.on("session_error", error);
    inject.mockRejectedValueOnce(failure);
    page.emit("framenavigated", main);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
    inject.mockResolvedValue(undefined);
    page.emit("framenavigated", main);
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(3));
  });

  it("retries a destroyed execution context during initialization", async () => {
    const { client, inject } = fixture();
    inject.mockRejectedValueOnce(new Error("Execution context was destroyed"));
    await client.initialize();
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it("stops retries and exposes a permanent initialization failure", async () => {
    const { client, inject } = fixture();
    inject.mockRejectedValue(new Error("Execution context was destroyed"));
    await expect(client.initialize()).rejects.toThrow("Execution context was destroyed");
    expect(inject).toHaveBeenCalledTimes(3);
  });

  it("handles a real logout without deleting the profile of a running browser", async () => {
    const { client, page, main, inject } = fixture();
    await client.initialize();
    const logout = vi.spyOn(client.authStrategy, "logout");
    const disconnected = vi.fn();
    client.on("disconnected", disconnected);
    main.url = () => "https://web.whatsapp.com/?post_logout=1";
    page.emit("framenavigated", main);
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledWith("LOGOUT"));
    expect(logout).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledTimes(1);
  });
});

describe("directory read recovery", () => {
  function client() {
    return { pupPage: { isClosed: () => false, waitForFunction: vi.fn(async () => {}) } } as unknown as Pick<Client, "pupPage">;
  }
  it("waits for the connected store and restarts a read after navigation", async () => {
    const source = client();
    const read = vi.fn().mockRejectedValueOnce(new Error("Execution context was destroyed")).mockResolvedValue(["contact"]);
    expect(await readWhatsApp(source, read)).toEqual(["contact"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(source.pupPage!.waitForFunction).toHaveBeenCalledTimes(2);
  });
  it("does not retry a permanent WhatsApp error", async () => {
    const read = vi.fn().mockRejectedValue(new Error("r"));
    await expect(readWhatsApp(client(), read)).rejects.toThrow("r");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("discards data if the user disconnected while the read was in flight", async () => {
    let current = true;
    const read = vi.fn(async () => { current = false; return ["stale"]; });
    await expect(readWhatsApp(client(), read, () => current)).rejects.toThrow("changed during sync");
  });
});
