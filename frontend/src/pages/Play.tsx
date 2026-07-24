import React, { useCallback, useEffect, useRef, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, rtdb, functions } from '../firebase'
import { assignRole, confirmReady, verifyAttendanceCode, recordLogin, CLASSROOM_URL } from '../api'
import {
  useStudentSession,
  KnowledgeCheck,
  InfoPage,
  PrepQuestions,
  GameHeader,
  WaitingRoom,
  typography,
  colors,
  layout,
  spacing,
} from '@mygames/game-ui'
import type { BootstrapArgs, InfoPageLink } from '@mygames/game-ui'
import CrisisGame from '../game/CrisisGame'
import OnlineGroupReveal from '../game/OnlineGroupReveal'

// ── Phase state ───────────────────────────────────────────────────────────────
//
// Crisis Slice 0 (SCAFFOLD) wires the SHARED pre-game flow only: info → KC → prep →
// hold → confirmation → attendance-code → waiting-room → matched. The actual game (bid
// screen, allocation screen, fix screen, shared history table — spec §1.2) is the
// STUDENT UI slice (Slice 3) and is NOT built here; the terminal 'matched' state is a
// placeholder waiting room. Roles are assigned LATE (spec §2), so nothing role-specific
// is shown before the game begins.
type GamePhase =
  | { name: 'loading' }
  | { name: 'error';           message: string }
  | { name: 'info';            roleLabel: string; links: InfoPageLink[]; publicLink: { label: string; url: string } | null }
  | { name: 'kc' }
  | { name: 'prep' }
  | { name: 'hold' }
  | { name: 'confirmation' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room' }
  | { name: 'online_holding' }   // ONLINE: grouped at deploy, but the instructor hasn't grouped yet
  | { name: 'matched';         groupId: string }

// The per-instance clock/mode setting. 'off' = ONLINE play (no attendance code, no waiting
// room, group reveal on login); 'on' = CLASSROOM (unchanged). recordLogin returns this.
type Mode = 'on' | 'off'

// ── Phase routing ─────────────────────────────────────────────────────────────

type GetInfoUrlsResult = {
  ok: boolean
  roleLabel: string
  links: InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

// Returns the underlying phase PLUS, in online mode, the group to reveal first (the reveal
// is a gate layered in front of the phase — see the component). Classroom routing (mode 'on')
// is BYTE-IDENTICAL to before: same branches, revealGroupId always null.
async function routeToPhase(
  participantId: string,
  gameInstanceId: string,
  mode: Mode,
): Promise<{ phase: GamePhase; revealGroupId: string | null }> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}

  // ── Underlying phase ────────────────────────────────────────────────────────
  let phase: GamePhase
  if (d.prep_status !== 'complete') {
    // info → KC → prep is shared between both modes and unchanged.
    if (d.knowledge_check_score != null) {
      phase = { name: 'prep' }
    } else {
      const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
      const { data } = await fn({})
      phase = { name: 'info', roleLabel: data.roleLabel, links: data.links, publicLink: data.publicLink ?? null }
    }
  } else if (mode === 'off') {
    // ONLINE: no attendance code, no waiting room. Grouped → into the game; not yet → holding.
    phase = d.group_id ? { name: 'matched', groupId: d.group_id as string } : { name: 'online_holding' }
  } else {
    // CLASSROOM — unchanged join routing.
    if (!d.confirmed_ready_at)      phase = { name: 'hold' }
    else if (!d.attendance_confirmed_at) phase = { name: 'confirmation' }
    else if (!d.group_id)          phase = { name: 'waiting-room' }
    else                           phase = { name: 'matched', groupId: d.group_id as string }
  }

  // ── Online reveal gate: a pre-grouped student sees their group first, until it locks ──
  // Only for a group formed by online grouping (it carries members[]); a group without
  // members[] — e.g. a classroom/seeded group — never triggers the reveal.
  let revealGroupId: string | null = null
  if (mode === 'off' && d.group_id) {
    const gsnap = await getDoc(doc(db, 'game_instances', gameInstanceId, 'groups', d.group_id as string))
    const g = gsnap.exists() ? gsnap.data() : undefined
    const isOnlineGroup = Array.isArray(g?.members)
    const locked = g?.seats_locked_at != null
    if (isOnlineGroup && !locked) revealGroupId = d.group_id as string
  }

  return { phase, revealGroupId }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p       = new URLSearchParams(window.location.search)
  const token   = p.get('token')
  const testPid = import.meta.env.DEV ? p.get('_pid') : null
  const testGid = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase]             = useState<GamePhase>({ name: 'loading' })
  const [mode, setMode]               = useState<Mode>('on')
  const [revealGroupId, setRevealGroupId] = useState<string | null>(null)
  const revealDismissed               = useRef(false)
  const [headerLinks, setHeaderLinks] = useState<InfoPageLink[] | null>(null)
  const [confError,   setConfError]   = useState<string | null>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [codeValue,   setCodeValue]   = useState('')
  const [codeError,   setCodeError]   = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // ── Session lifecycle ────────────────────────────────────────────────────

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // ── Phase routing + header-link population ────────────────────────────────

  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false

    const run = async () => {
      // Session establishment: stamp last_login_at (best-effort) and learn the mode. On any
      // failure we fall back to 'on' — i.e. the unchanged classroom flow — so a transient
      // recordLogin error never strands a classroom student.
      let m: Mode = 'on'
      try {
        const rec = await recordLogin()
        m = rec.clock_mode === 'off' ? 'off' : 'on'
      } catch { /* best-effort; default to classroom routing */ }
      if (cancelled) return
      setMode(m)

      let res: { phase: GamePhase; revealGroupId: string | null }
      try {
        res = await routeToPhase(participantId, gameInstanceId, m)
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' })
        return
      }
      if (cancelled) return
      setPhase(res.phase)
      // Online reveal gate — show once per session, until dismissed or the group locks.
      setRevealGroupId(m === 'off' && res.revealGroupId && !revealDismissed.current ? res.revealGroupId : null)

      if (res.phase.name === 'info') {
        if (!cancelled) setHeaderLinks(res.phase.links)
      } else {
        const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
        fn({}).then(({ data }) => { if (!cancelled) setHeaderLinks(data.links) }).catch(() => {})
      }
    }

    void run()
    return () => { cancelled = true }
  }, [session])

  // Online-only: re-resolve the underlying phase after prep completes (online skips
  // hold/confirmation, so prep-done → straight into the game). Classroom keeps its own
  // onComplete → 'hold' path untouched.
  const rerouteOnline = useCallback(async () => {
    if (session.kind !== 'ready') return
    try {
      const res = await routeToPhase(session.participantId, session.gameInstanceId, 'off')
      setPhase(res.phase)
    } catch { /* leave the current phase in place */ }
  }, [session])

  // ── Render: pre-session states (no header) ────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Crisis</h2>
        <p>Please launch this game from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  const { participantId, gameInstanceId } = session

  // ── Join handlers ──────────────────────────────────────────────────────────

  const handleConfirmReady = () => {
    setConfLoading(true)
    setConfError(null)
    confirmReady({})
      .then(() => setPhase({ name: 'attendance-code' }))
      .catch((err: unknown) => {
        setConfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setConfLoading(false)
      })
  }

  const handleAttendanceCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = codeValue.trim()
    if (code.length < 4) return
    setCodeLoading(true)
    setCodeError(null)
    verifyAttendanceCode({}, code)
      .then(() => setPhase({ name: 'waiting-room' }))
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setCodeLoading(false)
      })
  }

  // ── Render: session ready — header persists across all phases ─────────────

  // Online reveal GATE: shown in front of the underlying phase until the student continues
  // (or the group locks). This is what makes the flow "login → reveal → continue → KC → play".
  if (revealGroupId) {
    return (
      <div style={{ fontFamily: typography.fontFamily }}>
        <GameHeader studentLinks={headerLinks} />
        <OnlineGroupReveal
          gameInstanceId={gameInstanceId}
          groupId={revealGroupId}
          participantId={participantId}
          onContinue={() => { revealDismissed.current = true; setRevealGroupId(null) }}
        />
      </div>
    )
  }

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader studentLinks={headerLinks} />

      {phase.name === 'online_holding' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Not grouped yet</h1>
          <p data-testid="crisis-online-holding" style={{ lineHeight: 1.6, color: colors.textSecondary }}>
            Your instructor has not formed groups yet. Check back soon — this page will show your
            group as soon as it does.
          </p>
        </main>
      )}

      {phase.name === 'info' && (
        <InfoPage
          roleLabel={phase.roleLabel}
          links={phase.links}
          publicLink={phase.publicLink}
          onContinue={() => setPhase({ name: 'kc' })}
        />
      )}

      {phase.name === 'kc' && (
        <KnowledgeCheck
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'prep' })}
        />
      )}

      {phase.name === 'prep' && (
        <PrepQuestions
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => { if (mode === 'off') void rerouteOnline(); else setPhase({ name: 'hold' }) }}
        />
      )}

      {phase.name === 'hold' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Preparation complete</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            When class begins and your instructor starts the session, you&apos;ll be placed
            in a group of three players.
          </p>
          <p style={{ color: colors.textSecondary, marginBottom: layout.pagePad }}>
            You can close this tab and come back later — your work has been saved.
          </p>
          <button onClick={() => setPhase({ name: 'confirmation' })}>
            I&apos;m in class — continue
          </button>
        </main>
      )}

      {phase.name === 'confirmation' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to play?</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ll be placed in a group of three. Only continue if you are in class and
            ready to take part right now.
          </p>
          {confError && (
            <p style={{ color: '#c00', marginBottom: spacing.gapSm }}>{confError}</p>
          )}
          <div style={{ display: 'flex', gap: spacing.gapBtn }}>
            <button onClick={handleConfirmReady} disabled={confLoading}>
              {confLoading ? 'Confirming…' : "Yes, I'm ready"}
            </button>
            <button
              onClick={() => setPhase({ name: 'hold' })}
              disabled={confLoading}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              Not now
            </button>
          </div>
        </main>
      )}

      {phase.name === 'attendance-code' && (
        <main style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
          <p style={{ lineHeight: 1.6, marginBottom: layout.pagePad }}>
            Enter the code your instructor is displaying.
          </p>
          <form onSubmit={handleAttendanceCode}>
            <input
              value={codeValue}
              onChange={e => setCodeValue(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. ABJKM"
              autoFocus
              autoCapitalize="characters"
              spellCheck={false}
              disabled={codeLoading}
              style={{
                fontSize:     '2rem',
                letterSpacing: '0.25em',
                width:         '100%',
                padding:       '0.5rem 0.75rem',
                boxSizing:     'border-box',
                fontFamily:    'monospace',
                textTransform: 'uppercase',
              }}
            />
            {codeError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
            )}
            <button
              type="submit"
              disabled={codeLoading || codeValue.trim().length < 4}
              style={{ marginTop: spacing.gapMd }}
            >
              {codeLoading ? 'Checking…' : 'Submit'}
            </button>
          </form>
        </main>
      )}

      {phase.name === 'waiting-room' && (
        <WaitingRoom
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          rtdb={rtdb}
          onMatched={(groupId) => setPhase({ name: 'matched', groupId })}
        />
      )}

      {phase.name === 'matched' && (
        <div data-testid="crisis-room">
          <CrisisGame participantId={participantId} gameInstanceId={gameInstanceId} groupId={phase.groupId} />
        </div>
      )}
    </div>
  )
}
