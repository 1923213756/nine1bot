/**
 * Extension Relay - multi-agent WebSocket relay for browser extensions.
 *
 * Each connection is scoped by:
 * - instanceId: a Nine1Bot server runtime instance
 * - browserAgentId: a browser extension installation/profile
 * - connectionId: the current live socket for that browserAgentId
 */

import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'

export interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
}

export interface ConnectedTarget {
  sessionId: string
  targetId: string
  targetInfo: TargetInfo
}

export interface BrowserAgentBinding {
  instanceId: string
  browserAgentId: string
}

export interface ExtensionHelloPayload {
  instanceId?: string
  browserAgentId?: string
  serverOrigin?: string
  protocolVersion?: string
  extensionVersion?: string
  connectedAt?: number
  tools?: string[]
  capabilities?: Record<string, unknown>
}

export interface ExtensionHealthPayload {
  instanceId?: string
  browserAgentId?: string
  timestamp: number
  lastPongAt?: number
  activeCommands?: number
  reconnectAttempt?: number
  activeTabCount?: number
  attachedTabCount?: number
}

export interface ExtensionAgentStatePayload {
  instanceId?: string
  browserAgentId?: string
  tabId: number
  state: 'active' | 'idle' | 'stopping'
  heartbeatAt: number
  taskLabel?: string
}

export interface RelayRecentEvent {
  instanceId: string
  browserAgentId: string
  connectionId: string
  disconnectReason: string
  disconnectedAt: number
  lastSeenAt: number
}

export interface RelayAgentSummary {
  instanceId: string
  browserAgentId: string
  connectionId: string
  status: AgentConnectionStatus
  createdAt: number
  connectedAt: number | null
  lastSeenAt: number
  disconnectReason: string | null
  hello: ExtensionHelloPayload | null
  health: ExtensionHealthPayload | null
  tools: string[]
  capabilities: Record<string, unknown>
  targetCount: number
  targets: ConnectedTarget[]
  agentStates: ExtensionAgentStatePayload[]
}

export interface ExtensionRelay {
  extensionConnected: (binding?: BrowserAgentBinding) => boolean
  getAgents: () => RelayAgentSummary[]
  getTargets: (binding?: BrowserAgentBinding) => ConnectedTarget[]
  getTools: (binding?: BrowserAgentBinding) => string[]
  getCapabilities: (binding?: BrowserAgentBinding) => Record<string, unknown>
  getHealth: (binding?: BrowserAgentBinding) => ExtensionHealthPayload | null
  getHelloAt: (binding?: BrowserAgentBinding) => number | null
  getHello: (binding?: BrowserAgentBinding) => ExtensionHelloPayload | null
  getAgentStates: (binding?: BrowserAgentBinding) => ExtensionAgentStatePayload[]
  getRecentEvents: () => RelayRecentEvent[]
  sendCommand: (
    method: string,
    params?: unknown,
    targetId?: string,
    binding?: BrowserAgentBinding,
  ) => Promise<unknown>
  stop: () => Promise<void>
}

type AgentConnectionStatus = 'connecting' | 'online' | 'stale' | 'replaced' | 'offline' | 'disposed'

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type AgentConnectionState = {
  connectionId: string
  ws: WSContext | null
  instanceId: string
  browserAgentId: string
  status: AgentConnectionStatus
  hello: ExtensionHelloPayload | null
  health: ExtensionHealthPayload | null
  lastSeenAt: number
  targets: Map<string, ConnectedTarget>
  pendingRequests: Map<number, PendingRequest>
  agentStates: Map<number, ExtensionAgentStatePayload>
  tools: string[]
  capabilities: Record<string, unknown>
  createdAt: number
  connectedAt: number | null
  disconnectReason: string | null
}

type SocketConnectionMeta = {
  connectionId: string
  createdAt: number
  instanceId?: string
  browserAgentId?: string
}

type CdpClientState = {
  ws: WSContext
  instanceId: string
  browserAgentId: string
}

class RelayConnectionError extends Error {
  constructor(
    public readonly code: 'BROWSER_AGENT_REPLACED' | 'BROWSER_AGENT_OFFLINE' | 'BROWSER_AGENT_STALE',
    message: string,
  ) {
    super(message)
    this.name = code
  }
}

class BrowserAgentRoutingError extends Error {
  constructor(
    public readonly code: 'AGENT_OFFLINE' | 'AGENT_REPLACED' | 'AGENT_NOT_BOUND' | 'INSTANCE_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = code
  }
}

