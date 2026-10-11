/**
 * Local embedding client (ollama) — the semantic layer behind the nearFloor
 * reranker (A4 决议 2, spec §3.1).
 *
 * Semantics (mirror of jev/client's outcome mode):
 *  - every failure returns as a structured {ok:false, outcome} result, NEVER
 *    a throw — the caller degrades explicitly to the pure-lexical path;
 *  - one AbortSignal.timeout per request, NO retry (query 2s / batch 30s);
 *  - localhost only in v1 (ADR 0017 local exception). Remote providers do
 *    not exist here by design: a remote embedding may only ever enter a
 *    slow-lane/offline path, never the fast lane (red line ①).
 *
 * @module embedding
 */

import { execFileSync } from 'node:child_process'

/** Default ollama bind (the plugin's own default; OLLAMA_HOST overrides). */
export const DEFAULT_EMBED_HOST = 'http://127.0.0.1:11434'

/** Provider default model when embeddingModel is the '' sentinel
 *  (spec §7: ollama → nomic-embed-text, 768 dims, A1 §5 measured). */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

/** Query-side timeout — the reranker sits in the spliced hot path; a slow
 *  ollama must lose the race, not the injection. */
export const EMBED_QUERY_TIMEOUT_MS = 2000
/** Batch-side timeout (index rebuild: A1 measured ~9.5s for 137 topics). */
export const EMBED_BATCH_TIMEOUT_MS = 30_000

/** Per-text byte cap before anything leaves the process (query端 p50=153 tok
 *  ~ well under this; the cap only bites on paste pollution). */
export const MAX_TEXT_BYTES = 2048

/** The only provider v1 speaks. Anything else is an explicit
 *  unsupported_provider outcome, not a silent attempt. */
export const SUPPORTED_PROVIDER = 'ollama'

/** The config slice the embed functions need (pass straight from
 *  TopicsConfigValue). '' sentinels: provider off / provider default model. */
export interface EmbeddingConfig {
  provider?: string
  model?: string
  /** Explicit host; absent → OLLAMA_HOST env → DEFAULT_EMBED_HOST. */
  host?: string
}

/** Resolve the ollama base URL: explicit arg wins, then OLLAMA_HOST, then
 *  the localhost default. Bare `host:port` values get the http:// prefix
 *  (ollama's own OLLAMA_HOST convention); trailing slashes are trimmed. */
export function resolveEmbedHost(explicit?: string): string {
  const raw = (explicit ?? process.env.OLLAMA_HOST ?? '').trim()
  const withScheme = raw === '' ? DEFAULT_EMBED_HOST : /^https?:\/\//.test(raw) ? raw : `http://${raw.replace(/^tcp:\/\//, '')}`
  return withScheme.replace(/\/+$/, '')
}

/** '' sentinel → provider default model. */
export function resolveEmbedModel(model?: string): string {
  const m = (model ?? '').trim()
  return m === '' ? DEFAULT_EMBED_MODEL : m
}

/** Truncate a string to ≤ maxBytes UTF-8 bytes WITHOUT splitting a multibyte
 *  character: cut at the byte cap, then back off over any continuation bytes
 *  (0b10xxxxxx) so the decoded tail is never a replacement char. */
export function truncateUtf8(text: string, maxBytes: number = MAX_TEXT_BYTES): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

// ---------------------------------------------------------------------------
// Outcomes — the explicit-degradation vocabulary. Callers branch on `ok`;
// `outcome` is the human/queryable why (降级状态可查, spec §3.1).
// ---------------------------------------------------------------------------

export type EmbeddingFailureOutcome =
  | 'provider_off' // config provider is the '' sentinel — semantic layer off
  | 'unsupported_provider' // configured, but not a v1 provider (no remote!)
  | 'empty_input' // nothing to embed — refused before any network activity
  | 'network' // connect refused / DNS / socket — ollama not serving
  | 'timeout' // the one AbortSignal fired
  | 'model_missing' // ollama answered 404: model not pulled
  | 'http_4xx'
  | 'http_5xx'
  | 'bad_json'
  | 'bad_shape' // 200 but the embeddings array is malformed / dims disagree

