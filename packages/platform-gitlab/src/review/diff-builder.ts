import type { GitLabDiffManifest, GitLabRawChange, GitLabRawChangesResponse, GitLabSkippedFile } from './types'

const BLACKLISTED_PATH_PATTERNS = [
  /(^|\/)(package-lock|npm-shrinkwrap)\.json$/i,
  /(^|\/)(yarn|pnpm-lock|bun)\.lock$/i,
  /(^|\/)(dist|build|coverage|\.next|\.nuxt|vendor)\//i,
  /\.min\.(js|css)$/i,
  /\.(map|svg|png|jpe?g|gif|webp|avif|ico|pdf|zip|tar|gz|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i,
  /(^|\/)generated\//i,
]

export type BuildGitLabDiffManifestOptions = {
  maxDiffBytes?: number
  maxFiles?: number
  blockOnOverflow?: boolean
}

export function buildGitLabDiffManifest(
  response: GitLabRawChangesResponse,
  options: BuildGitLabDiffManifestOptions = {},
): GitLabDiffManifest {
  const maxDiffBytes = options.maxDiffBytes ?? 240_000
  const maxFiles = options.maxFiles ?? 80
  const changes = response.changes ?? []
  const truncated = Boolean(response.overflow || changes.some(isOverflowChange))

  if ((options.blockOnOverflow ?? true) && truncated) {
    return blockedManifest(response, changes, 'MR diff is too large or was truncated by GitLab.', {
      truncated: true,
      fallbackReason: 'too-large',
    })
  }

  const files = []
  const skipped: GitLabSkippedFile[] = []
  let includedBytes = 0

  for (const change of changes) {
    const path = displayPath(change)
    if (change.generated_file) {
      skipped.push({ path, reason: 'generated' })
      continue
    }
    if (isBlacklistedReviewPath(path)) {
      skipped.push({ path, reason: 'blacklisted' })
      continue
    }
    if (change.too_large || change.collapsed) {
      skipped.push({ path, reason: 'too-large' })
      continue
    }
    if (!change.diff?.trim()) {
      return blockedManifest(response, changes, `MR diff for ${path} is empty or unavailable.`, {
        truncated: false,
        fallbackReason: 'empty-diff',
      })
    }
    const nextBytes = byteLength(change.diff)
    if (files.length >= maxFiles || includedBytes + nextBytes > maxDiffBytes) {
      skipped.push({ path, reason: 'budget-exceeded' })
      continue
    }
    includedBytes += nextBytes
    files.push({
      oldPath: change.old_path,
      newPath: change.new_path,
      diff: change.diff,
      added: Boolean(change.new_file),
      renamed: Boolean(change.renamed_file),
      deleted: Boolean(change.deleted_file),
      generated: Boolean(change.generated_file),
    })
  }

  return {
    files,
    skipped,
    blocked: false,
    diffRefs: normalizeDiffRefs(response),
    stats: {
      fileCount: changes.length,
      includedFileCount: files.length,
      skippedFileCount: skipped.length,
      includedBytes,
      truncated,
    },
  }
}

export function isBlacklistedReviewPath(path: string) {
  return BLACKLISTED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

function blockedManifest(
  response: GitLabRawChangesResponse,
  changes: GitLabRawChange[],
  blockReason: string,
  options: {
    truncated: boolean
    fallbackReason: GitLabSkippedFile['reason']
  },
): GitLabDiffManifest {
  return {
    files: [],
    skipped: changes.map((change) => ({
      path: displayPath(change),
      reason: skippedReasonForBlockedChange(change, options.fallbackReason),
    })),
    blocked: true,
    blockReason,
    diffRefs: normalizeDiffRefs(response),
    stats: {
      fileCount: changes.length,
      includedFileCount: 0,
      skippedFileCount: changes.length,
      includedBytes: 0,
      truncated: options.truncated,
    },
  }
}

function skippedReasonForBlockedChange(
  change: GitLabRawChange,
  fallbackReason: GitLabSkippedFile['reason'],
): GitLabSkippedFile['reason'] {
  const path = displayPath(change)
  if (change.generated_file) return 'generated'
  if (isBlacklistedReviewPath(path)) return 'blacklisted'
  if (change.overflow || change.too_large || change.collapsed) return 'too-large'
  if (!change.diff?.trim()) return 'empty-diff'
  return fallbackReason
}

function isOverflowChange(change: GitLabRawChange) {
  return Boolean(change.overflow || change.too_large)
}

function displayPath(change: GitLabRawChange) {
  return change.new_path || change.old_path
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).length
}

function normalizeDiffRefs(response: GitLabRawChangesResponse) {
  return response.diff_refs
    ? {
        baseSha: response.diff_refs.base_sha,
        startSha: response.diff_refs.start_sha,
        headSha: response.diff_refs.head_sha,
      }
    : undefined
}
