import { useEffect, useState } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { getGameConfig, setClockMode } from '../api'

// A clearly-labeled switch the instructor sets BEFORE starting a game (§3.1):
//   ON  = classroom — each stage has a 120s clock; a timeout applies the default table.
//   OFF = online play — no clock; a stage closes only when every seat has acted.
// Writes the per-instance `clock_mode` config field via updateGameConfig (read at openRound).

const btn = (active: boolean): React.CSSProperties => ({
  padding: '0.35rem 0.9rem', fontWeight: 600, cursor: 'pointer', borderRadius: 4,
  border: `1px solid ${active ? colors.text : colors.borderLight}`,
  background: active ? colors.text : colors.white,
  color: active ? colors.white : colors.textSecondary,
})

export default function ClockSwitch() {
  const [mode, setMode] = useState<'on' | 'off' | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getGameConfig().then(c => setMode(c.clock_mode === 'off' ? 'off' : 'on')).catch(() => setMode('on'))
  }, [])

  const choose = async (m: 'on' | 'off') => {
    if (m === mode || saving) return
    setSaving(true); setErr(null)
    try { const c = await setClockMode(m); setMode(c.clock_mode === 'off' ? 'off' : 'on') }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.') }
    setSaving(false)
  }

  return (
    <div data-testid="crisis-clock-switch" style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap', margin: `${spacing.gapMd} 0` }}>
      <span style={{ fontWeight: 600 }}>Round clock</span>
      <span style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>Set this before starting.</span>
      <div style={{ display: 'flex', gap: spacing.gapSm }}>
        <button data-testid="clock-on" style={btn(mode === 'on')} disabled={saving || mode === null} onClick={() => choose('on')}>ON — classroom</button>
        <button data-testid="clock-off" style={btn(mode === 'off')} disabled={saving || mode === null} onClick={() => choose('off')}>OFF — online</button>
      </div>
      {mode && <span data-testid="clock-mode-value" style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>
        {mode === 'on' ? 'Timeouts apply the default action after 120s.' : 'No clock — stages wait for every player.'}
      </span>}
      {err && <span style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{err}</span>}
    </div>
  )
}
