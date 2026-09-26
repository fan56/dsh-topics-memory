import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TopicsConfig, CONFIG_KEYS, displayKey, parseConfigValue } from '../lib/config.js'

// Schemastery resolves volatile fields into live {get()} refs on real hosts;
// bare harnesses may hand back plain values — accept both.
function read(ref) {
  return typeof ref?.get === 'function' ? ref.get() : ref
}

test('config: jev* defaults (design §4 — default-off, zen, model sentinel, 3s timeout, no secret file)', () => {
  const resolved = TopicsConfig({})
  assert.equal(read(resolved.jevEnabled), false)
  assert.equal(read(resolved.jevBackend), 'zen')
  assert.equal(read(resolved.jevModel), '') // '' = resolve per backend at call time
  assert.equal(read(resolved.jevTimeoutMs), 3000)
  assert.equal(read(resolved.jevSecretFile), '')
})

test('config: jev* keys accept explicit values', () => {
  const resolved = TopicsConfig({ jevEnabled: true, jevBackend: 'native', jevModel: 'jev-1.13.0', jevTimeoutMs: 8000, jevSecretFile: '/tmp/secrets' })
  assert.equal(read(resolved.jevEnabled), true)
  assert.equal(read(resolved.jevBackend), 'native')
  assert.equal(read(resolved.jevModel), 'jev-1.13.0')
  assert.equal(read(resolved.jevTimeoutMs), 8000)
  assert.equal(read(resolved.jevSecretFile), '/tmp/secrets')
})

test('config: CONFIG_KEYS carries the five jev keys; display uses kebab', () => {
  for (const key of ['jevEnabled', 'jevBackend', 'jevModel', 'jevTimeoutMs', 'jevSecretFile']) {
    assert.ok(CONFIG_KEYS.includes(key), `CONFIG_KEYS missing ${key}`)
  }
  assert.equal(displayKey('jevEnabled'), 'jev-enabled')
  assert.equal(displayKey('jevBackend'), 'jev-backend')
  assert.equal(displayKey('jevModel'), 'jev-model')
  assert.equal(displayKey('jevTimeoutMs'), 'jev-timeout-ms')
  assert.equal(displayKey('jevSecretFile'), 'jev-secret-file')
})

test('config: parseConfigValue jev-enabled on|off', () => {
  assert.equal(parseConfigValue('jevEnabled', 'on'), true)
  assert.equal(parseConfigValue('jevEnabled', 'true'), true)
  assert.equal(parseConfigValue('jevEnabled', 'off'), false)
  assert.equal(parseConfigValue('jevEnabled', 'false'), false)
  assert.deepEqual(parseConfigValue('jevEnabled', 'yes'), { error: 'jevEnabled 取值 on|off' })
})

test('config: parseConfigValue jev-backend enum', () => {
  assert.equal(parseConfigValue('jevBackend', 'zen'), 'zen')
  assert.equal(parseConfigValue('jevBackend', 'native'), 'native')
  assert.equal(parseConfigValue('jevBackend', 'openrouter'), 'openrouter')
  assert.deepEqual(parseConfigValue('jevBackend', 'auto'), { error: 'jev-backend 取值 zen|native|openrouter' })
})

test('config: parseConfigValue jev-timeout-ms non-negative integer', () => {
  assert.equal(parseConfigValue('jevTimeoutMs', '0'), 0)
  assert.equal(parseConfigValue('jevTimeoutMs', '1500'), 1500)
  assert.deepEqual(parseConfigValue('jevTimeoutMs', '1.5'), { error: 'jevTimeoutMs 需要非负整数' })
  assert.deepEqual(parseConfigValue('jevTimeoutMs', '-3'), { error: 'jevTimeoutMs 需要非负整数' })
  assert.deepEqual(parseConfigValue('jevTimeoutMs', 'abc'), { error: 'jevTimeoutMs 需要非负整数' })
})

test('config: parseConfigValue jev-model / jev-secret-file pass raw strings (empty sentinel allowed)', () => {
  assert.equal(parseConfigValue('jevModel', 'jev-1.13.0'), 'jev-1.13.0')
  assert.equal(parseConfigValue('jevModel', ''), '')
  assert.equal(parseConfigValue('jevSecretFile', '/Users/x/.config/jev-secrets'), '/Users/x/.config/jev-secrets')
  assert.equal(parseConfigValue('jevSecretFile', ''), '')
})
