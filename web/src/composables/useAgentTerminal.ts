import { ref, computed } from 'vue'
import type { SSEEvent } from '../api/client'
import { agentTerminalApi } from '../api/client'

export interface AgentTerminalInfo {
  id: string
  name: string
  sessionID: string
  status: 'running' | 'exited'
  rows: number
  cols: number
  createdAt: number
  lastActivity: number
}

export interface TerminalScreen {
  id: string
  sessionID: string
  screen: string
  screenAnsi: string
  cursor: { row: number; col: number }
  outputData?: string
  outputSeq?: number
  outputResetToken?: number
  latestSeq?: number
}

const terminals = ref<Map<string, AgentTerminalInfo>>(new Map())
const terminalScreens = ref<Map<string, TerminalScreen>>(new Map())
const activeTerminalBySession = ref<Map<string, string>>(new Map())
const currentSessionID = ref<string | null>(null)
const isPanelOpen = ref(false)

const initializedSessions = new Set<string>()
const recoveringTerminals = new Set<string>()
const queuedRecoveries = new Set<string>()
let resetTokenCounter = 0

function emptyScreen(id: string, sessionID: string): TerminalScreen {
  return {
    id,
    sessionID,
    screen: '',
    screenAnsi: '',
    cursor: { row: 0, col: 0 },
    outputSeq: 0,
    latestSeq: 0,
  }
}

function isVisibleSession(sessionID?: string) {
  return Boolean(sessionID && currentSessionID.value && sessionID === currentSessionID.value)
}

function visibleTerminalList() {
  const sessionID = currentSessionID.value
  if (!sessionID) return []
  return terminalListForSession(sessionID)
}

function terminalListForSession(sessionID: string) {
  return Array.from(terminals.value.values()).filter((terminal) => terminal.sessionID === sessionID)
}

function currentActiveTerminalId() {
  const sessionID = currentSessionID.value
  if (!sessionID) return null
  const active = activeTerminalBySession.value.get(sessionID)
  if (active && terminals.value.get(active)?.sessionID === sessionID) return active
  return visibleTerminalList()[0]?.id || null
}

async function refreshScreen(id: string, sessionID: string) {
  try {
    const screenData = await agentTerminalApi.getScreen(id, sessionID)
    const existing = terminalScreens.value.get(id)
    terminalScreens.value.set(id, {
      ...emptyScreen(id, screenData.sessionID || sessionID),
      ...existing,
      ...screenData,
      outputData: existing?.outputData,
      outputSeq: existing?.outputSeq,
      outputResetToken: existing?.outputResetToken,
      latestSeq: existing?.latestSeq,
    })
  } catch (error) {
    console.warn(`[AgentTerminal] Failed to refresh screen for terminal ${id}:`, error)
  }
}

async function recoverTerminalOutput(id: string, afterSeq?: number) {
  if (recoveringTerminals.has(id)) {
    queuedRecoveries.add(id)
    return
  }
  const terminal = terminals.value.get(id)
  const sessionID = terminal?.sessionID || currentSessionID.value
  if (!sessionID) return

  recoveringTerminals.add(id)
  try {
    const snapshot = await agentTerminalApi.getBuffer(id, sessionID, afterSeq)
    const existing = terminalScreens.value.get(id) || emptyScreen(id, sessionID)
    if (snapshot.reset) {
      terminalScreens.value.set(id, {
        ...existing,
        sessionID,
        outputData: snapshot.buffer,
        outputSeq: snapshot.latestSeq,
        outputResetToken: ++resetTokenCounter,
        latestSeq: snapshot.latestSeq,
      })
      await refreshScreen(id, sessionID)
      return
    }

    if (snapshot.chunks.length === 0) {
      terminalScreens.value.set(id, {
        ...existing,
        sessionID,
        latestSeq: snapshot.latestSeq,
      })
      await refreshScreen(id, sessionID)
      return
    }

    const data = snapshot.chunks.map((chunk) => chunk.data).join('')
    terminalScreens.value.set(id, {
      ...existing,
      sessionID,
      outputData: data,
      outputSeq: snapshot.latestSeq,
      latestSeq: snapshot.latestSeq,
    })
    await refreshScreen(id, sessionID)
  } catch (error) {
    console.warn(`[AgentTerminal] Failed to recover terminal ${id}:`, error)
  } finally {
    recoveringTerminals.delete(id)
    if (queuedRecoveries.delete(id)) {
      const latestSeq = terminalScreens.value.get(id)?.latestSeq
      void recoverTerminalOutput(id, latestSeq ?? afterSeq)
    }
  }
}

