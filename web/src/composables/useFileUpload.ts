import { computed, ref } from 'vue'
import { api } from '../api/client'

export interface FileAttachment {
  id: string
  file: File
  status: 'selected' | 'uploading' | 'ready' | 'error'
  preview?: string
  error?: string
  mime: string
  filename: string
  size: number
  progress: number
  url?: string
  controller?: AbortController
}

interface UseFileUploadOptions {
  ensureSessionId: () => Promise<string | null>
}

const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
]

const MAX_FILE_SIZE = 500 * 1024 * 1024

function createAttachmentId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }

    if (typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(8))
      const suffix = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
      return `attachment-${suffix}`
    }
  }

  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function useFileUpload(options: UseFileUploadOptions) {
  const attachments = ref<FileAttachment[]>([])
  const uploadError = ref<string | null>(null)
  let uploadQueue = Promise.resolve()

  const isProcessing = computed(() =>
    attachments.value.some(a => a.status === 'selected' || a.status === 'uploading')
  )

  const hasReady = computed(() =>
    attachments.value.some(a => a.status === 'ready')
  )

  function isImage(file: File): boolean {
    return SUPPORTED_IMAGE_TYPES.includes(file.type)
  }

  function isDocument(_file: File): boolean {
    return true
  }

  function isSupported(file: File): boolean {
    return file.size >= 0
  }

  function getMimeType(file: File): string {
    if (file.type && file.type !== 'application/octet-stream') {
      return file.type
    }

    const ext = file.name.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      xml: 'application/xml'
    }
    return mimeMap[ext || ''] || 'application/octet-stream'
  }

  function findAttachmentIndex(id: string) {
    return attachments.value.findIndex(a => a.id === id)
  }

  function revokePreview(attachment?: FileAttachment) {
    if (attachment?.preview) {
      URL.revokeObjectURL(attachment.preview)
    }
  }

  async function addFiles(files: FileList | File[]) {
    const fileArray = Array.from(files)
    uploadError.value = null

    for (const file of fileArray) {
      if (!isSupported(file)) {
        uploadError.value = `不支持上传 ${file.name}。`
        continue
      }

      if (file.size > MAX_FILE_SIZE) {
        uploadError.value = `${file.name} 过大。聊天上传当前限制为 500MB。`
        continue
      }

      const attachment: FileAttachment = {
        id: createAttachmentId(),
        file,
        status: 'selected',
        mime: getMimeType(file),
        filename: file.name,
        size: file.size,
        progress: 0,
        preview: isImage(file) ? URL.createObjectURL(file) : undefined
      }

      attachments.value.push(attachment)
      queueUpload(attachment.id)
    }
  }

  function queueUpload(id: string) {
    uploadQueue = uploadQueue
      .then(async () => {
        await uploadAttachment(id)
      })
      .catch((error) => {
        console.error('Attachment upload queue failed:', error)
      })
  }

  async function uploadAttachment(id: string) {
    const idx = findAttachmentIndex(id)
    if (idx === -1) return

    attachments.value[idx].status = 'uploading'
    attachments.value[idx].progress = 0
    const controller = new AbortController()
    attachments.value[idx].controller = controller

    try {
      const sessionId = await options.ensureSessionId()
      if (!sessionId) {
        throw new Error('创建会话失败，请重试。')
      }

      const uploaded = await api.uploadSessionFile(sessionId, attachments.value[idx].file, {
        signal: controller.signal,
        onProgress: (progress) => {
          const nextIdx = findAttachmentIndex(id)
          if (nextIdx === -1) return
          attachments.value[nextIdx].progress = progress
        }
      })

      const nextIdx = findAttachmentIndex(id)
      if (nextIdx === -1) return

      attachments.value[nextIdx].status = 'ready'
      attachments.value[nextIdx].progress = 100
      attachments.value[nextIdx].url = uploaded.url
      attachments.value[nextIdx].mime = uploaded.mime
      attachments.value[nextIdx].filename = uploaded.filename
      attachments.value[nextIdx].error = undefined
    } catch (err) {
      const nextIdx = findAttachmentIndex(id)
      const aborted = err instanceof DOMException && err.name === 'AbortError'

      if (aborted) {
        if (nextIdx !== -1) {
          revokePreview(attachments.value[nextIdx])
          attachments.value.splice(nextIdx, 1)
        }
        return
      }

      const message = err instanceof Error ? err.message : '上传失败，请重试。'
      if (nextIdx !== -1) {
        attachments.value[nextIdx].status = 'error'
        attachments.value[nextIdx].error = message
      }
      uploadError.value = `${attachments.value[nextIdx]?.filename || '文件'} 上传失败：${message}`
    } finally {
      const nextIdx = findAttachmentIndex(id)
      if (nextIdx !== -1) {
        attachments.value[nextIdx].controller = undefined
      }
    }
  }

  function removeFile(id: string) {
    const idx = findAttachmentIndex(id)
    if (idx === -1) return

    attachments.value[idx].controller?.abort()
    revokePreview(attachments.value[idx])
    attachments.value.splice(idx, 1)
  }

  function clearAll() {
    for (const attachment of attachments.value) {
      attachment.controller?.abort()
      revokePreview(attachment)
    }
    attachments.value = []
    uploadError.value = null
  }

  function clearError() {
    uploadError.value = null
  }

  function toMessageParts(): Array<{ type: 'file'; mime: string; filename: string; url: string }> {
    return attachments.value
      .filter(a => a.status === 'ready' && a.url)
      .map(a => ({
        type: 'file' as const,
        mime: a.mime,
        filename: a.filename,
        url: a.url!
      }))
  }

  return {
    attachments,
    uploadError,
    isProcessing,
    hasReady,
    addFiles,
    removeFile,
    clearAll,
    clearError,
    toMessageParts,
    isImage,
    isDocument,
    isSupported
  }
}
