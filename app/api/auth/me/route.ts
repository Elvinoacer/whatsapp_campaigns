import { NextRequest } from "next/server";
import { ok, requireUser, respondError } from "@/lib/http";
export async function GET(req: NextRequest) {
  try { return ok({ user: await requireUser(req) }); }
  catch (e) { return respondError(e); }
}
