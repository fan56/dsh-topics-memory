/**
 * Model-facing tools (ADR 0004 explicit channel): `topic_save`, `topic_search`,
 * `topic_observe`, `topic_history`.
 *
 * @module tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TopicsService } from './service.ts'

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const

function preview(text: string, max = 240): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

export function buildTopicTools(service: TopicsService) {
  const topicSave = defineTool({
    name: 'topic_save',
    description:
      'Create or update one Topic in the long-term topic memory (OKF bundle). ' +
      'Use when a durable conclusion crystallizes: the topic name, what it depends on, open questions, ' +
      'the current conclusion, its impact, and actionable recommendations. ' +
      'Pass `slug` to update an existing topic; omit it to create a new one.',
    parameters: {
      title: { type: 'string', required: true, description: 'Human-readable topic name (immutable identity; renaming creates a new topic)' },
      conclusion: { type: 'string', required: true, description: 'The current best conclusion, self-contained markdown prose' },
      description: { type: 'string', description: 'One-line summary for indexes and snippets' },
      tags: { ...STRING_ARRAY, description: 'Cross-cutting tags (project, domain, component); lowercased on save' },
      triggers: { ...STRING_ARRAY, description: 'Short recall phrases that should bring this topic back (specific nouns/terms, no generic words)' },
      depends: { ...STRING_ARRAY, description: 'Slugs of prerequisite topics (topics this one builds on)' },
      open_questions: { ...STRING_ARRAY, description: 'Unresolved questions this topic still carries' },
      impact: { ...STRING_ARRAY, description: 'What this conclusion affects: topics, projects, decisions' },
      recommendations: { type: 'string', description: 'Actionable recommendation following from the conclusion' },
      status: { type: 'string', description: 'Lifecycle: draft (default) | stable | deprecated' },
      slug: { type: 'string', description: 'Existing topic slug to update; omit to create' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', required: true },
          path: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          committed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: `${value.created ? 'Created' : 'Updated'} topic \`${value.slug}\` → ${value.path}${value.committed ? ' (committed)' : ''}`,
        },
      ],
    },
    async execute(args) {
      const result = await service.saveTopic({
        title: args.title,
        conclusion: args.conclusion,
        description: args.description,
        tags: args.tags,
        triggers: args.triggers,
        depends: args.depends,
        openQuestions: args.open_questions,
        impact: args.impact,
        recommendations: args.recommendations,
        status: args.status === 'draft' || args.status === 'stable' || args.status === 'deprecated' ? args.status : undefined,
        slug: args.slug,
        source: 'model',
      })
      return { slug: result.slug, path: result.path, created: result.created, committed: result.committed }
    },
  })

  const topicOpen = defineTool({
    name: 'topic_open',
    description:
      'Open one topic from the long-term memory in full: conclusion, open questions, recommendations, ' +
      'plus a staleness notice. Use when a <topic-memory> pointer (or a search hit) is actually relevant — ' +
      'pointers are one-line hints; this fetches the real content.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Topic slug (from a pointer or topic_search)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
          title: { type: 'string' },
          status: { type: 'string' },
          updatedAt: { type: 'string' },
          description: { type: 'string' },
          conclusion: { type: 'string' },
          openQuestions: { type: 'array', items: { type: 'string' } },
          recommendations: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: !value.found
            ? `Topic \`${value.slug}\` 不存在（可能已合并或改名；用 topic_search 找）。`
            : [
                `快照于 ${value.updatedAt}，代码事实以源码为准。`,
                `### ${value.title} [${value.status}] (topics:${value.slug})`,
                value.description ?? '',
                value.conclusion !== '' ? `# Conclusion\n\n${value.conclusion}` : '',
                value.openQuestions !== undefined && value.openQuestions.length > 0 ? `待决: ${value.openQuestions.join('；')}` : '',
                value.recommendations !== '' ? `# Recommendations\n\n${value.recommendations}` : '',
              ]
                .filter((l) => l !== '')
                .join('\n\n'),
        },
      ],
    },
    async execute(args) {
      return await service.openTopic(args.slug)
    },
  })

  const topicSearch = defineTool({
    name: 'topic_search',
    description:
      'Search the long-term topic memory by keywords (hot path, no LLM). ' +
      'Use when the user references past work, or when injected topic memory hints at related history.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to recall from topic memory' },
      top_k: { type: 'number', description: 'Max results (default 8)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                score: { type: 'number', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text:
            value.results.length === 0
              ? 'No topic memory found for this query.'
              : value.results
                  .map((r: { slug: string; title: string; status: string; score: number; preview: string }) => `### ${r.title} [${r.status}] (${r.slug} score:${r.score.toFixed(2)})\n${r.preview}`)
                  .join('\n\n'),
        },
      ],
    },
    async execute(args) {
      const outcome = await service.search(args.query, args.top_k)
      const roster = new Map((await service.roster()).map((r) => [r.slug, r]))
      const docs = await Promise.all(
        outcome.hits.map(async (h) => {
          const doc = await service.store.readTopic(h.slug).catch(() => undefined)
          return { hit: h, doc }
        }),
      )
      return {
        results: docs.flatMap(({ hit, doc }) => {
          const meta = roster.get(hit.slug)
          if (doc === undefined || meta === undefined) return []
          const conclusion = extractConclusion(doc.body)
          return [
            {
              slug: hit.slug,
              title: doc.fm.title,
              status: doc.fm.status,
              score: hit.score,
              preview: preview(conclusion !== '' ? conclusion : (doc.fm.description ?? '')),
            },
          ]
        }),
      }
    },
  })

  const topicObserve = defineTool({
    name: 'topic_observe',
    description:
      'Record one atomic observation (a decision, finding, constraint, or open question) as raw material ' +
      'for later distillation into topic memory. Cheap and safe to call mid-task; prefer topic_save when a ' +
      'full conclusion is already settled.',
    parameters: {
      kind: { type: 'string', required: true, description: 'One of: decision | finding | constraint | question' },
      text: { type: 'string', required: true, description: 'The observation, one atomic statement' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text' as const, text: `Observed (${value.id})` }],
    },
    async execute(args) {
      const kind = args.kind === 'decision' || args.kind === 'finding' || args.kind === 'constraint' || args.kind === 'question' ? args.kind : 'finding'
      const obs = await service.observe({ kind, text: args.text })
      return { id: obs.id }
    },
  })

  const topicHistory = defineTool({
    name: 'topic_history',
    description:
      'Show the git history of one topic — how its conclusion changed over time, commit by commit. ' +
      'Use when the user asks when/why a conclusion changed or wants to trace a decision.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Topic slug' },
      limit: { type: 'number', description: 'Max commits (default 20)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hash: { type: 'string', required: true },
                date: { type: 'string', required: true },
                message: { type: 'string', required: true },
                conclusion: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text:
            value.entries.length === 0
              ? 'No history (topic unknown or bundle not a git repo).'
              : value.entries
                  .map((e: { hash: string; date: string; message: string; conclusion?: string }) => `- ${e.hash} ${e.date} ${e.message}${e.conclusion !== undefined ? `\n  结论当时: ${e.conclusion}` : ''}`)
                  .join('\n'),
        },
      ],
    },
    async execute(args) {
      const { entries } = await service.history(args.slug, args.limit ?? 20)
      // conclusion is omitted, never present-as-undefined — the host rejects
      // undefined-valued keys as non-lossless JSON (INVALID_TOOL_OUTPUT).
      return {
        entries: entries.flatMap((e) => {
          const entry: { hash: string; date: string; message: string; conclusion?: string } = {
            hash: e.hash,
            date: e.date,
            message: e.message,
          }
          if (typeof e.conclusion === 'string') entry.conclusion = e.conclusion
          return [entry]
        }),
      }
    },
  })

  return [topicSave, topicOpen, topicSearch, topicObserve, topicHistory]
}

function extractConclusion(body: string): string {
  // Local copy to avoid importing okf section helpers into the hot render path.
  const m = /^# Conclusion\s*\n+([\s\S]*?)(?=\n# |\s*$)/im.exec(body)
  return m === null ? '' : m[1].trim()
}
