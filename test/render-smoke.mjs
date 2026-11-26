// Offline render smoke test for the sidebar entry.
//
// Loads client.js in Node with a minimal React stub and fake DSH services, then
// renders the component once per scenario. It catches the class of bug that is
// otherwise only visible as a red error box in the running app: undefined
// identifiers, bad field access, hook-order crashes in a single pass, and
// missing-service handling.
//
// Run: node test/render-smoke.mjs

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

let captured = null
const storage = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  confirm: () => false,
}

globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}

// ---------------------------------------------------------------- React stub

let hookValues = []
let hookCursor = 0

function resetHooks() {
  hookCursor = 0
}

function nextSlot(initial) {
  const index = hookCursor++
  if (hookValues.length <= index) hookValues[index] = initial
  return index
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useReducer(reducer, initial) {
    const index = nextSlot(initial)
    const dispatch = () => {}
    return [hookValues[index], dispatch]
  },
  useState(initial) {
    const index = nextSlot(typeof initial === 'function' ? initial() : initial)
    const set = (value) => {
      hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value
    }
    return [hookValues[index], set]
  },
  useMemo(factory) {
    const index = hookCursor++
    hookValues[index] = factory()
    return hookValues[index]
  },
  useEffect(effect) {
    const index = hookCursor++
    if (hookValues.length <= index) hookValues[index] = effect()
    return undefined
  },
  useRef(initial) {
    const index = nextSlot({ current: initial })
    return hookValues[index]
  },
  useCallback(callback) {
    const index = nextSlot(callback)
    return hookValues[index]
  },
  Fragment: 'fragment',
}

const fakeRequire = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require in smoke test: ' + name)
}

// -------------------------------------------------------------- DSH services

const storeOf = (value) => ({
  getSnapshot: () => value,
  subscribe: () => () => {},
})

const session = (id, title, updatedAt, extra) => ({
  id,
  title,
  displayTitle: title,
  blank: false,
  running: false,
  retainedBy: {},
  updatedAt,
  ...extra,
})

function makeServices({ withSessions = true, current = null } = {}) {
  const rows = {
    s1: session('s1', 'root session', 3000),
    s2: session('s2', 'code session', 2000),
    s3: session('s3', 'archived session', 1000),
    s4: session('s4', 'other session', 500),
  }
  if (current !== null && rows[current]) rows[current].retainedBy = { mainView: 1 }
  const sessionsSnapshot = {
    ids: ['s1', 's2', 's3', 's4'],
    byId: rows,
    phase: 'ready',
    projectionsBySession: {},
  }
  const workspacesSnapshot = {
    items: [
      {
        workspaceId: 'w-root',
        path: 'D:\\project\\demo',
        title: 'demo',
        sessionIds: ['s1', 's2'],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        workspaceId: 'w-code',
        path: 'D:\\project\\demo\\code\\project-demo',
        title: 'project-demo',
        sessionIds: ['s2', 's3'],
        createdAt: '2026-11-02T00:00:00.000Z',
        updatedAt: '2026-11-02T00:00:00.000Z',
      },
      {
        workspaceId: 'w-other',
        path: 'D:\\project\\other',
        title: 'other',
        sessionIds: ['s4'],
        createdAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:00:00.000Z',
      },
    ],
    archivedSessionIds: ['s3'],
    pinnedSessionIds: ['s1'],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
  return {
    sessions: withSessions
      ? { list: storeOf(sessionsSnapshot), using: async () => undefined }
      : undefined,
    workspaces: { list: storeOf(workspacesSnapshot) },
    uiWorkspace: {
      openSession() {},
      openWorkspace() {},
      pinSession() {},
      unpinSession() {},
      archiveSession() {},
      unarchiveSession() {},
      forkSession() {},
    },
  }
}

function makeContext(services) {
  return {
    effect(effect) {
      effect()
    },
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : key + JSON.stringify(params)),
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, Component) => {
        registered = Component
        return () => {}
      },
    },
    get: (name) => services[name],
  }
}

// ------------------------------------------------------------------- helpers

let registered = null

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    for (const child of node.children || []) collectText(child, out)
    if (node.props && Array.isArray(node.props.children)) collectText(node.props.children, out)
    else if (node.props && typeof node.props.children === 'string') collectText(node.props.children, out)
  }
  return out
}