export interface EmbedBatchOk {
  ok: true
  /** Vectors aligned 1:1 with the (truncated) input texts. */
  vectors: number[][]
  model: string
  dim: number
  latencyMs: number
}

export interface EmbedQueryOk {
  ok: true
  vector: number[]
  model: string
  dim: number
  latencyMs: number
}

export interface EmbedFailure {
  ok: false
  outcome: EmbeddingFailureOutcome
  message: string
  host: string
  model: string
  latencyMs: number
}

export type EmbedResult = EmbedBatchOk | EmbedFailure
export type EmbedQueryResult = EmbedQueryOk | EmbedFailure
export type ProbeResult = { ok: true; host: string; model: string; dim: number; latencyMs: number } | EmbedFailure

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Shared request path: POST {host}/api/embed, outcome-mode failures only. */
async function embedRequest(
  texts: readonly string[],
  config: EmbeddingConfig,
  timeoutMs: number,
): Promise<EmbedResult> {
  const provider = (config.provider ?? '').trim()
  if (provider === '') {
    return { ok: false, outcome: 'provider_off', message: "embeddingProvider is '' — the semantic layer is off (pure lexical).", host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  if (provider !== SUPPORTED_PROVIDER) {
    return { ok: false, outcome: 'unsupported_provider', message: `embeddingProvider '${provider}' is not supported in v1 (only '${SUPPORTED_PROVIDER}'); remote providers may not enter the fast lane.`, host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  if (texts.length === 0) {
    return { ok: false, outcome: 'empty_input', message: 'no texts to embed.', host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  const host = resolveEmbedHost(config.host)
  const model = resolveEmbedModel(config.model)
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts.map((t) => truncateUtf8(t)) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const outcome: EmbeddingFailureOutcome =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network'
    return { ok: false, outcome, message: `${outcome}: ${err instanceof Error ? err.message : String(err)}`, host, model, latencyMs: Date.now() - started }
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    // ollama answers 404 {"error":"model \"…\" not found, try pulling it first"}
    const outcome: EmbeddingFailureOutcome = res.status === 404 ? 'model_missing' : res.status >= 500 ? 'http_5xx' : 'http_4xx'
    return { ok: false, outcome, message: `ollama responded ${res.status}: ${text}`, host, model, latencyMs: Date.now() - started }
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    return { ok: false, outcome: 'bad_json', message: `non-JSON body: ${err instanceof Error ? err.message : String(err)}`, host, model, latencyMs: Date.now() - started }
  }
  const vectors = isPlainObject(json) ? json.embeddings : undefined
  if (
    !Array.isArray(vectors) ||
    vectors.length !== texts.length ||
    !vectors.every((v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) ||
    new Set(vectors.map((v) => (v as number[]).length)).size !== 1
  ) {
    return { ok: false, outcome: 'bad_shape', message: 'embeddings must be a rectangular [texts.length][dim] array of finite numbers.', host, model, latencyMs: Date.now() - started }
  }
  return { ok: true, vectors: vectors as number[][], model, dim: (vectors[0] as number[]).length, latencyMs: Date.now() - started }
}

/** Batch-embed texts (index build/rebuild path). Vectors align 1:1 with the
 *  input order; each text is truncated to MAX_TEXT_BYTES first. */
export async function embedTexts(
  texts: readonly string[],
  config: EmbeddingConfig = {},
  opts: { timeoutMs?: number } = {},
): Promise<EmbedResult> {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : EMBED_BATCH_TIMEOUT_MS
  return embedRequest(texts, config, timeoutMs)
}

/** Embed one query (reranker hot path, 2s budget). Empty/whitespace queries
 *  fail locally with 'empty_input' — nothing leaves the process. */
export async function embedQuery(
  query: string,
  config: EmbeddingConfig = {},
  opts: { timeoutMs?: number } = {},
): Promise<EmbedQueryResult> {
  if ((query ?? '').trim() === '') {
    return { ok: false, outcome: 'empty_input', message: 'empty query.', host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : EMBED_QUERY_TIMEOUT_MS
  const r = await embedRequest([query], config, timeoutMs)
  if (!r.ok) return r
  return { ok: true, vector: r.vectors[0]!, model: r.model, dim: r.dim, latencyMs: r.latencyMs }
}

/**
 * Probe: is the server there, is the model pulled? One micro embed call —
 * unlike a /api/tags listing it validates the FULL path (server + model +
 * response shape) and yields the vector dim for index validation, at the
 * same 15-30ms cost (A1 §5). Structured result; never throws.
 */
export async function probeEmbedding(config: EmbeddingConfig = {}, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : EMBED_QUERY_TIMEOUT_MS
  const r = await embedRequest(['dsh-topics-memory semantic layer probe'], config, timeoutMs)
  if (!r.ok) return r
  return { ok: true, host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), dim: r.dim, latencyMs: r.latencyMs }
}

/**
 * Build an embedder handle for retrieval's `ensureIndexFresh` — a callable
 * embedTexts bound to this config, carrying the RESOLVED model identity the
 * index must match. ensureIndexFresh reads `.model` only; the actual
 * rebuild stays with the caller.
 */
export function embedderWith(
  config: EmbeddingConfig,
): ((texts: readonly string[]) => Promise<EmbedResult>) & { model: string } {
  const fn = (texts: readonly string[]) => embedTexts(texts, config)
  return Object.assign(fn, { model: resolveEmbedModel(config.model) })
}

// --- Sync query embed (Phase-2 wiring) --------------------------------------
// The spliced hot path is synchronous (the chancelu lesson): retrieveSync
// cannot await. A local ollama query is 15-30ms steady state (A1 §5), so a
// bounded SYNC subprocess call keeps the reranker on the hot lane inside the
// ADR 0017 local exception — hard-capped so a wedged ollama loses the race,
// never the injection. curl ships with the host OS; node has no sync HTTP.

/** Hard sync budget for the hot-lane query embed. Generous over the measured
 *  15-30ms, merciless for a wedged server. */
export const EMBED_QUERY_SYNC_TIMEOUT_MS = 250

export function embedQuerySync(query: string, config: EmbeddingConfig = {}): EmbedQueryResult {
  const provider = (config.provider ?? '').trim()
  if (provider === '') {
    return { ok: false, outcome: 'provider_off', message: "embeddingProvider is '' — the semantic layer is off.", host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  if (provider !== SUPPORTED_PROVIDER) {
    return { ok: false, outcome: 'unsupported_provider', message: `embeddingProvider '${provider}' is not supported in v1.`, host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  if ((query ?? '').trim() === '') {
    return { ok: false, outcome: 'empty_input', message: 'empty query.', host: resolveEmbedHost(config.host), model: resolveEmbedModel(config.model), latencyMs: 0 }
  }
  const host = resolveEmbedHost(config.host)
  const model = resolveEmbedModel(config.model)
  const started = Date.now()
  let raw: string
  try {
    raw = execFileSync(
      'curl',
      [
        '-sS',
        '--max-time', String(Math.ceil(EMBED_QUERY_SYNC_TIMEOUT_MS / 1000)),
        '-X', 'POST', `${host}/api/embed`,
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ model, input: [truncateUtf8(query)] }),
      ],
      { timeout: EMBED_QUERY_SYNC_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const outcome: EmbeddingFailureOutcome = /timed out|ETIMEDOUT|maxTime/i.test(message) ? 'timeout' : 'network'
    return { ok: false, outcome, message: `${outcome}: ${message}`, host, model, latencyMs: Date.now() - started }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, outcome: 'bad_json', message: 'ollama returned non-JSON (sync path).', host, model, latencyMs: Date.now() - started }
  }
  const embeddings = isPlainObject(json) ? (json as Record<string, unknown>).embeddings : undefined
  const first = Array.isArray(embeddings) && embeddings.length > 0 ? embeddings[0] : undefined
  if (!Array.isArray(first)) {
    return { ok: false, outcome: 'bad_shape', message: 'ollama response has no embeddings[0] array (sync path).', host, model, latencyMs: Date.now() - started }
  }
  const vector = (first as unknown[]).filter((n): n is number => typeof n === 'number')
  if (vector.length === 0 || vector.length !== (first as unknown[]).length) {
    return { ok: false, outcome: 'bad_shape', message: 'embeddings[0] malformed (sync path).', host, model, latencyMs: Date.now() - started }
  }
  return { ok: true, vector, model, dim: vector.length, latencyMs: Date.now() - started }
}
