import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colors } from '@mygames/game-ui'
import { getCrisisDashboard, groupParticipantsOnline } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineMatchControl (Slice O2.1) — the SINGLE matching control, in the toolbar at "Match Now"'s
// historical position, both modes:
//   • Classroom (clock_mode='on'): nothing here — the shared "Match Now" stays, byte-identical.
//   • Online (clock_mode='off'): the shared "Match Now" is DOM-hidden and this control takes its
//     place — "Group participants" / "Re-group participants", disabled with a lock message once a
//     group has started.
// Approved mechanism (no shared edit): hide the shared button + portal ours into its slot.
// ═══════════════════════════════════════════════════════════════════════════════

function findMatchWrapper(): HTMLElement | null {
  for (const btn of Array.from(document.querySelectorAll('button'))) {
    const t = (btn.textContent ?? '').trim()
    if (t === 'Match Now' || t === 'Matching…') return btn.parentElement
  }
  return null
}

export default function OnlineMatchControl() {
  const [online, setOnline] = useState(false)
  const [groupsCount, setGroupsCount] = useState(0)
  const [anyStarted, setAnyStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const [, force] = useState(0)

  useEffect(() => {
    let alive = true
    const tick = () => getCrisisDashboard().then(r => {
      if (!alive || !r.ok) return
      setOnline(r.clock_mode === 'off')
      setGroupsCount(r.groups.length)
      setAnyStarted(r.groups.some(g => g.status !== 'not_started'))
    }).catch(() => {})
    tick()
    const id = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!online) {
      const w = findMatchWrapper(); if (w) w.style.display = ''
      if (hostRef.current) { hostRef.current.remove(); hostRef.current = null; force(x => x + 1) }
      return
    }
    if (!hostRef.current) { hostRef.current = document.createElement('div'); hostRef.current.setAttribute('data-crisis-match-host', ''); force(x => x + 1) }
    const place = () => {
      const wrapper = findMatchWrapper()
      if (!wrapper) return
      if (wrapper.style.display !== 'none') wrapper.style.display = 'none' // hide shared Match Now
      const h = hostRef.current
      if (h && h.previousElementSibling !== wrapper) wrapper.parentElement?.insertBefore(h, wrapper.nextSibling)
    }
    place()
    const mo = new MutationObserver(place)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      const w = findMatchWrapper(); if (w) w.style.display = ''
      if (hostRef.current) { hostRef.current.remove(); hostRef.current = null }
    }
  }, [online])

  if (!online || !hostRef.current) return null

  const label = groupsCount === 0 ? 'Group participants' : 'Re-group participants'
  const doGroup = async () => { setBusy(true); setError(null); try { await groupParticipantsOnline() } catch (e) { setError(e instanceof Error ? e.message : 'failed') } setBusy(false) }

  return createPortal(
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <button data-testid="crisis-match-control" onClick={doGroup} disabled={busy || anyStarted}>
        {busy ? 'Grouping…' : label}
      </button>
      {anyStarted && <span style={{ fontSize: '0.7rem', color: colors.textMuted, marginTop: 2 }}>A group has started — re-grouping is locked.</span>}
      {error && <span style={{ fontSize: '0.7rem', color: '#b91c1c', marginTop: 2 }}>{error}</span>}
    </div>,
    hostRef.current,
  )
}
