import type { GitLabUrlInfo, PageContextPayload } from './types'

export function parseGitLabUrl(input?: string): GitLabUrlInfo | undefined {
  if (!input) return undefined

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }

  if (!isLikelyGitLabHost(url.hostname)) return undefined

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length === 0) return undefined

  const dashIndex = parts.indexOf('-')
  const projectParts = dashIndex === -1 ? parts : parts.slice(0, dashIndex)
  const projectPath = projectParts.join('/')
  if (!projectPath) return undefined

  if (dashIndex === -1) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.hostname, projectPath, 'repo'),
      route: 'repo',
    }
  }

  const route = parts[dashIndex + 1]
  const rest = parts.slice(dashIndex + 2)

  if (route === 'merge_requests' && rest[0]) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-mr',
      objectKey: objectKey(url.hostname, projectPath, 'merge_request', rest[0]),
      route: 'merge_request',
      iid: rest[0],
    }
  }

  if (route === 'issues' && rest[0]) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-issue',
      objectKey: objectKey(url.hostname, projectPath, 'issue', rest[0]),
      route: 'issue',
      iid: rest[0],
    }
  }

  if (route === 'blob' && rest[0]) {
    const ref = rest[0]
    const filePath = rest.slice(1).join('/')
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-file',
      objectKey: objectKey(url.hostname, projectPath, 'file', ref, filePath),
      route: 'blob',
      ref,
      filePath,
    }
  }

  if (route === 'tree') {
    const ref = rest[0]
    const treePath = rest.slice(1).join('/')
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.hostname, projectPath, 'tree', ref, treePath),
      route: 'tree',
      ref,
      treePath,
    }
  }

  return {
    host: url.hostname,
    projectPath,
    pageType: 'gitlab-repo',
    objectKey: objectKey(url.hostname, projectPath, 'repo'),
    route: 'repo',
  }
}

export function buildGitLabPageContextPayload(input: {
  url: string
  title: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}): PageContextPayload {
  const gitlab = parseGitLabUrl(input.url)
  if (!gitlab) {
    return {
      platform: 'generic-browser',
      url: input.url,
      title: input.title,
      selection: trimText(input.selection, 4000),
      visibleSummary: trimText(input.visibleSummary, 2000),
      raw: input.raw,
    }
  }

  return {
    platform: 'gitlab',
    url: input.url,
    title: input.title,
    pageType: gitlab.pageType,
    objectKey: gitlab.objectKey,
    selection: trimText(input.selection, 4000),
    visibleSummary: trimText(input.visibleSummary, 2000),
    raw: {
      ...(input.raw ?? {}),
      gitlab: {
        ...(asRecord(input.raw?.gitlab) ?? {}),
        host: gitlab.host,
        projectPath: gitlab.projectPath,
        route: gitlab.route,
        ref: gitlab.ref,
        filePath: gitlab.filePath,
        treePath: gitlab.treePath,
        iid: gitlab.iid,
      },
    },
  }
}

export function normalizeGitLabPagePayload(page: PageContextPayload): PageContextPayload | undefined {
  const parsed = parseGitLabUrl(page.url)
  if (!parsed && page.platform !== 'gitlab') return undefined
  const gitlab = parsed ?? gitLabInfoFromRaw(page)
  if (!gitlab) return undefined

  return {
    ...page,
    platform: 'gitlab',
    pageType: gitlab.pageType,
    objectKey: gitlab.objectKey,
    raw: {
      ...(page.raw ?? {}),
      gitlab: {
        ...(asRecord(page.raw?.gitlab) ?? {}),
        host: gitlab.host,
        projectPath: gitlab.projectPath,
        route: gitlab.route,
        ref: gitlab.ref,
        filePath: gitlab.filePath,
        treePath: gitlab.treePath,
        iid: gitlab.iid,
      },
    },
  }
}

export function gitLabTemplateIdsForPage(page?: Pick<PageContextPayload, 'platform' | 'pageType' | 'url'>): string[] {
  const normalized = page ? normalizeGitLabPagePayload(page as PageContextPayload) : undefined
  if (!normalized) return []
  const ids = ['browser-gitlab']
  if (normalized.pageType?.startsWith('gitlab-')) ids.push(normalized.pageType)
  return ids
}

export function isGitLabPagePayload(page?: Pick<PageContextPayload, 'platform' | 'url'>): boolean {
  return Boolean(page && (page.platform === 'gitlab' || parseGitLabUrl(page.url)))
}

export function trimText(input: string | undefined, maxLength: number): string | undefined {
  const normalized = input?.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized
}

export function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function isLikelyGitLabHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'gitlab.com' || normalized.includes('gitlab')
}

function objectKey(host: string, projectPath: string, ...parts: Array<string | undefined>) {
  return [host, projectPath, ...parts.filter((part) => part && part.trim())].join(':')
}

function gitLabInfoFromRaw(page: PageContextPayload): GitLabUrlInfo | undefined {
  const raw = asRecord(page.raw?.gitlab)
  const host = stringValue(raw?.host)
  const projectPath = stringValue(raw?.projectPath)
  const route = stringValue(raw?.route)
  if (!host || !projectPath) return undefined

  const pageType = page.pageType?.startsWith('gitlab-')
    ? page.pageType as GitLabUrlInfo['pageType']
    : route === 'merge_request'
      ? 'gitlab-mr'
      : route === 'issue'
        ? 'gitlab-issue'
        : route === 'blob'
          ? 'gitlab-file'
          : 'gitlab-repo'

  return {
    host,
    projectPath,
    pageType,
    objectKey: page.objectKey || objectKey(host, projectPath, route || 'repo', stringValue(raw?.iid)),
    route: route === 'merge_request' || route === 'issue' || route === 'blob' || route === 'tree' ? route : 'repo',
    ref: stringValue(raw?.ref),
    filePath: stringValue(raw?.filePath),
    treePath: stringValue(raw?.treePath),
    iid: stringValue(raw?.iid),
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}
