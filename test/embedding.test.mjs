// embedding client tests — hermetic: globalThis.fetch is stubbed, no
// network (jev-client.test.mjs discipline). Every failure path must come
// back as a structured {ok:false, outcome} result, never a throw, and the
// refused paths (provider off / unsupported / empty input) must not touch
// fetch at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  embedTexts,
  embedQuery,
  probeEmbedding,
  embedderWith,
  resolveEmbedHost,
  resolveEmbedModel,
  truncateUtf8,
  DEFAULT_EMBED_HOST,
  DEFAULT_EMBED_MODEL,
  EMBED_QUERY_TIMEOUT_MS,
  EMBED_BATCH_TIMEOUT_MS,
  MAX_TEXT_BYTES,
  SUPPORTED_PROVIDER,
} = await import('../lib/embedding.js')

/** Stub global fetch; handler(url, init) -> Response | Promise<Response>. */
function stubFetch(handler) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  }
  const prev = globalThis.fetch
  globalThis.fetch = stub
  return {
    calls,
    restore: () => {
      globalThis.fetch = prev
    },
  }
}

function embedResponse(vectors, status = 200) {
  return new Response(JSON.stringify({ model: DEFAULT_EMBED_MODEL, embeddings: vectors }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const OLLAMA_CFG = { provider: 'ollama', model: '', host: '' }

test('constants: timeouts, byte cap, provider, defaults', () => {
  assert.equal(DEFAULT_EMBED_HOST, 'http://127.0.0.1:11434')
  assert.equal(DEFAULT_EMBED_MODEL, 'nomic-embed-text')
  assert.equal(SUPPORTED_PROVIDER, 'ollama')
  assert.equal(EMBED_QUERY_TIMEOUT_MS, 2000)
  assert.equal(EMBED_BATCH_TIMEOUT_MS, 30000)
  assert.equal(MAX_TEXT_BYTES, 2048)
})

test('resolveEmbedHost: explicit arg > OLLAMA_HOST env > localhost default; scheme repair', () => {
  assert.equal(resolveEmbedHost(), DEFAULT_EMBED_HOST)
  assert.equal(resolveEmbedHost('  '), DEFAULT_EMBED_HOST)
  const prev = process.env.OLLAMA_HOST
  try {
    process.env.OLLAMA_HOST = '0.0.0.0:11434'
    assert.equal(resolveEmbedHost(), 'http://0.0.0.0:11434')
    process.env.OLLAMA_HOST = 'http://192.168.1.9:11434/'
    assert.equal(resolveEmbedHost(), 'http://192.168.1.9:11434')
    process.env.OLLAMA_HOST = 'tcp://10.0.0.3:11434'
    assert.equal(resolveEmbedHost(), 'http://10.0.0.3:11434')
    // explicit config wins over env
    assert.equal(resolveEmbedHost('127.0.0.1:9999'), 'http://127.0.0.1:9999')
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prev
  }
})

test("resolveEmbedModel: '' sentinel resolves to nomic-embed-text", () => {
  assert.equal(resolveEmbedModel(), DEFAULT_EMBED_MODEL)
  assert.equal(resolveEmbedModel(''), DEFAULT_EMBED_MODEL)
  assert.equal(resolveEmbedModel('  '), DEFAULT_EMBED_MODEL)
  assert.equal(resolveEmbedModel('mxbai-embed-large'), 'mxbai-embed-large')
})

test('truncateUtf8: caps at MAX_TEXT_BYTES without splitting multibyte chars', () => {
  const ascii = 'a'.repeat(5000)
  const cut = truncateUtf8(ascii)
  assert.equal(Buffer.byteLength(cut), MAX_TEXT_BYTES)
  const cjk = '部'.repeat(3000) // 3 bytes each → 9000 bytes
  const cutCjk = truncateUtf8(cjk)
  assert.ok(Buffer.byteLength(cutCjk) <= MAX_TEXT_BYTES)
  assert.ok(!cutCjk.includes('\uFFFD'), 'no replacement chars at the cut')
  assert.ok(MAX_TEXT_BYTES - Buffer.byteLength(cutCjk) < 3, 'cut lands on a char boundary')
  assert.equal(truncateUtf8('短文本'), '短文本')
  assert.equal(truncateUtf8('任意', 0), '')
})

test('embedTexts: normal batch — url, body shape, no auth header, vectors aligned', async () => {
  const s = stubFetch(() => embedResponse([[1, 2, 3], [4, 5, 6]]))
  try {
    const r = await embedTexts(['部署 voice-agent', 'ollama 索引'], OLLAMA_CFG)
    assert.equal(r.ok, true)
    assert.deepEqual(r.vectors, [[1, 2, 3], [4, 5, 6]])
    assert.equal(r.model, 'nomic-embed-text')
    assert.equal(r.dim, 3)
    assert.ok(r.latencyMs >= 0)
    assert.equal(s.calls.length, 1)
    const { url, init } = s.calls[0]
    assert.equal(url, `${DEFAULT_EMBED_HOST}/api/embed`)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.equal(init.headers.authorization, undefined, 'localhost needs no auth')
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'nomic-embed-text')
    assert.deepEqual(body.input, ['部署 voice-agent', 'ollama 索引'])
    assert.ok(init.signal instanceof AbortSignal, 'one AbortSignal.timeout per request')
  } finally {
    s.restore()
  }
})

test('embedTexts: explicit model/host config rides the request', async () => {
  const s = stubFetch(() => embedResponse([[1, 0]]))
  try {
    const r = await embedTexts(['x'], { provider: 'ollama', model: 'mxbai-embed-large', host: '127.0.0.1:11500' })
    assert.equal(r.ok, true)
    assert.equal(r.model, 'mxbai-embed-large')
    assert.equal(s.calls[0].url, 'http://127.0.0.1:11500/api/embed')
    assert.equal(JSON.parse(s.calls[0].init.body).model, 'mxbai-embed-large')
  } finally {
    s.restore()
  }
})

test('embedTexts: OLLAMA_HOST env override feeds the endpoint', async () => {
  const prev = process.env.OLLAMA_HOST
  process.env.OLLAMA_HOST = '127.0.0.1:12345'
  const s = stubFetch(() => embedResponse([[1]]))
  try {
    const r = await embedTexts(['x'], { provider: 'ollama' })
    assert.equal(r.ok, true)
    assert.equal(s.calls[0].url, 'http://127.0.0.1:12345/api/embed')
  } finally {
    s.restore()
    if (prev === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prev
  }
})

test('embedTexts: per-text 2KB truncation before anything leaves the process', async () => {
  const s = stubFetch(() => embedResponse([[1]]))
  try {
    const big = '部'.repeat(3000) // 9000 utf8 bytes
    await embedTexts([big], OLLAMA_CFG)
    const sent = JSON.parse(s.calls[0].init.body).input[0]
    assert.ok(Buffer.byteLength(sent, 'utf8') <= MAX_TEXT_BYTES)
    assert.ok(!sent.includes('\uFFFD'))
  } finally {
    s.restore()
  }
})

test('embedTexts: timeout surfaces as outcome=timeout (never throws)', async () => {
  const s = stubFetch(() => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  })
  try {
    const r = await embedTexts(['x'], OLLAMA_CFG)
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'timeout')
    assert.match(r.message, /timeout/)
    assert.equal(r.host, DEFAULT_EMBED_HOST)
    assert.equal(r.model, 'nomic-embed-text')
  } finally {
    s.restore()
  }
})

test('embedTexts: disconnect (ollama not serving) surfaces as outcome=network', async () => {
  const s = stubFetch(() => {
    throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434')
  })
  try {
    const r = await embedTexts(['x'], OLLAMA_CFG)
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'network')
    assert.match(r.message, /ECONNREFUSED|fetch failed/)
  } finally {
    s.restore()
  }
})

