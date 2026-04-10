import { ref, computed } from 'vue'

export interface FileAttachment {
  id: string
  file: File
  status: 'pending' | 'processing' | 'ready' | 'error'
  preview?: string  // Data URL for image preview
  dataUrl?: string  // Base64 data URL for sending
  error?: string
  mime: string
  filename: string
  size: number
}

// Supported image types (for previews only)
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
]

// Max file size: 20MB for chat uploads to avoid oversized JSON/data URL payloads
const MAX_FILE_SIZE = 20 * 1024 * 1024

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

export function useFileUpload() {
  const attachments = ref<FileAttachment[]>([])
  const uploadError = ref<string | null>(null)

  const isProcessing = computed(() =>
    attachments.value.some(a => a.status === 'processing')
  )

  const hasReady = computed(() =>
    attachments.value.some(a => a.status === 'ready')
  )

  // Check if file is a supported image
  function isImage(file: File): boolean {
    return SUPPORTED_IMAGE_TYPES.includes(file.type)
  }

  // Any file type is allowed; images only affect preview rendering.
  function isDocument(_file: File): boolean {
    return true
  }

  function isSupported(file: File): boolean {
    return file.size >= 0
  }

  // Get MIME type, with fallback for generic types
  function getMimeType(file: File): string {
    if (file.type && file.type !== 'application/octet-stream') {
      return file.type
    }
    // Fallback based on extension
    const ext = file.name.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      'pdf': 'application/pdf',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'ppt': 'application/vnd.ms-powerpoint',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'csv': 'text/csv',
      'json': 'application/json',
      'xml': 'application/xml'
    }
    return mimeMap[ext || ''] || file.type
  }

  // Convert file to base64 data URL
  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
  }

  // Add files
  async function addFiles(files: FileList | File[]) {
    const fileArray = Array.from(files)
    uploadError.value = null

    for (const file of fileArray) {
      if (!isSupported(file)) {
        uploadError.value = `不支持上传 ${file.name}。`
        continue
      }

      if (file.size > MAX_FILE_SIZE) {
        uploadError.value = `${file.name} 过大。聊天上传当前限制为 20MB。`
        console.warn(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB, max: ${MAX_FILE_SIZE / 1024 / 1024}MB)`)
        continue
      }

      const id = createAttachmentId()
      const mime = getMimeType(file)

      const attachment: FileAttachment = {
        id,
        file,
        status: 'pending',
        mime,
        filename: file.name,
        size: file.size
      }

      attachments.value.push(attachment)

      // Process asynchronously
      processFile(attachment)
    }
  }

  async function processFile(attachment: FileAttachment) {
    const idx = attachments.value.findIndex(a => a.id === attachment.id)
    if (idx === -1) return

    attachments.value[idx].status = 'processing'

    try {
      const dataUrl = await fileToDataUrl(attachment.file)

      attachments.value[idx].dataUrl = dataUrl
      // Only set preview for images
      if (isImage(attachment.file)) {
        attachments.value[idx].preview = dataUrl
      }
      attachments.value[idx].status = 'ready'
    } catch (err) {
      attachments.value[idx].status = 'error'
      attachments.value[idx].error = (err as Error).message
      uploadError.value = `读取 ${attachment.filename} 失败，请重试。`
    }
  }

  // Remove a file
  function removeFile(id: string) {
    const idx = attachments.value.findIndex(a => a.id === id)
    if (idx !== -1) {
      attachments.value.splice(idx, 1)
    }
  }

  // Clear all files
  function clearAll() {
    attachments.value = []
    uploadError.value = null
  }

  function clearError() {
    uploadError.value = null
  }

  // Convert to message parts for API
  function toMessageParts(): Array<{ type: 'file'; mime: string; filename: string; url: string }> {
    return attachments.value
      .filter(a => a.status === 'ready' && a.dataUrl)
      .map(a => ({
        type: 'file' as const,
        mime: a.mime,
        filename: a.filename,
        url: a.dataUrl!
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
