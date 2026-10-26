import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { currentUserId } from "./auth";
import { db } from "./db";
import { Prisma } from "@prisma/client";
import { unstable_rethrow } from "next/navigation";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function requireUser(req: NextRequest) {
  const id = await currentUserId(req);
  if (!id) throw new HttpError(401, "Please sign in");
  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true } });
  if (!user) throw new HttpError(401, "Session expired");
  return user;
}
export function rejectCrossOrigin(req: NextRequest) {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, "Cross-origin action denied");
  }
}
export async function payload(req: NextRequest) {
  try { return await req.json(); } catch { throw new HttpError(400, "Expected valid JSON"); }
}
export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function respondError(error: unknown) {
  unstable_rethrow(error);
  if (error instanceof HttpError) return ok({ error: error.message }, error.status);
  if (error instanceof ZodError) return ok({ error: error.issues.map(i => i.path.join(".") + ": " + i.message).join("; ") }, 400);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return ok({ error: "A record with this name or identifier already exists" }, 409);
    if (error.code === "P2025") return ok({ error: "Resource not found" }, 404);
    if (error.code === "P2003") return ok({ error: "A referenced resource no longer exists. Refresh and try again." }, 400);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) return ok({ error: "Database unavailable. Run npm run doctor to check the setup." }, 503);
  if (error instanceof Error && (error.name === "MaxRetriesPerRequestError" || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Command timed out/.test(error.message)))
    return ok({ error: "A required service is unavailable. Run npm run doctor and check PostgreSQL and Redis." }, 503);
  console.error("API error", error);
  return ok({ error: "Unexpected server error. Review server logs." }, 500);
}
