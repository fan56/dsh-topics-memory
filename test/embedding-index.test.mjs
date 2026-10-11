import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'

// Mock ollama: deterministic 8-dim vectors from the input text, request
// counter exposed for freshness/idempotence assertions.
let requests = 0
let server
let serverHost

function vecFor(text) {
  const v = new Array(8).fill(0)
  for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % 8] += 1
  return v
}

beforeEach(async () => {
  requests = 0
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests += 1
      let input = []
      try {
        input = JSON.parse(body).input ?? []
      } catch { /* bad body → empty */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ embeddings: input.map((t) => vecFor(String(t))) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverHost = `http://127.0.0.1:${server.address().port}`
  process.env.OLLAMA_HOST = serverHost
  process.env.DSH_TOPICS_HOME = mkdtempSync(join(tmpdir(), 'embed-index-'))
})

afterEach(() => {
  const root = process.env.DSH_TOPICS_HOME
  delete process.env.OLLAMA_HOST
  delete process.env.DSH_TOPICS_HOME
  server.close()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

const CFG = (over = {}) => ({
  autoInject: false,
  matchThreshold: 0.3,
  topK: 4,
  injectMode: 'pointer',
  packageMode: 'shadow',
  embeddingProvider: 'ollama',
  embeddingModel: 'index-test-model',
  ...over,
})

const setup = async (cfgOverrides = {}) => {
  const root = process.env.DSH_TOPICS_HOME
  const store = new BundleStore(root, { gitDisabled: true })
  const service = new TopicsService(store, () => CFG(cfgOverrides))
  await service.saveTopic({ title: 'Volvo Proxy Kubectl Guide QX7QZ', conclusion: 'kubectl must go through the corporate proxy.' })
  requests = 0
  return { root, service }
}

const indexPath = (root) => join(root, 'meta', 'embeddings.json')

test('embedding index: packageMode off → refresh is a no-op (default-off byte-for-byte)', async () => {
  const { root, service } = await setup({ packageMode: 'off' })
  await service.refreshEmbeddingIndex()
  assert.equal(existsSync(indexPath(root)), false)
  assert.equal(requests, 0)
})

test('embedding index: builds index for fresh roster, entries carry the resolved model', async () => {
  const { root, service } = await setup()
  await service.refreshEmbeddingIndex()
  assert.equal(existsSync(indexPath(root)), true)
  const index = JSON.parse(readFileSync(indexPath(root), 'utf8'))
  const slugs = Object.keys(index)
  assert.equal(slugs.length, 1)
  assert.equal(index[slugs[0]].model, 'index-test-model')
  assert.equal(index[slugs[0]].vec.length, 8)
  assert.ok(requests >= 1)
})

test('embedding index: second refresh is idempotent — zero new requests', async () => {
  const { service, root } = await setup()
  await service.refreshEmbeddingIndex()
  const afterBuild = requests
  assert.ok(afterBuild >= 1)
  await service.refreshEmbeddingIndex()
  assert.equal(requests, afterBuild)
  assert.ok(existsSync(indexPath(root)))
})

test('embedding index: model change triggers rebuild with the new model tag', async () => {
  const { root, service } = await setup()
  await service.refreshEmbeddingIndex()
  const before = requests
  service.getConfig = () => CFG({ embeddingModel: 'other-model' })
  // cfg getter delegates to getConfig — swap via the same handle the service uses.
  await service.refreshEmbeddingIndex()
  assert.ok(requests > before, 'stale-by-model entries must be re-embedded')
  const index = JSON.parse(readFileSync(indexPath(root), 'utf8'))
  for (const entry of Object.values(index)) assert.equal(entry.model, 'other-model')
})
