import { useCallback, useEffect, useState } from 'react'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { getOnlineGroups, groupParticipantsOnline, type OnlineGroup } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineGroupingPanel (Slice O1) — the instructor's online grouping control, portaled above
// the shared dashboard. Renders ONLY in online mode (clock_mode='off'); in classroom mode it
// is invisible and the dashboard is untouched. The single "Group Participants" button pre-forms
// random groups of 3 from the roster; the formed groups (names + emails) render below it.
// Re-grouping is rejected once any group has locked — that rejection is surfaced verbatim.
// ═══════════════════════════════════════════════════════════════════════════════

export default function OnlineGroupingPanel() {
  const [online, setOnline] = useState<boolean | null>(null) // null = not yet known
  const [groups, setGroups] = useState<OnlineGroup[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await getOnlineGroups()
      setOnline(r.clock_mode === 'off')
      setGroups(r.groups ?? [])
    } catch {
      // Not fatal — if this fails the panel simply stays hidden; the rest of the dashboard runs.
      setOnline(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleGroup = async () => {
    setBusy(true); setError(null)
    try {
      await groupParticipantsOnline()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Grouping failed. Please try again.')
    }
    setBusy(false)
  }

  // Classroom mode (or unknown/failed): render nothing — dashboard unchanged.
  if (online !== true) return null

  const anyLocked = groups.some((g) => g.locked)

  return (
    <section
      data-testid="crisis-online-grouping"
      style={{
        maxWidth: layout.contentWidth,
        margin: `${spacing.gapMd} auto 0`,
        padding: layout.pagePad,
        fontFamily: typography.fontFamily,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        background: colors.surfaceSubtle,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap' }}>
        <strong style={{ color: colors.textStrong }}>Online mode — group participants</strong>
        <button data-testid="crisis-group-participants" onClick={handleGroup} disabled={busy || anyLocked}>
          {busy ? 'Grouping…' : groups.length > 0 ? 'Re-group participants' : 'Group Participants'}
        </button>
        {anyLocked && (
          <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>
            A group has started playing — groups are locked.
          </span>
        )}
      </div>

      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: `${spacing.gapSm} 0 0` }}>
        Forms random groups of three from the whole roster (no attendance code). Any leftover
        one or two students form one short group. You can re-group until the first group starts
        playing.
      </p>

      {error && (
        <p data-testid="crisis-grouping-error" role="alert" style={{ color: '#b91c1c', marginTop: spacing.gapSm }}>
          {error}
        </p>
      )}

      {groups.length > 0 && (
        <ol data-testid="crisis-online-groups" style={{ margin: `${spacing.gapMd} 0 0`, paddingLeft: '1.4rem' }}>
          {groups.map((g) => (
            <li key={g.group_id} style={{ marginBottom: spacing.gapSm }}>
              <span style={{ color: colors.textSecondary, fontSize: typography.sizeXs }}>
                {g.size} player{g.size === 1 ? '' : 's'}{g.locked ? ' · locked' : ''}
              </span>
              <div style={{ display: 'flex', gap: spacing.gapMd, flexWrap: 'wrap', marginTop: 2 }}>
                {g.members.map((m) => (
                  <span key={m.participant_id} style={{ color: colors.textStrong }}>
                    {m.display_name}
                    {m.email && (
                      <span style={{ color: colors.textMuted, fontSize: typography.sizeXs }}> ({m.email})</span>
                    )}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
