import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSettings, PRESETS, VOICES, DEFAULTS, type Settings } from '../lib/settings'
import { createSpeaker } from '../lib/tts'

/**
 * Settings: everything a user might want to change, applied the moment it
 * changes and remembered in this browser. Opened from ⚙ in the toolbar.
 */

const TABS = ['Appearance', 'Voice', 'Listening', 'Interface', 'Music'] as const
type Tab = (typeof TABS)[number]

function Toggle({ label, on, set, hint }: { label: string; on: boolean; set: (v: boolean) => void; hint?: string }) {
  return (
    <label className="st-row">
      <span>
        <span className="st-label">{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </span>
      <button className={`st-switch${on ? ' st-on' : ''}`} onClick={() => set(!on)} role="switch" aria-checked={on}>
        <i />
      </button>
    </label>
  )
}

export function SettingsPanel() {
  const { settings, open, setOpen, update, reset } = useSettings()
  const [tab, setTab] = useState<Tab>('Appearance')
  const set = (patch: (s: Settings) => Settings) => update(patch)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])
  const show = (k: keyof Settings['show']) => (v: boolean) => set((s) => ({ ...s, show: { ...s.show, [k]: v } }))

  const preview = (voice: string) => {
    set((s) => ({ ...s, voice }))
    // Spoken through the normal speaker so it is exactly what answers sound like.
    setTimeout(() => {
      const spk = createSpeaker()
      spk.push(`This is ${VOICES[voice]?.split(' — ')[0] ?? 'the new voice'}. Twenty-one degrees and overcast, sir — how do I sound?`)
      void spk.end()
    }, 50)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="st-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <motion.section
            className="st"
            role="dialog"
            aria-label="Settings"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          >
            <span className="pk pk-tl" />
            <span className="pk pk-tr" />
            <span className="pk pk-bl" />
            <span className="pk pk-br" />
            <header className="st-head">
              <span>⚙ SETTINGS</span>
              <button className="bl-btn" onClick={() => setOpen(false)} title="Close (Esc)">
                ✕
              </button>
            </header>
            <nav className="st-tabs">
              {TABS.map((t) => (
                <button key={t} className={`st-tab${t === tab ? ' st-tab-on' : ''}`} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </nav>

            <div className="st-body">
              {tab === 'Appearance' && (
                <>
                  <div className="st-section">Two-tone theme</div>
                  <div className="st-presets">
                    {Object.entries(PRESETS).map(([id, p]) => (
                      <button
                        key={id}
                        className={`st-preset${settings.theme.preset === id ? ' st-preset-on' : ''}`}
                        onClick={() => set((s) => ({ ...s, theme: { preset: id, primary: p.primary, secondary: p.secondary } }))}
                        title={p.label}
                      >
                        <span className="st-swatch" style={{ background: `linear-gradient(135deg, ${p.primary} 50%, ${p.secondary} 50%)` }} />
                        <span>{p.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="st-colours">
                    <label className="st-colour">
                      <input
                        type="color"
                        value={settings.theme.primary}
                        onChange={(e) => set((s) => ({ ...s, theme: { ...s.theme, preset: 'custom', primary: e.target.value } }))}
                      />
                      <span>
                        <span className="st-label">Primary</span>
                        <span className="st-hint">rings, glow, the interface</span>
                      </span>
                    </label>
                    <label className="st-colour">
                      <input
                        type="color"
                        value={settings.theme.secondary}
                        onChange={(e) => set((s) => ({ ...s, theme: { ...s.theme, preset: 'custom', secondary: e.target.value } }))}
                      />
                      <span>
                        <span className="st-label">Secondary</span>
                        <span className="st-hint">detail arcs, headings, thinking</span>
                      </span>
                    </label>
                  </div>
                  <div className="st-section">Reactor size</div>
                  <div className="st-row">
                    <input
                      className="st-range"
                      type="range"
                      min={0.6}
                      max={1.6}
                      step={0.05}
                      value={settings.reactorScale}
                      onChange={(e) => set((s) => ({ ...s, reactorScale: Number(e.target.value) }))}
                    />
                    <span className="st-val">{Math.round(settings.reactorScale * 100)}%</span>
                  </div>
                </>
              )}

              {tab === 'Voice' && (
                <>
                  <div className="st-section">ZEN's voice (runs on this Mac)</div>
                  <div className="st-list">
                    {Object.entries(VOICES).map(([id, label]) => (
                      <div key={id} className={`st-voice${settings.voice === id ? ' st-voice-on' : ''}`}>
                        <button className="st-voice-pick" onClick={() => set((s) => ({ ...s, voice: id }))}>
                          <span className="st-radio" />
                          {label}
                        </button>
                        <button className="tb-btn" onClick={() => preview(id)}>
                          ▶ PREVIEW
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === 'Listening' && (
                <>
                  <div className="st-section">After an answer, keep listening for</div>
                  <div className="st-row">
                    <input
                      className="st-range"
                      type="range"
                      min={0}
                      max={20}
                      step={1}
                      value={settings.followUpSec}
                      onChange={(e) => set((s) => ({ ...s, followUpSec: Number(e.target.value) }))}
                    />
                    <span className="st-val">{settings.followUpSec ? `${settings.followUpSec}s` : 'off'}</span>
                  </div>
                  <p className="st-hint st-para">
                    Within this window you can ask a follow-up without saying “Hey Zen”. Shorter picks up less background
                    noise; 0 means always say the wake word.
                  </p>
                </>
              )}

              {tab === 'Interface' && (
                <>
                  <div className="st-section">Show on screen</div>
                  <Toggle label="Brand (Z.E.N.)" on={settings.show.brand} set={show('brand')} />
                  <Toggle label="Systems list" on={settings.show.systems} set={show('systems')} hint="left rail" />
                  <Toggle label="Transcript" on={settings.show.transcript} set={show('transcript')} />
                  <Toggle label="Suggestions" on={settings.show.suggestions} set={show('suggestions')} hint="“try saying…”" />
                  <Toggle label="Activity badge" on={settings.show.toolBadge} set={show('toolBadge')} hint="“Checking the weather…”" />
                </>
              )}

              {tab === 'Music' && (
                <>
                  <div className="st-section">Player</div>
                  <Toggle label="Up next & For you" on={settings.show.picks} set={show('picks')} hint="recommendations in the player" />
                  <Toggle
                    label="Lyrics open by default"
                    on={settings.lyricsByDefault}
                    set={(v) => set((s) => ({ ...s, lyricsByDefault: v }))}
                  />
                </>
              )}
            </div>

            <footer className="st-foot">
              <span className="st-hint">Saved on this Mac · applies instantly</span>
              <button
                className="tb-btn"
                onClick={() => {
                  if (confirm('Reset every setting to the default?')) reset()
                }}
                disabled={JSON.stringify(settings) === JSON.stringify(DEFAULTS)}
              >
                RESET ALL
              </button>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