const GC_INTERVAL_MS = 10_000
const STALE_AFTER_MS = 30_000
const PING_INTERVAL_MS = 5_000
const COMMAND_TIMEOUT_MS = 30_000
const MAX_RECENT_EVENTS = 64

const instanceAgents = new Map<string, Map<string, AgentConnectionState>>()
const socketConnections = new Map<WSContext, SocketConnectionMeta>()
const cdpClients = new Set<CdpClientState>()
const recentEvents = new Map<string, RelayRecentEvent[]>()

let maintenanceStarted = false
let nextExtensionId = 1

function startMaintenanceLoops() {
  if (maintenanceStarted) return
  maintenanceStarted = true

  setInterval(() => {
    const now = Date.now()
    for (const [instanceId, agents] of instanceAgents) {
      for (const state of agents.values()) {
        if (state.status !== 'online') continue
        if (!state.ws || state.ws.readyState !== 1) {
          disposeAgentConnection(state, 'offline')
          continue
        }
        if (now - state.lastSeenAt > STALE_AFTER_MS) {
          disposeAgentConnection(state, 'stale')
        }
      }
      if (agents.size === 0) {
        instanceAgents.delete(instanceId)
      }
    }
  }, GC_INTERVAL_MS)

  setInterval(() => {
    for (const agents of instanceAgents.values()) {
      for (const state of agents.values()) {
        if (!state.ws || state.ws.readyState !== 1) continue
        state.ws.send(JSON.stringify({ method: 'ping' }))
      }
    }
  }, PING_INTERVAL_MS)
}

