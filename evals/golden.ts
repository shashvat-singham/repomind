/**
 * Golden retrieval set for the fixture repo. Each case is a realistic developer
 * question paired with the file(s) that genuinely answer it. `relevantPaths` is
 * the ground truth; a retrieved chunk counts as relevant if its path is in that
 * set. These questions deliberately span both paraphrase (tests the dense arm)
 * and exact-token queries (tests the lexical arm) so the eval exercises the full
 * hybrid pipeline, not just one half.
 */
export interface GoldenCase {
  id: string;
  question: string;
  relevantPaths: string[];
  /** Which retrieval strength this case is designed to probe. */
  probes: "semantic" | "lexical" | "both";
}

export const GOLDEN_SET: GoldenCase[] = [
  {
    id: "auth-login",
    question: "How does a user log in and how are credentials verified?",
    relevantPaths: ["src/api/routes.ts", "src/auth/password.ts"],
    probes: "semantic",
  },
  {
    id: "password-hashing",
    question: "What algorithm is used to hash passwords?",
    relevantPaths: ["src/auth/password.ts"],
    probes: "both",
  },
  {
    id: "session-ttl",
    question: "How long are sessions valid before they expire?",
    relevantPaths: ["src/auth/session.ts"],
    probes: "semantic",
  },
  {
    id: "session-validate",
    question: "Where do we validate a session token and return the user id?",
    relevantPaths: ["src/auth/session.ts"],
    probes: "both",
  },
  {
    id: "stripe-charge",
    question: "How do we charge a customer's card with Stripe?",
    relevantPaths: ["src/payments/stripe.ts"],
    probes: "lexical",
  },
  {
    id: "refund",
    question: "Can we issue a refund, and where is that handled?",
    relevantPaths: ["src/payments/stripe.ts"],
    probes: "semantic",
  },
  {
    id: "rate-limit",
    question: "How is rate limiting implemented and what backs it?",
    relevantPaths: ["src/api/rate-limit.ts"],
    probes: "both",
  },
  {
    id: "login-throttle",
    question: "How many login attempts are allowed before we throttle?",
    relevantPaths: ["src/api/routes.ts", "src/api/rate-limit.ts"],
    probes: "semantic",
  },
  {
    id: "config-required",
    question: "Which environment variables are required to boot the service?",
    relevantPaths: ["src/config.ts"],
    probes: "both",
  },
  {
    id: "db-pool",
    question: "How does the app connect to Postgres?",
    relevantPaths: ["src/db/client.ts"],
    probes: "semantic",
  },
  {
    id: "email-retry",
    question: "How does the email queue handle failures and retries?",
    relevantPaths: ["src/jobs/email-queue.ts"],
    probes: "semantic",
  },
  {
    id: "backoff",
    question: "Where is exponential backoff used?",
    relevantPaths: ["src/jobs/email-queue.ts"],
    probes: "lexical",
  },
  {
    id: "checkout-flow",
    question: "What happens end to end when an authenticated user checks out?",
    relevantPaths: ["src/api/routes.ts", "src/payments/stripe.ts"],
    probes: "semantic",
  },
  {
    id: "session-revoke",
    question: "How do we log a user out / revoke their session?",
    relevantPaths: ["src/auth/session.ts"],
    probes: "both",
  },
];
