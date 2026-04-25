import type { ContextBlock, ResourceSpec } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimePlatformAdapterRegistry {
  export type PagePayload = {
    platform: string
    url?: string
    pageType?: string
    title?: string
    objectKey?: string
    selection?: string
    visibleSummary?: string
    raw?: Record<string, unknown>
  }

  export type TemplateInput = {
    entry?: {
      source?: string
      platform?: string
      mode?: string
      templateIds?: string[]
    }
    page?: PagePayload
  }

  export type PlatformAdapter = {
    id: string
    matchPage?: (page: PagePayload) => boolean
    normalizePage?: (page: PagePayload) => PagePayload | undefined
    blocksFromPage?: (page: PagePayload, observedAt: number) => ContextBlock[] | undefined
    inferTemplateIds?: (input: TemplateInput) => string[]
    templateContextBlocks?: (input: { templateIds: string[]; page?: PagePayload }) => ContextBlock[]
    resourceContributions?: (input: { templateIds: string[] }) => ResourceSpec | undefined
    recommendedAgent?: (input: { templateIds: string[]; fallback: string }) => string | undefined
  }

  const adapters = new Map<string, PlatformAdapter>()

  export function register(adapter: PlatformAdapter) {
    adapters.set(adapter.id, adapter)
  }

  export function unregister(id: string) {
    adapters.delete(id)
  }

  export function clearForTesting() {
    adapters.clear()
  }

  export function list() {
    return Array.from(adapters.values())
  }

  export function normalizePage(page: PagePayload): PagePayload {
    for (const adapter of adapters.values()) {
      if (!adapter.matchPage?.(page)) continue
      const normalized = adapter.normalizePage?.(page)
      if (normalized) return normalized
    }
    return page
  }

  export function blocksFromPage(page: PagePayload, observedAt: number): ContextBlock[] | undefined {
    for (const adapter of adapters.values()) {
      if (!adapter.matchPage?.(page)) continue
      const blocks = adapter.blocksFromPage?.(page, observedAt)
      if (blocks?.length) return blocks
    }
    return undefined
  }

  export function inferTemplateIds(input: TemplateInput): string[] {
    return unique(Array.from(adapters.values()).flatMap((adapter) => adapter.inferTemplateIds?.(input) ?? []))
  }

  export function templateContextBlocks(input: { templateIds: string[]; page?: PagePayload }): ContextBlock[] {
    return Array.from(adapters.values()).flatMap((adapter) => adapter.templateContextBlocks?.(input) ?? [])
  }

  export function resourceContributions(input: { templateIds: string[] }): ResourceSpec[] {
    return Array.from(adapters.values()).flatMap((adapter) => {
      const resources = adapter.resourceContributions?.(input)
      return resources ? [resources] : []
    })
  }

  export function recommendedAgent(input: { templateIds: string[]; fallback: string }): string {
    for (const adapter of adapters.values()) {
      const recommended = adapter.recommendedAgent?.(input)
      if (recommended) return recommended
    }
    return input.fallback
  }

  function unique(values: string[]) {
    const seen = new Set<string>()
    return values.filter((value) => {
      if (!value.trim() || seen.has(value)) return false
      seen.add(value)
      return true
    })
  }
}