function generateConnectionId(): string {
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function recentEventBuffer(instanceId: string) {
  let events = recentEvents.get(instanceId)
  if (!events) {
    events = []
    recentEvents.set(instanceId, events)
  }
  return events
}

function recordRecentEvent(state: AgentConnectionState, reason: string) {
  const events = recentEventBuffer(state.instanceId)
  events.push({
    instanceId: state.instanceId,
    browserAgentId: state.browserAgentId,
    connectionId: state.connectionId,
    disconnectReason: reason,
    disconnectedAt: Date.now(),
    lastSeenAt: state.lastSeenAt,
  })
  if (events.length > MAX_RECENT_EVENTS) {
    events.splice(0, events.length - MAX_RECENT_EVENTS)
  }
}

function getAgentsForInstance(instanceId: string, create = false): Map<string, AgentConnectionState> | undefined {
  let agents = instanceAgents.get(instanceId)
  if (!agents && create) {
    agents = new Map()
    instanceAgents.set(instanceId, agents)
  }
  return agents
}

function getAgentState(binding: BrowserAgentBinding): AgentConnectionState | undefined {
  return getAgentsForInstance(binding.instanceId)?.get(binding.browserAgentId)
}

function onlineAgents(instanceId: string): AgentConnectionState[] {
  return [...(getAgentsForInstance(instanceId)?.values() ?? [])].filter((state) => state.status === 'online')
}

function connectionErrorForReason(reason: string) {
  if (reason === 'replaced') {
    return new RelayConnectionError('BROWSER_AGENT_REPLACED', 'Browser agent connection was replaced by a newer socket.')
  }
  if (reason === 'stale') {
    return new RelayConnectionError('BROWSER_AGENT_STALE', 'Browser agent heartbeat timed out.')
  }
  return new RelayConnectionError('BROWSER_AGENT_OFFLINE', 'Browser agent went offline.')
}

function disposeAgentConnection(
  state: AgentConnectionState,
  reason: 'replaced' | 'offline' | 'stale' | 'server_stopping',
) {
  if (state.status === 'disposed') return

  state.status = reason === 'server_stopping' ? 'offline' : reason
  state.disconnectReason = reason
  state.lastSeenAt = Date.now()
  recordRecentEvent(state, reason)

  const error = connectionErrorForReason(reason === 'server_stopping' ? 'offline' : reason)
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  state.pendingRequests.clear()

  const ws = state.ws
  state.ws = null
  state.targets.clear()
  state.agentStates.clear()
  state.health = null
  state.hello = null
  state.tools = []
  state.capabilities = {}

  if (ws) {
    socketConnections.delete(ws)
    if (ws.readyState === 1) {
      try {
        ws.close(reason === 'server_stopping' ? 1001 : 1011, reason)
      } catch {
        // ignore close errors
      }
    }
  }

  const agents = getAgentsForInstance(state.instanceId)
  if (agents?.get(state.browserAgentId)?.connectionId === state.connectionId) {
    agents.delete(state.browserAgentId)
    if (agents.size === 0) {
      instanceAgents.delete(state.instanceId)
    }
  }

  state.status = 'disposed'
}

function routingErrorFromRecentEvent(binding: BrowserAgentBinding): BrowserAgentRoutingError {
  const last = [...(recentEvents.get(binding.instanceId) ?? [])]
    .reverse()
    .find((event) => event.browserAgentId === binding.browserAgentId)

  if (last?.disconnectReason === 'replaced') {
    return new BrowserAgentRoutingError('AGENT_REPLACED', 'The bound browser agent was replaced by another connection.')
  }

  return new BrowserAgentRoutingError('AGENT_OFFLINE', 'The bound browser agent is offline. Reopen the browser extension or rebind the session.')
}

function resolveCommandAgent(instanceId: string, binding?: BrowserAgentBinding): AgentConnectionState {
  if (binding) {
    if (binding.instanceId !== instanceId) {
      throw new BrowserAgentRoutingError('INSTANCE_MISMATCH', `Session is bound to ${binding.instanceId}, not ${instanceId}.`)
    }
    const bound = getAgentState(binding)
    if (!bound || bound.status !== 'online' || !bound.ws || bound.ws.readyState !== 1) {
      throw routingErrorFromRecentEvent(binding)
    }
    return bound
  }

  const agents = onlineAgents(instanceId)
  if (agents.length === 0) {
    throw new BrowserAgentRoutingError('AGENT_OFFLINE', 'No browser agent is currently connected.')
  }
  if (agents.length > 1) {
    throw new BrowserAgentRoutingError('AGENT_NOT_BOUND', 'Multiple browser agents are connected. Bind the session to a specific browser agent first.')
  }
  return agents[0]
}

function summarizeAgent(state: AgentConnectionState): RelayAgentSummary {
  return {
    instanceId: state.instanceId,
    browserAgentId: state.browserAgentId,
    connectionId: state.connectionId,
    status: state.status,
    createdAt: state.createdAt,
    connectedAt: state.connectedAt,
    lastSeenAt: state.lastSeenAt,
    disconnectReason: state.disconnectReason,
    hello: state.hello ? { ...state.hello } : null,
    health: state.health ? { ...state.health } : null,
    tools: [...state.tools],
    capabilities: { ...state.capabilities },
    targetCount: state.targets.size,
    targets: [...state.targets.values()].map((target) => ({
      sessionId: target.sessionId,
      targetId: target.targetId,
      targetInfo: { ...target.targetInfo },
    })),
    agentStates: [...state.agentStates.values()].map((agentState) => ({ ...agentState })),
  }
}

function unionTools(states: AgentConnectionState[]) {
  return [...new Set(states.flatMap((state) => state.tools))]
}

function findSessionIdForTarget(state: AgentConnectionState, targetId: string): string | undefined {
  for (const target of state.targets.values()) {
    if (target.targetId === targetId) return target.sessionId
  }
  return undefined
}

function validateExtensionToolIfPossible(state: AgentConnectionState, cmd: { method: string; params?: unknown }) {
  if (cmd.method !== 'Extension.callTool') return
  if (state.tools.length === 0) return

  const params = (cmd.params ?? {}) as { toolName?: string }
  const toolName = params.toolName
  if (!toolName || typeof toolName !== 'string') {
    throw new Error('Extension.callTool requires string toolName')
  }
  if (!state.tools.includes(toolName)) {
    throw new Error(`Unknown extension tool: ${toolName}. Available: ${state.tools.join(', ')}`)
  }
}

function sendToAgent(
  state: AgentConnectionState,
  payload: { id: number; method: string; params: Record<string, unknown> },
): Promise<unknown> {
  if (!state.ws || state.ws.readyState !== 1 || state.status !== 'online') {
    return Promise.reject(connectionErrorForReason(state.disconnectReason ?? 'offline'))
  }

  state.ws.send(JSON.stringify(payload))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(payload.id)
      reject(new Error(`Extension request timeout: ${(payload.params as { method?: string }).method || 'unknown'}`))
    }, COMMAND_TIMEOUT_MS)

    state.pendingRequests.set(payload.id, { resolve, reject, timer })
  })
}

