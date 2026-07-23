import { useEffect, useRef, useState } from 'react'
import { colors } from '@mygames/game-ui'

// Per-stage countdown — ONLY rendered when the clock is ON (deadlineMs non-null, §3.1).
// At the threshold it nudges the person being waited on through TWO channels (some mute
// tabs, some have headphones off) and fires exactly ONCE per stage — a muted tab is worse
// than no beep, so we never nag.

const THRESHOLD_S = 30

function beepOnce() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.value = 0.05
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.18)
    osc.onended = () => ctx.close().catch(() => {})
  } catch { /* autoplay blocked / no audio — the title flash still fires */ }
}

export default function ClockBar({
  deadlineMs, stageKey, nudge,
}: {
  /** Stage deadline (ms epoch), or null when the clock is off → this component renders nothing. */
  deadlineMs: number | null
  /** Changes each stage/round so the once-per-stage nudge re-arms. */
  stageKey: string
  /** True when THIS seat owes the pending action (the person being waited on). */
  nudge: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  const firedFor = useRef<string | null>(null)
  const origTitle = useRef<string>(typeof document !== 'undefined' ? document.title : '')

  useEffect(() => {
    if (deadlineMs === null) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [deadlineMs])

  const secondsLeft = deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - now) / 1000))

  useEffect(() => {
    if (deadlineMs === null || secondsLeft === null) return
    if (nudge && secondsLeft <= THRESHOLD_S && secondsLeft > 0 && firedFor.current !== stageKey) {
      firedFor.current = stageKey
      beepOnce()
      document.title = `⏰ ${secondsLeft}s — your move`
      setTimeout(() => { document.title = origTitle.current }, 5000)
    }
  }, [secondsLeft, nudge, stageKey, deadlineMs])

  if (deadlineMs === null || secondsLeft === null) return null

  const urgent = secondsLeft <= THRESHOLD_S
  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div
      data-testid="crisis-clock"
      data-seconds-left={secondsLeft}
      style={{
        display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: 4,
        fontVariantNumeric: 'tabular-nums', fontWeight: 600,
        background: urgent ? '#fde8e8' : colors.surfaceSubtle,
        color: urgent ? '#b91c1c' : colors.textSecondary,
        border: `1px solid ${urgent ? '#f5b5b5' : colors.borderLight}`,
      }}
    >
      ⏱ {mm}:{ss}
    </div>
  )
}
