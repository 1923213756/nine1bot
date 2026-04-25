export type KnownGitLabPageType = 'gitlab-repo' | 'gitlab-file' | 'gitlab-mr' | 'gitlab-issue'

export interface PageContextPayload {
  platform: string
  url?: string
  title?: string
  pageType?: string
  objectKey?: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}

export interface GitLabUrlInfo {
  host: string
  projectPath: string
  pageType: KnownGitLabPageType
  objectKey: string
  ref?: string
  filePath?: string
  treePath?: string
  iid?: string
  route: 'repo' | 'blob' | 'tree' | 'merge_request' | 'issue'
}

export type PlatformContextBlock = {
  id: string
  layer: 'platform' | 'page'
  source: string
  enabled: boolean
  priority: number
  lifecycle: 'session' | 'turn'
  visibility: 'system-required' | 'developer-toggle'
  mergeKey?: string
  observedAt?: number
  content: string
}

export type PlatformResourceContribution = {
  builtinTools: {
    enabledGroups?: string[]
    enabledTools?: string[]
  }
  mcp: {
    servers: string[]
    tools?: Record<string, string[]>
    lifecycle: 'session'
    mergeMode: 'additive-only'
  }
  skills: {
    skills: string[]
    lifecycle: 'session'
    mergeMode: 'additive-only'
  }
}
