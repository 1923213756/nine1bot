import { loadConfig } from '../config/loader'
import type { Nine1BotConfig } from '../config/schema'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime, RuntimeApplyResult } from './types'

export class EngineManager {
  private currentConfig?: Nine1BotConfig
  private currentPrepared?: PreparedRuntime
  private currentHandle?: EngineHandle
  private pendingPrepared?: PreparedRuntime
  private pendingReason?: string
  private pendingWatcher?: ReturnType<typeof setInterval>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly adapter: EngineAdapter,
    private readonly context: EngineContext,
  ) {}

  async start(config: Nine1BotConfig): Promise<EngineHandle> {
    return this.runExclusive(async () => {
      this.currentConfig = config
      this.currentPrepared = await this.adapter.prepare(config, this.context)
      this.currentHandle = await this.adapter.start(this.currentPrepared)
      return this.currentHandle
    })
  }

  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      this.clearPendingRebuild()
      if (this.currentHandle) {
        await this.currentHandle.stop()
        this.currentHandle = undefined
      }
    })
  }

  currentBaseUrl(): string {
    if (!this.currentHandle) {
      throw new Error('Engine is not started')
    }
    return this.currentHandle.baseUrl
  }

  async health(): Promise<boolean> {
    if (!this.currentHandle) {
      return false
    }
    return this.currentHandle.health()
  }

  async proxy(path: string, request: Request): Promise<Response> {
    const baseUrl = this.currentBaseUrl()
    const headers = new Headers(request.headers)
    headers.delete('host')

    return fetch(`${baseUrl}${path}`, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      // @ts-expect-error Bun accepts duplex when needed and ignores it otherwise.
      duplex: 'half',
    })
  }

  async applyRuntimeChange(reason: string): Promise<RuntimeApplyResult> {
    return this.runExclusive(async () => {
      const config = await loadConfig(this.context.configPath)
      this.currentConfig = config

      const { prepared, requiresRestart } = await this.adapter.rebuildRuntime(
        reason,
        config,
        this.context,
        this.currentPrepared,
      )

      if (!requiresRestart) {
        this.clearPendingRebuild()
        this.currentPrepared = prepared
        return {
          state: 'applied',
          effectiveAfterCurrentSession: false,
        }
      }

      if (await this.hasActiveSessions()) {
        this.pendingPrepared = prepared
        this.pendingReason = reason
        this.ensurePendingWatcher()
        return {
          state: 'pending-rebuild',
          effectiveAfterCurrentSession: true,
        }
      }

      await this.restart(prepared)
      return {
        state: 'applied',
        effectiveAfterCurrentSession: false,
      }
    })
  }

  private ensurePendingWatcher() {
    if (this.pendingWatcher) return

    this.pendingWatcher = setInterval(() => {
      void this.runExclusive(async () => {
        if (!this.pendingPrepared) return
        if (await this.hasActiveSessions()) return

        const prepared = this.pendingPrepared
        this.clearPendingRebuild()
        await this.restart(prepared)
      })
    }, 1000)
  }

  private clearPendingRebuild() {
    if (this.pendingWatcher) {
      clearInterval(this.pendingWatcher)
      this.pendingWatcher = undefined
    }
    this.pendingPrepared = undefined
    this.pendingReason = undefined
  }

  private async restart(prepared: PreparedRuntime) {
    const previousHandle = this.currentHandle
    const requiresStopFirst = this.currentPrepared?.startSpec.type === 'in-process' || prepared.startSpec.type === 'in-process'

    if (requiresStopFirst && previousHandle) {
      await previousHandle.stop()
    }

    const nextHandle = await this.adapter.start(prepared)
    this.currentHandle = nextHandle
    this.currentPrepared = prepared

    if (!requiresStopFirst && previousHandle) {
      await previousHandle.stop()
    }
  }

  private async hasActiveSessions(): Promise<boolean> {
    if (!this.currentHandle) return false
    try {
      const response = await fetch(`${this.currentHandle.baseUrl}/session/status`)
      if (!response.ok) return false
      const data = await response.json() as Record<string, { type?: string }>
      return Object.values(data).some((status) => status.type === 'busy' || status.type === 'retry')
    } catch {
      return false
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}
