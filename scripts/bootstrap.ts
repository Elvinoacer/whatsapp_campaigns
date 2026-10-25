import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../lib/db";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in .env");
  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.upsert({ where: { email }, update: { passwordHash }, create: { email, passwordHash } });
  console.log("Admin account ready:", email);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