function broadcastToCdpClients(instanceId: string, browserAgentId: string, evt: unknown) {
  const message = JSON.stringify(evt)
  for (const client of cdpClients) {
    if (client.instanceId !== instanceId || client.browserAgentId !== browserAgentId) continue
    if (client.ws.readyState !== 1) continue
    client.ws.send(message)
  }
}

function sendResponseToCdp(ws: WSContext, res: unknown) {
  if (ws.readyState !== 1) return
  ws.send(JSON.stringify(res))
}

async function routeCdpCommand(
  instanceId: string,
  browserAgentId: string,
  cmd: { id: number; method: string; params?: unknown; sessionId?: string },
) {
  const state = resolveCommandAgent(instanceId, { instanceId, browserAgentId })
  switch (cmd.method) {
    case 'Browser.getVersion':
      return {
        protocolVersion: '1.3',
        product: 'Chrome/Browser-MCP-Extension-Relay',
        revision: '0',
        userAgent: 'Browser-MCP-Extension-Relay',
        jsVersion: 'V8',
      }

    case 'Browser.setDownloadBehavior':
    case 'Target.setAutoAttach':
    case 'Target.setDiscoverTargets':
      return {}

    case 'Target.getTargets':
      return {
        targetInfos: [...state.targets.values()].map((target) => ({
          ...target.targetInfo,
          attached: true,
        })),
      }

    case 'Target.getTargetInfo': {
      const params = (cmd.params ?? {}) as { targetId?: string }
      const targetId = params.targetId

      if (targetId) {
        const sessionId = findSessionIdForTarget(state, targetId)
        if (!sessionId) throw new Error(`Browser target not found: ${targetId}`)
        return { targetInfo: state.targets.get(sessionId)!.targetInfo }
      }

      if (cmd.sessionId) {
        const target = state.targets.get(cmd.sessionId)
        if (!target) throw new Error(`Browser session not found: ${cmd.sessionId}`)
        return { targetInfo: target.targetInfo }
      }

      const first = [...state.targets.values()][0]
      return { targetInfo: first?.targetInfo }
    }

    case 'Target.attachToTarget': {
      const params = (cmd.params ?? {}) as { targetId?: string }
      if (!params.targetId) throw new Error('targetId required')

      const sessionId = findSessionIdForTarget(state, params.targetId)
      if (!sessionId) throw new Error(`Browser target not found: ${params.targetId}`)
      return { sessionId }
    }

    default: {
      validateExtensionToolIfPossible(state, cmd)
      if (cmd.sessionId && !state.targets.has(cmd.sessionId)) {
        throw new Error(`Browser session not found: ${cmd.sessionId}`)
      }

      const id = nextExtensionId++
      return await sendToAgent(state, {
        id,
        method: 'forwardCDPCommand',
        params: {
          connectionId: state.connectionId,
          commandId: id,
          instanceId: state.instanceId,
          browserAgentId: state.browserAgentId,
          sessionId: cmd.sessionId,
          issuedAt: Date.now(),
          method: cmd.method,
          params: cmd.params,
        },
      })
    }
  }
}

function validateHello(scope: { instanceId: string }, hello: ExtensionHelloPayload) {
  if (!hello.instanceId || hello.instanceId !== scope.instanceId) {
    return 'instance_mismatch'
  }
  if (!hello.browserAgentId || typeof hello.browserAgentId !== 'string') {
    return 'missing_browser_agent_id'
  }
  if (!hello.protocolVersion || !hello.extensionVersion || !hello.serverOrigin || !Array.isArray(hello.tools)) {
    return 'invalid_hello'
  }
  return null
}

