<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, ChevronDown, Check } from 'lucide-vue-next'
import type { MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'

interface Step {
  parts: MessagePart[]
  isComplete: boolean
}

const props = defineProps<{
  steps: Step[]
  isStreaming: boolean
}>()

const isExpanded = ref(false)
const reasoningExpanded = ref<Record<string, boolean>>({})

const allComplete = computed(() => props.steps.length > 0 && props.steps.every(s => s.isComplete))

const allParts = computed(() => props.steps.flatMap(s => s.parts))

const lastRunningTool = computed(() => {
  const allTools = allParts.value.filter(p => p.type === 'tool')
  const running = allTools.filter(p => p.state?.status === 'running')
  if (running.length > 0) return running[running.length - 1]
  return allTools[allTools.length - 1] ?? null
})

const stepSummary = computed(() => {
  const lastTool = lastRunningTool.value
  if (!lastTool) {
    const count = allParts.value.filter(p => p.type === 'tool').length
    return count > 0 ? `${count} 个操作` : `${props.steps.length} 个步骤`
  }
  const name = getToolDisplayName(lastTool)
  const target = getToolTarget(lastTool)
  if (target) return `${name} · ${target}`
  return name
})

function getToolDisplayName(part: MessagePart): string {
  const title = part.state?.title
  if (title) return title
  const names: Record<string, string> = {
    read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash',
    grep: 'Grep', glob: 'Glob', list: 'List', webfetch: 'Fetch',
    task: 'Task', todowrite: 'Todo', todoread: 'Todo'
  }
  const toolName = (part.tool || '').toLowerCase()
  return names[toolName] || part.tool || 'Tool'
}

function getToolTarget(part: MessagePart): string {
  const input = part.state?.input
  if (!input) return ''
  if (input.filePath || input.file_path) {
    const p = (input.filePath || input.file_path) as string
    return p.length > 45 ? '...' + p.slice(-42) : p
  }
  if (input.path) {
    const p = input.path as string
    return p.length > 45 ? '...' + p.slice(-42) : p
  }
  if (input.command) {
    const cmd = input.command as string
    return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd
  }
  if (input.pattern) return `"${input.pattern}"`
  if (input.url) return input.url as string
  if (input.query) return input.query as string
  return ''
}

function toggleReasoning(partId: string) {
  reasoningExpanded.value[partId] = !reasoningExpanded.value[partId]
}

function needsExpandButton(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 200
}
</script>

<template>
  <!-- State A: Running — show only the last active tool -->
  <div v-if="!allComplete && !isExpanded" class="steps-running">
    <ToolCall v-if="lastRunningTool" :tool="lastRunningTool" :hideAttachments="true" />
  </div>

  <!-- State B: Complete + Collapsed -->
  <div v-else-if="allComplete && !isExpanded" class="steps-row" @click="isExpanded = true">
    <div class="steps-icon">
      <Check :size="10" />
    </div>
    <span class="steps-summary">{{ stepSummary }}</span>
    <ChevronRight :size="12" class="steps-chevron" />
  </div>

  <!-- State C: Expanded -->
  <div v-else class="steps-expanded">
    <div class="steps-header" @click="isExpanded = false">
      <ChevronDown :size="12" class="steps-chevron" />
      <span class="steps-summary">{{ stepSummary }}</span>
    </div>
    <div class="steps-body">
      <template v-for="(step, stepIndex) in steps" :key="stepIndex">
        <div v-if="stepIndex > 0" class="step-divider" />
        <template v-for="part in step.parts" :key="part.id">
          <!-- Reasoning block -->
          <div v-if="part.type === 'reasoning'" class="reasoning-block">
            <div v-if="part.text">
              <div
                class="reasoning-text"
                :class="{ clamped: !reasoningExpanded[part.id] }"
              >{{ part.text }}</div>
              <button
                v-if="needsExpandButton(part.text)"
                class="reasoning-toggle"
                @click.stop="toggleReasoning(part.id)"
              >
                {{ reasoningExpanded[part.id] ? '收起' : '展开' }}
              </button>
            </div>
            <div v-else class="loading-wave">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </div>
          <!-- Tool call -->
          <ToolCall v-else-if="part.type === 'tool'" :tool="part" :hideAttachments="true" />
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.steps-running {
  margin: 2px 0 4px;
}

/* ── Collapsed complete row ── */
.steps-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  margin: 2px 0 6px;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.steps-row:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.steps-icon {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--success, #16a34a) 15%, transparent);
  color: var(--success, #16a34a);
}

:root[data-theme='dark'] .steps-icon {
  background: color-mix(in srgb, #22c55e 15%, transparent);
  color: #22c55e;
}

.steps-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.steps-row:hover .steps-summary {
  color: var(--text-secondary);
}

.steps-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
}

/* ── Expanded ── */
.steps-expanded {
  margin: 2px 0 8px;
}

.steps-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  margin-bottom: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.steps-header:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.steps-header .steps-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.steps-body {
  padding-left: 14px;
  border-left: 1.5px solid var(--border-subtle);
  margin-left: 6px;
}

.step-divider {
  height: 0.5px;
  background: var(--border-subtle);
  margin: 8px 0;
}

/* ── Reasoning ── */
.reasoning-block {
  margin: 4px 0 6px;
}

.reasoning-text {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
}

.reasoning-text.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.reasoning-toggle {
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  margin-top: 2px;
  font-family: inherit;
  line-height: 1.8;
}
.reasoning-toggle:hover {
  text-decoration: underline;
}

/* ── Loading dots ── */
.loading-wave span {
  animation: wave 1.2s infinite ease-in-out;
  display: inline-block;
  margin: 0 1px;
  font-size: 18px;
  line-height: 10px;
  color: var(--text-muted);
}
.loading-wave span:nth-child(2) { animation-delay: 0.1s; }
.loading-wave span:nth-child(3) { animation-delay: 0.2s; }

@keyframes wave {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-4px); opacity: 1; }
}
</style>
