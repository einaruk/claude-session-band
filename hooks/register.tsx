// session-band: watches the prompt cache's TTL, prices a re-warm, warns before it goes cold,
// and turns "handoff → /clear → paste → send" into two button presses.
// Every function that takes $ lives at the top of this file: the engine follows $ only there.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import {
  COMPACT_FLOOR_TOKENS,
  COMPACT_REGROW_TOKENS,
  COMPACT_STEP_TOKENS,
  defaultCompactAt,
  describeCompactPoint,
  parseCompactSetting,
  resolveCompactPoint,
  shouldAutoCompact,
} from './auto-compact-policy'
import type { CompactSetting } from './auto-compact-policy'
import {
  MINUTE_MS,
  TTL_1H_MS,
  TTL_5M_MS,
  cacheWriteMultiple,
  formatCountdown,
  formatTokens,
  formatUntil,
  formatUsd,
  resolveInputPrice,
  weightedUnits,
} from './cache-math'
import { LIMIT_LABEL, PHASE_COLOR, TONE_DOT_COLOR, autoCompactSummary, bandChips, headline, modelFamily, percentLeft } from './cache-view-model'
import type { CachePhase, KeeperConfig, KeeperView, ModelFamily, TtlSource } from './cache-view-model'

// Session state, held by the host in $.state so it survives hot reloads.
const touchAtom = atom({ plugin: 'session-band', key: 'touch' } as const, null)
const isRunningAtom = atom({ plugin: 'session-band', key: 'isRunning' } as const, false)
const turnStartedAtAtom = atom({ plugin: 'session-band', key: 'turnStartedAt' } as const, null)
// Written by the ticker so drawings that read it redraw as the countdown moves.
const nowAtom = atom({ plugin: 'session-band', key: 'now' } as const, 0)
const observedTtlAtom = atom({ plugin: 'session-band', key: 'observedTtlMs' } as const, null)
// The touch timestamp already warned about, so each cache cycle warns once.
const warnedForAtom = atom({ plugin: 'session-band', key: 'warnedFor' } as const, null)
const autoOpenedAtom = atom({ plugin: 'session-band', key: 'autoOpened' } as const, false)
const handoffAtom = atom({ plugin: 'session-band', key: 'handoff' } as const, {
  status: 'idle',
  text: '',
})
const calibrationAtom = atom({ plugin: 'session-band', key: 'calibration' } as const, null)
const compactAtAtom = atom({ plugin: 'session-band', key: 'compactAt' } as const, null)
const compactRefusedAtAtom = atom({ plugin: 'session-band', key: 'compactRefusedAt' } as const, null)
// The caveman plugin's flag file as last read: its level, '' while off, null before the first read.
const cavemanAtom = atom({ plugin: 'session-band', key: 'caveman' } as const, null)
const cavemanResumeAtom = atom({ plugin: 'session-band', key: 'cavemanResume' } as const, 'full')
const cavemanToldAtom = atom({ plugin: 'session-band', key: 'cavemanTold' } as const, null)
const modelSeenAtom = atom({ plugin: 'session-band', key: 'modelSeen' } as const, {})

const PANE_ID = 'session-band'
const PANE_TITLE = 'Session band'
const TICK_MS = 15_000
// Lets the finished turn settle before an auto-compaction starts.
const AUTO_COMPACT_DELAY_MS = 1_000

const KEEP_ALIVE_PROMPT =
  'Prompt-cache keep-alive from the session-band mod. No action needed: reply with just "ok".'

const HANDOFF_ARGS =
  'Put the complete handoff in your final reply, ready to paste as the first message of a fresh session.'

// Used when the configured save command is not installed.
const SAVE_PROMPT =
  "Update the project's working notes (status, decisions, open items) for the work done in this session. " +
  'Re-read each file right before writing it.'

// Used when the configured handoff command is not installed.
const HANDOFF_PROMPT = [
  'Write a session handoff so a fresh session can continue this work without the transcript.',
  'Cover: the objective, decisions made, current state (files, commands, IDs exactly), what is left, and what not to redo.',
  'Reply with the handoff only, written as the first message of the new session.',
].join(' ')

// Levels the caveman plugin keeps on between turns, and the one-shot modes its own commands set.
const CAVEMAN_LEVELS = ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra']
const CAVEMAN_ONE_SHOT_MODES = ['commit', 'review', 'compress']

