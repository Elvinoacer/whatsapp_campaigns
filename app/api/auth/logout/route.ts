import { NextRequest } from "next/server";
import { cookieName, cookieOptions } from "@/lib/auth";
import { ok, rejectCrossOrigin, respondError } from "@/lib/http";
export async function POST(req: NextRequest) {
  try {
    rejectCrossOrigin(req);
    const response = ok({ success: true });
    response.cookies.set(cookieName, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (e) { return respondError(e); }
}
