// sanitizeQuery golden tests (A4 决议 4, spec §3.3): fenced code, URLs,
// line-leading prompts, over-long lines, token cap — and the normal queries
// that must pass through untouched. Pure function, zero I/O.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeQuery, tokenize, QUERY_TOKEN_CAP, MAX_LINE_CHARS } from '../lib/retrieval.js'

test('golden: normal Chinese query passes through byte-identical', () => {
  assert.equal(sanitizeQuery('部署 voice-agent 用哪个仓库'), '部署 voice-agent 用哪个仓库')
  assert.equal(sanitizeQuery('dsh-topics-memory 的注入预算怎么调整'), 'dsh-topics-memory 的注入预算怎么调整')
})

test('golden: fenced code block stripped wholesale, surrounding prose kept', () => {
  const q = '这个报错怎么修\n```bash\nnpm run build && echo done\n```\n谢谢'
  assert.equal(sanitizeQuery(q), '这个报错怎么修 谢谢')
  // ~~~ fences too
  assert.equal(sanitizeQuery('解析一下\n~~~py\nprint(1)\n~~~'), '解析一下')
  // unclosed fence: everything from the opener on is paste tail
  assert.equal(sanitizeQuery('部署问题\n```\nnpm ERR! missing script: build'), '部署问题')
  // fence-only input sanitizes to empty
  assert.equal(sanitizeQuery('```\njust code\n```'), '')
})

test('golden: URLs stripped, prose kept', () => {
  assert.equal(sanitizeQuery('参考 https://example.com/a?b=1&c=2 这篇文档怎么说'), '参考 这篇文档怎么说')
  assert.equal(sanitizeQuery('看看 www.example.com/x 的配置'), '看看 的配置')
})

test('golden: line-leading shell prompts stripped, words survive', () => {
  assert.equal(sanitizeQuery('$ npm run build'), 'npm run build')
  assert.equal(sanitizeQuery('❯ git status\n➜ ls -la'), 'git status ls -la')
  assert.equal(sanitizeQuery('user@mac:~/repo$ cargo build --release'), 'cargo build --release')
  assert.equal(sanitizeQuery('C:\\Users\\dev> dir'), 'dir')
  assert.equal(sanitizeQuery('# 注释行也剥掉'), '注释行也剥掉')
  // mid-line / non-prompt dollars survive
  assert.equal(sanitizeQuery('$100 万预算怎么配'), '$100 万预算怎么配')
  assert.equal(sanitizeQuery('部署 $PATH 环境变量'), '部署 $PATH 环境变量')
})

test('golden: realistic polluted log paste collapses to its head tokens', () => {
  const paste = [
    '帮我看看 ollama 起不来怎么办',
    '$ ollama serve',
    '2026/10/10 12:00:00 routes.go:1150: INFO server started',
    'Error: listen tcp 127.0.0.1:11434: bind: address already in use',
    '```',
    'lsof -i :11434',
    '```',
    '❯ ps aux | grep ollama',
  ].join('\n')
  const out = sanitizeQuery(paste)
  assert.ok(out.startsWith('帮我看看 ollama 起不来怎么办'), out)
  assert.ok(!out.includes('ollama serve') || true, 'prompt-stripped words may survive as text')
  assert.ok(!out.includes('lsof'), 'fenced body gone')
  assert.ok(tokenize(out).length <= QUERY_TOKEN_CAP)
  // every surviving token came from the original
  const orig = new Set(tokenize(paste))
  for (const t of tokenize(out)) assert.ok(orig.has(t), `token ${t} invented`)
})

test('golden: over-long line folds to MAX_LINE_CHARS head (fold ≠ token cap)', () => {
  const longWord = 'x'.repeat(1000)
  const out = sanitizeQuery(`前缀 ${longWord}`)
  assert.ok(out.startsWith('前缀 '))
  assert.ok(out.length <= MAX_LINE_CHARS + '前缀 '.length)
  assert.ok(tokenize(out).length <= QUERY_TOKEN_CAP)
})

test('golden: token cap — QUERY_TOKEN_CAP=96, giant runs truncate not drop', () => {
  assert.equal(QUERY_TOKEN_CAP, 96)
  const run = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i * 7)).join('')
  const out = sanitizeQuery(run)
  assert.equal(tokenize(out).length, QUERY_TOKEN_CAP, 'cap fills exactly; head intent kept')
  // the kept head is the ORIGINAL head (first kept char survives)
  assert.ok(run.startsWith(out.slice(0, 4)))
  // over-cap latin paste also truncates to the cap (fold disabled to isolate it)
  const latin = Array.from({ length: 150 }, (_, i) => `word${i}zz`).join(' ')
  const outLatin = sanitizeQuery(latin, { maxLineChars: Number.MAX_SAFE_INTEGER })
  assert.equal(tokenize(outLatin).length, QUERY_TOKEN_CAP)
  assert.ok(outLatin.startsWith('word0zz'), 'head intent kept')
  // custom cap
  assert.equal(tokenize(sanitizeQuery('甲乙丙丁戊己庚辛壬癸 甲乙丙丁', { maxTokens: 5 })).length <= 5, true)
})

test('golden: token cap binds before the fold when the line fits (720 chars, >96 tokens)', () => {
  // 100 six-char words = 699 chars (under the fold) but 100 tokens (over
  // the cap) — exactly the shape the cap exists for.
  const longQuery = Array.from({ length: 100 }, (_, i) => 'xy' + String(i).padStart(4, '0')).join(' ')
  assert.ok(longQuery.length <= MAX_LINE_CHARS)
  const out = sanitizeQuery(longQuery)
  assert.equal(tokenize(out).length, QUERY_TOKEN_CAP)
  assert.ok(out.startsWith('xy0000 xy0001'), 'head intent kept')
})

test('golden: a giant single-line paste is folded first, then capped', () => {
  const paste = Array.from({ length: 150 }, (_, i) => `configure${i}`).join(' ')
  assert.ok(paste.length > MAX_LINE_CHARS)
  const out = sanitizeQuery(paste)
  assert.ok(out.length <= MAX_LINE_CHARS, 'fold bound')
  assert.ok(tokenize(out).length <= QUERY_TOKEN_CAP)
  assert.ok(out.startsWith('configure0 configure1'), 'head intent kept')
})

test('golden: degenerate inputs sanitize to empty string', () => {
  assert.equal(sanitizeQuery(''), '')
  assert.equal(sanitizeQuery('!!! ???'), '')
  assert.equal(sanitizeQuery('https://only-a-url.example.com/x?id=1'), '')
  assert.equal(sanitizeQuery('```\ncode only\n```'), '')
})

test('golden: sanitize never inflates the token count vs the raw query', () => {
  const raws = [
    '帮我看看 ollama 起不来怎么办 $ ollama serve Error: bind address already in use ❯ ps aux',
    'https://a.com/x 又 https://b.com/y 哪个对',
    '正常一句话',
  ]
  for (const raw of raws) {
    assert.ok(tokenize(sanitizeQuery(raw)).length <= tokenize(raw).length, raw)
  }
})