function registerHello(scope: { instanceId: string }, ws: WSContext, hello: ExtensionHelloPayload) {
  const validationError = validateHello(scope, hello)
  if (validationError) {
    try {
      ws.close(1008, validationError)
    } catch {
      // ignore close errors
    }
    return
  }

  const meta = socketConnections.get(ws)
  if (!meta) return

  const binding = {
    instanceId: scope.instanceId,
    browserAgentId: hello.browserAgentId!,
  }

  const current = getAgentState(binding)
  if (current && current.connectionId !== meta.connectionId) {
    disposeAgentConnection(current, 'replaced')
  }

  const state: AgentConnectionState = {
    connectionId: meta.connectionId,
    ws,
    instanceId: scope.instanceId,
    browserAgentId: binding.browserAgentId,
    status: 'online',
    hello: {
      instanceId: hello.instanceId,
      browserAgentId: hello.browserAgentId,
      serverOrigin: hello.serverOrigin,
      protocolVersion: hello.protocolVersion,
      extensionVersion: hello.extensionVersion,
      connectedAt: hello.connectedAt,
      tools: hello.tools,
      capabilities: hello.capabilities ?? {},
    },
    health: null,
    lastSeenAt: Date.now(),
    targets: new Map(),
    pendingRequests: new Map(),
    agentStates: new Map(),
    tools: hello.tools!.filter((tool): tool is string => typeof tool === 'string'),
    capabilities: hello.capabilities ?? {},
    createdAt: meta.createdAt,
    connectedAt: Date.now(),
    disconnectReason: null,
  }

  getAgentsForInstance(scope.instanceId, true)!.set(binding.browserAgentId, state)
  socketConnections.set(ws, {
    ...meta,
    instanceId: scope.instanceId,
    browserAgentId: binding.browserAgentId,
  })
}

function currentSocketState(ws: WSContext) {
  const meta = socketConnections.get(ws)
  if (!meta?.instanceId || !meta.browserAgentId) return undefined
  const state = getAgentState({
    instanceId: meta.instanceId,
    browserAgentId: meta.browserAgentId,
  })
  if (!state || state.connectionId !== meta.connectionId) return undefined
  return state
}

function handleExtensionMessage(scope: { instanceId: string }, ws: WSContext, data: string) {
  let parsed: any = null
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }

  if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number') {
    const state = currentSocketState(ws)
    if (!state) return

    state.lastSeenAt = Date.now()
    const pending = state.pendingRequests.get(parsed.id)
    if (!pending) return

    state.pendingRequests.delete(parsed.id)
    clearTimeout(pending.timer)

    if ('error' in parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      pending.reject(new Error(parsed.error))
    } else {
      pending.resolve(parsed.result)
    }
    return
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
    return
  }

  if (parsed.method === 'extension.hello') {
    registerHello(scope, ws, (parsed.params ?? {}) as ExtensionHelloPayload)
    return
  }

  const state = currentSocketState(ws)
  if (!state) {
    try {
      ws.close(1008, 'missing_hello')
    } catch {
      // ignore close errors
    }
    return
  }

  state.lastSeenAt = Date.now()

  if (parsed.method === 'pong') {
    state.health = {
      ...(state.health ?? { timestamp: Date.now() }),
      instanceId: state.instanceId,
      browserAgentId: state.browserAgentId,
      lastPongAt: Date.now(),
    }
    return
  }

  if (parsed.method === 'extension.health') {
    const params = (parsed.params ?? {}) as ExtensionHealthPayload
    state.health = {
      timestamp: params.timestamp ?? Date.now(),
      lastPongAt: params.lastPongAt,
      activeCommands: params.activeCommands,
      reconnectAttempt: params.reconnectAttempt,
      activeTabCount: params.activeTabCount,
      attachedTabCount: params.attachedTabCount,
      instanceId: state.instanceId,
      browserAgentId: state.browserAgentId,
    }
    return
  }

  if (parsed.method === 'extension.agentState') {
    const params = (parsed.params ?? {}) as ExtensionAgentStatePayload
    if (typeof params.tabId === 'number') {
      state.agentStates.set(params.tabId, {
        ...params,
        instanceId: state.instanceId,
        browserAgentId: state.browserAgentId,
      })
    }
    return
  }

  if (parsed.method !== 'forwardCDPEvent') return

  const params = (parsed.params ?? {}) as {
    method?: string
    params?: unknown
    sessionId?: string
  }
  const method = params.method
  const eventParams = params.params
  const sessionId = params.sessionId

  if (!method || typeof method !== 'string') return

  if (method === 'Target.attachedToTarget') {
    const attached = (eventParams ?? {}) as { sessionId?: string; targetInfo?: TargetInfo }
    if ((attached.targetInfo?.type ?? 'page') !== 'page') return
    if (attached.sessionId && attached.targetInfo?.targetId) {
      const prev = state.targets.get(attached.sessionId)
      const changedTarget = Boolean(prev && prev.targetId !== attached.targetInfo.targetId)

      state.targets.set(attached.sessionId, {
        sessionId: attached.sessionId,
        targetId: attached.targetInfo.targetId,
        targetInfo: attached.targetInfo,
      })

      if (changedTarget && prev?.targetId) {
        broadcastToCdpClients(state.instanceId, state.browserAgentId, {
          method: 'Target.detachedFromTarget',
          params: { sessionId: attached.sessionId, targetId: prev.targetId },
          sessionId: attached.sessionId,
        })
      }

      if (!prev || changedTarget) {
        broadcastToCdpClients(state.instanceId, state.browserAgentId, { method, params: eventParams, sessionId })
      }
      return
    }
  }

  if (method === 'Target.detachedFromTarget') {
    const detached = (eventParams ?? {}) as { sessionId?: string }
    if (detached.sessionId) {
      state.targets.delete(detached.sessionId)
    }
    broadcastToCdpClients(state.instanceId, state.browserAgentId, { method, params: eventParams, sessionId })
    return
  }

  if (method === 'Target.targetInfoChanged') {
    const changed = (eventParams ?? {}) as { targetInfo?: TargetInfo }
    const targetInfo = changed.targetInfo
    if (targetInfo?.targetId && (targetInfo.type ?? 'page') === 'page') {
      for (const [sid, target] of state.targets) {
        if (target.targetId !== targetInfo.targetId) continue
        state.targets.set(sid, {
          ...target,
          targetInfo: { ...target.targetInfo, ...targetInfo },
        })
      }
    }
  }

  broadcastToCdpClients(state.instanceId, state.browserAgentId, { method, params: eventParams, sessionId })
}

