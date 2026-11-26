// Sidebar surface: one project at a time, with a project switcher on top.
//
// Contract notes (verified against the installed 0.2.2-rc.5 bundles):
// - `sidebar.workspaces` is a root-scoped `single` slot; this plugin occupies it
//   instead of the shipped Workspace browser. Disabling the plugin restores that
//   browser, because the slot falls back to its other registrant.
// - Data comes from the Client services `sessions` and `workspaces`, whose `list`
//   members are snapshot stores: `{ getSnapshot(), subscribe(fn) }`.
// - Navigation, pinning and unarchiving go through the `uiWorkspace` service.

window.__ModuleLoader__.load({
  id: 'dsh-project-scope',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'projectScope'
    const STORAGE_KEY = 'dsh-project-scope:selected-workspace'
    const FAVORITES_KEY = 'dsh-project-scope:favorites'

    function loadFavorites() {
      try {
        const raw = window.localStorage.getItem(FAVORITES_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({ key: entry.key, at: typeof entry.at === 'number' ? entry.at : 0 }))
      } catch {
        return []
      }
    }

    function saveFavorites(list) {
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
      } catch {
        /* storage may be unavailable */
      }
    }

    function isDefaultWorkspace(project) {
      const path = String(project.path || '')
      const title = String(project.title || '')
      return title === 'default-workspace' || /(^|[\\/])default-workspace$/i.test(path)
    }

    const en = {
      switcherLabel: 'Project',
      switcherEmpty: 'No project has sessions yet.',
      switcherCount: '{n} sessions',
      switcherUntitled: 'Untitled project',
      switcherUngrouped: 'Ungrouped',
      newSession: 'New session',
      favorite: 'Favorite project',
      unfavorite: 'Remove from favorites',
      noSessions: 'This project has no sessions yet.',
      untitled: 'Untitled',
      pin: 'Pin',
      unpin: 'Unpin',
      rename: 'Rename',
      renameTitle: 'Rename session',
      cancel: 'Cancel',
      save: 'Save',
      fork: 'Fork session',
      copyId: 'Copy session ID',
      copied: 'Session ID copied',
      archive: 'Archive (hide)',
      unarchive: 'Unarchive',
      showArchived: 'Show archived',
      hideArchived: 'Hide archived',
      archivedTag: 'Archived',
      more: 'More actions',
      archiveActiveConfirm: 'This session is still running. Stop it and archive?',
      statusRunning: 'Running',
      statusApproval: 'Waiting for approval',
      statusPlan: 'Plan awaiting review',
      statusAnswer: 'Waiting for answer',
      statusDone: 'Finished, not viewed',
      openFailed: 'Could not open that session.',
    }
    const zh = {
      switcherLabel: '工程',
      switcherEmpty: '还没有任何工程产生过会话。',
      switcherCount: '{n} 个会话',
      switcherUntitled: '未命名工程',
      switcherUngrouped: '未分组',
      newSession: '新建会话',
      favorite: '收藏工程',
      unfavorite: '取消收藏',
      noSessions: '这个工程还没有会话。',
      untitled: '未命名',
      pin: '固定',
      unpin: '取消固定',
      rename: '重命名',
      renameTitle: '重命名会话',
      cancel: '取消',
      save: '保存',
      fork: '分叉会话',
      copyId: '复制会话 ID',
      copied: '已复制会话 ID',
      archive: '归档（隐藏）',
      unarchive: '取消归档',
      showArchived: '显示已归档',
      hideArchived: '隐藏已归档',
      archivedTag: '已归档',
      more: '更多操作',
      archiveActiveConfirm: '这个会话还在运行，停止并归档？',
      statusRunning: '运行中',
      statusApproval: '等待批准',
      statusPlan: '计划待审',
      statusAnswer: '等待回答',
      statusDone: '已完成，未查看',
      openFailed: '打开会话失败。',
    }

    // ---------------------------------------------------------------- stores

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function useStore(store) {
      const [, bump] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        if (!store || typeof store.subscribe !== 'function') return undefined
        return store.subscribe(bump)
      }, [store])
      if (!store || typeof store.getSnapshot !== 'function') return undefined
      return store.getSnapshot()
    }

    // ------------------------------------------------------------- accessors

    function workspaceRows(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.items)) return []
      return snapshot.items.map((row) => ({
        id: row.workspaceId,
        title: row.title,
        path: row.path,
        sessionIds: row.sessionIds || [],
      }))
    }

    function sessionRows(snapshot) {
      if (!snapshot) return []
      return Object.values(snapshot.byId || {})
    }

    function isArchived(snapshot, id) {
      const ids = snapshot && (snapshot.archivedSessionIds || [])
      return ids.indexOf(id) !== -1
    }

    function lastActivity(row) {
      const stamp = row.updatedAt || row.createdAt
      if (typeof stamp === 'number') return stamp
      const value = stamp ? Date.parse(stamp) : 0
      return Number.isFinite(value) ? value : 0
    }

    function titleOf(row, fallback) {
      return row.title || row.displayTitle || fallback
    }

    function relativeTime(value, now) {
      if (!value) return ''
      const diff = Math.max(0, now - value)
      const minute = 60000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return 'now'
      if (diff < hour) return Math.floor(diff / minute) + 'm'
      if (diff < day) return Math.floor(diff / hour) + 'h'
      if (diff < 7 * day) return Math.floor(diff / day) + 'd'
      const date = new Date(value)
      return date.getMonth() + 1 + '/' + date.getDate()
    }

    // ---------------------------------------------------------- project roots

    function normalizePath(value) {
      return String(value || '').replace(/[\\/]+$/, '')
    }

    function isAncestor(parent, child) {
      const a = normalizePath(parent).toLowerCase()
      const b = normalizePath(child).toLowerCase()
      if (a === '' || a === b) return false
      return b.indexOf(a + '\\') === 0 || b.indexOf(a + '/') === 0
    }

    function baseName(value) {
      const cleaned = normalizePath(value)
      const cut = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'))
      return cut === -1 ? cleaned : cleaned.slice(cut + 1)
    }

    // A project is the topmost registered ancestor of a workspace, or the folder
    // above a trailing `code` segment. That keeps `<project>` and
    // `<project>\code\<project>-...` in one switcher entry instead of two.
    function groupProjects(workspaces) {
      const buckets = new Map()
      for (const workspace of workspaces) {
        let root = null
        for (const candidate of workspaces) {
          if (candidate.id === workspace.id) continue
          if (!isAncestor(candidate.path, workspace.path)) continue
          if (root === null || normalizePath(candidate.path).length < normalizePath(root.path).length) root = candidate
        }
        let rawKey
        if (root !== null) {
          rawKey = normalizePath(root.path)
        } else {
          const parts = normalizePath(workspace.path).split(/[\\/]/)
          let cut = -1
          for (let index = parts.length - 1; index > 0; index -= 1) {
            if (parts[index].toLowerCase() === 'code') {
              cut = index
              break
            }
          }
          rawKey = cut === -1 ? normalizePath(workspace.path) : parts.slice(0, cut).join('\\')
        }
        const key = rawKey.toLowerCase()
        let bucket = buckets.get(key)
        if (bucket === undefined) {
          bucket = { key, path: rawKey, title: '', sessionIds: [], workspaceIds: [], primaryWorkspaceId: null }
          buckets.set(key, bucket)
        }
        if (root !== null && root.id === workspace.id) {
          bucket.title = workspace.title || ''
          bucket.path = normalizePath(workspace.path)
          bucket.primaryWorkspaceId = workspace.id
        }
        bucket.workspaceIds.push(workspace.id)
        for (const id of workspace.sessionIds) {
          if (bucket.sessionIds.indexOf(id) === -1) bucket.sessionIds.push(id)
        }
      }
      const projects = [...buckets.values()]
      for (const project of projects) {
        if (!project.title) project.title = baseName(project.path) || project.path
        if (project.primaryWorkspaceId === null) project.primaryWorkspaceId = project.workspaceIds[0]
      }
      return projects
    }

    const styles = `
.psx-root { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; box-sizing: border-box; }
.psx-root[data-wide="true"] { flex: none; max-height: 100cqh; }
.psx-switcher { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0; height: 32px; box-sizing: border-box; padding: 0 8px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px)); border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #e6edf3); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.psx-newinline { flex: none; width: 24px; height: 24px; margin-right: 2px; }
.psx-newinline:disabled { opacity: 0.4; cursor: default; }
.psx-switcher:hover, .psx-switcher[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); }
.psx-switcher-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 6px 0 var(--dsh-sidebar-label-gap, 6px); }
.psx-caret { flex: none; opacity: 0.6; }
.psx-count { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b98a9); }
.psx-menu { position: absolute; z-index: 60; top: 32px; left: 4px; right: 4px; margin-top: 4px; padding: 4px; box-sizing: border-box; display: flex; flex-direction: column; gap: 0; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-specific-menu, #1b2330); backdrop-filter: var(--dsw-menu-backdrop-filter, none); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,0.35)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(255,255,255,0.1)); max-height: 60vh; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: none; }
.psx-menu::-webkit-scrollbar { width: 0; height: 0; }
.psx-menu-row { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 4px 6px 8px; box-sizing: border-box; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #e6edf3); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; text-align: left; }
.psx-star { flex: none; width: 22px; height: 22px; }
.psx-star[aria-pressed="true"] { color: var(--dsw-alias-brand-primary, #e0a33a); }
.psx-menu-filter { width: 100%; box-sizing: border-box; height: 32px; margin-bottom: 4px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.12)); border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #e6edf3); font: inherit; font-size: 13px; }
.psx-menu-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); }
.psx-menu-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); }
.psx-menu-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psx-menu-status { flex: none; display: inline-flex; align-items: center; gap: 4px; }
.psx-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.psx-dot-pending { background: var(--dsw-alias-state-warn-primary, #e0a33a); }
.psx-dot-done { background: var(--dsw-alias-state-success-primary, #3fbf7f); }
.psx-spinner-sm { display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1.4px solid var(--dsw-alias-label-tertiary, #8b98a9); border-top-color: transparent; animation: psx-spin 0.9s linear infinite; }
.psx-menu-time { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b98a9); font-variant-numeric: tabular-nums; }
.psx-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: none; display: flex; flex-direction: column; gap: 2px; margin-left: -4px; padding-left: 4px; }
.psx-list::-webkit-scrollbar { width: 0; height: 0; }
.psx-row { position: relative; display: flex; align-items: center; gap: 0; width: 100%; height: 32px; box-sizing: border-box; padding: 0 8px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px)); border: 0; border-inline: var(--dsh-sidebar-paint-inset, 3px) solid transparent; background-clip: padding-box; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #e6edf3); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.psx-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); }
.psx-row[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(91,157,255,0.14)); }
.psx-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 6px 0 var(--dsh-sidebar-label-gap, 6px); }
.psx-time { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b98a9); }
.psx-actions { position: absolute; right: 8px; display: none; align-items: center; gap: 0; padding-left: 12px; background: linear-gradient(90deg, transparent, var(--dsw-specific-sidebar-fill, #232c3a) 26%); }
.psx-row:hover .psx-actions, .psx-row:focus-within .psx-actions { display: flex; }
.psx-row:hover .psx-time { visibility: hidden; }
.psx-icon-btn { display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary, #a9b6c7); cursor: pointer; padding: 0; }
.psx-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.1)); color: var(--dsw-alias-label-primary, #e6edf3); }
.psx-empty { padding: 16px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8b98a9); }
.psx-footer { display: flex; align-items: center; gap: 4px; padding: 4px 0 8px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px)); }
.psx-new { display: flex; align-items: center; gap: var(--dsh-sidebar-label-gap, 6px); height: 32px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-secondary, #a9b6c7); font: inherit; font-size: 13px; cursor: pointer; }
.psx-new:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); color: var(--dsw-alias-label-primary, #e6edf3); }
.psx-pin-mark { flex: none; width: 12px; height: 12px; margin-left: 2px; color: var(--dsw-alias-label-tertiary, #8b98a9); }
.psx-rename { display: flex; align-items: center; gap: 4px; width: 100%; height: 32px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px)); box-sizing: border-box; }
.psx-rename input { flex: 1; min-width: 0; height: 26px; padding: 0 6px; border-radius: var(--dsw-radius-sm, 6px); border: 0.5px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.18)); background: transparent; color: inherit; font: inherit; font-size: 13px; }
.psx-rename button { height: 26px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.psx-status { flex: none; width: 16px; height: 20px; display: inline-flex; align-items: center; justify-content: center; }
.psx-status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: transparent; }
.psx-status-pending::before { background: var(--dsw-alias-state-warn-primary, #e0a33a); }
.psx-status-done::before { background: var(--dsw-alias-state-business-primary, #5b9dff); }
.psx-spinner { flex: none; width: 16px; height: 20px; display: inline-flex; align-items: center; justify-content: center; }
.psx-spinner::before { content: ''; width: 10px; height: 10px; border-radius: 50%; border: 1.6px solid var(--dsw-alias-label-tertiary, #8b98a9); border-top-color: transparent; animation: psx-spin 0.9s linear infinite; }
@keyframes psx-spin { to { transform: rotate(360deg); } }
.psx-row[data-archived="true"] .psx-title { color: var(--dsw-alias-label-caption, #6f7d8f); }
.psx-rowmenu { position: absolute; z-index: 70; left: 4px; right: 4px; padding: 4px; box-sizing: border-box; display: flex; flex-direction: column; gap: 0; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-specific-menu, #1b2330); backdrop-filter: var(--dsw-menu-backdrop-filter, none); box-shadow: var(--dsw-elevation-prominent, 0 12px 28px rgba(0,0,0,0.38)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(255,255,255,0.1)); }
.psx-menu-item { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #e6edf3); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; white-space: nowrap; box-sizing: border-box; }
.psx-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); }
.psx-ghost { height: 32px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-tertiary, #8b98a9); font: inherit; font-size: 12px; cursor: pointer; }
.psx-ghost:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); color: var(--dsw-alias-label-primary, #e6edf3); }
`

    // ------------------------------------------------------------- component

    function ProjectScope(props) {
      try {
        return renderScope(props)
      } catch (error) {
        // A throw here would make the slot abdicate and silently restore the
        // built-in browser; show the failure instead so it can be diagnosed.
        console.error('[project-scope] render failed', error)
        const detail = String((error && (error.stack || error.message)) || error)
        return h(
          'div',
          {
            style: {
              padding: '12px 10px',
              font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
              color: '#ff9b9b',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          'project-scope render error:\n' + detail,
        )
      }
    }

    function renderScope(props) {
      const wide = props && props.wide !== false
      const ctx = props && props.ctx
      const t = props && props.t
      const sessionsService = ctx && ctx.get('sessions')
      const workspacesService = ctx && ctx.get('workspaces')
      const uiWorkspace = ctx && ctx.get('uiWorkspace')

      // The sidebar hands each section occupant a scroller hook; binding it keeps
      // wheel handoff between the sidebar viewport and this list working.
      const useSectionScroller = props && props.useSectionScroller
      const sectionScroller = typeof useSectionScroller === 'function' ? useSectionScroller() : null
      const bindScrollerRef = sectionScroller && sectionScroller.bindScrollerRef

      const sessionsSnapshot = useStore(sessionsService && sessionsService.list)
      const workspacesSnapshot = useStore(workspacesService && workspacesService.list)

      // Live per-session status (running / pending interaction / unread completion).
      const useSessionStatus = props && props.useSessionStatus
      const statusMap = typeof useSessionStatus === 'function' ? useSessionStatus((value) => value) : null

      const [selectedId, setSelectedId] = React.useState(() => {
        try {
          return window.localStorage.getItem(STORAGE_KEY) || null
        } catch {
          return null
        }
      })
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [rowMenu, setRowMenu] = React.useState(null)
      const [showArchived, setShowArchived] = React.useState(false)
      const [favorites, setFavorites] = React.useState(loadFavorites)
      const [now, setNow] = React.useState(() => Date.now())
      const [renamingId, setRenamingId] = React.useState(null)
      const [renameDraft, setRenameDraft] = React.useState('')
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        let timer = null
        const tick = () => setNow(Date.now())
        const start = () => {
          if (timer === null) timer = window.setInterval(tick, 30000)
        }
        const stop = () => {
          if (timer !== null) {
            window.clearInterval(timer)
            timer = null
          }
        }
        // No timer wakeups while the window is hidden; resuming refreshes the
        // relative timestamps immediately.
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') {
            stop()
          } else {
            tick()
            start()
          }
        }
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      React.useEffect(() => {
        if (!menuOpen && rowMenu === null) return undefined
        const close = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) {
            setMenuOpen(false)
            setRowMenu(null)
          }
        }
        const escape = (event) => {
          if (event.key === 'Escape') {
            setMenuOpen(false)
            setRowMenu(null)
          }
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', escape)
        }
      }, [menuOpen, rowMenu])

      const workspaces = workspaceRows(workspacesSnapshot)
      const projects = React.useMemo(() => groupProjects(workspaces), [workspacesSnapshot])
      const sessions = sessionRows(sessionsSnapshot)

      // Projects are ordered by their most recent session activity, so the
      // project you touched last is always the first row of the switcher.
      const activityOf = React.useMemo(() => {
        const byId = (sessionsSnapshot && sessionsSnapshot.byId) || {}
        const map = new Map()
        for (const project of projects) {
          let latest = 0
          for (const id of project.sessionIds) {
            const row = byId[id]
            if (!row) continue
            const stamp = lastActivity(row)
            if (stamp > latest) latest = stamp
          }
          map.set(project.key, latest)
        }
        return map
      }, [projects, sessionsSnapshot])

      // Per-project status roll-up for the switcher: any session waiting for the
      // user, any finished-but-unviewed session, and any still running.
      const projectStatus = React.useMemo(() => {
        const map = new Map()
        for (const project of projects) {
          let pending = 0
          let unread = 0
          let running = 0
          for (const id of project.sessionIds) {
            const status = statusMap && typeof statusMap.get === 'function' ? statusMap.get(id) : undefined
            if (!status) continue
            if (status.pendingInteraction) pending += 1
            else if (status.completionUnread) unread += 1
            else if (status.running) running += 1
          }
          map.set(project.key, { pending, unread, running })
        }
        return map
      }, [projects, statusMap])

      const orderedProjects = React.useMemo(() => {
        // Order: the default workspace, then favorites in the order they were
        // added, then everything else by most recent conversation activity.
        const favoriteAt = new Map(favorites.map((entry) => [entry.key, entry.at]))
        const copy = projects.slice()
        copy.sort((left, right) => {
          const leftDefault = isDefaultWorkspace(left)
          const rightDefault = isDefaultWorkspace(right)
          if (leftDefault !== rightDefault) return leftDefault ? -1 : 1
          const leftFavorite = favoriteAt.has(left.key)
          const rightFavorite = favoriteAt.has(right.key)
          if (leftFavorite !== rightFavorite) return leftFavorite ? -1 : 1
          if (leftFavorite && rightFavorite) return (favoriteAt.get(left.key) || 0) - (favoriteAt.get(right.key) || 0)
          return (activityOf.get(right.key) || 0) - (activityOf.get(left.key) || 0)
        })
        return copy
      }, [projects, activityOf, favorites])

      const currentSessionId = React.useMemo(() => {
        for (const row of sessions) {
          const retained = row.retainedBy && row.retainedBy.mainView
          if (retained && retained > 0) return row.id
        }
        return null
      }, [sessionsSnapshot])

      const resolvedKey = React.useMemo(() => {
        // The open conversation wins: a session created or opened from outside the
        // panel (Explorer right-click, fork, shortcut) pulls the sidebar to its
        // project, so the list never shows a project the user has left.
        const containing = currentSessionId
          ? projects.find((project) => project.sessionIds.indexOf(currentSessionId) !== -1)
          : undefined
        if (containing) return containing.key
        if (selectedId) {
          const remembered = projects.find((project) => project.key === selectedId)
          if (remembered) return remembered.key
        }
        return orderedProjects.length > 0 ? orderedProjects[0].key : null
      }, [selectedId, projects, orderedProjects, currentSessionId])

      React.useEffect(() => {
        // Remember what the panel is showing. Without this, closing or archiving
        // the open session leaves no current session, and the fallback would jump
        // to the most active project instead of staying where the user was.
        if (resolvedKey && resolvedKey !== selectedId) setSelectedId(resolvedKey)
      }, [resolvedKey, selectedId])

      React.useEffect(() => {
        if (!resolvedKey) return
        try {
          window.localStorage.setItem(STORAGE_KEY, resolvedKey)
        } catch {
          /* storage may be unavailable */
        }
      }, [resolvedKey])

      const selected = projects.find((project) => project.key === resolvedKey) || null

      const rows = React.useMemo(() => {
        if (!selected) return []
        const pinnedIds = (workspacesSnapshot && workspacesSnapshot.pinnedSessionIds) || []
        const pinnedRank = new Map(pinnedIds.map((id, index) => [id, index]))
        const result = []
        const seen = new Set()
        const byId = (sessionsSnapshot && sessionsSnapshot.byId) || {}
        const consider = (id) => {
          if (seen.has(id)) return
          seen.add(id)
          const row = byId[id]
          if (!row) return
          if (!showArchived && isArchived(workspacesSnapshot, id)) return
          result.push(row)
        }
        for (const id of pinnedIds) {
          if (selected.sessionIds.indexOf(id) !== -1) consider(id)
        }
        for (const id of selected.sessionIds) consider(id)
        result.sort((a, b) => {
          const aArchived = isArchived(workspacesSnapshot, a.id)
          const bArchived = isArchived(workspacesSnapshot, b.id)
          if (aArchived !== bArchived) return aArchived ? 1 : -1
          const aPinned = pinnedRank.has(a.id)
          const bPinned = pinnedRank.has(b.id)
          if (aPinned !== bPinned) return aPinned ? -1 : 1
          if (aPinned && bPinned) return pinnedRank.get(a.id) - pinnedRank.get(b.id)
          return lastActivity(b) - lastActivity(a)
        })
        return result
      }, [selected, sessionsSnapshot, workspacesSnapshot, showArchived])

      const openSession = (id) => {
        try {
          uiWorkspace.openSession(id)
        } catch (error) {
          console.warn('[project-scope] openSession failed', error)
        }
      }

      const switchTo = (project) => {
        setMenuOpen(false)
        setSelectedId(project.key)
        const byId = (sessionsSnapshot && sessionsSnapshot.byId) || {}
        const candidates = project.sessionIds
          .filter((id) => !isArchived(workspacesSnapshot, id))
          .map((id) => byId[id])
          .filter(Boolean)
        const openable = candidates.filter((row) => !row.blank)
        const target = (openable.length > 0 ? openable : candidates)
          .slice()
          .sort((a, b) => lastActivity(b) - lastActivity(a))[0]
        if (target) {
          openSession(target.id)
          return
        }
        try {
          uiWorkspace.openWorkspace(project.primaryWorkspaceId)
        } catch (error) {
          console.warn('[project-scope] openWorkspace failed', error)
        }
      }

      const newSession = () => {
        if (!selected) return
        try {
          uiWorkspace.openWorkspace(selected.primaryWorkspaceId)
        } catch (error) {
          console.warn('[project-scope] openWorkspace failed', error)
        }
      }

      const togglePin = (row) => {
        const pinnedIds = (workspacesSnapshot && workspacesSnapshot.pinnedSessionIds) || []
        const isPinned = pinnedIds.indexOf(row.id) !== -1
        try {
          if (isPinned) uiWorkspace.unpinSession(row.id)
          else uiWorkspace.pinSession(row.id)
        } catch (error) {
          console.warn('[project-scope] pin toggle failed', error)
        }
      }

      const startRename = (row) => {
        setRowMenu(null)
        setRenamingId(row.id)
        setRenameDraft(titleOf(row, ''))
      }

      const looksActive = (error) => {
        const text = String((error && (error.code || error.message)) || error || '')
        return text.indexOf('session-active') !== -1
      }

      const archiveSession = async (row) => {
        setRowMenu(null)
        try {
          await uiWorkspace.archiveSession(row.id)
        } catch (error) {
          if (!looksActive(error)) {
            console.warn('[project-scope] archive failed', error)
            return
          }
          if (!window.confirm(t('archiveActiveConfirm'))) return
          try {
            await uiWorkspace.archiveSession(row.id, { stopActivity: true })
          } catch (retryError) {
            console.warn('[project-scope] archive after stop failed', retryError)
          }
        }
      }

      const unarchiveSession = async (row) => {
        setRowMenu(null)
        try {
          await uiWorkspace.unarchiveSession(row.id)
        } catch (error) {
          console.warn('[project-scope] unarchive failed', error)
        }
      }

      const forkSession = async (row) => {
        setRowMenu(null)
        try {
          const childId = await uiWorkspace.forkSession(row.id)
          if (childId) openSession(childId)
        } catch (error) {
          console.warn('[project-scope] fork failed', error)
        }
      }

      const copySessionId = async (row) => {
        setRowMenu(null)
        try {
          await navigator.clipboard.writeText(row.id)
        } catch (error) {
          console.warn('[project-scope] copy id failed', error)
        }
      }

      const openRowMenu = (event, row) => {
        event.stopPropagation()
        event.preventDefault()
        const root = rootRef.current
        if (!root) return
        const button = event.currentTarget.getBoundingClientRect()
        const anchor = root.getBoundingClientRect()
        // The menu is right-anchored by CSS; only the vertical offset varies.
        setRowMenu({ id: row.id, top: Math.round(button.bottom - anchor.top + 4) })
      }

      const toggleFavorite = (project) => {
        setFavorites((current) => {
          const existing = current.filter((entry) => entry.key === project.key)
          const next = existing.length > 0
            ? current.filter((entry) => entry.key !== project.key)
            : current.concat({ key: project.key, at: Date.now() })
          saveFavorites(next)
          return next
        })
      }

      const statusOf = (row) => (statusMap && typeof statusMap.get === 'function' ? statusMap.get(row.id) : undefined)

      const commitRename = async () => {
        const id = renamingId
        const title = renameDraft.trim()
        setRenamingId(null)
        if (!id || title === '') return
        try {
          await sessionsService.using(id, { source: 'workspaceOperation' }, (reference) => reference.binding.session.rename(title))
        } catch (error) {
          console.warn('[project-scope] rename failed', error)
        }
      }

      const pinnedIds = (workspacesSnapshot && workspacesSnapshot.pinnedSessionIds) || []
      const visibleCount = (project) =>
        project.sessionIds.reduce((total, id) => total + (isArchived(workspacesSnapshot, id) ? 0 : 1), 0)

      const header = h(
        'div',
        { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 2 } },
        h(
          'button',
          {
            type: 'button',
            className: 'psx-switcher',
            'aria-expanded': menuOpen,
            'aria-haspopup': 'listbox',
            title: selected ? selected.path || selected.title : t('switcherLabel'),
            onClick: () => setMenuOpen((open) => !open),
          },
          h('span', { className: 'psx-switcher-label' }, selected ? selected.title || t('switcherUntitled') : t('switcherLabel')),
          selected ? h('span', { className: 'psx-count' }, String(visibleCount(selected))) : null,
          h('svg', { className: 'psx-caret', viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
            h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'psx-icon-btn psx-newinline',
            title: t('newSession'),
            'aria-label': t('newSession'),
            disabled: !selected,
            onClick: newSession,
          },
          h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
            h('path', { d: 'M8 3v10M3 8h10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })),
        ),
        menuOpen
          ? h(
              'div',
              { className: 'psx-menu', role: 'listbox', 'aria-label': t('switcherLabel') },
              h('input', {
                className: 'psx-menu-filter',
                autoFocus: true,
                value: filter,
                placeholder: t('switcherLabel'),
                'aria-label': t('switcherLabel'),
                onChange: (event) => setFilter(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') setMenuOpen(false)
                },
              }),
              orderedProjects.length === 0
                ? h('div', { className: 'psx-empty' }, t('switcherEmpty'))
                : orderedProjects
                    .filter((project) => {
                      const needle = filter.trim().toLowerCase()
                      if (needle === '') return true
                      return (project.title || '').toLowerCase().indexOf(needle) !== -1
                        || (project.path || '').toLowerCase().indexOf(needle) !== -1
                    })
                    .map((project) => {
                      const favorite = favorites.some((entry) => entry.key === project.key)
                      return h(
                        'div',
                        {
                          key: project.key,
                          role: 'option',
                          tabIndex: 0,
                          'aria-selected': project.key === resolvedKey,
                          'data-selected': project.key === resolvedKey,
                          className: 'psx-menu-row',
                          title: project.path || project.title,
                          onClick: () => switchTo(project),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              switchTo(project)
                            }
                          },
                        },
                        h('span', { className: 'psx-menu-title' }, project.title || t('switcherUntitled')),
                        (() => {
                          const status = projectStatus.get(project.key) || {}
                          return h('span', { className: 'psx-menu-status' },
                            status.pending
                              ? h('span', { className: 'psx-dot psx-dot-pending', title: t('statusApproval'), 'aria-label': t('statusApproval') })
                              : null,
                            status.unread
                              ? h('span', { className: 'psx-dot psx-dot-done', title: t('statusDone'), 'aria-label': t('statusDone') })
                              : null,
                            status.running
                              ? h('span', { className: 'psx-spinner-sm', title: t('statusRunning'), 'aria-label': t('statusRunning') })
                              : null)
                        })(),
                        h('span', { className: 'psx-menu-time' }, relativeTime(activityOf.get(project.key) || 0, now)),
                        h('button', {
                          type: 'button',
                          className: 'psx-icon-btn psx-star',
                          'aria-pressed': favorite,
                          title: favorite ? t('unfavorite') : t('favorite'),
                          'aria-label': favorite ? t('unfavorite') : t('favorite'),
                          onClick: (event) => {
                            event.stopPropagation()
                            toggleFavorite(project)
                          },
                        }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
                            h('path', { d: 'M8 1.5l1.9 3.9 4.1.6-3 2.9.7 4.2L8 11l-3.7 2.1.7-4.2-3-2.9 4.1-.6z', fill: favorite ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }))),
                      )
                    }),
            )
          : null,
      )

      const statusCell = (row) => {
        const status = statusOf(row)
        const pending = status && status.pendingInteraction
        if (pending) {
          const kind = pending.kind
          const label = kind === 'approval' ? t('statusApproval') : kind === 'plan' ? t('statusPlan') : t('statusAnswer')
          return h('span', { className: 'psx-status psx-status-pending', title: label, 'aria-label': label })
        }
        if (status && status.running) {
          return h('span', { className: 'psx-spinner', title: t('statusRunning'), 'aria-label': t('statusRunning') })
        }
        if (status && status.completionUnread) {
          return h('span', { className: 'psx-status psx-status-done', title: t('statusDone'), 'aria-label': t('statusDone') })
        }
        return h('span', { className: 'psx-status' })
      }

      const list = h(
        'div',
        { className: 'psx-list', role: 'list', ref: bindScrollerRef },
        rows.length === 0
          ? h('div', { className: 'psx-empty' }, t('noSessions'))
          : rows.map((row) => {
              if (renamingId === row.id) {
                return h(
                  'div',
                  { key: row.id, className: 'psx-rename' },
                  h('input', {
                    autoFocus: true,
                    value: renameDraft,
                    'aria-label': t('renameTitle'),
                    onChange: (event) => setRenameDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitRename()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingId(null)
                      }
                    },
                  }),
                  h('button', { type: 'button', onClick: () => void commitRename() }, t('save')),
                  h('button', { type: 'button', onClick: () => setRenamingId(null) }, t('cancel')),
                )
              }
              const pinned = pinnedIds.indexOf(row.id) !== -1
              const archived = isArchived(workspacesSnapshot, row.id)
              return h(
                'div',
                {
                  key: row.id,
                  role: 'listitem',
                  className: 'psx-row',
                  'data-current': row.id === currentSessionId,
                  'data-archived': archived,
                  tabIndex: 0,
                  title: titleOf(row, t('untitled')),
                  onClick: () => (archived ? undefined : openSession(row.id)),
                  onKeyDown: (event) => {
                    if (archived) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openSession(row.id)
                    }
                  },
                },
                statusCell(row),
                pinned
                  ? h('svg', { className: 'psx-pin-mark', viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': true },
                      h('path', { d: 'M8 1.5l1.9 3.9 4.1.6-3 2.9.7 4.2L8 11l-3.7 2.1.7-4.2-3-2.9 4.1-.6z', fill: 'currentColor' }))
                  : null,
                h('span', { className: 'psx-title' }, titleOf(row, t('untitled'))),
                h('span', { className: 'psx-time' }, relativeTime(lastActivity(row), now)),
                h(
                  'div',
                  { className: 'psx-actions', onClick: (event) => event.stopPropagation() },
                  archived
                    ? null
                    : h('button', {
                        type: 'button',
                        className: 'psx-icon-btn',
                        title: pinned ? t('unpin') : t('pin'),
                        'aria-label': pinned ? t('unpin') : t('pin'),
                        onClick: () => togglePin(row),
                      }, h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
                          h('path', { d: 'M8 1.5l1.9 3.9 4.1.6-3 2.9.7 4.2L8 11l-3.7 2.1.7-4.2-3-2.9 4.1-.6z', fill: pinned ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.2 }))),
                  h('button', {
                    type: 'button',
                    className: 'psx-icon-btn',
                    title: archived ? t('unarchive') : t('more'),
                    'aria-label': archived ? t('unarchive') : t('more'),
                    'aria-haspopup': archived ? undefined : 'menu',
                    onClick: (event) => (archived ? void unarchiveSession(row) : openRowMenu(event, row)),
                  }, archived
                    ? h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
                        h('path', { d: 'M3 8a5 5 0 105-5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
                    : h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
                        h('circle', { cx: 3.5, cy: 8, r: 1.2, fill: 'currentColor' }),
                        h('circle', { cx: 8, cy: 8, r: 1.2, fill: 'currentColor' }),
                        h('circle', { cx: 12.5, cy: 8, r: 1.2, fill: 'currentColor' }))),
                ),
              )
            }),
      )

      const menuRow = rowMenu === null ? null : rows.find((candidate) => candidate.id === rowMenu.id) || null
      const rowMenuNode = menuRow === null
        ? null
        : (() => {
            const archived = isArchived(workspacesSnapshot, menuRow.id)
            const pinned = pinnedIds.indexOf(menuRow.id) !== -1
            const item = (key, label, onSelect) =>
              h('button', {
                key,
                type: 'button',
                role: 'menuitem',
                className: 'psx-menu-item',
                onClick: (event) => {
                  event.stopPropagation()
                  onSelect()
                },
              }, label)
            const entries = archived
              ? [item('unarchive', t('unarchive'), () => void unarchiveSession(menuRow))]
              : [
                  item('pin', pinned ? t('unpin') : t('pin'), () => { setRowMenu(null); togglePin(menuRow) }),
                  item('rename', t('rename'), () => startRename(menuRow)),
                  item('fork', t('fork'), () => void forkSession(menuRow)),
                  item('copy', t('copyId'), () => void copySessionId(menuRow)),
                  item('archive', t('archive'), () => void archiveSession(menuRow)),
                ]
            return h('div', {
              className: 'psx-rowmenu',
              role: 'menu',
              style: { top: rowMenu.top },
              onClick: (event) => event.stopPropagation(),
            }, entries)
          })()

      const footer = h(
        'div',
        { className: 'psx-footer' },
        h(
          'button',
          { type: 'button', className: 'psx-new', onClick: newSession, disabled: !selected, title: t('newSession') },
          h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
            h('path', { d: 'M8 3v10M3 8h10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })),
          h('span', null, t('newSession')),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'psx-ghost',
            'aria-pressed': showArchived,
            title: showArchived ? t('hideArchived') : t('showArchived'),
            onClick: () => setShowArchived((value) => !value),
          },
          showArchived ? t('hideArchived') : t('showArchived'),
        ),
      )

      return h(
        'div',
        { className: 'psx-root', ref: rootRef, 'data-wide': wide ? 'true' : 'false' },
        h('style', null, styles),
        header,
        list,
        rowMenuNode,
        footer,
      )
    }

    // ---------------------------------------------------------------- plugin

    return {
      // Only the two services this plugin cannot work without. Session and
      // workspace data are read lazily through ctx.get so that a missing optional
      // service degrades the panel instead of silently skipping apply entirely.
      inject: ['slots', 'locale'],
      apply(ctx) {
        console.info('[project-scope] applying')
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'project-scope: dictionaries')
        ctx.slots.inject('sidebar.workspaces', () => {
          try {
            return ctx.slots.register(
              { name: 'sidebar.workspaces', id: 'project-scope', priority: -1 },
              (props) => {
                const t = ctx.locale.bind(NS)
                return h(ProjectScope, { ...props, ctx, t })
              },
            )
          } catch (error) {
            console.error('[project-scope] could not occupy sidebar.workspaces:', error)
            return () => {}
          }
        })
      },
    }
  },
})
