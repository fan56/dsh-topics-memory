import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { BundleStore } from '../lib/store.js'
import { Sync } from '../lib/sync.js'
import { unpushedCount } from '../lib/git.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'topics-sync-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function seed(store) {
  await store.ensure()
  await store.saveTopic(
    { slug: 'alpha', doc: { fm: { type: 'Topic', title: 'A', tags: [], depends: [], open_questions: [], impact: [], status: 'draft', generated: { by: 't', at: '2026-08-31T00:00:00Z' } }, body: 'one\n' } },
    { message: 'seed' },
  )
}

test('sync: inactive in local-only mode', async () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new BundleStore(dir, { gitDisabled: true })
    const sync = new Sync(store, () => ({ repo: '', pushDebounceSeconds: 5 }))
    assert.equal(sync.active, false)
    const pull = await sync.pull()
    assert.equal(pull.ok, true)
    assert.match(pull.message, /local-only/)
    const flush = await sync.flush()
    assert.equal(flush.ok, true)
    sync.schedulePush() // must be a no-op, no timer
    sync.dispose()
  } finally {
    cleanup()
  }
})

test('sync: pull + debounced push against a bare remote', async () => {
  const work = tmp()
  const bare = mkdtempSync(join(tmpdir(), 'topics-bare-'))
  try {
    const store = new BundleStore(work.dir)
    await seed(store)
    execFileSync('git', ['init', '--bare', '-b', 'main', join(bare, 'origin.git')], { stdio: 'pipe' })
    const cfg = { repo: 'owner/name', pushDebounceSeconds: 1 }
    const sync = new Sync(store, () => cfg, async () => undefined, (repo) => join(bare, 'origin.git'))
    assert.equal(sync.active, true)
    // First push: local repo has no upstream; push sets origin/main? git push origin main works even without upstream.
    const r = await sync.flush()
    assert.equal(r.ok, true, r.message)
    // A second machine clones and pulls cleanly.
    const other = mkdtempSync(join(tmpdir(), 'topics-other-'))
    try {
      execFileSync('git', ['clone', join(bare, 'origin.git'), other], { stdio: 'pipe' })
      writeFileSync(join(other, 'topics/beta.md'), '---\ntype: Topic\ntitle: B\n---\n', 'utf8')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: other, stdio: 'pipe' })
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'beta'], { cwd: other, stdio: 'pipe' })
      execFileSync('git', ['push'], { cwd: other, stdio: 'pipe' })
      const pull = await sync.pull()
      assert.equal(pull.ok, true, pull.message)
      assert.match(await readFile(join(work.dir, 'topics/beta.md'), 'utf8'), /title: B/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    // schedulePush fires within the debounce window and pushes.
    await store.saveTopic(
      { slug: 'gamma', doc: { fm: { type: 'Topic', title: 'G', tags: [], depends: [], open_questions: [], impact: [], status: 'draft', generated: { by: 't', at: '2026-08-31T00:00:00Z' } }, body: 'g\n' } },
      { message: 'gamma' },
    )
    sync.schedulePush()
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const head = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: work.dir, encoding: 'utf8' }).trim()
    const local = execFileSync('git', ['rev-parse', 'main'], { cwd: work.dir, encoding: 'utf8' }).trim()
    assert.equal(head, local, 'debounced push landed')
    sync.dispose()
  } finally {
    work.cleanup()
    rmSync(bare, { recursive: true, force: true })
  }
})

