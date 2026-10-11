// Injection-quality line config keys (spec §7: embeddingProvider /
// embeddingModel / packageMode) + the default-off guard.
//
// The guard is the hard discipline (zero-open-decay.test.mjs #1 手法): with
// the three keys at their defaults (and with them absent entirely) the end-
// to-end retrieval path is byte-identical — same outcome, same injection
// text, the raw query still reaches the ilog UNSANITIZED, and no
// `semantic-rerank` tag ever appears. The new code is capability-only;
// Phase 2 wires it behind packageMode.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { TopicsConfig, CONFIG_KEYS, displayKey, parseConfigValue } from '../lib/config.js'
import { tokenize } from '../lib/retrieval.js'

const SLUG_A = 'inject-guard-marker-zz7k'
const QUERY = 'inject guard marker zz7k 部署 voice-agent 超时 回滚'
// paste pollution: if the sanitizer were (wrongly) wired into the hot path,
// queryTokenCount and querySample would move.
const POLLUTED = `${QUERY}\n$ npm run build\n参考 https://example.com/log?id=1\n\`\`\`bash\nlsof -i :11434\n\`\`\``

const BASE_CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, injectMode: 'pointer', graphDepth: 0, recencyWindowDays: 0,
  autoObserve: false, observationMaxChars: 2000, distillEveryTurns: 5, distillOnSessionEnd: false,
  distillProvider: '', distillModel: '', pushDebounceSeconds: 45, usageBoost: 0,
}

function makeService(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-injectcfg-'))
  const store = new BundleStore(root, { gitDisabled: true })
  const cfg = { ...BASE_CFG, ...cfgOverrides }
  const service = new TopicsService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { service, store, cfg, cleanup }
}

async function seedTopics(service) {
  await service.saveTopic({ title: 'Inject Guard Marker ZZ7K', conclusion: 'An unrelated English conclusion.' })
  await service.saveTopic({ title: 'Side Topic 无关', description: '蒸馏 适配器', conclusion: '别的领域' })
}

test('GUARD: three keys at defaults (or absent) keep retrieval byte-for-byte identical', async () => {
  const absent = makeService() // new keys not present at all (bare harness)
  const defaults = makeService({ embeddingProvider: '', embeddingModel: '', packageMode: 'off' })
  try {
    for (const m of [absent, defaults]) {
      await m.service.store.ensure()
      await seedTopics(m.service)
    }
    const a = absent.service.retrieveSync(POLLUTED, 's1')
    const b = defaults.service.retrieveSync(POLLUTED, 's1')
    assert.deepEqual(b.outcome, a.outcome, 'identical outcome objects')
    assert.equal(b.text, a.text, 'identical injection text')
    assert.ok(a.outcome.hits.some((h) => h.slug === SLUG_A), 'baseline hit survives')
    for (const outcome of [a.outcome, b.outcome]) {
      for (const h of [...outcome.hits, ...outcome.nearMisses]) {
        assert.equal(h.reasons?.includes('semantic-rerank'), false, 'no semantic tag anywhere')
      }
    }
    // the polluted raw query reaches the record UNSANITIZED (capability is
    // NOT wired into the hot lane)
    const r = await defaults.service.retrieve(POLLUTED, 's1')
    assert.equal(r.recorded, true)
    const record = (await defaults.service.store.readInjectionRecords()).at(-1)
    assert.equal(record.queryTokenCount, tokenize(POLLUTED).length, 'raw token count — sanitizer not wired')
    assert.equal(record.injected, true)
  } finally {
    absent.cleanup()
    defaults.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Config surface (spec §7 四处接线, all volatile, /topics set hot-editable)
// ---------------------------------------------------------------------------

const read = (ref) => (typeof ref?.get === 'function' ? ref.get() : ref)

test('config: schema defaults — semantic layer off, package gate off', () => {
  const cfg = TopicsConfig({})
  assert.equal(read(cfg.embeddingProvider), '', "'' sentinel = semantic layer off")
  assert.equal(read(cfg.embeddingModel), '', "'' = provider default (nomic-embed-text)")
  assert.equal(read(cfg.packageMode), 'off', 'A-line master gate default off')
  const set = TopicsConfig({ embeddingProvider: 'ollama', embeddingModel: 'mxbai-embed-large', packageMode: 'shadow' })
  assert.equal(read(set.embeddingProvider), 'ollama')
  assert.equal(read(set.embeddingModel), 'mxbai-embed-large')
  assert.equal(read(set.packageMode), 'shadow')
})

test('config: keys are volatile (schemastery live refs) and listed in CONFIG_KEYS', () => {
  const cfg = TopicsConfig({})
  for (const key of ['embeddingProvider', 'embeddingModel', 'packageMode']) {
    assert.ok(typeof cfg[key]?.get === 'function', `${key} resolves to a live {get} ref (volatile)`)
    assert.ok(CONFIG_KEYS.includes(key))
  }
  assert.equal(displayKey('embeddingProvider'), 'embedding-provider')
  assert.equal(displayKey('embeddingModel'), 'embedding-model')
  assert.equal(displayKey('packageMode'), 'package-mode')
})

test('config: parseConfigValue — embeddingProvider v1 whitelist (ollama or empty)', () => {
  assert.equal(parseConfigValue('embeddingProvider', ''), '')
  assert.equal(parseConfigValue('embeddingProvider', 'ollama'), 'ollama')
  assert.match(parseConfigValue('embeddingProvider', 'openai').error, /ollama/)
  assert.match(parseConfigValue('embeddingProvider', 'Ollama').error, /ollama/, 'case-sensitive on purpose')
})

test('config: parseConfigValue — embeddingModel free string', () => {
  assert.equal(parseConfigValue('embeddingModel', ''), '')
  assert.equal(parseConfigValue('embeddingModel', 'nomic-embed-text'), 'nomic-embed-text')
})

test('config: parseConfigValue — packageMode three states', () => {
  for (const v of ['off', 'shadow', 'on']) assert.equal(parseConfigValue('packageMode', v), v)
  assert.match(parseConfigValue('packageMode', 'true').error, /off\|shadow\|on/)
  assert.match(parseConfigValue('packageMode', '').error, /off\|shadow\|on/)
})
