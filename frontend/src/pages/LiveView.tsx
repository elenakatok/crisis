import { useEffect, useState } from 'react'
import { signInWithCustomToken, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { GameHeader, colors, typography, layout, spacing } from '@mygames/game-ui'
import { auth } from '../firebase'
import { getInstructorSession, getGameConfig } from '../api'
import CrisisLivePanel from './CrisisLivePanel'

// ═══════════════════════════════════════════════════════════════════════════════
// The SEPARATE "Live view" (/live) — its OWN window (SAA's pattern), so the instructor
// can put it on a second screen during class. It is the §4A WINDOW: the round clock
// switch (set before starting), then the live per-group view (round / stage / who the
// stage is waiting on / timeouts) with the launcher "Start game" action. Read-only apart
// from those two endorsed instructor actions. Bootstraps its own instructor session from
// the launch token in the query string (mirrors the shared dashboard).
// ═══════════════════════════════════════════════════════════════════════════════

function useInstructorAuth() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const params = new URLSearchParams(window.location.search)
      const devGid = import.meta.env.DEV ? params.get('_dev_game_instance_id') : null
      const tokenParam = params.get('token')
      try {
        await auth.authStateReady()
        const expected = devGid ? `instructor_${devGid}` : null
        if (auth.currentUser && (!expected || auth.currentUser.uid === expected)) { if (!cancelled) setReady(true); return }
        const args = devGid ? { _dev: { game_instance_id: devGid } } : tokenParam ? { token: tokenParam } : null
        if (!args) { if (!cancelled) setError('No launch token found.'); return }
        const res = await getInstructorSession(args)
        if (params.get('_session') === 'tab') await setPersistence(auth, browserSessionPersistence)
        await signInWithCustomToken(auth, res.customToken)
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not authenticate.')
      }
    })()
    return () => { cancelled = true }
  }, [])
  return { ready, error }
}

// /live shows the session mode READ-ONLY (the switch lives on the dashboard — one control,
// one place). §O2.1 step 1.
function ModeReadout() {
  const [mode, setMode] = useState<'on' | 'off'>('on') // default classroom until the config loads
  useEffect(() => { getGameConfig().then(c => setMode(c.clock_mode === 'off' ? 'off' : 'on')).catch(() => {}) }, [])
  return (
    <div data-testid="crisis-mode-readout" style={{ display: 'flex', alignItems: 'center', gap: spacing.gapSm, margin: `${spacing.gapMd} 0`, color: colors.textSecondary, fontSize: '0.9rem' }}>
      <span style={{ fontWeight: 600, color: colors.text }}>Session mode:</span>
      {mode === 'on' ? 'Classroom — round clock' : 'Online — no clock'}
      <span style={{ color: colors.textFaint }}>· change it on the dashboard</span>
    </div>
  )
}

export default function LiveView() {
  const { ready, error } = useInstructorAuth()

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader />
      <main style={{ maxWidth: layout.maxWidth, margin: '0 auto', padding: `1.5rem ${layout.pagePad} 3rem` }}>
        {/* UNIFORM with SAA's live view: heading + top-right orange "← Back to dashboard"
            (same window, href nav). */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapLg }}>
          <h2 style={{ margin: 0 }}>Live view</h2>
          <a data-testid="crisis-back-to-dashboard" href={`/dashboard${window.location.search}`} style={{ color: '#D38626', fontWeight: 600, fontSize: typography.sizeSm }}>← Back to dashboard</a>
        </div>
        {error && <p style={{ color: colors.errorText }}>{error}</p>}
        {!ready && !error && <p style={{ color: colors.textSecondary }}>Loading…</p>}
        {ready && (
          <>
            <ModeReadout />
            <CrisisLivePanel />
          </>
        )}
      </main>
    </div>
  )
}
