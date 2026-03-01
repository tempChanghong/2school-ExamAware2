import { watch, type WatchStopHandle } from 'vue'
import type { App } from 'vue'
import type { AppModule } from '../types'
import { DisposerGroup } from '@renderer/runtime/disposable'
import { useCentralControl } from '@renderer/composables/useCentralControl'

export interface HomeButtonMeta {
  id: string
  label: string
  icon: string
  theme?: 'default' | 'primary' | 'success' | 'warning' | 'danger'
  order?: number
  action: () => void | Promise<void>
}

export class HomeButtonsRegistry {
  private buttons = new Map<string, HomeButtonMeta>()
  private listeners = new Set<() => void>()

  register(meta: HomeButtonMeta) {
    this.buttons.set(meta.id, { order: 0, theme: 'default', ...meta })
    this.notify()
    // return disposer to unregister
    return () => {
      if (this.buttons.has(meta.id)) {
        this.buttons.delete(meta.id)
        this.notify()
      }
    }
  }

  unregister(id: string) {
    this.buttons.delete(id)
    this.notify()
  }

  get(id: string): HomeButtonMeta | undefined {
    return this.buttons.get(id)
  }

  list(): HomeButtonMeta[] {
    return Array.from(this.buttons.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    this.listeners.forEach((l) => {
      try {
        l()
      } catch {}
    })
  }
}

export const homeButtonsModule: AppModule = {
  name: 'home-buttons',
  install(app: App, ctx) {
    const registry = new HomeButtonsRegistry()
    const group = new DisposerGroup()

    // 注册默认按钮
    const add = (meta: HomeButtonMeta) => group.add(registry.register(meta))

    ctx.addHomeButton = async (meta: HomeButtonMeta) => {
      if (ctx.disposable) await ctx.disposable(() => registry.register(meta))
      else add(meta)
    }

    add({
      id: 'editor',
      label: '编辑器',
      icon: 'edit',
      theme: 'success',
      order: 1,
      action: () => {
        window.api.ipc.send('open-editor-window')
      }
    })

    add({
      id: 'player',
      label: '放映器',
      icon: 'play-circle',
      theme: 'warning',
      order: 2,
      action: async () => {
        const router = (app.config.globalProperties as any).$router
        if (router) {
          await router.push('/playerhome')
        }
      }
    })

    add({
      id: 'url-player',
      label: '从 URL 放映',
      icon: 'link',
      theme: 'default',
      order: 3,
      action: () => {
        // TODO: 实现 URL 放映功能
        console.log('URL 放映功能待实现')
      }
    })

    // ===== 集控按钮：响应式更新 =====
    // 使用 watch 监听连接状态变化，通过「注销 → 重新注册」策略实现按钮 UI 的实时刷新。
    // order 固定为 4，防止重注册时发生位置跳动。
    const { status, statusLabel, statusTheme, statusIcon } = useCentralControl()

    const registerControlButton = () => {
      registry.unregister('control')
      registry.register({
        id: 'control',
        label: statusLabel.value,
        icon: statusIcon.value,
        theme: statusTheme.value,
        order: 4,
        action: () => {
          window.api?.ipc?.send('open-settings-window', 'central-control')
        }
      })
    }

    // 首次注册
    registerControlButton()

    // 状态变化时自动重新注册
    const stopWatch: WatchStopHandle = watch(status, () => {
      registerControlButton()
    })

    // 将 watch 清理函数加入 disposer group
    group.add(stopWatch)

    // ===== 其他默认按钮 =====

    add({
      id: 'settings',
      label: '设置',
      icon: 'setting',
      theme: 'default',
      order: 5,
      action: async () => {
        // 作为独立窗口（单例）弹出
        window.api?.ipc?.send('open-settings-window')
      }
    })

    add({
      id: 'help',
      label: '帮助',
      icon: 'help-circle',
      theme: 'default',
      order: 6,
      action: () => {
        console.log('帮助功能待实现')
      }
    })

    add({
      id: 'about',
      label: '关于',
      icon: 'info-circle',
      theme: 'default',
      order: 7,
      action: () => {
        window.api?.ipc?.send('open-settings-window', 'about')
      }
    })

    // 添加更多示例按钮以测试滚动功能
    add({
      id: 'logs',
      label: '日志',
      icon: 'file-code',
      theme: 'default',
      order: 8,
      action: () => {
        // 打开/聚焦独立的日志窗口（单例）
        window.api?.ipc?.send('open-logs-window')
      }
    })
    ;(app.config.globalProperties as any).$homeButtons = registry
    ctx.provides.homeButtons = registry
    if (ctx.provide) ctx.provide('homeButtons', registry)
    ctx.provides.homeButtonsGroup = group
  },
  uninstall(app: App, ctx) {
    // Remove provided instance
    if ((app.config.globalProperties as any).$homeButtons) {
      delete (app.config.globalProperties as any).$homeButtons
    }
    const group = ctx.provides.homeButtonsGroup as DisposerGroup | undefined
    if (group) group.disposeAll()
  }
}