// The band's model switch: from each family, the family it goes to, the letter on the button,
// and the model id used until that family has been seen in this session.
const MODEL_SWITCH: Record<ModelFamily, { to: ModelFamily; label: string; model: string }> = {
  fable: { to: 'opus', label: 'O', model: 'claude-opus-5-5' },
  opus: { to: 'fable', label: 'F', model: 'claude-fable-5-1' },
}

// Attached to the next prompt after a flip, so the toggle costs no turn of its own.
const CAVEMAN_OFF_NOTE =
  'The user switched caveman mode off with the toggle on the session-band band, the same as typing "stop caveman". ' +
  'Write in normal prose from this reply on, until caveman is switched on again.'
const CAVEMAN_ON_NOTE =
  'The user switched caveman mode on with the toggle on the session-band band, the same as typing "/caveman". ' +
  'Follow the caveman rules from this reply on.'

// ---------------------------------------------------------------- view

/** The TTL in force: the configured one, else what a gap proved, else 1h on a subscription and 5m off one. */
async function resolveTtl(
  $: EngineInterface,
  config: KeeperConfig,
  rateLimits: SessionRateLimit[],
): Promise<{ ms: number; source: TtlSource }> {
  if (config.cacheTtl === '1h') return { ms: TTL_1H_MS, source: 'config' }
  if (config.cacheTtl === '5m') return { ms: TTL_5M_MS, source: 'config' }
  const observed = await read($, observedTtlAtom)
  if (observed !== null) return { ms: observed, source: 'observed' }
  return { ms: rateLimits.length > 0 ? TTL_1H_MS : TTL_5M_MS, source: 'assumed' }
}

/** Reads state and the session's usage figures into one view; reading from a render subscribes it. */
async function computeView($: EngineInterface, config: KeeperConfig): Promise<KeeperView> {
  const ticked = await read($, nowAtom)
  const now = ticked > 0 ? ticked : await $.clock.now()
  const usage = await $.session.usage()
  const touch = await read($, touchAtom)
  const isRunning = await read($, isRunningAtom)
  const ttl = await resolveTtl($, config, usage.rateLimits)

  const contextTokens = usage.context.tokens ?? touch?.contextTokens ?? 0
  const sessionModel = await $.session.model()
  // The price follows the model the cache was last written under; the band shows the one in force.
  const model = touch?.model ?? sessionModel
  const price = resolveInputPrice(
    config.inputPricePerMTok,
    await read($, calibrationAtom),
    usage.cost?.usd,
    model,
  )
  const remainingMs = touch ? touch.at + ttl.ms - now : 0

  let phase: CachePhase = 'empty'
  if (isRunning) phase = 'running'
  else if (touch && remainingMs <= 0) phase = 'cold'
  else if (touch && remainingMs <= config.warnMs) phase = 'cooling'
  else if (touch) phase = 'warm'

  return {
    phase,
    model: sessionModel,
    now,
    remainingMs,
    ttlMs: ttl.ms,
    ttlSource: ttl.source,
    touchAt: touch?.at ?? null,
    contextTokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    rewarmUsd: contextTokens * price.perToken * cacheWriteMultiple(ttl.ms),
    priceSource: price.source,
    rateLimits: usage.rateLimits,
    costUsd: usage.cost?.usd,
    compact: resolveCompactPoint(await read($, compactAtAtom), config.autoCompact, usage.context.window),
  }
}