function cleanupSocket(scope: { instanceId: string }, ws: WSContext) {
  const state = currentSocketState(ws)
  if (state) {
    disposeAgentConnection(state, 'offline')
    return
  }

  const meta = socketConnections.get(ws)
  if (meta?.instanceId && meta.browserAgentId) {
    const current = getAgentState({ instanceId: meta.instanceId, browserAgentId: meta.browserAgentId })
    if (current?.connectionId === meta.connectionId) {
      disposeAgentConnection(current, 'offline')
      return
    }
  }

  socketConnections.delete(ws)
  for (const client of [...cdpClients]) {
    if (client.ws === ws) {
      cdpClients.delete(client)
    }
  }

  if ((getAgentsForInstance(scope.instanceId)?.size ?? 0) === 0) {
    instanceAgents.delete(scope.instanceId)
  }
}

export function createRelayRoutes(options: { instanceId: string }): Hono {
  startMaintenanceLoops()
  const scope = { instanceId: options.instanceId }

  return new Hono()
    .get(
      '/extension',
      upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          socketConnections.set(ws, {
            connectionId: generateConnectionId(),
            createdAt: Date.now(),
          })
        },
        onMessage(event, ws) {
          handleExtensionMessage(scope, ws, String(event.data))
        },
        onClose(_event, ws) {
          cleanupSocket(scope, ws)
        },
      })),
    )
    .get(
      '/cdp',
      async (c, next) => {
        const requestedAgentId = c.req.query('browserAgentId')
        const agents = onlineAgents(scope.instanceId)
        if (agents.length === 0) {
          return c.text('Extension not connected', 503)
        }
        if (requestedAgentId) {
          const matched = agents.find((state) => state.browserAgentId === requestedAgentId)
          if (!matched) {
            return c.text('Requested browser agent not connected', 503)
          }
          return next()
        }
        if (agents.length > 1) {
          return c.text('Multiple browser agents connected. Specify ?browserAgentId=<id>.', 409)
        }
        return next()
      },
      upgradeWebSocket((c) => {
        const requestedAgentId = c.req.query('browserAgentId') ?? onlineAgents(scope.instanceId)[0]?.browserAgentId
        let currentClient: CdpClientState | undefined

        return {
          onOpen(_event, ws) {
            if (!requestedAgentId) return
            currentClient = {
              ws,
              instanceId: scope.instanceId,
              browserAgentId: requestedAgentId,
            }
            cdpClients.add(currentClient)

            const state = getAgentState({ instanceId: scope.instanceId, browserAgentId: requestedAgentId })
            for (const target of state?.targets.values() ?? []) {
              ws.send(JSON.stringify({
                method: 'Target.attachedToTarget',
                params: {
                  sessionId: target.sessionId,
                  targetInfo: { ...target.targetInfo, attached: true },
                  waitingForDebugger: false,
                },
              }))
            }
          },
          async onMessage(event, ws) {
            if (!requestedAgentId) {
              sendResponseToCdp(ws, {
                error: { message: 'No browser agent selected for CDP relay.' },
              })
              return
            }

            let cmd: any = null
            try {
              cmd = JSON.parse(String(event.data))
            } catch {
              return
            }

            if (!cmd || typeof cmd !== 'object') return
            if (typeof cmd.id !== 'number' || typeof cmd.method !== 'string') return

            try {
              const result = await routeCdpCommand(scope.instanceId, requestedAgentId, cmd)
              sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result })
            } catch (error) {
              sendResponseToCdp(ws, {
                id: cmd.id,
                sessionId: cmd.sessionId,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            }
          },
          onClose() {
            if (currentClient) {
              cdpClients.delete(currentClient)
            }
          },
        }
      }),
    )
}

