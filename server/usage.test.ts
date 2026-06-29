import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearParserMemoryCacheForTests,
  getUsageSummary,
  getUsageSummaryWithBackgroundScan,
} from './usage'

const tempRoots: string[] = []

afterEach(async () => {
  clearParserMemoryCacheForTests()
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

  it('supports configurable anomaly policy strictness', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 200, 50, 10, 1_260),
          last: bucket(1_000, 200, 50, 10, 1_260),
        },
        30,
        47,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(301_000, 200, 50, 10, 301_260),
          last: bucket(301_000, 200, 50, 10, 301_260),
        },
        32,
        48,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(301_250, 200, 70, 10, 301_320),
          last: bucket(301_250, 200, 70, 10, 301_320),
        },
        33,
        48,
      ),
    ]
    const { codexHome, dataDir } = await createFixture(lines)

    const strict = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:10:00.000Z'),
      anomalyPolicy: 'strict',
      writeHistory: false,
      useCache: false,
    })
    const relaxed = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:10:00.000Z'),
      anomalyPolicy: 'relaxed',
      writeHistory: false,
      useCache: false,
    })

    expect(strict.source.parseDiagnostics.anomalousDeltas).toBe(1)
    expect(relaxed.source.parseDiagnostics.anomalousDeltas).toBe(0)
    expect(strict.source.eventsFound).toBe(1)
    expect(relaxed.source.eventsFound).toBe(2)
    expect(relaxed.source.ignoredEvents).toBe(0)
    expect(strict.source.ignoredEvents).toBe(1)
    expect(relaxed.windows.lastHour.totalTokens).toBeGreaterThan(
      strict.windows.lastHour.totalTokens,
    )
  })

  it('falls back to normal anomaly policy for invalid values', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 200, 50, 10, 1_260),
          last: bucket(1_000, 200, 50, 10, 1_260),
        },
        30,
        47,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(301_000, 200, 50, 10, 301_260),
          last: bucket(301_000, 200, 50, 10, 301_260),
        },
        32,
        48,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(301_250, 200, 70, 10, 301_320),
          last: bucket(301_250, 200, 70, 10, 301_320),
        },
        33,
        48,
      ),
    ]
    const { codexHome, dataDir } = await createFixture(lines)

    const fallback = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:10:00.000Z'),
      anomalyPolicy: 'invalid-policy',
      writeHistory: false,
      useCache: false,
    })

    expect(fallback.source.parseDiagnostics.anomalousDeltas).toBe(1)
    expect(fallback.source.eventsFound).toBe(1)
    expect(fallback.source.ignoredEvents).toBe(1)
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

  it('survives rapid burst events without letting one spike dominate burn math', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 500, 200, 20, 1_720),
          last: bucket(1_000, 500, 200, 20, 1_720),
        },
        35,
        65,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:00:30.000Z',
        {
          total: bucket(1_150_000, 500, 200, 20, 1_150_720),
          last: bucket(1_150_000, 500, 200, 20, 1_150_720),
        },
        36,
        66,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(1_080, 500, 230, 20, 1_630),
          last: bucket(1_080, 500, 230, 20, 1_630),
        },
        36,
        66,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(1_200, 520, 240, 22, 1_782),
          last: bucket(1_200, 520, 240, 22, 1_782),
        },
        37,
        67,
      ),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:10:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.anomalousDeltas).toBe(1)
    expect(summary.source.parseDiagnostics.resetEvents).toBe(1)
    expect(summary.source.ignoredEvents).toBe(2)
    expect(summary.source.eventsFound).toBe(1)
    expect(summary.rates.lastHourTokensPerHour).toBeLessThan(10_000)
    expect(summary.rates.lastHourTokensPerHour).toBeGreaterThanOrEqual(0)
    expect(summary.windows.lastHour.totalTokens).toBe(152)
  })

  it('handles large cached vs active mix and keeps active burn separate', async () => {
    const lines = [
      tokenLineWithBuckets(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(10_000, 9_300, 180, 20, 10_200),
          last: bucket(10_000, 9_300, 180, 20, 10_200),
        },
        20,
        60,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:10:00.000Z',
        {
          total: bucket(10_800, 9_940, 190, 22, 11_012),
          last: bucket(10_800, 9_940, 190, 22, 11_012),
        },
        22,
        61,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:20:00.000Z',
        {
          total: bucket(11_600, 10_580, 200, 24, 11_824),
          last: bucket(11_600, 10_580, 200, 24, 11_824),
        },
        24,
        62,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:30:00.000Z',
        {
          total: bucket(12_400, 11_220, 210, 26, 12_636),
          last: bucket(12_400, 11_220, 210, 26, 12_636),
        },
        26,
        63,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:40:00.000Z',
        {
          total: bucket(13_200, 11_860, 220, 28, 13_448),
          last: bucket(13_200, 11_860, 220, 28, 13_448),
        },
        28,
        64,
      ),
      tokenLineWithBuckets(
        '2026-05-25T10:50:00.000Z',
        {
          total: bucket(14_000, 12_500, 230, 30, 14_260),
          last: bucket(14_000, 12_500, 230, 30, 14_260),
        },
        30,
        65,
      ),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T11:00:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.windows.lastHour.totalTokens).toBe(4_060)
    expect(summary.windows.lastHour.cachedInputTokens).toBe(3_200)
    expect(summary.windows.lastHour.uncachedInputTokens).toBe(800)
    expect(summary.windows.lastHour.activeTokens).toBe(860)
    expect(summary.rates.lastHourRateConfidence.level).toBe('medium')
  })

  it('keeps sustained high but stable per-minute rates in analysis', async () => {
    const baseTotal = 10_000
    const lines = Array.from({ length: 7 }, (_, index) => {
      const total = 100 + baseTotal * index
      return tokenLineWithBuckets(
        `2026-05-25T10:${String(index).padStart(2, '0')}:00.000Z`,
        {
          total: bucket(total, 0, 0, 0, total),
          last: bucket(total, 0, 0, 0, total),
        },
        20 + index,
        60 + index,
      )
    })

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:06:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.anomalousDeltas).toBe(0)
    expect(summary.source.parseDiagnostics.resetEvents).toBe(0)
    expect(summary.source.ignoredEvents).toBe(0)
    expect(summary.source.eventsFound).toBe(6)
  })

  it('flags an adaptive spike relative to recent high-traffic baseline', async () => {
    const baselineEvents = [
      { total: 100, minute: 0 },
      { total: 10_100, minute: 1 },
      { total: 20_100, minute: 2 },
      { total: 30_100, minute: 3 },
      { total: 40_100, minute: 4 },
      { total: 140_100, minute: 5 },
      { total: 150_100, minute: 6 },
    ]

    const lines = baselineEvents.map(({ total, minute }) =>
      tokenLineWithBuckets(
        `2026-05-25T10:${String(minute).padStart(2, '0')}:00.000Z`,
        {
          total: bucket(total, 0, 0, 0, total),
          last: bucket(total, 0, 0, 0, total),
        },
        24 + (minute % 10),
        62 + (minute % 8),
      ),
    )

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:06:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.anomalousDeltas).toBe(1)
    expect(summary.source.ignoredEvents).toBe(1)
    expect(summary.source.eventsFound).toBe(5)
    expect(summary.windows.lastHour.totalTokens).toBe(50_000)
  })

  it('parses the schema-drift regression fixture safely', async () => {
    const fixtureText = await readFile(
      new URL('./fixtures/schema-drift.jsonl', import.meta.url),
      'utf8',
    )
    const { codexHome, dataDir } = await createFixture(
      fixtureText.split(/\r?\n/).filter(Boolean),
    )

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.parsedLines).toBe(6)
    expect(summary.source.parseDiagnostics.nonTokenLines).toBe(1)
    expect(summary.source.parseDiagnostics.malformedLines).toBe(0)
    expect(summary.source.parseDiagnostics.parseFailures).toBe(1)
    expect(summary.source.parseDiagnostics.fallbackTokenSourceUsed).toBe(1)
    expect(summary.source.parseDiagnostics.resetEvents).toBe(1)
    expect(summary.source.eventsFound).toBe(2)
    expect(summary.source.ignoredEvents).toBe(1)
    expect(summary.windows.lastHour.totalTokens).toBe(280)
    expect(summary.limits.secondary.usedPercent).toBe(52)
  })

  it('skips large non-token-heavy logs without treating them as malformed', async () => {
    const nonTokenLines = Array.from({ length: 30_000 }, (_, index) =>
      JSON.stringify({
        timestamp: new Date(
          Date.parse('2026-05-25T09:00:00.000Z') + index * 1000,
        ).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          id: `message-${index}`,
        },
      }),
    )
    const tokenLines = [
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52),
    ]

    const { codexHome, dataDir } = await createFixture([
      ...nonTokenLines,
      ...tokenLines,
    ])
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.parseDiagnostics.parsedLines).toBe(30_003)
    expect(summary.source.parseDiagnostics.nonTokenLines).toBe(30_000)
    expect(summary.source.parseDiagnostics.malformedLines).toBe(0)
    expect(summary.source.parseDiagnostics.parseFailures).toBe(0)
    expect(summary.source.parseDiagnostics.tokenRecords).toBe(3)
    expect(summary.source.eventsFound).toBe(2)
    expect(summary.source.largestFileLines).toBe(30_003)
    expect(summary.source.scanDurationMs).toBeGreaterThanOrEqual(0)
    expect(summary.source.warnings.join(' ')).toContain('non-token JSONL lines')
  })

  it('reports parser cache reuse between uncached summary refreshes', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52),
    ])

    const first = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })
    const second = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:31:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(first.source.filesParsed).toBe(1)
    expect(first.source.filesFromCache).toBe(0)
    expect(second.source.filesParsed).toBe(0)
    expect(second.source.filesFromCache).toBe(1)
    expect(second.source.filesFromMemoryCache).toBe(1)
    expect(second.source.filesFromDiskCache).toBe(0)
    expect(second.source.eventsFound).toBe(first.source.eventsFound)
  })

  it('reuses persistent parser cache after memory cache is cleared', async () => {
    const { codexHome, dataDir } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52),
    ])

    const first = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })
    clearParserMemoryCacheForTests()
    const second = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:31:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(first.source.filesParsed).toBe(1)
    expect(second.source.filesParsed).toBe(0)
    expect(second.source.filesFromCache).toBe(1)
    expect(second.source.filesFromDiskCache).toBe(1)
    expect(second.source.eventsFound).toBe(first.source.eventsFound)
  })

  it('parses only appended bytes when a complete append-only session grows', async () => {
    const { codexHome, dataDir, sessionPath } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52),
    ])

    await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })
    await appendFile(
      sessionPath,
      `${tokenLine('2026-05-25T10:15:00.000Z', 650, 130, 50, 15, 715, 33, 53)}\n`,
      'utf8',
    )
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:31:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.filesParsed).toBe(1)
    expect(summary.source.filesFromCache).toBe(0)
    expect(summary.source.filesIncremental).toBe(1)
    expect(summary.source.parseDiagnostics.tokenRecords).toBe(4)
    expect(summary.source.eventsFound).toBe(3)
    expect(summary.windows.lastHour.totalTokens).toBe(600)
  })

  it('serves last-known usage while a background refresh parses appended logs', async () => {
    const { codexHome, dataDir, sessionPath } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
    ])
    const firstNow = Date.parse('2026-05-25T10:30:00.000Z')
    const refreshNow = firstNow + 6_000

    const first = await getUsageSummaryWithBackgroundScan({
      codexHome,
      dataDir,
      now: firstNow,
      writeHistory: false,
      useCache: false,
    })

    await appendFile(
      sessionPath,
      `${tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52)}\n`,
      'utf8',
    )

    const startedAt = Date.now()
    const refreshing = await getUsageSummaryWithBackgroundScan({
      codexHome,
      dataDir,
      now: refreshNow,
      writeHistory: false,
      forceRefresh: true,
      scanDelayMsForTests: 180,
    })
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(180)
    expect(refreshing.scanStatus.state).toBe('refreshing')
    expect(refreshing.scanStatus.servedFromLastKnown).toBe(true)
    expect(refreshing.source.eventsFound).toBe(first.source.eventsFound)

    const fresh = await waitForBackgroundSummary({
      codexHome,
      dataDir,
      now: refreshNow + 1_000,
      writeHistory: false,
    })

    expect(fresh.scanStatus.state).toBe('fresh')
    expect(fresh.source.filesIncremental).toBe(1)
    expect(fresh.source.eventsFound).toBe(2)
    expect(fresh.windows.lastHour.totalTokens).toBe(437)
  })

  it('invalidates persistent parser cache when a session log shrinks', async () => {
    const { codexHome, dataDir, sessionPath } = await createFixture([
      tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
      tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      tokenLine('2026-05-25T10:10:00.000Z', 500, 90, 40, 12, 552, 32, 52),
    ])

    await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })
    clearParserMemoryCacheForTests()
    await writeFile(
      sessionPath,
      [
        tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
        tokenLine('2026-05-25T10:05:00.000Z', 160, 30, 20, 8, 188, 31, 51),
      ].join('\n') + '\n',
      'utf8',
    )

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:31:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.filesParsed).toBe(1)
    expect(summary.source.filesIncremental).toBe(0)
    expect(summary.source.cacheInvalidations).toBe(1)
    expect(summary.source.cacheWarnings.join(' ')).toContain('log file shrank')
    expect(summary.source.eventsFound).toBe(1)
    expect(summary.windows.lastHour.totalTokens).toBe(73)
  })

  it('includes archived sessions in scan metrics and session totals', async () => {
    const { codexHome, dataDir } = await createFixture(
      [
        tokenLine('2026-05-25T10:00:00.000Z', 100, 20, 10, 5, 115, 30, 50),
        tokenLine('2026-05-25T10:05:00.000Z', 350, 70, 20, 10, 380, 31, 51),
      ],
      [
        tokenLine('2026-05-25T09:00:00.000Z', 200, 80, 30, 10, 240, 20, 40),
        tokenLine('2026-05-25T09:10:00.000Z', 460, 100, 80, 20, 560, 22, 42),
      ],
    )

    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.source.filesScanned).toBe(2)
    expect(summary.source.filesParsed).toBe(2)
    expect(summary.source.sessionsFound).toBe(2)
    expect(summary.source.parseDiagnostics.files).toHaveLength(2)
    expect(summary.source.eventsFound).toBe(2)
    expect(summary.windows.lastDay.totalTokens).toBe(585)
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

  it('downgrades projection confidence when latest weekly sample is stale', async () => {
    const lines = [
      ...Array.from({ length: 6 }, (_, index) => {
        const minute = index * 1800_000
        const usedPercent = 20 + index * 2
        return tokenLineWithBuckets(
          new Date(Date.parse('2026-05-25T08:00:00.000Z') + minute).toISOString(),
          {
            total: bucket(100 + index * 60, 30, 20, 5, 155 + index * 60),
            last: bucket(100 + index * 60, 30, 20, 5, 155 + index * 60),
          },
          10 + index,
          usedPercent,
        )
      }),
    ]

    const { codexHome, dataDir } = await createFixture(lines)
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T12:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    expect(summary.rates.weeklyPercent.confidence.level).toBe('low')
    expect(summary.rates.weeklyPercent.projectedExhaustAt).toBeNull()
    expect(summary.rates.weeklyPercent.percentPerHour).toBeNull()
  })
})

async function waitForBackgroundSummary(
  options: Parameters<typeof getUsageSummaryWithBackgroundScan>[0],
) {
  let summary = await getUsageSummaryWithBackgroundScan(options)
  for (let attempt = 0; attempt < 12 && summary.scanStatus.state === 'refreshing'; attempt += 1) {
    await sleep(25)
    summary = await getUsageSummaryWithBackgroundScan(options)
  }
  return summary
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function createFixture(lines: string[], archivedLines: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tokometer-'))
  tempRoots.push(root)

  const codexHome = path.join(root, '.codex')
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '25')
  const dataDir = path.join(root, 'data')
  const sessionPath = path.join(sessionDir, 'rollout-test-session.jsonl')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    sessionPath,
    `${lines.join('\n')}\n`,
    'utf8',
  )

  if (archivedLines.length > 0) {
    const archivedDir = path.join(
      codexHome,
      'archived_sessions',
      '2026',
      '05',
      '25',
    )
    await mkdir(archivedDir, { recursive: true })
    await writeFile(
      path.join(archivedDir, 'rollout-archived-test-session.jsonl'),
      `${archivedLines.join('\n')}\n`,
      'utf8',
    )
  }

  return { codexHome, dataDir, sessionPath }
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
