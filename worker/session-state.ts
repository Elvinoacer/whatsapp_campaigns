export function shouldRestoreSession(session: { status: string; phone: string | null }, profileExists: boolean) {
  if (["CONNECTED", "CONNECTING", "QR_READY"].includes(session.status)) return true;
  return session.status === "ERROR" && !!session.phone && profileExists;
}

export function requiresPairing(reason: string) {
  return /LOGOUT|UNPAIRED/.test(reason.toUpperCase());
}
