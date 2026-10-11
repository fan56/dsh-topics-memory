// semantic rerank tests (A4 决议 2, spec §3.1): synthetic vectors prove the
// cosine reordering of the 0.20–0.30 nearFloor band, the `semantic-rerank`
// reason + similarity tag, and EVERY degradation path passing candidates
// through in original order with an explicit why (原序透传，不许静默).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rerankNearFloor,
  cosineSimilarity,
  loadEmbeddingIndex,
  saveEmbeddingIndex,
  ensureIndexFresh,
  embeddingIndexPath,
  RERANK_FLOOR,
  RERANK_CEILING,
  SEMANTIC_RERANK_REASON,
} from '../lib/retrieval.js'

function hit(slug, gateScore, reasons = []) {
  return { slug, score: gateScore, reasons, viaGraph: false, strong: false, bodyHits: 1, gateScore }
}

// query vector = e1; B is near-parallel, C diagonal, A orthogonal.
const QUERY = [1, 0, 0]
const INDEX = {
  'a-orthogonal': { model: 'nomic-embed-text', dim: 3, vec: [0, 1, 0] },
  'b-parallel': { model: 'nomic-embed-text', dim: 3, vec: [0.9, 0.1, 0] },
  'c-diagonal': { model: 'nomic-embed-text', dim: 3, vec: [0.6, 0.8, 0] },
}
const BAND = [hit('a-orthogonal', 0.25), hit('b-parallel', 0.22), hit('c-diagonal', 0.28)]

test('cosineSimilarity: identical/orthogonal/opposite/mismatch/zero', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [2, 4]) - 1) < 1e-12)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, 'dim mismatch → 0, never throws')
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector → 0')
})

test('band constants: 0.20–0.30 (the 93% near-miss mass, spec 口径消歧)', () => {
  assert.equal(RERANK_FLOOR, 0.2)
  assert.equal(RERANK_CEILING, 0.3)
})

test('rerank reorders the band by cosine, tags reasons, exposes similarity, never re-scores', () => {
  const r = rerankNearFloor('部署 ollama', QUERY, BAND, INDEX)
  assert.equal(r.reranked, true)
  assert.equal(r.passthroughReason, undefined)
  assert.deepEqual(
    r.hits.map((h) => h.slug),
    ['b-parallel', 'c-diagonal', 'a-orthogonal'],
  )
  for (const h of r.hits) {
    assert.ok(h.reasons.includes(SEMANTIC_RERANK_REASON), 'tag appended')
    assert.equal(h.reasons.filter((x) => x === SEMANTIC_RERANK_REASON).length, 1, 'tag exactly once')
    assert.ok(typeof h.similarity === 'number')
    assert.ok(h.similarity >= -1 && h.similarity <= 1)
  }
  assert.ok(Math.abs(r.hits[0].similarity - 0.9939) < 1e-4, `cos(0.9,0.1,0 · e1) = 0.99388, got ${r.hits[0].similarity}`)
  assert.ok(Math.abs(r.hits[1].similarity - 0.6) < 1e-4)
  assert.ok(Math.abs(r.hits[2].similarity - 0) < 1e-4)
  // scores untouched — reordering only
  for (const h of r.hits) assert.equal(h.score, h.gateScore)
  // input array untouched (pure function)
  assert.equal(BAND[0].slug, 'a-orthogonal')
  assert.equal(BAND[0].reasons.includes(SEMANTIC_RERANK_REASON), false)
})

test('ties keep input order (stable sort)', () => {
  const idx = {
    x1: { model: 'm', dim: 2, vec: [1, 0] },
    x2: { model: 'm', dim: 2, vec: [1, 0] },
    x3: { model: 'm', dim: 2, vec: [1, 0] },
  }
  const r = rerankNearFloor('q', [1, 0], [hit('x3', 0.21), hit('x1', 0.25), hit('x2', 0.23)], idx)
  assert.deepEqual(r.hits.map((h) => h.slug), ['x3', 'x1', 'x2'])
})

test('out-of-band candidates (0.15–0.20 / ≥0.30) ride through at the tail, untagged', () => {
  const candidates = [
    hit('b-parallel', 0.22),
    hit('below-floor', 0.18), // 0.15–0.20 段不参与重排
    hit('above-ceiling', 0.31),
  ]
  const r = rerankNearFloor('q', QUERY, candidates, { ...INDEX, 'below-floor': INDEX['b-parallel'], 'above-ceiling': INDEX['c-diagonal'] })
  assert.equal(r.reranked, true)
  assert.deepEqual(r.hits.map((h) => h.slug), ['b-parallel', 'below-floor', 'above-ceiling'])
  assert.equal(r.hits[1].similarity, undefined)
  assert.equal(r.hits[1].reasons.includes(SEMANTIC_RERANK_REASON), false)
  assert.equal(r.hits[2].reasons.includes(SEMANTIC_RERANK_REASON), false)
})