test('sync: conflicting edit marks conflicted topics on pull', async () => {
  const work = tmp()
  const bare = mkdtempSync(join(tmpdir(), 'topics-bare-'))
  try {
    const store = new BundleStore(work.dir)
    await seed(store)
    execFileSync('git', ['init', '--bare', '-b', 'main', join(bare, 'origin.git')], { stdio: 'pipe' })
    const sync = new Sync(store, () => ({ repo: 'o/n', pushDebounceSeconds: 30 }), async () => undefined, (repo) => join(bare, 'origin.git'))
    assert.equal((await sync.flush()).ok, true)
    const other = mkdtempSync(join(tmpdir(), 'topics-other-'))
    try {
      execFileSync('git', ['clone', join(bare, 'origin.git'), other], { stdio: 'pipe' })
      writeFileSync(join(other, 'topics/alpha.md'), 'remote side\n', 'utf8')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: other, stdio: 'pipe' })
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'remote edit'], { cwd: other, stdio: 'pipe' })
      execFileSync('git', ['push'], { cwd: other, stdio: 'pipe' })
      // Local side rewrites the same topic.
      writeFileSync(join(work.dir, 'topics/alpha.md'), 'local side\n', 'utf8')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: work.dir, stdio: 'pipe' })
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'local edit'], { cwd: work.dir, stdio: 'pipe' })
      const pull = await sync.pull()
      assert.equal(pull.ok, false)
      assert.deepEqual(pull.conflicted, ['alpha'])
      assert.deepEqual([...(await store.getConflicts())], ['alpha'])
      // Local content untouched (rebase aborted).
      assert.equal(await readFile(join(work.dir, 'topics/alpha.md'), 'utf8'), 'local side\n')
      // Resolve by making local authoritative (force push), then a clean pull
      // clears the conflict marks.
      execFileSync('git', ['push', '--force', 'origin', 'main'], { cwd: work.dir, stdio: 'pipe' })
      const pull2 = await sync.pull()
      assert.equal(pull2.ok, true, pull2.message)
      assert.equal((await store.getConflicts()).size, 0)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    work.cleanup()
    rmSync(bare, { recursive: true, force: true })
  }
})

test('sync: pull replays the push deferred by a local-only exit', async () => {
  const work = tmp()
  const bare = mkdtempSync(join(tmpdir(), 'topics-bare-'))
  const other = mkdtempSync(join(tmpdir(), 'topics-other-'))
  try {
    const store = new BundleStore(work.dir)
    await seed(store)
    execFileSync('git', ['init', '--bare', '-b', 'main', join(bare, 'origin.git')], { stdio: 'pipe' })
    const sync = new Sync(store, () => ({ repo: 'o/n', pushDebounceSeconds: 3600 }), async () => undefined, (repo) => join(bare, 'origin.git'))
    // Land a base so the bare remote has main, then simulate the local-only
    // exit: one further commit that never leaves the machine.
    assert.equal((await sync.flush()).ok, true)
    await store.saveTopic(
      { slug: 'gamma', doc: { fm: { type: 'Topic', title: 'G', tags: [], depends: [], open_questions: [], impact: [], status: 'draft', generated: { by: 't', at: '2026-08-31T00:00:00Z' } }, body: 'g\n' } },
      { message: 'gamma' },
    )
    assert.equal(await unpushedCount(work.dir), 1, 'the exit backlog sits unpushed')
    // A second machine advances the remote past the base.
    execFileSync('git', ['clone', join(bare, 'origin.git'), other], { stdio: 'pipe' })
    writeFileSync(join(other, 'topics/beta.md'), '---\ntype: Topic\ntitle: B\n---\n', 'utf8')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: other, stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'beta'], { cwd: other, stdio: 'pipe' })
    execFileSync('git', ['push'], { cwd: other, stdio: 'pipe' })
    // The boot pull rebases onto beta AND replays the deferred push.
    const pull = await sync.pull()
    assert.equal(pull.ok, true, pull.message)
    const head = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: work.dir, encoding: 'utf8' }).trim()
    const local = execFileSync('git', ['rev-parse', 'main'], { cwd: work.dir, encoding: 'utf8' }).trim()
    assert.equal(head, local, 'the deferred push landed during pull')
    assert.match(await readFile(join(work.dir, 'topics/beta.md'), 'utf8'), /title: B/)
  } finally {
    work.cleanup()
    rmSync(other, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})
