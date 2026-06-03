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

    expect(summary.source.eventsFound).toBe(1)
    expect(summary.windows.lastHour.totalTokens).toBe(130)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(60)
    expect(summary.windows.lastHour.uncachedInputTokens).toBe(60)
    expect(summary.limits.secondary.usedPercent).toBe(45)
  })

  it('uses last_token_usage when total_token_usage is missing', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: null,
          last: bucket(120, 50, 20, 5, 40),
        },
        44,
        91,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:10:00.000Z',
        {
          total: null,
          last: bucket(280, 140, 40, 10, 100),
        },
        51,
        99,
      ),
    ])

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.fallbackTokenSourceUsed).toBe(2)
    expect(summary.source.parseDiagnostics.tokenRecords).toBe(2)
    expect(summary.source.eventsFound).toBe(1)
    expect(summary.windows.lastHour.totalTokens).toBe(60)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(90)
  })

  it('infers missing total_tokens from available component fields', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: {
            input_tokens: 1000,
            cached_input_tokens: 650,
            output_tokens: 140,
            reasoning_output_tokens: 20,
          },
          last: {
            input_tokens: 1000,
            cached_input_tokens: 650,
            output_tokens: 140,
            reasoning_output_tokens: 20,
          },
        },
        44,
        91,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:05:00.000Z',
        {
          total: {
            input_tokens: 1850,
            cached_input_tokens: 1200,
            output_tokens: 140,
            reasoning_output_tokens: 20,
          },
          last: {
            input_tokens: 1850,
            cached_input_tokens: 1200,
            output_tokens: 140,
            reasoning_output_tokens: 20,
          },
        },
        45,
        92,
      ),
    ])

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.windows.lastHour.totalTokens).toBe(1400)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(550)
    expect(summary.windows.lastHour.uncachedInputTokens).toBe(300)
    expect(summary.windows.lastHour.activeTokens).toBe(300)
  })

  it('parses numeric token counts passed as strings', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: {
            input_tokens: '100',
            cached_input_tokens: '10',
            output_tokens: '20',
            reasoning_output_tokens: '5',
            total_tokens: '135',
          },
          last: {
            input_tokens: '100',
            cached_input_tokens: '10',
            output_tokens: '20',
            reasoning_output_tokens: '5',
            total_tokens: '135',
          },
        },
        44,
        91,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:10:00.000Z',
        {
          total: {
            input_tokens: '200',
            cached_input_tokens: '10',
            output_tokens: '45',
            reasoning_output_tokens: '5',
            total_tokens: '260',
          },
          last: {
            input_tokens: '200',
            cached_input_tokens: '10',
            output_tokens: '45',
            reasoning_output_tokens: '5',
            total_tokens: '260',
          },
        },
        45,
        92,
      ),
    ])

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.windows.lastHour.totalTokens).toBe(125)
    expect(summary.windows.lastHour.activeTokens).toBe(125)
    expect(summary.windows.lastHour.uncachedInputTokens).toBe(100)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(0)
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

  it('ignores counter resets and anomalous spikes, and reports ignored events', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(120, 40, 10, 5, 175),
          last: bucket(120, 40, 10, 5, 175),
        },
        20,
        40,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(100, 30, 8, 2, 140),
          last: bucket(100, 30, 8, 2, 140),
        },
        25,
        43,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(140, 35, 10, 3, 188),
          last: bucket(140, 35, 10, 3, 188),
        },
        27,
        47,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:03:00.000Z',
        {
          total: bucket(500588, 35, 10, 3, 500713),
          last: bucket(500588, 35, 10, 3, 500713),
        },
        28,
        48,
      ),
    ]

    const { codexHome, dataDir } = await createFixture(lines)

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:04:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.resetEvents).toBe(1)
    expect(summary.source.parseDiagnostics.anomalousDeltas).toBe(1)
    expect(summary.source.ignoredEvents).toBe(2)
    expect(summary.source.eventsFound).toBe(1)
    expect(summary.windows.lastHour.totalTokens).toBe(48)
  })

  it('uses observed elapsed minutes for sparse 5h/last-hour rates', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T09:30:00.000Z',
        {
          total: bucket(1000, 300, 120, 10, 1430),
          last: bucket(1000, 300, 120, 10, 1430),
        },
        30,
        45,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:40:00.000Z',
        {
          total: bucket(1600, 300, 180, 14, 1794),
          last: bucket(1600, 300, 180, 14, 1794),
        },
        31,
        46,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:10:00.000Z',
        {
          total: bucket(1300, 300, 150, 12, 1662),
          last: bucket(1300, 300, 150, 12, 1662),
        },
        30,
        45,
      ),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:50:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.windows.lastHour.observedMinutes).toBe(30)
    expect(summary.rates.lastHourTokensPerHour).toBeCloseTo(728) // 364 tokens across 30m -> 728/hr
    expect(summary.rates.lastFiveHoursTokensPerHour).toBeCloseTo(728)
  })

  it('flags local logs as stale when no fresh events are present', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLine(
        '2026-05-25T09:00:00.000Z',
        120,
        30,
        20,
        10,
        180,
        40,
        80,
      ),
    ])

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T13:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.freshness.stale).toBe(true)
    expect(summary.freshness.staleMinutes).toBe(270)
    expect(summary.alerts.some((alert) => alert.id === 'local-stale-critical')).toBe(true)
  })
})

