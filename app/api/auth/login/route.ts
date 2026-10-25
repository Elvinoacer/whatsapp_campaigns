import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { cookieName, cookieOptions, issueToken } from "@/lib/auth";
import { ok, payload, rejectCrossOrigin, respondError } from "@/lib/http";
import { z } from "zod";

export async function POST(req: NextRequest) {
  try {
    rejectCrossOrigin(req);
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await payload(req));
    const user = await db.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
    if (!user || !await bcrypt.compare(input.password, user.passwordHash))
      return ok({ error: "Incorrect email or password" }, 401);
    const response = ok({ user: { id: user.id, email: user.email } });
    response.cookies.set(cookieName, await issueToken(user.id), cookieOptions);
    return response;
  } catch (err) { return respondError(err); }
}
