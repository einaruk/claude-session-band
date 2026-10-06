/** The last main-thread API activity: when the prompt cache was last refreshed and how big it is. */
export type CacheTouch = { at: number; contextTokens: number; model: string }

/** Handoff flow: idle → pending (handoff turn running) → ready (text captured, waiting for Clear & continue). */
export type CacheHandoff = { status: 'idle' | 'pending' | 'ready'; text: string }

/** Price calibration from the cost ledger: cost at the first observation and weighted token units since. */
export type CacheCalibration = { costStart: number; units: number }

declare module 'claude-code' {
  interface PluginState {
    'session-band': {
      touch: CacheTouch | null
      isRunning: boolean
      turnStartedAt: number | null
      now: number
      observedTtlMs: number | null
      warnedFor: number | null
      autoOpened: boolean
      handoff: CacheHandoff
      calibration: CacheCalibration | null
      /** This session's auto-compact point in tokens, 'off', or null for the mod setting / research default. */
      compactAt: number | 'off' | null
      /** Context tokens when an auto-compaction was last refused; null once one goes through. */
      compactRefusedAt: number | null
      /** The caveman plugin's flag as last read: its level, '' while off, null before the first read. */
      caveman: string | null
      /** The level the band's toggle switches caveman back on at: the last one seen on. */
      cavemanResume: string
      /** Whether caveman was on when the model was last told; null until a prompt or a toggle records it. */
      cavemanTold: boolean | null
      /** The writing-rules toggle's flag as last read. */
      style: boolean
      /** Whether the writing rules were on when the model was last told; null until a prompt or a toggle records it. */
      styleTold: boolean | null
      /** Whether the writing-rules toggle is offered: rules are set and their skill is installed. */
      styleAvailable: boolean
      /** The model id last seen on each side of the Fable ↔ Opus switch, so switching back restores it exactly. */
      modelSeen: { fable?: string; opus?: string }
    }
  }
}