test('embedTexts: ollama 404 = model not pulled → outcome=model_missing', async () => {
  const s = stubFetch(
    () =>
      new Response(JSON.stringify({ error: `model "${DEFAULT_EMBED_MODEL}" not found, try pulling it first` }), {
        status: 404,
      }),
  )
  try {
    const r = await embedTexts(['x'], OLLAMA_CFG)
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'model_missing')
    assert.match(r.message, /not found/)
  } finally {
    s.restore()
  }
})

test('embedTexts: http error classes split 4xx/5xx', async () => {
  const s = stubFetch(() => new Response('bad request', { status: 400 }))
  try {
    const r = await embedTexts(['x'], OLLAMA_CFG)
    assert.equal(r.outcome, 'http_4xx')
  } finally {
    s.restore()
  }
  const s2 = stubFetch(() => new Response('boom', { status: 503 }))
  try {
    const r = await embedTexts(['x'], OLLAMA_CFG)
    assert.equal(r.outcome, 'http_5xx')
  } finally {
    s2.restore()
  }
})

test('embedTexts: non-JSON body → bad_json; ragged/short embeddings → bad_shape', async () => {
  const s = stubFetch(() => new Response('<html>proxy error</html>', { status: 200 }))
  try {
    assert.equal((await embedTexts(['x'], OLLAMA_CFG)).outcome, 'bad_json')
  } finally {
    s.restore()
  }
  for (const bad of [
    [[1, 2]], // length mismatch vs 2 inputs
    [[1, 2], [1, 2], [1, 2]], // extra rows
    [[1, 2], [1]], // ragged dims
    [[1, 'x'], [1, 2]], // non-number
  ]) {
    const s2 = stubFetch(() => embedResponse(bad))
    try {
      const r = await embedTexts(['a', 'b'], OLLAMA_CFG)
      assert.equal(r.ok, false)
      assert.equal(r.outcome, 'bad_shape', JSON.stringify(bad))
    } finally {
      s2.restore()
    }
  }
})

