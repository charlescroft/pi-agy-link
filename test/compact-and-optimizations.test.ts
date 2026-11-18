import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../src/common/types.ts'
import {
  DEFAULT_AGY_COMPACT_LIMIT,
  parseCompactLimitValue,
  resolveEffectiveCompactLimit,
} from '../src/common/compact-threshold.ts'
import { buildAgyEnv } from '../src/runtime/net/account-env.ts'
import { RunRecording } from '../src/host/recording.ts'
import { EventMapper } from '../src/provider/mapper/event-mapper.ts'
import { buildAgyArgs } from '../src/provider/attempt.ts'
import { agyCommandDefinition } from '../src/host/commands.ts'

test('parseCompactLimitValue and resolveEffectiveCompactLimit respect precedence', () => {
  assert.equal(parseCompactLimitValue('512k'), 512_000)
  assert.equal(parseCompactLimitValue('900K'), 900_000)
  assert.equal(parseCompactLimitValue('1m'), 1_000_000)
  assert.equal(parseCompactLimitValue('bad'), null)
  assert.equal(parseCompactLimitValue(500), null)

  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-settings-'))
  mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ contextWindow: '512K' }))

  const emptyHome = mkdtempSync(join(tmpdir(), 'agy-empty-'))
  assert.equal(resolveEffectiveCompactLimit({ autoCompactOverride: 0 }, {}, emptyHome).effectiveLimit, DEFAULT_AGY_COMPACT_LIMIT)
  assert.equal(resolveEffectiveCompactLimit({ autoCompactOverride: 0 }, {}, fakeHome).effectiveLimit, 512_000)
  assert.equal(
    resolveEffectiveCompactLimit({ autoCompactOverride: 0 }, { AGY_CLI_AUTO_COMPACT_OVERRIDE: '800000' }, fakeHome).effectiveLimit,
    800_000,
  )
  const fromCfg = resolveEffectiveCompactLimit({ autoCompactOverride: 900_000 }, { AGY_CLI_AUTO_COMPACT_OVERRIDE: '800000' }, fakeHome)
  assert.equal(fromCfg.effectiveLimit, 900_000)
  assert.equal(fromCfg.source, 'config')
})

test('buildAgyEnv injects AGY_CLI_AUTO_COMPACT_OVERRIDE and AGY_CLI_MODEL_API_MAX_RETRIES', () => {
  const cfg = { ...defaultConfig(), autoCompactOverride: 850_000, modelApiMaxRetries: 5 }
  const env = buildAgyEnv({ cfg, base: {} })
  assert.equal(env.AGY_CLI_AUTO_COMPACT_OVERRIDE, '850000')
  assert.equal(env.AGY_CLI_MODEL_API_MAX_RETRIES, '5')
})

test('RunRecording + EventMapper emit compaction marker when agy internally compacts mid-run', () => {
  const rec = new RunRecording('test-run')
  const mapper = new EventMapper({ runId: 'test-run', cutOnTool: true, usage: rec })

  const step1 = Array.from(
    mapper.map(
      {
        kind: 'step',
        stepKey: '1',
        stepKind: 'text',
        text: 'step1',
        fragment: true,
        usage: { input_tokens: 3000, cache_read_tokens: 253000, output_tokens: 43 },
        raw: {},
      },
      0,
    ),
  )
  assert.ok(step1.some((c) => c.type === 'text-delta' && c.text === 'step1'))

  const step2 = Array.from(
    mapper.map(
      {
        kind: 'step',
        stepKey: '2',
        stepKind: 'text',
        text: 'step2',
        fragment: true,
        usage: { input_tokens: 13638, cache_read_tokens: 0, output_tokens: 205 },
        raw: {},
      },
      1,
    ),
  )
  const textOut = step2
    .filter((c): c is { type: 'text-delta'; index: number; text: string } => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
  assert.match(textOut, /#agy-compaction-card\?before=256043&after=13843/)
  assert.ok(rec.internalCompaction !== null)
})

test('buildAgyArgs passes --disable-slash-commands and /agy compact-limit|net|slim work', async () => {
  const args = buildAgyArgs({
    prompt: 'hi',
    model: 'gemini-4-argon',
    permissionMode: 'skip',
    timeoutMs: 60_000,
    extraArgs: [],
    disableSlashCommands: true,
  })
  assert.ok(args.includes('--disable-slash-commands'))

  const overrides: Record<string, unknown> = {}
  const cfg = () => ({ ...defaultConfig(), ...overrides }) as ReturnType<typeof defaultConfig>
  const def = agyCommandDefinition({
    cfg,
    bin: () => '/usr/local/bin/agy',
    version: () => '1.5.9',
    auth: () => null,
    catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }),
    store: () => ({ all: () => ({}) }),
    lastRun: () => null,
    setOverride: (k: string, v: unknown) => {
      overrides[k] = v
    },
    runDoctor: async () => '',
  } as never)

  const r1 = await def.handler({ rawInput: 'compact-limit 900k' } as never)
  assert.equal(r1.kind, 'success')
  assert.equal(overrides.autoCompactOverride, 900_000)

  const r2 = await def.handler({ rawInput: 'net retries 6' } as never)
  assert.equal(r2.kind, 'success')
  assert.equal(overrides.modelApiMaxRetries, 6)

  const r3 = await def.handler({ rawInput: 'slim off' } as never)
  assert.equal(r3.kind, 'success')
  assert.equal(overrides.slimPromptRules, false)
})
