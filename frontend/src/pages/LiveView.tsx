import { useEffect, useState } from 'react'
import { signInWithCustomToken, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { GameHeader, colors, typography, layout, spacing } from '@mygames/game-ui'
import { auth } from '../firebase'
import { getInstructorSession } from '../api'
import ClockSwitch from './ClockSwitch'
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

export default function LiveView() {
  const { ready, error } = useInstructorAuth()

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader />
      <main style={{ maxWidth: layout.maxWidth, margin: '0 auto', padding: `1.5rem ${layout.pagePad} 3rem` }}>
        <h1 style={{ marginTop: 0, marginBottom: spacing.gapMd, fontSize: '1.25rem', fontWeight: 600 }}>Crisis — live view</h1>
        {error && <p style={{ color: colors.deadlockText }}>{error}</p>}
        {!ready && !error && <p style={{ color: colors.textSecondary }}>Setting up session…</p>}
        {ready && (
          <>
            <ClockSwitch />
            <CrisisLivePanel />
          </>
        )}
      </main>
    </div>
  )
}
