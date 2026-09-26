import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PATTERNS,
  loadExternalSecrets,
  reloadSecrets,
  currentSecrets,
  scanForSecrets,
  describeHit,
} from '../lib/jev/gate.js'

// One hitting sample per builtin pattern — a miss here means the gate would
// let that credential family through (dsh-jev-mcp gate-regression parity).
const SAMPLES = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'openrouter-key': 'sk-or-v1-abcdefghijklmnopqrst',
  'anthropic-key': 'sk-ant-api03-abcdefghijklmnopqrst',
  'openai-project-key': 'sk-proj-abcdefghijklmnopqrst',
  'openai-sk-key': 'sk-12345678901234567890',
  'github-token': 'ghp_abcdefghijklmnopqrstuvwxyz',
  'github-pat': 'github_pat_11ABCDEFGH0abcdefghij123456',
  'gitlab-token': 'glpat-abcdefghijklmnopqrst',
  'slack-token': 'xoxb-1234567890-123456789012',
  'aws-access-key-id': 'AKIAIOSFODNN7EXAMPLE',
  'aws-temp-key-id': 'ASIAIOSFODNN7EXAMPLE',
  'google-api-key': 'AIzaSyA-1234567890_abcdefghij',
  'private-key-block': '-----BEGIN RSA PRIVATE KEY-----',
}

test('gate: builtin pattern table has the 13 families', () => {
  assert.equal(BUILTIN_PATTERNS.length, 13)
})

for (const [name, sample] of Object.entries(SAMPLES)) {
  test(`gate: ${name} sample is caught`, () => {
    const hit = scanForSecrets(JSON.stringify({ model: 'm', state: `token: ${sample}`, questions: {} }))
    assert.ok(hit, 'expected a gate hit')
    assert.equal(hit.pattern, name)
    assert.ok(hit.offset > 0)
    assert.ok(!hit.context.includes(sample), 'context must not echo the secret')
  })
}

test('gate: discussing a prefix without a long continuation does NOT trip', () => {
  const payload = JSON.stringify({
    model: 'm',
    state: 'set OPENROUTER_API_KEY to an sk-or-v1- key, or a ghp_ token, or an AKIA id — discussed, not leaked',
    questions: {},
  })
  assert.equal(scanForSecrets(payload), null)
})

test('gate: clean payload passes', () => {
  assert.equal(scanForSecrets(JSON.stringify({ model: 'jev-1.13-free', state: '用户在讨论 dsh 记忆插件', questions: { c1: { type: 'noul' } } })), null)
})

test('gate: describeHit keeps ≤10 printable chars before the hit, redacts the rest', () => {
  const payload = 'aaTOPSECRET-TAIL'
  const matched = 'TOPSECRET'
  const offset = payload.indexOf(matched) // 2 — as re.exec would report
  const hit = describeHit('test-pattern', offset, matched, payload)
  assert.equal(hit.offset, 2)
  assert.equal(hit.context, 'aa[REDACTED:test-pattern]')
  assert.ok(!hit.context.includes('TOPSECRET'))
  assert.ok(!hit.context.includes('TAIL'))
})

test('gate: non-printable bytes in the before-window are masked', () => {
  const hit = describeHit('p', 4, 'SECRET!!', 'ab\u0000\u00e9SECRET!!')
  assert.equal(hit.context, 'ab..[REDACTED:p]')
})

test('gate: context collapses fully when the window itself repeats the matched text', () => {
  // matched at offset 9; the 10-char window before it contains the match again
  const hit = describeHit('p', 9, 'TOPSECRET', 'TOPSECRETTOPSECRET')
  assert.equal(hit.context, '[REDACTED]')
})

test('gate: external list — valid entries hit, short lines and comments skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topics-jev-gate-'))
  try {
    const file = join(dir, 'secrets')
    const warnings = []
    writeFileSync(file, [
      '# comment line',
      '',
      'corp-token-abc123',
      'short',
      'another-secret-999',
    ].join('\n'), 'utf8')
    const secrets = loadExternalSecrets(file, { warn: (m) => warnings.push(m) })
    assert.equal(secrets.length, 2)
    assert.ok(secrets.includes('corp-token-abc123'))
    assert.ok(secrets.includes('another-secret-999'))
    assert.equal(warnings.length, 1, 'exactly the short-line warning')
    assert.match(warnings[0], /line 4/)

    const hit = scanForSecrets(JSON.stringify({ state: 'payload with corp-token-abc123 inside' }), secrets, file)
    assert.ok(hit)
    assert.equal(hit.pattern, `external(${file})`)
    assert.ok(!hit.context.includes('corp-token-abc123'))

    // the skipped short line must NOT hit
    assert.equal(scanForSecrets(JSON.stringify({ state: 'short' }), secrets, file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: >512-char entries warn but match at FULL length (no truncation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topics-jev-gate-'))
  try {
    const file = join(dir, 'long-secret')
    const warnings = []
    const long = 'S'.repeat(600)
    writeFileSync(file, `${long}\n`, 'utf8')
    const secrets = loadExternalSecrets(file, { warn: (m) => warnings.push(m) })
    assert.equal(secrets.length, 1)
    assert.equal(secrets[0].length, 600)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /600 chars/)
    assert.match(warnings[0], /FULL line/)

    // the entry is loaded at full length and matched at full length
    const hit = scanForSecrets(JSON.stringify({ state: `leak: ${long}` }), secrets, file)
    assert.ok(hit, 'a >512-char secret must still be caught')
    assert.ok(!hit.context.includes('SSSS'), 'context must not echo the secret')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: unreadable secret file warns and continues empty', () => {
  const warnings = []
  assert.deepEqual(loadExternalSecrets('/nonexistent/topics-jev/secrets', { warn: (m) => warnings.push(m) }), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot read jevSecretFile/)
})

test('gate: currentSecrets caches per path; reloadSecrets forces a re-read (volatile hot swap)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topics-jev-gate-'))
  try {
    const file = join(dir, 'secrets')
    writeFileSync(file, 'first-secret-1\n', 'utf8')
    assert.deepEqual(currentSecrets(file), ['first-secret-1'])

    // in-place content change: cached view stays (one-time load semantics)…
    writeFileSync(file, 'second-secret-2\n', 'utf8')
    assert.deepEqual(currentSecrets(file), ['first-secret-1'])
    // …until the /topics set wiring forces the reload
    assert.deepEqual(reloadSecrets(file), ['second-secret-2'])
    assert.deepEqual(currentSecrets(file), ['second-secret-2'])

    // swapping the path reloads on the next call without any explicit reload
    const other = join(dir, 'other')
    writeFileSync(other, 'third-secret-3\n', 'utf8')
    assert.deepEqual(currentSecrets(other), ['third-secret-3'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: empty jevSecretFile means no external secrets, no reads', () => {
  assert.deepEqual(currentSecrets(''), [])
  assert.equal(scanForSecrets('anything at all'), null)
})