/** Where the caveman plugin keeps its mode flag: under the Claude Code configuration directory. */
async function cavemanFlagPath($: EngineInterface): Promise<string | null> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return `${configDir}/.caveman-active`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude/.caveman-active` : null
}

/**
 * Reads the flag into state and returns the level, '' while caveman is off. A missing, empty or
 * unknown flag is off, as the caveman plugin's own readers treat it.
 */
async function refreshCaveman($: EngineInterface): Promise<string> {
  const path = await cavemanFlagPath($)
  let level = ''
  if (path !== null && (await $.fs.exists(path).catch(() => false))) {
    const text = (await $.fs.read(path).catch(() => '')).trim().toLowerCase()
    if (CAVEMAN_LEVELS.includes(text) || CAVEMAN_ONE_SHOT_MODES.includes(text)) level = text
  }
  if ((await read($, cavemanAtom)) !== level) await update($, cavemanAtom, () => level)
  if (CAVEMAN_LEVELS.includes(level) && (await read($, cavemanResumeAtom)) !== level) {
    await update($, cavemanResumeAtom, () => level)
  }
  return level
}

/** Moves the countdown, refreshes the status line, and warns once per cache cycle. */
async function tick($: EngineInterface, config: KeeperConfig): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  // Caveman is also switched by typed commands and by other sessions; the flag file is the truth.
  await refreshCaveman($)
  const view = await computeView($, config)

  if (view.phase !== 'cooling' || view.touchAt === null) return
  if ((await read($, warnedForAtom)) === view.touchAt) return
  await update($, warnedForAtom, () => view.touchAt)
  $.ui.toast(
    `Cache goes cold in ${formatCountdown(view.remainingMs)}; re-warming ${formatTokens(view.contextTokens)} tokens ` +
      `would cost ≈${formatUsd(view.rewarmUsd)}. Keep warm, compact or hand off from the band above the prompt.`,
    { timeoutMs: 15_000 },
  )
}

// ---------------------------------------------------------------- actions

/** Runs an action without letting a failure escape the press or command that started it. */
function runAction($: EngineInterface, label: string, action: () => Promise<unknown>): void {
  void action().catch((error: unknown) => {
    $.ui.toast(`session-band: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function keepWarm($: EngineInterface): Promise<void> {
  await $.prompt.submit({ text: KEEP_ALIVE_PROMPT })
}

async function compactNow($: EngineInterface, config: KeeperConfig): Promise<void> {
  const args = config.compactInstructions.trim()
  await $.command.run(args ? { command: 'compact', args } : { command: 'compact' })
}

/** Runs the configured notes skill; a plain prompt when none is set or it is not installed. */
async function saveNotes($: EngineInterface, config: KeeperConfig): Promise<void> {
  const names = (await $.command.list()).map(command => command.name)
  const wanted = config.saveCommand.replace(/^\//, '')
  const command = wanted
    ? (names.find(name => name === wanted) ?? names.find(name => name.endsWith(`:${wanted}`)))
    : undefined
  if (command) await $.command.run({ command })
  else await $.prompt.submit({ text: SAVE_PROMPT })
}

/** Starts the handoff turn; turn.complete captures its answer as the handoff text. */
async function startHandoff($: EngineInterface, config: KeeperConfig): Promise<void> {
  const names = (await $.command.list()).map(command => command.name)
  const wanted = config.handoffCommand.replace(/^\//, '')
  const command =
    names.find(name => name === wanted) ??
    names.find(name => name === 'context-handoff' || name.endsWith(':context-handoff'))

  await update($, handoffAtom, () => ({ status: 'pending', text: '' }))
  try {
    if (command) await $.command.run({ command, args: HANDOFF_ARGS })
    else await $.prompt.submit({ text: HANDOFF_PROMPT })
  } catch (error) {
    await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
    throw error
  }
}

/** /clear, then sends the captured handoff as the first prompt of the fresh conversation. */
async function clearAndContinue($: EngineInterface): Promise<void> {
  const handoff = await read($, handoffAtom)
  const text = handoff.text.trim()
  if (handoff.status !== 'ready' || text === '') {
    $.ui.toast('session-band: no handoff ready yet. Press Handoff first.')
    return
  }
  await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text, asUser: true })
}

/**
 * Compacts between turns once the context reaches the point in force. A refusal or failure
 * waits for more context before trying again, so it never repeats every turn.
 */
async function autoCompact($: EngineInterface, config: KeeperConfig): Promise<void> {
  if (await read($, isRunningAtom)) return
  if ((await read($, handoffAtom)).status !== 'idle') return
  const view = await computeView($, config)
  if (!shouldAutoCompact(view.contextTokens, view.compact.at, await read($, compactRefusedAtAtom))) return

  $.ui.toast(`Auto-compacting at ${formatTokens(view.contextTokens)} · point ${describeCompactPoint(view.compact)}`)
  let reason: string
  try {
    const instructions = config.compactInstructions.trim()
    const result = await $.session.compact(instructions ? { instructions } : undefined)
    if (result.skip === undefined) return
    reason = result.skip
  } catch (error) {
    if (await read($, isRunningAtom)) return // a turn started first: try again when it ends
    reason = error instanceof Error ? error.message : String(error)
    // Desktop and SDK sessions refuse $.session.compact (compaction there runs inside a turn), so
    // queue /compact the way the 📦 button does. A compaction that lands clears the refusal mark
    // in the session.compact hook; one that never runs waits for more context before the next try.
    if (/not available/i.test(reason)) {
      await update($, compactRefusedAtAtom, () => view.contextTokens)
      await compactNow($, config)
      return
    }
  }
  await update($, compactRefusedAtAtom, () => view.contextTokens)
  $.ui.toast(
    `session-band: auto-compact did not run (${reason}). Next try after ${formatTokens(COMPACT_REGROW_TOKENS)} more context.`,
  )
}

