-- RepoMind schema. Runs verbatim on both PGlite (local/CI) and Neon (prod).
-- Statements are separated by a single blank line; the migrator runs them one
-- at a time so it works over Neon's one-statement-per-call HTTP driver too.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repos (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  name         TEXT NOT NULL,
  ref          TEXT NOT NULL DEFAULT 'HEAD',
  commit_sha   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  file_count   INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  embed_model  TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS repos_slug_idx ON repos (owner, name, ref);

CREATE TABLE IF NOT EXISTS chunks (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  lang          TEXT NOT NULL DEFAULT 'text',
  symbol        TEXT,
  symbol_kind   TEXT,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  token_count   INTEGER NOT NULL DEFAULT 0,
  embedding     vector(1536),
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english',
                    coalesce(symbol, '') || ' ' ||
                    coalesce(path, '')   || ' ' ||
                    coalesce(context, '')|| ' ' ||
                    coalesce(content, ''))
                ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chunks_dedup_idx ON chunks (repo_id, content_hash);

CREATE INDEX IF NOT EXISTS chunks_repo_path_idx ON chunks (repo_id, path);

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

CREATE INDEX IF NOT EXISTS chunks_symbol_idx ON chunks (repo_id, symbol);

-- Observability: one row per answered question, for the live cost/latency panel.
CREATE TABLE IF NOT EXISTS query_log (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       TEXT,
  question      TEXT NOT NULL,
  mode          TEXT NOT NULL,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  retrieve_ms   INTEGER NOT NULL DEFAULT 0,
  generate_ms   INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_hit     BOOLEAN NOT NULL DEFAULT false,
  n_retrieved   INTEGER NOT NULL DEFAULT 0,
  injection     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS query_log_created_idx ON query_log (created_at DESC);

-- Semantic cache: reuse an answer when a new question is near-identical to a
-- previous one (cosine over the question embedding), scoped per repo.
CREATE TABLE IF NOT EXISTS semantic_cache (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  question       TEXT NOT NULL,
  embedding      vector(1536) NOT NULL,
  answer_json    JSONB NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_cache_repo_idx ON semantic_cache (repo_id);