export function useAgentTerminal() {
  const terminalList = computed(() => visibleTerminalList())

  const activeTerminalId = computed(() => currentActiveTerminalId())

  const activeTerminal = computed(() => {
    const id = activeTerminalId.value
    return id ? terminals.value.get(id) || null : null
  })

  const activeScreen = computed(() => {
    const id = activeTerminalId.value
    return id ? terminalScreens.value.get(id) || null : null
  })

  const hasTerminals = computed(() => terminalList.value.length > 0)

  function setSessionContext(sessionID?: string | null) {
    const next = sessionID || null
    if (currentSessionID.value === next) return
    currentSessionID.value = next
    if (!next) {
      isPanelOpen.value = false
      return
    }
    void initialize(true)
  }

  async function initialize(force = false) {
    const sessionID = currentSessionID.value
    if (!sessionID) return
    if (initializedSessions.has(sessionID) && !force) return

    try {
      const list = await agentTerminalApi.list(sessionID)
      const ids = new Set(list.map((info) => info.id))
      for (const [id, info] of terminals.value) {
        if (info.sessionID === sessionID && !ids.has(id)) {
          terminals.value.delete(id)
          terminalScreens.value.delete(id)
        }
      }

      for (const info of list) {
        terminals.value.set(info.id, info)
        const existing = terminalScreens.value.get(info.id)
        await refreshScreen(info.id, sessionID)
        await recoverTerminalOutput(info.id, existing?.latestSeq ?? 0)
      }

      const visible = terminalListForSession(sessionID)
      const active = activeTerminalBySession.value.get(sessionID)
      if (!active || !ids.has(active)) {
        activeTerminalBySession.value.set(sessionID, visible[0]?.id || '')
      }
      if (currentSessionID.value === sessionID && visible.length > 0) {
        isPanelOpen.value = true
      }
      initializedSessions.add(sessionID)
    } catch (error) {
      console.error('[AgentTerminal] Failed to initialize:', error)
    }
  }

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'server.connected': {
        void initialize(true)
        break
      }

      case 'agent-terminal.created': {
        const info = properties.info as AgentTerminalInfo
        terminals.value.set(info.id, info)
        if (isVisibleSession(info.sessionID)) {
          activeTerminalBySession.value.set(info.sessionID, info.id)
          isPanelOpen.value = true
          void refreshScreen(info.id, info.sessionID)
        }
        break
      }

      case 'agent-terminal.updated': {
        const info = properties.info as AgentTerminalInfo
        terminals.value.set(info.id, info)
        break
      }

      case 'agent-terminal.screen': {
        const screen = properties as TerminalScreen
        if (!isVisibleSession(screen.sessionID)) break
        const existing = terminalScreens.value.get(screen.id)
        terminalScreens.value.set(screen.id, {
          ...screen,
          outputData: existing?.outputData,
          outputSeq: existing?.outputSeq,
          outputResetToken: existing?.outputResetToken,
          latestSeq: existing?.latestSeq,
        })
        break
      }

      case 'agent-terminal.output': {
        const { id, sessionID, seq, data } = properties as {
          id: string
          sessionID: string
          seq: number
          data: string
        }
        if (!isVisibleSession(sessionID)) break

        const existing = terminalScreens.value.get(id) || emptyScreen(id, sessionID)
        const lastSeq = existing.latestSeq ?? existing.outputSeq ?? 0
        if (seq <= lastSeq) break
        if (seq > lastSeq + 1) {
          void recoverTerminalOutput(id, lastSeq)
          break
        }

        terminalScreens.value.set(id, {
          ...existing,
          sessionID,
          outputData: data,
          outputSeq: seq,
          latestSeq: seq,
        })
        break
      }

      case 'agent-terminal.exited': {
        const { id, sessionID } = properties as { id: string; sessionID: string; exitCode: number }
        const terminal = terminals.value.get(id)
        if (terminal) {
          terminals.value.set(id, { ...terminal, status: 'exited' })
        }
        if (isVisibleSession(sessionID)) {
          void refreshScreen(id, sessionID)
        }
        break
      }

      case 'agent-terminal.closed': {
        const { id, sessionID } = properties as { id: string; sessionID: string }
        terminals.value.delete(id)
        terminalScreens.value.delete(id)
        if (activeTerminalBySession.value.get(sessionID) === id) {
          const remaining = terminalListForSession(sessionID)
          activeTerminalBySession.value.set(sessionID, remaining[0]?.id || '')
        }
        if (isVisibleSession(sessionID) && visibleTerminalList().length === 0) {
          isPanelOpen.value = false
        }
        break
      }
    }
  }

  function selectTerminal(id: string) {
    const terminal = terminals.value.get(id)
    if (terminal && isVisibleSession(terminal.sessionID)) {
      activeTerminalBySession.value.set(terminal.sessionID, id)
    }
  }

  function togglePanel() {
    isPanelOpen.value = !isPanelOpen.value
  }

  function openPanel() {
    if (hasTerminals.value) isPanelOpen.value = true
  }

  function closePanel() {
    isPanelOpen.value = false
  }

  async function writeToTerminal(id: string, data: string): Promise<boolean> {
    try {
      const terminal = terminals.value.get(id)
      return await agentTerminalApi.write(id, data, terminal?.sessionID || currentSessionID.value || undefined)
    } catch (error) {
      console.error('Failed to write to terminal:', error)
      return false
    }
  }

  async function closeTerminal(id: string): Promise<boolean> {
    try {
      const terminal = terminals.value.get(id)
      return await agentTerminalApi.close(id, terminal?.sessionID || currentSessionID.value || undefined)
    } catch (error) {
      console.error('Failed to close terminal:', error)
      return false
    }
  }

  function clearTerminals() {
    terminals.value.clear()
    terminalScreens.value.clear()
    activeTerminalBySession.value.clear()
    currentSessionID.value = null
    initializedSessions.clear()
    recoveringTerminals.clear()
    queuedRecoveries.clear()
    isPanelOpen.value = false
  }

  return {
    terminals: terminalList,
    activeTerminalId,
    activeTerminal,
    activeScreen,
    isPanelOpen,
    hasTerminals,
    currentSessionID,
    setSessionContext,
    initialize,
    handleSSEEvent,
    recoverTerminalOutput,
    selectTerminal,
    togglePanel,
    openPanel,
    closePanel,
    writeToTerminal,
    closeTerminal,
    clearTerminals,
  }
}
