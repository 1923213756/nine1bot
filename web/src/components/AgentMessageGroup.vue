<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Message, MessagePart, FilePart } from '../api/client'
import AgentSteps from './AgentSteps.vue'
import { X, FileDown, File, Eye } from 'lucide-vue-next'
import { useFilePreview } from '../composables/useFilePreview'

interface Step { parts: MessagePart[]; isComplete: boolean }

const props = defineProps<{
  messages: Message[]
  isStreaming: boolean
}>()

// Collect all steps from all messages in this group
const allSteps = computed<Step[]>(() => {
  const steps: Step[] = []
  for (const message of props.messages) {
    let currentStep: Step | null = null
    for (const part of message.parts) {
      if (part.type === 'step-start') {
        currentStep = { parts: [], isComplete: false }
        steps.push(currentStep)
      } else if (part.type === 'step-finish') {
        if (currentStep) currentStep.isComplete = true
        currentStep = null
      } else if (part.type === 'tool' || part.type === 'reasoning') {
        if (currentStep) {
          currentStep.parts.push(part)
        } else {
          // tool/reasoning outside explicit steps — implicit completed step
          if (steps.length === 0 || steps[steps.length - 1].isComplete) {
            steps.push({ parts: [], isComplete: true })
          }
          steps[steps.length - 1].parts.push(part)
        }
      }
    }
  }
  return steps
})

// Collect all text/file outputs (always visible)
type OutputItem =
  | { type: 'text'; text: string; id: string }
  | { type: 'file'; part: MessagePart }

const textOutputs = computed<OutputItem[]>(() => {
  const outputs: OutputItem[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (part.type === 'text' && !(part as any).synthetic && part.text) {
        outputs.push({ type: 'text', text: part.text, id: part.id })
      } else if (part.type === 'file') {
        outputs.push({ type: 'file', part })
      }
    }
  }
  return outputs
})

function formatText(text: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(text) as string)
  } catch {
    return DOMPurify.sanitize(text)
  }
}

function isImageFile(part: MessagePart): boolean {
  return ((part as any).mime || '').startsWith('image/')
}

function resolveFileUrl(url: string): string {
  if (url.startsWith('file://')) {
    return `/file/upload?path=${encodeURIComponent(url.slice(7))}`
  }
  return url
}

const previewImageUrl = ref<string | null>(null)

const { openPreviewByPath } = useFilePreview()

// Collect all file attachments from tool state across all steps
const toolAttachments = computed<FilePart[]>(() => {
  const result: FilePart[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.state?.attachments?.length) {
        for (const att of part.state.attachments) {
          if ((att as any).url) result.push(att as FilePart)
        }
      }
    }
  }
  return result
})

// Collect all preview_file tools (completed)
interface PreviewMeta {
  path: string
  filename?: string
  size?: number
  interactive?: boolean
  sessionID: string
}
const previewTools = computed<PreviewMeta[]>(() => {
  const result: PreviewMeta[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (
        part.type === 'tool' &&
        (part.tool || '').toLowerCase() === 'preview_file' &&
        part.state?.status === 'completed' &&
        part.state?.metadata?.path
      ) {
        result.push({
          path: part.state.metadata.path as string,
          filename: part.state.metadata.filename as string | undefined,
          size: part.state.metadata.size as number | undefined,
          interactive: part.state.metadata.interactive as boolean | undefined,
          sessionID: part.sessionID
        })
      }
    }
  }
  return result
})

