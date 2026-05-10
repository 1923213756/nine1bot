import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getDataDir } from '../config/loader'

export type ReviewRunStatus = 'accepted' | 'rejected' | 'blocked' | 'running' | 'succeeded' | 'failed'

export type ReviewRunRecord = {
  id: string
  platform: 'gitlab'
  idempotencyKey?: string
  status: ReviewRunStatus
  createdAt: number
  updatedAt: number
  error?: string
  trigger?: Record<string, unknown>
  sessionId?: string
  turnSnapshotId?: string
  publishedAt?: number
  failureNotifiedAt?: number
  retryCount?: number
  lastRetryAt?: number
  warnings?: string[]
  context?: unknown
}

export type CreateReviewRunInput = Omit<ReviewRunRecord, 'id' | 'createdAt' | 'updatedAt'>

type ReviewRunStoreFile = {
  version: 1
  sequence: number
  runs: ReviewRunRecord[]
}

const runs = new Map<string, ReviewRunRecord>()
let sequence = 0
let loaded = false
let storePathOverride: string | undefined
let maxRecordsOverride: number | undefined

function defaultStorePath() {
  return process.env.NINE1BOT_REVIEW_RUN_STORE_PATH || join(getDataDir(), 'review-runs.json')
}

function storePath() {
  return storePathOverride || defaultStorePath()
}

function maxRecords() {
  if (maxRecordsOverride !== undefined) return maxRecordsOverride
  const configured = Number(process.env.NINE1BOT_REVIEW_RUN_STORE_LIMIT)
  return Number.isFinite(configured) && configured > 0 ? configured : 100
}

export namespace ReviewRunStore {
  export function create(input: CreateReviewRunInput): ReviewRunRecord {
    load()
    const now = Date.now()
    const run = {
      ...input,
      id: `review_${now.toString(36)}_${(++sequence).toString(36)}`,
      createdAt: now,
      updatedAt: now,
    } satisfies ReviewRunRecord
    runs.set(run.id, run)
    save()
    return { ...run }
  }

  export function findByIdempotencyKey(idempotencyKey: string): ReviewRunRecord | undefined {
    load()
    for (const run of runs.values()) {
      if (run.idempotencyKey === idempotencyKey) return { ...run }
    }
    return undefined
  }

  export function get(id: string): ReviewRunRecord | undefined {
    load()
    const run = runs.get(id)
    return run ? { ...run } : undefined
  }

  export function update(id: string, patch: Partial<Omit<ReviewRunRecord, 'id' | 'createdAt'>>): ReviewRunRecord | undefined {
    load()
    const existing = runs.get(id)
    if (!existing) return undefined
    const next = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    runs.set(id, next)
    save()
    return { ...next }
  }

  export function list(options: { limit?: number } = {}): ReviewRunRecord[] {
    load()
    const sorted = [...runs.values()].sort(compareNewestFirst)
    const limit = options.limit && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : undefined
    return (limit ? sorted.slice(0, limit) : sorted).map((run) => ({ ...run }))
  }

  export function clearForTesting() {
    runs.clear()
    sequence = 0
    loaded = true
    if (storePathOverride && existsSync(storePathOverride)) {
      rmSync(storePathOverride, { force: true })
    }
  }

  export function setPathForTesting(filepath: string) {
    storePathOverride = filepath
    runs.clear()
    sequence = 0
    loaded = false
  }

  export function setMaxRecordsForTesting(limit: number | undefined) {
    maxRecordsOverride = limit
  }

  export function reloadForTesting() {
    runs.clear()
    sequence = 0
    loaded = false
  }
}

function load() {
  if (loaded) return
  loaded = true
  const filepath = storePath()
  if (!existsSync(filepath)) return
  try {
    const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as Partial<ReviewRunStoreFile>
    const records = Array.isArray(parsed.runs) ? parsed.runs.filter(isReviewRunRecord) : []
    runs.clear()
    for (const run of records) {
      runs.set(run.id, { ...run })
    }
    sequence = typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)
      ? parsed.sequence
      : inferSequence(records)
  } catch {
    runs.clear()
    sequence = 0
  }
}

function save() {
  const filepath = storePath()
  mkdirSync(dirname(filepath), { recursive: true })
  prune()
  const data: ReviewRunStoreFile = {
    version: 1,
    sequence,
    runs: [...runs.values()],
  }
  const tempPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tempPath, filepath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

function prune() {
  const limit = maxRecords()
  if (runs.size <= limit) return
  const keep = new Set(
    [...runs.values()]
      .sort(compareNewestFirst)
      .slice(0, limit)
      .map((run) => run.id),
  )
  for (const id of runs.keys()) {
    if (!keep.has(id)) runs.delete(id)
  }
}

function inferSequence(records: ReviewRunRecord[]) {
  return records.length
}

function compareNewestFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

function isReviewRunRecord(input: unknown): input is ReviewRunRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return typeof record.id === 'string'
    && record.platform === 'gitlab'
    && typeof record.status === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
}
