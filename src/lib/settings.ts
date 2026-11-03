import { create } from 'zustand'
import type { Phase } from '../store'

/**
 * The user's settings, kept in this browser and applied live. Everything the
 * Settings panel changes lives here; nothing in it needs a restart.
 */

export type Theme = { preset: string; primary: string; secondary: string }

export type Settings = {
  theme: Theme
  /** Kokoro voice id for the local voice server. */
  voice: string
  /** How long ZEN keeps listening after an answer, without the wake word. */
  followUpSec: number
  /** Reactor size multiplier. */
  reactorScale: number
  show: {
    systems: boolean
    transcript: boolean
    suggestions: boolean
    brand: boolean
    toolBadge: boolean
    picks: boolean
  }
  lyricsByDefault: boolean
}

/** Two-tone presets: primary carries the interface, secondary the detail. */
export const PRESETS: Record<string, { label: string; primary: string; secondary: string }> = {
  sapphire: { label: 'Sapphire', primary: '#2f6bff', secondary: '#dfe9ff' },
  royal: { label: 'Sapphire & Gold', primary: '#2f6bff', secondary: '#ffc857' },
  cyber: { label: 'Cyberpunk', primary: '#00e5ff', secondary: '#ff2bd6' },
  aurora: { label: 'Aurora', primary: '#00f5a0', secondary: '#8b5cf6' },
  ember: { label: 'Ember', primary: '#ff3d3d', secondary: '#ffb000' },
  rose: { label: 'Rose', primary: '#ff2d6f', secondary: '#ffd1dc' },
  violet: { label: 'Violet & Teal', primary: '#8b5cf6', secondary: '#2dd4bf' },
  mono: { label: 'Mono', primary: '#d6dbe4', secondary: '#7c8798' },
}

export const VOICES: Record<string, string> = {
  bm_george: 'George — British male (default)',
  bm_fable: 'Fable — British male, warmer',
  bm_lewis: 'Lewis — British male, lower',
  bm_daniel: 'Daniel — British male, brighter',
  bf_emma: 'Emma — British female',
  af_heart: 'Heart — American female (best rated)',
  af_bella: 'Bella — American female',
  am_michael: 'Michael — American male',
  am_fenrir: 'Fenrir — American male, deeper',
}

export const DEFAULTS: Settings = {
  theme: { preset: 'sapphire', ...PRESETS.sapphire },
  voice: 'bm_george',
  followUpSec: 7,
  reactorScale: 1,
  show: { systems: true, transcript: true, suggestions: true, brand: true, toolBadge: true, picks: true },
  lyricsByDefault: false,
}

const KEY = 'zen.settings'

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!saved) return DEFAULTS
    return { ...DEFAULTS, ...saved, theme: { ...DEFAULTS.theme, ...saved.theme }, show: { ...DEFAULTS.show, ...saved.show } }
  } catch {
    return DEFAULTS
  }
}

type SettingsStore = {
  settings: Settings
  open: boolean
  setOpen: (open: boolean) => void
  update: (patch: (s: Settings) => Settings) => void
  reset: () => void
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: load(),
  open: false,
  setOpen: (open) => set({ open }),
  update: (patch) =>
    set((st) => {
      const settings = patch(st.settings)
      try {
        localStorage.setItem(KEY, JSON.stringify(settings))
      } catch {
        /* storage blocked: still applies for this session */
      }
      return { settings }
    }),
  reset: () => {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* noop */
    }
    set({ settings: DEFAULTS })
  },
}))

/** Mix two hex colours, t in 0..1 toward b. */
function mix(a: string, b: string, t: number): string {
  const pa = a.match(/\w\w/g)!.map((x) => parseInt(x, 16))
  const pb = b.match(/\w\w/g)!.map((x) => parseInt(x, 16))
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/**
 * The phase colours for a two-tone theme: the primary at rest and when
 * listening or speaking, leaning toward the secondary while it thinks and
 * works, so a state change still reads as a change of colour.
 */
export function themePalette({ primary, secondary }: Theme): Record<Phase, string> {
  return {
    offline: mix(primary, '#000000', 0.7),
    boot: primary,
    dormant: mix(primary, '#000000', 0.25),
    waking: mix(primary, '#ffffff', 0.3),
    listening: primary,
    thinking: mix(primary, secondary, 0.45),
    tooling: mix(primary, secondary, 0.7),
    speaking: mix(primary, '#ffffff', 0.15),
  }
}

/** Read without React, for code paths outside components. */
export const currentSettings = () => useSettings.getState().settings