function downloadAttachment(att: FilePart) {
  let url = att.url
  if (url.startsWith('file://')) {
    url = `/file/download?path=${encodeURIComponent(url.slice(7))}`
  }
  const a = document.createElement('a')
  a.href = url
  a.download = att.filename || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const openingPreviewIdx = ref<number | null>(null)
async function openPreview(meta: PreviewMeta, idx: number) {
  openingPreviewIdx.value = idx
  try {
    await openPreviewByPath(meta.path, { interactive: meta.interactive, sessionID: meta.sessionID })
  } finally {
    openingPreviewIdx.value = null
  }
}
</script>

<template>
  <div class="agent-group">
    <!-- Steps: all steps from all consecutive messages in one fold -->
    <AgentSteps
      v-if="allSteps.length > 0"
      :steps="allSteps"
      :isStreaming="isStreaming"
    />

    <!-- Text / file outputs: always visible -->
    <template v-for="item in textOutputs" :key="item.type === 'text' ? item.id : (item.part as any).id">
      <div
        v-if="item.type === 'text'"
        class="markdown-content"
        v-html="formatText(item.text)"
      />
      <div v-else-if="item.type === 'file'" class="file-attachment">
        <img
          v-if="isImageFile(item.part)"
          :src="resolveFileUrl((item.part as any).url)"
          :alt="(item.part as any).filename || 'image'"
          class="uploaded-image"
          @click="previewImageUrl = resolveFileUrl((item.part as any).url)"
        />
        <a v-else :href="resolveFileUrl((item.part as any).url)" target="_blank" class="file-badge">
          <span class="file-icon">📄</span>
          <span class="file-name">{{ (item.part as any).filename || 'File' }}</span>
        </a>
      </div>
    </template>

    <!-- Tool file attachments: surfaced from inside collapsed steps -->
    <div v-if="toolAttachments.length > 0" class="tool-attachments-section">
      <div
        v-for="att in toolAttachments"
        :key="att.id"
        class="attachment-item"
      >
        <File :size="16" class="attachment-icon" />
        <span class="attachment-name">{{ att.filename || '未命名文件' }}</span>
        <span v-if="(att as any).size" class="attachment-size">{{ formatSize((att as any).size) }}</span>
        <button class="download-btn" @click="downloadAttachment(att)">
          <FileDown :size="13" /><span>下载</span>
        </button>
      </div>
    </div>

    <!-- Preview file tools: surfaced from inside collapsed steps -->
    <div v-if="previewTools.length > 0" class="preview-tools-section">
      <div
        v-for="(meta, idx) in previewTools"
        :key="meta.path"
        class="preview-item"
      >
        <Eye :size="16" class="preview-icon" />
        <span class="preview-name">{{ meta.filename || '文件预览' }}</span>
        <span v-if="meta.size" class="preview-size">{{ formatSize(meta.size) }}</span>
        <button
          class="preview-btn"
          @click="openPreview(meta, idx)"
          :disabled="openingPreviewIdx === idx"
        >
          <template v-if="openingPreviewIdx === idx">
            <div class="mini-spinner"></div><span>加载中</span>
          </template>
          <template v-else>
            <Eye :size="13" /><span>预览</span>
          </template>
        </button>
      </div>
    </div>
  </div>

  <!-- Image preview -->
  <Teleport to="body">
    <div v-if="previewImageUrl" class="image-preview-overlay" @click="previewImageUrl = null">
      <img :src="previewImageUrl" class="preview-image" @click.stop />
      <button class="preview-close" @click="previewImageUrl = null"><X :size="24" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
.agent-group {
  width: 100%;
}

.markdown-content {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-primary);
  font-weight: var(--font-weight-normal);
  margin-bottom: 4px;
}

.markdown-content :deep(p) { margin-bottom: 1em; }
.markdown-content :deep(p:last-child) { margin-bottom: 0; }
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin-top: 1.5em; margin-bottom: 0.75em;
  font-weight: 600; line-height: 1.3; color: var(--text-primary);
}
.markdown-content :deep(code) {
  background: var(--bg-tertiary); padding: 2px 5px;
  border-radius: var(--radius-sm); font-family: var(--font-mono);
  font-size: 0.9em; color: var(--accent);
}
.markdown-content :deep(pre) {
  background: var(--bg-secondary); padding: 16px;
  border-radius: var(--radius-md); margin: 1em 0;
  overflow-x: auto; border: 0.5px solid var(--border-default);
}
:root[data-theme='dark'] .markdown-content :deep(pre) { background: #1a1a1e; }
.markdown-content :deep(pre code) {
  background: transparent; padding: 0; color: inherit;
  font-size: 13px; border: none;
}
.markdown-content :deep(ul),
.markdown-content :deep(ol) { margin-bottom: 1em; padding-left: 1.5em; }
.markdown-content :deep(li) { margin-bottom: 0.25em; }
.markdown-content :deep(a) {
  color: var(--accent); text-decoration: underline;
  text-decoration-color: rgba(204, 77, 40, 0.3);
  text-underline-offset: 2px;
}
.markdown-content :deep(a:hover) { text-decoration-color: var(--accent); }
.markdown-content :deep(blockquote) {
  border-left: 2px solid var(--accent); margin: 1em 0;
  padding-left: 1em; font-style: italic; color: var(--text-muted);
}

.file-attachment { margin: 8px 0; }

.uploaded-image {
  max-width: 100%; max-height: 300px;
  border-radius: var(--radius-md); cursor: pointer;
  transition: transform var(--transition-fast);
  border: 0.5px solid var(--border-subtle);
}
.uploaded-image:hover { transform: scale(1.01); }

.file-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-secondary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md); font-size: 13px;
  text-decoration: none; color: inherit; cursor: pointer;
  transition: background var(--transition-fast);
}
.file-badge:hover { background: var(--bg-elevated); }
.file-icon { font-size: 18px; }
.file-name {
  color: var(--text-primary); max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Tool file attachments surfaced from steps */
.tool-attachments-section,
.preview-tools-section {
  margin-top: 10px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.attachment-item,
.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.attachment-item:not(:last-child),
.preview-item:not(:last-child) {
  border-bottom: 0.5px solid var(--border-subtle);
}

.attachment-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.preview-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.attachment-name,
.preview-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size,
.preview-size {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.download-btn,
.preview-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.download-btn:hover,
.preview-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.download-btn:active,
.preview-btn:active:not(:disabled) {
  transform: translateY(0);
}

.preview-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.mini-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

<style>
/* Non-scoped for Teleport */
.image-preview-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.9);
  display: flex; align-items: center; justify-content: center;
  z-index: 1001; cursor: pointer;
}
.preview-image {
  max-width: 90vw; max-height: 90vh;
  object-fit: contain; border-radius: 8px; cursor: default;
}
.preview-close {
  position: absolute; top: 20px; right: 20px;
  width: 40px; height: 40px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(255,255,255,0.1); border: none;
  border-radius: 50%; color: white; cursor: pointer;
}
.preview-close:hover { background: rgba(255,255,255,0.2); }
</style>