/** Sets this session's auto-compact point; null hands it back to the mod setting / research default. */
async function setSessionCompact($: EngineInterface, value: CompactSetting | null): Promise<void> {
  await update($, compactAtAtom, () => value)
  await update($, compactRefusedAtAtom, () => null)
}

async function discardHandoff($: EngineInterface): Promise<void> {
  await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
}

/**
 * Flips the caveman plugin's flag file. Off is an empty flag, not 'off': the plugin's per-turn
 * reminder treats 'off' as a level and would keep announcing the mode. The model hears of the
 * flip with the next prompt, from the prompt.submit hook.
 */
async function toggleCaveman($: EngineInterface): Promise<void> {
  const path = await cavemanFlagPath($)
  if (path === null) {
    $.ui.toast('session-band: cannot find the Claude Code configuration directory for the caveman flag.')
    return
  }
  const wasOn = (await refreshCaveman($)) !== ''
  // Before the first prompt nothing is recorded yet: record the state the model started under.
  if ((await read($, cavemanToldAtom)) === null) await update($, cavemanToldAtom, () => wasOn)
  const level = wasOn ? '' : await read($, cavemanResumeAtom)
  await $.fs.write(path, level)
  await update($, cavemanAtom, () => level)
  $.ui.toast(wasOn ? 'Caveman off from the next prompt.' : `Caveman on (${level}) from the next prompt.`)
}

/**
 * Runs /model for the other side of the Fable ↔ Opus pair. The id being left is remembered, so
 * switching back restores it exactly (a [1m] variant included) rather than the default id.
 */
async function switchModel($: EngineInterface, config: KeeperConfig): Promise<void> {
  const current = await $.session.model()
  const family = modelFamily(current)
  if (family === null) return
  const target = MODEL_SWITCH[family]
  await update($, modelSeenAtom, seen => ({ ...seen, [family]: current }))
  const model = (await read($, modelSeenAtom))[target.to] ?? target.model
  await $.command.run({ command: 'model', args: model })
  // Redraw now: the model chip and the button's letter follow the new model.
  await tick($, config)
}