describe('projection confidence', () => {
  it('uses linear trend with confidence for stable growth', async () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, index) => {
        const minute = index * 3600_000
        const usedPercent = 20 + index * 1.5
        return tokenLineWithBuckets(
          new Date(Date.parse('2026-05-25T00:00:00.000Z') + minute).toISOString(),
          {
            total: bucket(100 + index * 120, 30, 20, 5, 155 + index * 120),
            last: bucket(100 + index * 120, 30, 20, 5, 155 + index * 120),
          },
          12 + index,
          usedPercent,
        )
      }),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T09:00:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    const projection = summary.rates.weeklyPercent
    expect(projection.percentPerHour).toBeGreaterThan(0)
    expect(projection.projectedExhaustAt).toBeTypeOf('string')
    expect(projection.confidence.level).toBe('high')
    expect(projection.confidence.reason).toContain('Strong')
  })

  it('suppresses noisy weekly trend estimates when variance is high', async () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, index) => {
        const minute = index * 3600_000
        const usedPercent = 40 + (index % 2 ? 32 : 0) - (index % 3 === 0 ? 6 : 0)
        return tokenLineWithBuckets(
          new Date(Date.parse('2026-05-25T00:00:00.000Z') + minute).toISOString(),
          {
            total: bucket(100 + index * 20, 30, 20, 5, 155 + index * 20),
            last: bucket(100 + index * 20, 30, 20, 5, 155 + index * 20),
          },
          10 + (index % 4),
          usedPercent,
        )
      }),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T09:00:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    const projection = summary.rates.weeklyPercent
    expect(projection.confidence.level).toBe('low')
    expect(projection.percentPerHour).toBeNull()
    expect(projection.projectedExhaustAt).toBeNull()
  })

  it('returns no trend when insufficient weekly samples are available', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T08:00:00.000Z',
        {
          total: bucket(1000, 300, 120, 10, 1430),
          last: bucket(1000, 300, 120, 10, 1430),
        },
        30,
        45,
      ),
      tokenLineWithBuckets(
        '2026-05-25T12:00:00.000Z',
        {
          total: bucket(1600, 300, 180, 14, 1794),
          last: bucket(1600, 300, 180, 14, 1794),
        },
        30,
        46,
      ),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T12:05:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    const projection = summary.rates.weeklyPercent
    expect(projection.percentPerHour).toBeNull()
    expect(projection.projectedExhaustAt).toBeNull()
    expect(projection.basisHours).toBeNull()
    expect(projection.confidence.level).toBe('low')
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
  return tokenLineWithBuckets(
    timestamp,
    {
      total: {
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
        reasoning_output_tokens: reasoningOutputTokens,
        total_tokens: totalTokens,
      },
      last: {
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
        reasoning_output_tokens: reasoningOutputTokens,
        total_tokens: totalTokens,
      },
    },
    primaryUsed,
    secondaryUsed,
  )
}

type BucketShape = {
  input_tokens: number | string
  cached_input_tokens: number | string
  output_tokens: number | string
  reasoning_output_tokens: number | string
  total_tokens?: number | string
}

function bucket(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number,
): BucketShape {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
  }
}

function tokenLineWithBuckets(
  timestamp: string,
  buckets: {
    total: BucketShape | null
    last: BucketShape | null
  },
  primaryUsed: number,
  secondaryUsed: number,
) {
  const info: Record<string, unknown> = {
    model_context_window: 258400,
  }
  if (buckets.total !== null) {
    info.total_token_usage = buckets.total
  }
  if (buckets.last !== null) {
    info.last_token_usage = buckets.last
  }

  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info,
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
