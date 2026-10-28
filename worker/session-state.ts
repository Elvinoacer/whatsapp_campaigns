export function shouldRestoreSession(session: { status: string; phone: string | null }, profileExists: boolean) {
  // An explicit disconnect or WhatsApp logout must never be undone by a restart.
  // ERROR may occur before the phone is saved, but a saved browser profile can
  // still contain the authentication needed to recover it.
  if (["CONNECTED", "CONNECTING", "QR_READY"].includes(session.status)) return true;
  return session.status === "ERROR" && profileExists;
}

export function reconnectDelayMs(attempt: number) {
  // Retry transport/browser failures indefinitely, but back off to five
  // minutes so an offline network or broken Chromium cannot spin constantly.
  const exponent = Math.min(8, Math.max(0, Math.floor(attempt) - 1));
  return Math.min(300_000, 2_000 * 2 ** exponent);
}

export function requiresPairing(reason: string) {
  return /LOGOUT|UNPAIRED/.test(reason.toUpperCase());
}
