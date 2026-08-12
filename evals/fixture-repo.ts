/**
 * A small but realistic backend codebase used as the eval fixture. It has the
 * shape of a real service — auth, payments, rate limiting, config, db access,
 * background jobs — so the golden questions resemble what a developer actually
 * asks when onboarding to an unfamiliar repo. Keeping it in-repo makes the eval
 * hermetic and lets CI gate retrieval quality with no network.
 */
export const FIXTURE_FILES: Record<string, string> = {
  "src/auth/session.ts": `import { db } from "../db/client";
import { hashToken, randomToken } from "./crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

// Creates a new session for a user and returns the raw session token.
export async function issueSession(userId: string): Promise<string> {
  const raw = randomToken(32);
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.sessions.insert({ userId, tokenHash, expiresAt });
  return raw;
}

// Validates a session token and returns the user id if it is still valid.
export async function validateSession(rawToken: string): Promise<string | null> {
  const tokenHash = hashToken(rawToken);
  const row = await db.sessions.findByHash(tokenHash);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.sessions.delete(row.id);
    return null;
  }
  return row.userId;
}

export async function revokeSession(rawToken: string): Promise<void> {
  await db.sessions.deleteByHash(hashToken(rawToken));
}
`,
  "src/auth/password.ts": `import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// Hashes a plaintext password with a per-user random salt using scrypt.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return salt + ":" + derived.toString("hex");
}

// Verifies a plaintext password against a stored salt:hash value.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(key, "hex"), derived);
}
`,
  "src/payments/stripe.ts": `import { config } from "../config";
import { db } from "../db/client";

// Charges a customer's saved card via Stripe and records the invoice locally.
export async function chargeCustomer(customerId: string, amountCents: number, currency = "usd") {
  const intent = await stripeRequest("payment_intents", {
    customer: customerId,
    amount: amountCents,
    currency,
    confirm: true,
  });
  await db.invoices.insert({ customerId, amountCents, currency, intentId: intent.id });
  return intent;
}

// Issues a refund for a previously created payment intent.
export async function refundPayment(intentId: string, amountCents?: number) {
  return stripeRequest("refunds", { payment_intent: intentId, amount: amountCents });
}

async function stripeRequest(path: string, body: Record<string, unknown>) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.stripeSecretKey },
    body: new URLSearchParams(body as Record<string, string>),
  });
  if (!res.ok) throw new Error("Stripe error: " + res.status);
  return res.json();
}
`,
  "src/api/rate-limit.ts": `// Sliding-window rate limiter backed by Redis. Returns whether the request is
// allowed and how many requests remain in the current window.
import { redis } from "./redis";

export async function rateLimit(key: string, limit: number, windowSec: number) {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const redisKey = "ratelimit:" + key;
  await redis.zremrangebyscore(redisKey, 0, windowStart);
  const count = await redis.zcard(redisKey);
  if (count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  await redis.zadd(redisKey, now, now + ":" + Math.random());
  await redis.expire(redisKey, windowSec);
  return { allowed: true, remaining: limit - count - 1 };
}
`,
  "src/config.ts": `// Centralised configuration loaded from environment variables. Throws on boot
// if a required secret is missing, so misconfiguration fails fast.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required env var: " + name);
  return v;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  stripeSecretKey: required("STRIPE_SECRET_KEY"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port: Number(process.env.PORT ?? 3000),
};
`,
  "src/db/client.ts": `// Thin typed data-access layer over the connection pool. Each collection maps to
// a table and exposes only the queries the app actually needs.
import { Pool } from "pg";
import { config } from "../config";

const pool = new Pool({ connectionString: config.databaseUrl });

export const db = {
  sessions: {
    insert: (row: unknown) => pool.query("INSERT INTO sessions ...", []),
    findByHash: (hash: string) => pool.query("SELECT * FROM sessions WHERE token_hash=$1", [hash]),
    delete: (id: string) => pool.query("DELETE FROM sessions WHERE id=$1", [id]),
    deleteByHash: (hash: string) => pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash]),
  },
  invoices: {
    insert: (row: unknown) => pool.query("INSERT INTO invoices ...", []),
  },
};
`,
  "src/jobs/email-queue.ts": `// Background email queue. Enqueues emails and processes them with retry and
// exponential backoff so transient SMTP failures don't drop messages.
import { db } from "../db/client";
import { sendSmtp } from "./smtp";

export async function enqueueEmail(to: string, template: string, data: object) {
  await db.invoices.insert({ to, template, data, attempts: 0 });
}

export async function processQueue(batchSize = 20) {
  for (let attempt = 0; attempt < batchSize; attempt++) {
    const job = await nextJob();
    if (!job) break;
    try {
      await sendSmtp(job.to, render(job.template, job.data));
    } catch (err) {
      const delay = Math.min(2 ** job.attempts * 1000, 60000);
      await requeue(job, delay);
    }
  }
}

async function nextJob(): Promise<any> { return null; }
async function requeue(job: any, delayMs: number) {}
function render(template: string, data: object): string { return template; }
`,
  "src/api/routes.ts": `// HTTP route handlers wiring auth, payments, and rate limiting together.
import { validateSession } from "../auth/session";
import { verifyPassword } from "../auth/password";
import { chargeCustomer } from "../payments/stripe";
import { rateLimit } from "./rate-limit";

// POST /login — authenticates a user and starts a session.
export async function handleLogin(req: Request) {
  const { username, password } = await req.json();
  const rl = await rateLimit("login:" + username, 5, 60);
  if (!rl.allowed) return new Response("Too many attempts", { status: 429 });
  const user = await lookupUser(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return new Response("Invalid credentials", { status: 401 });
  }
  return new Response("ok");
}

// POST /checkout — charges the authenticated user's card.
export async function handleCheckout(req: Request) {
  const userId = await validateSession(req.headers.get("x-session") ?? "");
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { amountCents } = await req.json();
  await chargeCustomer(userId, amountCents);
  return new Response("charged");
}

async function lookupUser(username: string): Promise<any> { return null; }
`,
  "README.md": `# Acme Service

A small backend service demonstrating auth, payments, and background jobs.

## Environment
Set DATABASE_URL, STRIPE_SECRET_KEY, and optionally REDIS_URL and PORT.

## Security
Passwords are hashed with scrypt and a per-user salt. Sessions are stored as
salted hashes with a 7-day TTL. Login is rate limited to 5 attempts per minute.
`,
};
