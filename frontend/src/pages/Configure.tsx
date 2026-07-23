import { useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'

/**
 * Thin redirect stub — the classroom links here for "edit session item".
 * Crisis has no dedicated Configure UI; the config fields (round_seconds, num_rounds,
 * player_sheet_url) are edited on the shared SettingsPage. Redirect to /dashboard with
 * the same launch params.
 */
export default function Configure() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const token          = searchParams.get('token')
  const gameInstanceId = searchParams.get('game_instance_id')

  useEffect(() => {
    if (token && gameInstanceId) {
      navigate(
        `/dashboard?token=${encodeURIComponent(token)}&game_instance_id=${encodeURIComponent(gameInstanceId)}`,
        { replace: true },
      )
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!token || !gameInstanceId) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 480, margin: '4rem auto' }}>
        <p style={{ color: '#8b1a1a', fontWeight: 600 }}>Missing session parameters.</p>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>
          This page must be opened from the classroom. Return there and click Launch.
        </p>
      </main>
    )
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', color: '#888', textAlign: 'center', paddingTop: '6rem' }}>
      Redirecting…
    </main>
  )
}