/** Opens the details pane; pressed or typed, so the surface places it at any width. */
async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  if (!opened.isPlaced) $.ui.toast(`session-band: the details pane could not open (${opened.reason}).`)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const config: KeeperConfig = {
    cacheTtl: String(options.cacheTtl ?? 'auto'),
    warnMs: Math.max(1, Number(options.warnMinutes ?? 5)) * MINUTE_MS,
    inputPricePerMTok: Number(options.inputPricePerMTok ?? 0),
    handoffCommand: String(options.handoffCommand ?? 'anthropic-skills:context-handoff'),
    compactInstructions: String(options.compactInstructions ?? ''),
    saveCommand: String(options.saveCommand ?? ''),
    autoCompact: parseCompactSetting(String(options.autoCompact ?? 'auto')) ?? 'auto',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-band',
      description: 'Prompt-cache countdown and handoff: open, warm, compact, handoff, save notes, continue, caveman toggle',
      argumentHint: '[open|warm|compact|handoff|save|continue|caveman|autocompact <250k|off|auto>]',
    })
    if ((await read($, calibrationAtom)) === null) {
      const cost = (await $.session.usage()).cost?.usd
      if (cost !== undefined) await update($, calibrationAtom, () => ({ costStart: cost, units: 0 }))
    }
    // The bar above the prompt shows everything; clear a status entry left by an earlier version.
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => void tick($, config))
    await tick($, config)

    return next(e)
  })

  on('command.run', { command: 'session-band' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)
    const verb = first || 'open'
    if (verb === 'autocompact') {
      const setting = parseCompactSetting(rest.join(''))
      if (setting === undefined) return { text: 'Usage: /session-band autocompact <250k|off|auto>' }
      const sessionValue = setting === 'auto' ? null : setting
      await setSessionCompact($, sessionValue)
      const window = (await $.session.usage()).context.window
      return { text: `session-band: auto-compact for this session at ${describeCompactPoint(resolveCompactPoint(sessionValue, config.autoCompact, window))}` }
    }
    // Fire-and-forget: these queue a command or prompt that runs once this one finishes.
    if (verb === 'warm') runAction($, 'keep warm', () => keepWarm($))
    else if (verb === 'compact') runAction($, 'compact', () => compactNow($, config))
    else if (verb === 'handoff') runAction($, 'handoff', () => startHandoff($, config))
    else if (verb === 'save') runAction($, 'save', () => saveNotes($, config))
    else if (verb === 'continue') runAction($, 'clear & continue', () => clearAndContinue($))
    else if (verb === 'open') await openPane($)
    else if (verb === 'caveman') await toggleCaveman($)
    else return { text: 'Usage: /session-band [open|warm|compact|handoff|save|continue|caveman|autocompact <250k|off|auto>]' }

    return { text: `session-band: ${verb}` }
  })

  // Tells the model once when caveman flipped since it was last told, whoever flipped it:
  // this band, another session's, or a typed command.
  on('prompt.submit', async ($, e, next) => {
    let note: string | undefined
    try {
      const isOn = (await refreshCaveman($)) !== ''
      const told = await read($, cavemanToldAtom)
      if (told !== isOn) await update($, cavemanToldAtom, () => isOn)
      if (told !== null && told !== isOn) note = isOn ? CAVEMAN_ON_NOTE : CAVEMAN_OFF_NOTE
    } catch {
      // A flag that cannot be read must not hold up the prompt.
    }

    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, isRunningAtom, () => true)
    await update($, turnStartedAtAtom, () => now)
    void tick($, config)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    const ttl = await resolveTtl($, config, usage.rateLimits)
    const costUsd = usage.cost?.usd

    // Every loop's requests feed the price calibration against the cost ledger.
    if (e.usage && costUsd !== undefined) {
      const units = weightedUnits(e.usage, ttl.ms)
      await update($, calibrationAtom, prev => ({
        costStart: prev?.costStart ?? costUsd,
        units: (prev?.units ?? 0) + units,
      }))
    }
    if (e.agentId !== undefined) return result // a subagent's cache is not the main thread's

    const now = await $.clock.now()
    const prev = await read($, touchAtom)
    const startedAt = await read($, turnStartedAtAtom)
    await update($, isRunningAtom, () => false)

    // A gap between 5m and 1h tells the TTL apart: a 5m cache had to re-write the whole prefix.
    if (e.usage && prev && startedAt !== null && prev.contextTokens > 10_000) {
      const gap = startedAt - prev.at
      if (gap > TTL_5M_MS + 30_000 && gap < TTL_1H_MS - MINUTE_MS) {
        const rewrote = e.usage.cache_creation_input_tokens >= 0.5 * prev.contextTokens
        await update($, observedTtlAtom, () => (rewrote ? TTL_5M_MS : TTL_1H_MS))
      }
    }
    // Only a turn that reached the API refreshes the cache; an early interrupt leaves the old clock.
    if (e.usage) {
      const model = e.usage.model
      const contextTokens = usage.context.tokens ?? prev?.contextTokens ?? 0
      await update($, touchAtom, () => ({ at: now, contextTokens, model }))
    }

    const handoff = await read($, handoffAtom)
    if (handoff.status === 'pending') {
      const isAnswered = e.reason === 'answer' && e.answer.trim() !== ''
      await update($, handoffAtom, () =>
        isAnswered ? { status: 'ready', text: e.answer } : { status: 'idle', text: '' },
      )
      $.ui.toast(isAnswered ? 'Handoff ready: press Clear & continue.' : 'Handoff did not finish.')
    }

    if (!(await read($, autoOpenedAtom))) {
      await update($, autoOpenedAtom, () => true)
      void $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    }
    await tick($, config)
    // Only after a finished answer: an interrupted turn means the person is steering, so leave the context alone.
    if (e.reason === 'answer') $.clock.after(AUTO_COMPACT_DELAY_MS, () => void autoCompact($, config))

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (result.skip !== undefined) return result
    if (result.usage) {
      const ttl = await resolveTtl($, config, (await $.session.usage()).rateLimits)
      const units = weightedUnits(result.usage, ttl.ms)
      await update($, calibrationAtom, prev => (prev ? { ...prev, units: prev.units + units } : prev))
    }
    // The summarized conversation is a new prefix: nothing of it is cached until the next request.
    await update($, touchAtom, () => null)
    await update($, compactRefusedAtAtom, () => null)
    void tick($, config)

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, touchAtom, () => null)
      await update($, isRunningAtom, () => false)
      await update($, turnStartedAtAtom, () => null)
      await update($, warnedForAtom, () => null)
      void tick($, config)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await computeView($, config)
    const handoff = await read($, handoffAtom)
    const ttlLabel = view.ttlMs >= TTL_1H_MS ? '1h' : '5m'
    const hasActions = view.phase !== 'running' && view.phase !== 'empty' && handoff.status === 'idle'
    // The − / + buttons and "Turn on" start from the point in force, else this model's default.
    const compactBase = view.compact.at ?? defaultCompactAt(view.contextWindow) ?? COMPACT_FLOOR_TOKENS
    const compactCeiling = view.contextWindow > 0 ? view.contextWindow : Number.POSITIVE_INFINITY

    return (
      <Box flexDirection="column">
        <Text bold color={PHASE_COLOR[view.phase]}>
          {headline(view)}
        </Text>
        <Text dimColor>
          TTL {ttlLabel} ({view.ttlSource}) · re-warm if cold ≈{formatUsd(view.rewarmUsd)} ({view.priceSource} price)
        </Text>
        <Text> </Text>
        <Text>
          Context {formatTokens(view.contextTokens)} / {formatTokens(view.contextWindow)}
          {view.contextPercent !== undefined ? ` (${view.contextPercent}%)` : ''}
        </Text>
        {view.rateLimits.map(limit => (
          <Text>
            {LIMIT_LABEL[limit.kind] ?? limit.kind} {percentLeft(limit)}% left
            {formatUntil(limit.resetsAt, view.now) ? ` · resets in ${formatUntil(limit.resetsAt, view.now)}` : ''}
          </Text>
        ))}
        {view.costUsd !== undefined && <Text>Session at API rates {formatUsd(view.costUsd)}</Text>}

        {/* Auto-compact gets its own titled section so its buttons don't read as part of the actions below. */}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Auto-compact</Text>
          <Text dimColor>{autoCompactSummary(view)}</Text>
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button
            key="compact-less"
            label={`Sooner −${formatTokens(COMPACT_STEP_TOKENS)}`}
            onPress={() =>
              runAction($, 'auto-compact', () =>
                setSessionCompact($, Math.max(COMPACT_STEP_TOKENS, compactBase - COMPACT_STEP_TOKENS)),
              )
            }
          />
          <Button
            key="compact-more"
            label={`Later +${formatTokens(COMPACT_STEP_TOKENS)}`}
            onPress={() =>
              runAction($, 'auto-compact', () =>
                setSessionCompact($, Math.min(compactCeiling, compactBase + COMPACT_STEP_TOKENS)),
              )
            }
          />
          <Button
            key="compact-toggle"
            label={view.compact.at === null ? 'Turn on' : 'Turn off'}
            onPress={() =>
              runAction($, 'auto-compact', () => setSessionCompact($, view.compact.at === null ? compactBase : 'off'))
            }
          />
          {view.compact.source === 'session' && (
            <Button
              key="compact-reset"
              label="Reset to default"
              onPress={() => runAction($, 'auto-compact', () => setSessionCompact($, null))}
            />
          )}
        </Box>

        {hasActions && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Actions</Text>
            <Box flexDirection="row" gap={2}>
              <Button key="warm" label="🔥 Keep warm" onPress={() => runAction($, 'keep warm', () => keepWarm($))} />
              <Button key="compact" label="📦 Compact now" onPress={() => runAction($, 'compact', () => compactNow($, config))} />
              <Button
                key="handoff"
                label="🤝 Handoff"
                onPress={() => runAction($, 'handoff', () => startHandoff($, config))}
              />
              <Button key="save" label="📝 Save notes" onPress={() => runAction($, 'save', () => saveNotes($, config))} />
            </Box>
          </Box>
        )}
        {handoff.status === 'pending' && <Text color="yellow">Handoff running…</Text>}
        {handoff.status === 'ready' && (
          <Box flexDirection="row">
            <Text color="green">Handoff ready ({formatTokens(handoff.text.length)} chars) </Text>
            <Button
              key="continue"
              label="Clear & continue"
              variant="primary"
              onPress={() => runAction($, 'clear & continue', () => clearAndContinue($))}
            />
            <Text> </Text>
            <Button key="discard" label="Discard" onPress={() => runAction($, 'discard', () => discardHandoff($))} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = await computeView($, config)
    const handoff = await read($, handoffAtom)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (handoff.status === 'ready') {
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="green">Handoff ready.</Text>
          <Box flexDirection="row" flexShrink={0} gap={1}>
            <Button
              key="band-continue"
              label="Clear & continue"
              variant="primary"
              onPress={() => runAction($, 'clear & continue', () => clearAndContinue($))}
            />
            <Button key="band-discard" label="Discard" onPress={() => runAction($, 'discard', () => discardHandoff($))} />
          </Box>
        </Box>
      )
    }

    // Always-on bar: the figures at a glance, then the actions (hidden before the first reply and while a turn runs).
    const hasActions = view.phase !== 'empty' && view.phase !== 'running' && handoff.status === 'idle'
    const isTerminal = e.surface === 'terminal'
    const isCavemanOn = Boolean(await read($, cavemanAtom))
    // Offered before the first reply too (the cheapest moment to switch), never while a turn runs.
    const family = view.phase !== 'running' && handoff.status === 'idle' ? modelFamily(view.model) : null
    const modelTarget = family === null ? null : MODEL_SWITCH[family]

    // Figures on the left (growing to fill the row), buttons pinned to the right edge.
    return (
      <Box flexDirection="row" justifyContent="space-between">
        {/*
          One pill per group: gray text with a small colored dot for status.
          Desktop: a faint rounded border; height={1} holds it to one text row, else the desktop pads the border.
          Terminal: a bordered box needs three rows and height={1} clips the text away, so the pills are
          plain text separated by a dim bar instead.
        */}
        <Box flexDirection="row" flexGrow={1} flexShrink={1} gap={isTerminal ? 0 : 1}>
          {[...bandChips(view), ...(handoff.status === 'pending' ? [{ text: 'handoff running…', tone: 'warn' as const }] : [])].map(
            (chip, index) =>
              isTerminal ? (
                <Box flexDirection="row" flexShrink={0}>
                  {index > 0 && <Text dimColor> │ </Text>}
                  {TONE_DOT_COLOR[chip.tone] && <Text color={TONE_DOT_COLOR[chip.tone]}>● </Text>}
                  <Text dimColor>{chip.text}</Text>
                </Box>
              ) : (
                <Box flexDirection="row" flexShrink={0} borderStyle="round" borderDimColor paddingX={1} height={1}>
                  {TONE_DOT_COLOR[chip.tone] && <Text color={TONE_DOT_COLOR[chip.tone]}>● </Text>}
                  <Text dimColor>{chip.text}</Text>
                </Box>
              ),
          )}
        </Box>
        {/* One-glyph buttons to save width; the Details pane carries the same actions with word labels. */}
        <Box flexDirection="row" flexShrink={0} gap={1}>
          {modelTarget && (
            <Button
              key="band-model"
              label={modelTarget.label}
              onPress={() => runAction($, 'model switch', () => switchModel($, config))}
            />
          )}
          {hasActions && view.phase !== 'cold' && (
            <Button key="band-warm" label="🔥" onPress={() => runAction($, 'keep warm', () => keepWarm($))} />
          )}
          {hasActions && (
            <Button key="band-compact" label="📦" onPress={() => runAction($, 'compact', () => compactNow($, config))} />
          )}
          {hasActions && (
            <Button key="band-save" label="📝" onPress={() => runAction($, 'save', () => saveNotes($, config))} />
          )}
          {hasActions && (
            <Button
              key="band-handoff"
              label="🤝"
              onPress={() => runAction($, 'handoff', () => startHandoff($, config))}
            />
          )}
          <Button key="band-details" label="📊" onPress={() => runAction($, 'details', () => openPane($))} />
          {/* Shown in every phase: the toggle writes a flag file and submits nothing. */}
          <Button
            key="band-caveman"
            label={isCavemanOn ? '🪨 on' : '🪨 off'}
            dimColor={!isCavemanOn}
            onPress={() => runAction($, 'caveman toggle', () => toggleCaveman($))}
          />
        </Box>
      </Box>
    )
  })
}
