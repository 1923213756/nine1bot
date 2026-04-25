export {
  buildGitLabPageContextPayload,
  buildGitLabPageContextPayload as buildPageContextPayload,
  gitLabTemplateIdsForPage,
  isGitLabPagePayload,
  parseGitLabUrl,
} from './browser'
export {
  createGitLabPlatformAdapter,
  normalizeGitLabPagePayload,
} from './runtime'
export type { GitLabPlatformAdapter } from './runtime'
export type * from './types'
