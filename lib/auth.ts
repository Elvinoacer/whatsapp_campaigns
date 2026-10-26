import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const NAME = "wc_auth";
function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32 || /REPLACE|CHANGEME/i.test(value)) throw new Error("Run npm run setup to generate a random AUTH_SECRET");
  return new TextEncoder().encode(value);
}
export async function issueToken(id: string) {
  return new SignJWT({ sub: id }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime("7d").sign(secret());
}
export async function currentUserId(request?: NextRequest): Promise<string | null> {
  const token = request?.cookies.get(NAME)?.value ?? (await cookies()).get(NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch { return null; }
}
export const cookieName = NAME;
export const cookieOptions = {
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const,
  path: "/", maxAge: 60 * 60 * 24 * 7,
};