test('embedTexts: refused paths never touch fetch — provider off / unsupported / empty', async () => {
  const s = stubFetch(() => embedResponse([[1]]))
  try {
    const off = await embedTexts(['x'], { provider: '' })
    assert.equal(off.ok, false)
    assert.equal(off.outcome, 'provider_off')
    const unsupported = await embedTexts(['x'], { provider: 'openai' })
    assert.equal(unsupported.ok, false)
    assert.equal(unsupported.outcome, 'unsupported_provider')
    assert.match(unsupported.message, /fast lane/)
    const empty = await embedTexts([], OLLAMA_CFG)
    assert.equal(empty.ok, false)
    assert.equal(empty.outcome, 'empty_input')
    // undefined provider (bare harness) behaves as the '' sentinel
    const bare = await embedTexts(['x'], {})
    assert.equal(bare.outcome, 'provider_off')
    assert.equal(s.calls.length, 0, 'no network activity on any refused path')
  } finally {
    s.restore()
  }
})

test('embedQuery: single vector out; empty query refused locally', async () => {
  const s = stubFetch(() => embedResponse([[7, 8, 9]]))
  try {
    const r = await embedQuery('  部署 voice-agent ', OLLAMA_CFG)
    assert.equal(r.ok, true)
    assert.deepEqual(r.vector, [7, 8, 9])
    assert.equal(r.dim, 3)
    assert.deepEqual(JSON.parse(s.calls[0].init.body).input, ['  部署 voice-agent '])
    const empty = await embedQuery('   ', OLLAMA_CFG)
    assert.equal(empty.ok, false)
    assert.equal(empty.outcome, 'empty_input')
    const off = await embedQuery('q', { provider: '' })
    assert.equal(off.outcome, 'provider_off')
    assert.equal(s.calls.length, 1)
  } finally {
    s.restore()
  }
})

test('embedQuery: failure passthrough keeps the outcome vocabulary', async () => {
  const s = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  try {
    const r = await embedQuery('q', OLLAMA_CFG)
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'network')
  } finally {
    s.restore()
  }
})

test('probeEmbedding: ok path reports host/model/dim; offline and off report structured failures', async () => {
  const s = stubFetch(() => embedResponse([[1, 2, 3, 4]]))
  try {
    const ok = await probeEmbedding(OLLAMA_CFG)
    assert.equal(ok.ok, true)
    assert.equal(ok.host, DEFAULT_EMBED_HOST)
    assert.equal(ok.model, 'nomic-embed-text')
    assert.equal(ok.dim, 4)
  } finally {
    s.restore()
  }
  const s2 = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  try {
    const down = await probeEmbedding(OLLAMA_CFG)
    assert.equal(down.ok, false)
    assert.equal(down.outcome, 'network')
    assert.equal(down.host, DEFAULT_EMBED_HOST, 'failure carries the host for the degraded status line')
  } finally {
    s2.restore()
  }
  const off = await probeEmbedding({ provider: '' })
  assert.equal(off.ok, false)
  assert.equal(off.outcome, 'provider_off')
  const s3 = stubFetch(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
  try {
    const missing = await probeEmbedding(OLLAMA_CFG)
    assert.equal(missing.ok, false)
    assert.equal(missing.outcome, 'model_missing')
  } finally {
    s3.restore()
  }
})

test('embedderWith: binds config, carries the RESOLVED model identity, embeds through', async () => {
  const s = stubFetch(() => embedResponse([[1, 2]]))
  try {
    const fn = embedderWith({ provider: 'ollama', model: '' })
    assert.equal(typeof fn, 'function')
    assert.equal(fn.model, 'nomic-embed-text', "'' sentinel resolved so ensureIndexFresh can compare")
    const r = await fn(['x'])
    assert.equal(r.ok, true)
    assert.deepEqual(r.vectors, [[1, 2]])
    const custom = embedderWith({ provider: 'ollama', model: 'mxbai-embed-large' })
    assert.equal(custom.model, 'mxbai-embed-large')
  } finally {
    s.restore()
  }
})
