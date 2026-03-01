/**
 * useCentralControl.ts
 *
 * 集控连接状态的全局组合式函数（单例模式）。
 *
 * 在首次调用时自动注册 IPC 监听，后续所有调用返回同一份响应式状态。
 * 提供计算属性用于驱动 UI 的颜色、图标和文本显示。
 */

import { ref, computed, type Ref, type ComputedRef } from 'vue'

/** 连接状态字面量类型 */
export type CentralControlStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED'

export interface CentralControlState {
  /** 当前连接状态 */
  status: Ref<CentralControlStatus>
  /** 按钮/标签展示文本 */
  statusLabel: ComputedRef<string>
  /** 按钮主题色（匹配 HomeButtonMeta.theme） */
  statusTheme: ComputedRef<'default' | 'primary' | 'success' | 'warning' | 'danger'>
  /** 按钮图标名称 */
  statusIcon: ComputedRef<string>
}

// ---------- 单例状态 ----------

let initialized = false
const status = ref<CentralControlStatus>('DISCONNECTED')

/**
 * 全局单例的集控状态组合式函数。
 *
 * 使用示例：
 * ```ts
 * const { status, statusLabel, statusTheme } = useCentralControl()
 * ```
 */
export function useCentralControl(): CentralControlState {
  // 仅首次调用时注册 IPC 监听
  if (!initialized) {
    initialized = true
    try {
      window.api?.centralControl?.onStatusChanged?.((newStatus: string) => {
        if (
          newStatus === 'CONNECTING' ||
          newStatus === 'CONNECTED' ||
          newStatus === 'DISCONNECTED'
        ) {
          status.value = newStatus as CentralControlStatus
        }
      })
    } catch (error) {
      console.warn('[useCentralControl] 注册 IPC 监听失败', error)
    }
  }

  const statusLabel = computed(() => {
    switch (status.value) {
      case 'CONNECTED':
        return '集控 (在线)'
      case 'CONNECTING':
        return '集控 (连接中)'
      case 'DISCONNECTED':
      default:
        return '集控 (离线)'
    }
  })

  const statusTheme = computed<'default' | 'primary' | 'success' | 'warning' | 'danger'>(() => {
    switch (status.value) {
      case 'CONNECTED':
        return 'success'
      case 'CONNECTING':
        return 'warning'
      case 'DISCONNECTED':
      default:
        return 'default'
    }
  })

  const statusIcon = computed(() => 'server')

  return {
    status,
    statusLabel,
    statusTheme,
    statusIcon
  }
}
