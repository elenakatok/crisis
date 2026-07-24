import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { db } from '../firebase'
import type { OnlineMember } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineMembersStrip (Slice O1). A compact, always-visible reminder of who's in the group,
// shown on the pre-round screens after the reveal — so a student waiting for the game to
// start still sees who to chase. Renders NOTHING unless the group doc carries members[]
// (i.e. only online groups; classroom groups have none) AND the group has not yet locked
// (seats_locked_at) — once round 1 begins the strip disappears. Reads the group doc directly
// (NOT the shared GroupMembersPanel/useGroupMembers, which ride the absent RTDB attending
// overlay).
// ═══════════════════════════════════════════════════════════════════════════════

export default function OnlineMembersStrip({
  gameInstanceId,
  groupId,
  participantId,
}: {
  gameInstanceId: string
  groupId: string
  participantId: string
}) {
  const [members, setMembers] = useState<OnlineMember[] | null>(null)
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : undefined
      const m = data?.members as OnlineMember[] | undefined
      setMembers(Array.isArray(m) ? m : [])
      setLocked(data?.seats_locked_at != null)
    }, () => { setMembers([]); setLocked(false) })
    return () => unsub()
  }, [gameInstanceId, groupId])

  // Online-only + pre-round-1 only.
  if (locked || !members || members.length === 0) return null

  return (
    <div
      data-testid="crisis-members-strip"
      style={{
        maxWidth: layout.contentWidth,
        margin: '0 auto',
        padding: `${spacing.gapSm} ${layout.pagePad}`,
        fontFamily: typography.fontFamily,
        fontSize: typography.sizeXs,
        color: colors.textSecondary,
        display: 'flex',
        gap: spacing.gapSm,
        alignItems: 'baseline',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 600, color: colors.sectionMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Your group:
      </span>
      {members.map((m, i) => (
        <span key={m.participant_id} style={{ color: colors.textStrong }}>
          {m.display_name}{m.participant_id === participantId ? ' · you' : ''}{i < members.length - 1 ? ',' : ''}
        </span>
      ))}
    </div>
  )
}