export function getExtensionRelay(instanceId: string): ExtensionRelay {
  startMaintenanceLoops()

  return {
    extensionConnected(binding) {
      if (!binding) {
        return onlineAgents(instanceId).length > 0
      }
      const state = getAgentState(binding)
      return Boolean(state && state.status === 'online' && state.ws && state.ws.readyState === 1)
    },
    getAgents() {
      return onlineAgents(instanceId).map(summarizeAgent)
    },
    getTargets(binding) {
      if (binding) {
        const state = getAgentState(binding)
        return state ? [...state.targets.values()].map((target) => ({
          sessionId: target.sessionId,
          targetId: target.targetId,
          targetInfo: { ...target.targetInfo },
        })) : []
      }
      return onlineAgents(instanceId).flatMap((state) => summarizeAgent(state).targets)
    },
    getTools(binding) {
      if (binding) {
        return [...(getAgentState(binding)?.tools ?? [])]
      }
      return unionTools(onlineAgents(instanceId))
    },
    getCapabilities(binding) {
      if (binding) {
        return { ...(getAgentState(binding)?.capabilities ?? {}) }
      }
      const first = onlineAgents(instanceId)[0]
      return first ? { ...first.capabilities } : {}
    },
    getHealth(binding) {
      if (binding) {
        const health = getAgentState(binding)?.health
        return health ? { ...health } : null
      }
      const first = onlineAgents(instanceId)[0]
      return first?.health ? { ...first.health } : null
    },
    getHelloAt(binding) {
      if (binding) {
        return getAgentState(binding)?.connectedAt ?? null
      }
      return onlineAgents(instanceId)[0]?.connectedAt ?? null
    },
    getHello(binding) {
      if (binding) {
        const hello = getAgentState(binding)?.hello
        return hello ? { ...hello } : null
      }
      const first = onlineAgents(instanceId)[0]
      return first?.hello ? { ...first.hello } : null
    },
    getAgentStates(binding) {
      if (binding) {
        return [...(getAgentState(binding)?.agentStates.values() ?? [])].map((state) => ({ ...state }))
      }
      return onlineAgents(instanceId).flatMap((state) => [...state.agentStates.values()].map((agentState) => ({ ...agentState })))
    },
    getRecentEvents() {
      return [...(recentEvents.get(instanceId) ?? [])].map((event) => ({ ...event }))
    },
    async sendCommand(method, params, targetId, binding) {
      const state = resolveCommandAgent(instanceId, binding)

      let sessionId: string | undefined
      if (targetId) {
        sessionId = findSessionIdForTarget(state, targetId)
        if (!sessionId && !/^\d+$/.test(targetId)) {
          throw new Error(`Browser target not found: ${targetId}`)
        }
      }

      const id = nextExtensionId++
      return await sendToAgent(state, {
        id,
        method: 'forwardCDPCommand',
        params: {
          connectionId: state.connectionId,
          commandId: id,
          instanceId: state.instanceId,
          browserAgentId: state.browserAgentId,
          sessionId,
          targetId,
          issuedAt: Date.now(),
          method,
          params,
        },
      })
    },
    async stop() {
      for (const state of onlineAgents(instanceId)) {
        disposeAgentConnection(state, 'server_stopping')
      }
      for (const client of [...cdpClients]) {
        if (client.instanceId !== instanceId) continue
        try {
          client.ws.close(1001, 'server_stopping')
        } catch {
          // ignore close errors
        }
        cdpClients.delete(client)
      }
    },
  }
}