function renderScenario(name, { services, props } = {}) {
  const ctx = makeContext(services || makeServices())
  registered = null
  const plugin = captured.factory(fakeRequire)
  plugin.apply(ctx)
  if (typeof registered !== 'function') throw new Error(name + ': no component registered')

  const element = registered({
    wide: true,
    useSectionScroller: () => ({ bindScrollerRef: () => {} }),
    useSessionStatus: (selector) => selector(new Map()),
    ...props,
  })
  hookValues = []
  resetHooks()
  const tree = element.type(element.props)
  const text = collectText(tree).join(' | ')
  if (text.includes('project-scope render error')) {
    throw new Error(name + ': component rendered its error box: ' + text)
  }
  return text
}

function mount(services) {
  const ctx = makeContext(services)
  registered = null
  const plugin = captured.factory(fakeRequire)
  plugin.apply(ctx)
  if (typeof registered !== 'function') throw new Error('no component registered')
  const props = {
    wide: true,
    useSectionScroller: () => ({ bindScrollerRef: () => {} }),
    useSessionStatus: (selector) => selector(new Map()),
  }
  hookValues = []
  return {
    render() {
      resetHooks()
      const element = registered(props)
      return collectText(element.type(element.props)).join(' | ')
    },
  }
}

// -------------------------------------------------------------------- checks

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failures.push(name + ': ' + (error && error.message))
    console.log('FAIL  ' + name + ' -> ' + (error && error.message))
  }
}

await import(pathToFileURL(clientPath).href)
if (captured === null) throw new Error('client.js did not call window.__ModuleLoader__.load')

check('renders with sessions, workspaces and a merged project', () => {
  const text = renderScenario('normal')
  if (!text.includes('demo')) throw new Error('project title missing from render')
  if (!text.includes('root session')) throw new Error('session row missing from render')
})

check('renders when session data is unavailable', () => {
  renderScenario('no-sessions', { services: makeServices({ withSessions: false }) })
})

check('follows the open conversation into its own project', () => {
  const text = renderScenario('follow', { services: makeServices({ current: 's4' }) })
  if (!text.includes('other session')) throw new Error('open session missing from the list')
  if (text.includes('root session')) throw new Error('list stayed on the previous project')
})

check('stays on its project after the open session is archived', () => {
  const services = makeServices({ current: 's1' })
  const rows = services.sessions.list.getSnapshot().byId
  // Make another project the most active one, so a fallback would visibly jump.
  rows.s1.updatedAt = 100
  rows.s4.updatedAt = 9000
  const app = mount(services)
  const first = app.render()
  if (!first.includes('root session')) throw new Error('did not open on the session project')
  // Archiving the open session makes the host clear its main view.
  rows.s1.retainedBy = {}
  services.workspaces.list.getSnapshot().archivedSessionIds.push('s1')
  const second = app.render()
  if (!second.includes('demo')) throw new Error('jumped away after archiving: ' + second)
  if (second.includes('other session')) throw new Error('fell back to the most active project')
})

check('puts the default workspace first in the switcher', () => {
  storage.clear()
  const services = makeServices()
  const snapshot = services.workspaces.list.getSnapshot()
  snapshot.items.push({
    workspaceId: 'w-default',
    path: 'C:\\Users\\PC\\Documents\\deepseek-harness\\default-workspace',
    title: 'default-workspace',
    sessionIds: ['s5'],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  })
  services.sessions.list.getSnapshot().byId.s5 = session('s5', 'default session', 1)
  const text = renderScenario('default-first', { services })
  if (!text.includes('default-workspace')) throw new Error('default workspace is not the shown project: ' + text)
})

check('renders when no workspace is registered', () => {
  const services = makeServices()
  services.workspaces = { list: storeOf({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }) }
  renderScenario('empty', { services })
})

check('renders without the optional section scroller hook', () => {
  renderScenario('no-scroller', { props: { useSectionScroller: undefined } })
})

check('renders without the session status hook', () => {
  renderScenario('no-status', { props: { useSessionStatus: undefined } })
})

if (failures.length > 0) {
  console.error('\n' + failures.length + ' scenario(s) failed:')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('\nall scenarios passed')
