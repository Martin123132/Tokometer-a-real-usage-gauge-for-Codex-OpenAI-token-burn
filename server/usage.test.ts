import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getUsageSummary } from './usage'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
  tempRoots.length = 0
})

describe('usage parser', () => {
  it('deduplicates repeated token_count records using cumulative deltas', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 80, 20, 10, 110, 12, 44),
      tokenLine('2026-05-25T10:01:00.000Z', 100, 80, 20, 10, 110, 12, 44),
      tokenLine('2026-05-25T10:02:00.000Z', 220, 140, 50, 20, 240, 12, 45),
    ])

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.eventsFound).toBe(2)
    expect(summary.windows.lastHour.totalTokens).toBe(240)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(140)
    expect(summary.windows.lastHour.uncachedInputTokens).toBe(80)
    expect(summary.limits.secondary.usedPercent).toBe(45)
  })

  it('skips partial JSON lines and records history once per minute', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 25, 40, 5, 145, 91, 88),
      '{"timestamp":"partial"',
    ])

    const first = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:00:10.000Z'),
      useCache: false,
    })
    const second = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:00:45.000Z'),
      useCache: false,
    })

    expect(first.history.samples).toHaveLength(1)
    expect(second.history.samples).toHaveLength(1)
    expect(second.alerts.some((alert) => alert.id === 'weekly-warning')).toBe(true)
  })
})

async function createFixture(lines: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tokometer-'))
  tempRoots.push(root)

  const codexHome = path.join(root, '.codex')
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '25')
  const dataDir = path.join(root, 'data')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    path.join(sessionDir, 'rollout-test-session.jsonl'),
    `${lines.join('\n')}\n`,
    'utf8',
  )

  return { codexHome, dataDir }
}

function tokenLine(
  timestamp: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number,
  primaryUsed: number,
  secondaryUsed: number,
) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningOutputTokens,
          total_tokens: totalTokens,
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningOutputTokens,
          total_tokens: totalTokens,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: {
          used_percent: primaryUsed,
          window_minutes: 300,
          resets_at: 1780000000,
        },
        secondary: {
          used_percent: secondaryUsed,
          window_minutes: 10080,
          resets_at: 1780175065,
        },
        plan_type: 'prolite',
      },
    },
  })
}