test('unindexed / model-mismatched / dim-broken candidates ride through at the tail', () => {
  const candidates = [hit('b-parallel', 0.22), hit('not-in-index', 0.25)]
  const r1 = rerankNearFloor('q', QUERY, candidates, INDEX)
  assert.deepEqual(r1.hits.map((h) => h.slug), ['b-parallel', 'not-in-index'])
  assert.equal(r1.hits[1].reasons.includes(SEMANTIC_RERANK_REASON), false)

  const r2 = rerankNearFloor('q', QUERY, BAND, INDEX, { expectedModel: 'mxbai-embed-large' })
  assert.equal(r2.reranked, false)
  assert.equal(r2.passthroughReason, 'no-rerankable-candidates', 'every entry built by another model')

  const broken = { 'b-parallel': { model: 'nomic-embed-text', dim: 3, vec: [1, 0] } } // dim 3 vs vec.length 2
  const r3 = rerankNearFloor('q', QUERY, [hit('b-parallel', 0.22)], broken)
  assert.equal(r3.reranked, false)
  assert.equal(r3.passthroughReason, 'no-rerankable-candidates')

  const r4 = rerankNearFloor('q', [1, 0, 0, 0], BAND, INDEX, undefined) // dim mismatch vs index
  assert.equal(r4.reranked, false)
  assert.equal(r4.passthroughReason, 'no-rerankable-candidates')
})

test('explicit total degradation: no query vector / empty index / no candidates', () => {
  const noVec = rerankNearFloor('部署 ollama', null, BAND, INDEX)
  assert.equal(noVec.reranked, false)
  assert.equal(noVec.passthroughReason, 'no-query-vector')
  assert.deepEqual(noVec.hits, BAND, 'input order byte-identical')
  for (const h of noVec.hits) assert.equal(h.reasons.includes(SEMANTIC_RERANK_REASON), false)

  const emptyVec = rerankNearFloor('q', [], BAND, INDEX)
  assert.equal(emptyVec.passthroughReason, 'no-query-vector')

  const noIndex = rerankNearFloor('q', QUERY, BAND, {})
  assert.equal(noIndex.reranked, false)
  assert.equal(noIndex.passthroughReason, 'empty-index')
  assert.deepEqual(noIndex.hits, BAND)

  const noCandidates = rerankNearFloor('q', QUERY, [], INDEX)
  assert.equal(noCandidates.reranked, false)
  assert.equal(noCandidates.passthroughReason, 'no-candidates')
  assert.deepEqual(noCandidates.hits, [])
})

test('loadEmbeddingIndex/saveEmbeddingIndex: round trip, missing/corrupt → empty, bad entries skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'topics-embed-idx-'))
  try {
    assert.deepEqual(loadEmbeddingIndex(root), {}, 'missing file → explicit empty index')

    saveEmbeddingIndex(root, { 's1': { model: 'nomic-embed-text', dim: 2, vec: [1, 2] } })
    assert.equal(readFileSync(embeddingIndexPath(root), 'utf8'), JSON.stringify({ 's1': { model: 'nomic-embed-text', dim: 2, vec: [1, 2] } }))
    const loaded = loadEmbeddingIndex(root)
    assert.deepEqual(loaded['s1'], { model: 'nomic-embed-text', dim: 2, vec: [1, 2] })

    writeFileSync(embeddingIndexPath(root), '{not json')
    assert.deepEqual(loadEmbeddingIndex(root), {}, 'corrupt JSON → empty, never throws')
    writeFileSync(embeddingIndexPath(root), '[1,2]')
    assert.deepEqual(loadEmbeddingIndex(root), {}, 'non-object top level → empty')

    writeFileSync(
      embeddingIndexPath(root),
      JSON.stringify({
        good: { model: 'm', dim: 2, vec: [1, 2] },
        badDim: { model: 'm', dim: 3, vec: [1, 2] },
        badVec: { model: 'm', dim: 2, vec: [1, 'x'] },
        noModel: { dim: 2, vec: [1, 2] },
        notAnEntry: 'nope',
      }),
    )
    const picked = loadEmbeddingIndex(root)
    assert.deepEqual(Object.keys(picked), ['good'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureIndexFresh: missing / model-changed / shape-broken listed; fresh and off stay silent', () => {
  const topics = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }]
  const embedder = { model: 'nomic-embed-text' }
  const fn = Object.assign(async () => ({}), { model: 'nomic-embed-text' })

  assert.deepEqual(ensureIndexFresh({}, topics, fn), ['a', 'b', 'c'], 'empty index → everything stale')
  const index = {
    a: { model: 'nomic-embed-text', dim: 2, vec: [1, 0] },
    b: { model: 'mxbai-embed-large', dim: 2, vec: [1, 0] }, // other model
    c: { model: 'nomic-embed-text', dim: 3, vec: [1, 0] }, // shape-broken
  }
  assert.deepEqual(ensureIndexFresh(index, topics, fn), ['b', 'c'])
  const full = {
    a: { model: 'nomic-embed-text', dim: 2, vec: [1, 0] },
    b: { model: 'nomic-embed-text', dim: 2, vec: [0, 1] },
    c: { model: 'nomic-embed-text', dim: 2, vec: [1, 1] },
  }
  assert.deepEqual(ensureIndexFresh(full, topics, fn), [], 'covered roster → nothing to do')
  assert.deepEqual(ensureIndexFresh(index, topics, Object.assign(fn, { model: '' })), [], "'' model = semantic layer off → no maintenance")
  assert.deepEqual(ensureIndexFresh(full, topics, embedder), [], 'plain {model} handle also works (structural)')
})
