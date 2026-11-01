window.__ModuleLoader__.load({
  id: '@yg/dsh-session-mover',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LONG_PRESS_MS = 220
    // The browser starts its own drag at roughly 5px, so anything wider than
    // that keeps the reorder first; this only forgives hand tremor.
    const MOVE_TOLERANCE = 12
    const SESSION_ROW_PREFIX = 'session:'
    const WORKSPACE_ROW_PREFIX = 'workspace:'

    let hostContext = null

    const TEXT = {
      zh: {
        title: '移动到其他工作区',
        hint: '松手即完成搬迁，会话历史一并带走',
        noTarget: '只有一个工作区，没有可移动的目标',
        moving: '正在移动到',
        moved: '已移动到',
        failed: '移动失败',
        cancelHint: '按 Esc 取消',
      },
      en: {
        title: 'Move to another workspace',
        hint: 'Release to finish; the whole session history moves with it',
        noTarget: 'Only one workspace, so there is nowhere to move to',
        moving: 'Moving to',
        moved: 'Moved to',
        failed: 'Move failed',
        cancelHint: 'Press Esc to cancel',
      },
    }

    function text() {
      try {
        const active = hostContext.locale.getLocale().active
        return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en
      } catch {
        return TEXT.en
      }
    }

    function apiUrl(method) {
      const base = new URL(document.baseURI)
      const path = base.pathname
      const directory = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1)
      return `${base.origin}${directory}yg-session-mover/api/${method}`
    }

    const S = {
      layer: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: '32px',
        zIndex: 60,
        pointerEvents: 'none',
      },
      card: {
        pointerEvents: 'auto',
        minWidth: '264px',
        maxWidth: '320px',
        maxHeight: '70vh',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-overlay, #1f1f22)',
        boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
        color: 'var(--dsw-alias-label-primary, #ededed)',
        font: '13px/1.45 system-ui, "Segoe UI", sans-serif',
      },
      heading: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary, #9a9a9a)' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      target: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '9px 10px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
        background: 'var(--dsw-alias-bg-layer-1, #26262a)',
        transition: 'border-color 120ms ease, background 120ms ease',
      },
      targetHover: {
        borderColor: 'var(--dsw-alias-brand-primary, #4c8dff)',
        background: 'var(--dsw-alias-bg-layer-2, #2f2f34)',
      },
      targetBusy: { opacity: 0.6 },
      source: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '8px 10px',
        borderRadius: '9px',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      },
      ghost: {
        pointerEvents: 'none',
        position: 'fixed',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-brand-primary, #4c8dff)',
        background: 'var(--dsw-alias-bg-overlay, #1f1f22)',
        color: 'var(--dsw-alias-label-primary, #ededed)',
        font: '12px/1.3 system-ui, "Segoe UI", sans-serif',
        maxWidth: '280px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        boxShadow: '0 10px 26px rgba(0,0,0,0.4)',
        zIndex: 61,
      },
      toast: {
        pointerEvents: 'none',
        position: 'fixed',
        left: '50%',
        bottom: '28px',
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-overlay, #1f1f22)',
        color: 'var(--dsw-alias-label-primary, #ededed)',
        font: '12.5px/1.4 system-ui, "Segoe UI", sans-serif',
        maxWidth: '60vw',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      toastError: { borderColor: 'var(--dsw-alias-state-error-primary, #ff5f5f)' },
      toastOk: { borderColor: 'var(--dsw-alias-state-success-primary, #3ecf8e)' },
    }

    function workspaceIdFromRowKey(key) {
      return typeof key === 'string' && key.startsWith(WORKSPACE_ROW_PREFIX) ? key.slice(WORKSPACE_ROW_PREFIX.length) : null
    }

    function TargetCard({ workspace, hovered, busy }) {
      return h(
        'div',
        {
          'data-mover-target': workspace.workspaceId,
          style: { ...S.target, ...(hovered ? S.targetHover : null), ...(busy ? S.targetBusy : null) },
        },
        h('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, workspace.title ?? workspace.path ?? workspace.workspaceId),
        workspace.path === undefined
          ? null
          : h(
              'div',
              {
                style: {
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              workspace.path,
            ),
      )
    }

    function Mover() {
      const ctx = hostContext
      const [items, setItems] = React.useState([])
      const [session, setSession] = React.useState(null)
      const [pointer, setPointer] = React.useState({ x: 0, y: 0 })
      const [hoverTarget, setHoverTarget] = React.useState(null)
      const hoverRef = React.useRef(null)
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)

      const model = ctx?.workspaces?.list
      const itemsRef = React.useRef(items)
      itemsRef.current = items

      const gesture = React.useRef({
        phase: 'idle',
        timer: 0,
        startX: 0,
        startY: 0,
        rowKey: null,
        sessionId: null,
        pointerId: null,
        suppressClickUntil: 0,
        blockDrag: null,
        cancelOnDrag: null,
        rowEl: null,
        rowDraggable: null,
      })

      React.useEffect(() => {
        if (model === undefined || typeof model.getSnapshot !== 'function') return undefined
        const read = () => setItems(model.getSnapshot().items ?? [])
        read()
        if (typeof model.subscribe !== 'function') return undefined
        return model.subscribe(read)
      }, [model])

      React.useEffect(() => {
        if (note === null) return undefined
        const timer = window.setTimeout(() => setNote(null), 4200)
        return () => window.clearTimeout(timer)
      }, [note])

      const reset = React.useCallback(() => {
        const g = gesture.current
        if (g.timer !== 0) window.clearTimeout(g.timer)
        if (g.blockDrag !== null) {
          window.removeEventListener('dragstart', g.blockDrag, true)
          g.blockDrag = null
        }
        if (g.cancelOnDrag !== null) {
          window.removeEventListener('dragstart', g.cancelOnDrag, true)
          g.cancelOnDrag = null
        }
        if (g.rowEl !== null) {
          if (g.rowDraggable === null) g.rowEl.removeAttribute('draggable')
          else g.rowEl.setAttribute('draggable', g.rowDraggable)
          g.rowEl = null
          g.rowDraggable = null
        }
        g.phase = 'idle'
        g.timer = 0
        g.rowKey = null
        g.sessionId = null
        g.pointerId = null
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        setSession(null)
        setHoverTarget(null)
      }, [])

      const moveTo = React.useCallback(
        async (targetWorkspaceId) => {
          const current = gesture.current.sessionId
          if (current === null || targetWorkspaceId === null) {
            reset()
            return
          }
          const labels = text()
          const target = itemsRef.current.find((item) => item.workspaceId === targetWorkspaceId)
          const label = target?.title ?? target?.path ?? targetWorkspaceId
          reset()
          setBusy(targetWorkspaceId)
          setNote({ tone: 'idle', message: `${labels.moving} ${label}` })
          try {
            const response = await fetch(apiUrl('move'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: current, targetWorkspaceId }),
            })
            const payload = await response.json()
            if (payload !== null && payload.ok === true) {
              setNote({ tone: 'ok', message: `${labels.moved} ${label}` })
            } else {
              const detail = payload?.error?.message ?? `HTTP ${response.status}`
              setNote({ tone: 'error', message: `${labels.failed}: ${detail}` })
            }
          } catch (error) {
            setNote({ tone: 'error', message: `${labels.failed}: ${error?.message ?? String(error)}` })
          } finally {
            setBusy(null)
          }
        },
        [reset],
      )

      React.useEffect(() => {
        if (ctx === null) return undefined
        const g = gesture.current

        const findWorkspaceUnder = (x, y) => {
          const element = document.elementFromPoint(x, y)
          if (element === null) return null
          const known = element.closest('[data-mover-target]')
          if (known !== null) {
            const id = known.getAttribute('data-mover-target')
            return id === null || id === '' ? null : id
          }
          const row = element.closest('[data-row-key]')
          if (row === null) return null
          const candidate = workspaceIdFromRowKey(row.getAttribute('data-row-key'))
          if (candidate === null) return null
          return itemsRef.current.some((item) => item.workspaceId === candidate) ? candidate : null
        }

        const arm = () => {
          const owner = itemsRef.current.find(
            (item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(g.sessionId),
          )
          if (owner === undefined || itemsRef.current.length < 2) {
            reset()
            return
          }
          g.phase = 'armed'
          g.timer = 0
          // The long press won the race, so the reorder branch is over: drop the
          // canceller before it can demote this gesture back to idle.
          if (g.cancelOnDrag !== null) {
            window.removeEventListener('dragstart', g.cancelOnDrag, true)
            g.cancelOnDrag = null
          }
          // The press outlived the browser's own drag threshold, so the row is
          // ours now: suppress the native reorder for this drag only.
          if (g.rowEl !== null) g.rowEl.setAttribute('draggable', 'false')
          g.blockDrag = (event) => {
            event.preventDefault()
            event.stopPropagation()
          }
          window.addEventListener('dragstart', g.blockDrag, true)
          const selection = window.getSelection()
          if (selection !== null && selection.rangeCount > 0) selection.removeAllRanges()
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'grabbing'
          setSession({
            sessionId: g.sessionId,
            sourceWorkspaceId: owner.workspaceId,
            title: owner.title ?? owner.path ?? '',
          })
        }

        const onPointerDown = (event) => {
          if (event.button !== 0) return
          const target = event.target
          if (!(target instanceof Element)) return
          if (target.closest('[data-mover-target]') !== null) return
          const row = target.closest('[data-row-key]')
          if (row === null) return
          const key = row.getAttribute('data-row-key')
          if (typeof key !== 'string' || !key.startsWith(SESSION_ROW_PREFIX)) return
          const sessionId = key.slice(SESSION_ROW_PREFIX.length)
          if (sessionId === '') return
          reset()
          g.phase = 'pending'
          g.startX = event.clientX
          g.startY = event.clientY
          g.rowKey = key
          g.sessionId = sessionId
          g.pointerId = event.pointerId
          g.rowEl = row
          g.rowDraggable = row.getAttribute('draggable')
          // The sidebar's own reorder keeps the gesture if the pointer moves
          // first: a real drag cancels the pending long press.
          g.cancelOnDrag = () => {
            // Only a still-pending press can be cancelled; once armed the
            // gesture belongs to the mover even if the browser fires dragstart.
            if (g.phase !== 'pending') return
            reset()
          }
          window.addEventListener('dragstart', g.cancelOnDrag, true)
          g.timer = window.setTimeout(arm, LONG_PRESS_MS)
        }

        const onPointerMove = (event) => {
          if (g.phase === 'pending') {
            const dx = event.clientX - g.startX
            const dy = event.clientY - g.startY
            if (dx * dx + dy * dy > MOVE_TOLERANCE * MOVE_TOLERANCE) reset()
            return
          }
          if (g.phase !== 'armed') return
          event.preventDefault()
          if (event.buttons === 0) {
            // The release was swallowed (native drag grab or a lost pointerup);
            // the button is up, so finish with the position we have.
            finish(event.clientX, event.clientY)
            return
          }
          setPointer({ x: event.clientX, y: event.clientY })
          const next = findWorkspaceUnder(event.clientX, event.clientY)
          hoverRef.current = next
          setHoverTarget(next)
        }

        const finish = (x, y) => {
          if (g.phase !== 'armed') {
            if (g.phase === 'pending') reset()
            return
          }
          const target = findWorkspaceUnder(x, y) ?? hoverRef.current
          if (target !== null) {
            g.suppressClickUntil = Date.now() + 350
            moveTo(target)
            return
          }
          reset()
        }

        const onPointerUp = (event) => {
          finish(event.clientX, event.clientY)
        }

        // The browser cancels the pointer stream once a native drag would begin;
        // the mouse stream still reports the release, so drop is finished there.
        const onMouseUp = (event) => {
          if (g.phase !== 'armed') return
          finish(event.clientX, event.clientY)
        }

        const onPointerCancel = () => {
          if (g.phase === 'armed') return
          reset()
        }

        const onClickCapture = (event) => {
          if (Date.now() > g.suppressClickUntil) return
          event.preventDefault()
          event.stopPropagation()
        }

        const onKeyDown = (event) => {
          if (event.key === 'Escape' && g.phase === 'armed') reset()
        }

        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
        window.addEventListener('pointerup', onPointerUp, true)
        window.addEventListener('pointercancel', onPointerCancel, true)
        window.addEventListener('mouseup', onMouseUp, true)
        window.addEventListener('click', onClickCapture, true)
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('pointermove', onPointerMove, { capture: true })
          window.removeEventListener('pointerup', onPointerUp, true)
          window.removeEventListener('pointercancel', onPointerCancel, true)
          window.removeEventListener('mouseup', onMouseUp, true)
          window.removeEventListener('click', onClickCapture, true)
          window.removeEventListener('keydown', onKeyDown, true)
          document.body.style.userSelect = ''
          document.body.style.cursor = ''
          if (g.timer !== 0) window.clearTimeout(g.timer)
          g.phase = 'idle'
        }
      }, [ctx, moveTo, reset])

      const labels = text()
      const targets =
        session === null ? [] : items.filter((item) => item.workspaceId !== session.sourceWorkspaceId)

      const floating =
        session === null
          ? null
          : h(
              'div',
              null,
              h(
                'div',
                { style: { ...S.ghost, left: `${pointer.x}px`, top: `${pointer.y}px` } },
                session.title === '' ? labels.title : session.title,
              ),
              h(
                'div',
                { style: S.layer },
                h(
                  'div',
                  { style: S.card },
                  h(
                    'div',
                    { style: S.heading },
                    h('div', { style: S.title }, labels.title),
                    h('div', { style: S.hint }, labels.hint),
                  ),
                  h(
                    'div',
                    { style: S.list },
                    targets.length === 0
                      ? h('div', { style: S.hint }, labels.noTarget)
                      : targets.map((item) =>
                          h(TargetCard, {
                            key: item.workspaceId,
                            workspace: item,
                            hovered: hoverTarget === item.workspaceId,
                            busy: busy === item.workspaceId,
                          }),
                        ),
                  ),
                  h('div', { style: S.source }, h('div', { style: { fontSize: '11px' } }, labels.cancelHint)),
                ),
              ),
            )

      const toast =
        note === null
          ? null
          : h(
              'div',
              {
                style: {
                  ...S.toast,
                  ...(note.tone === 'error' ? S.toastError : null),
                  ...(note.tone === 'ok' ? S.toastOk : null),
                },
              },
              note.message,
            )

      return h(React.Fragment, null, floating, toast)
    }

    return {
      inject: ['slots', 'workspaces', 'locale'],
      apply(ctx) {
        hostContext = ctx
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'yg-session-mover-drop', order: 900 }, Mover),
        )
        return () => {
          hostContext = null
        }
      },
    }
  },
})
