/**
 * centralControlClient.ts
 *
 * 被控端集控服务 (Central Control Client)
 *
 * 功能概述：
 *   1. 通过 WebSocket 主动连接公网集控服务器，维持长连接
 *   2. 指数退避自动重连 —— 避免网络抖动时疯狂重连耗尽资源
 *   3. 心跳保活 —— 定期发送 HEARTBEAT，超时未响应则判定掉线
 *   4. 指令分发引擎 —— 按 action 路由处理 PUSH_EXAM_CONFIG / SYNC_TIME / UPDATE_SETTINGS
 *   5. 状态广播 —— 连接状态变化时通过 IPC 通知所有渲染进程窗口
 */

import { app, BrowserWindow } from 'electron'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { getConfig, patchConfig, onConfigChanged } from './configStore'
import { applyTimeConfig, saveTimeSyncConfig } from './ntpService/timeService'
import { setSharedConfig } from './state/sharedConfigStore'
import { createPlayerWindow } from './windows/playerWindow'
import { appLogger } from './logging/winstonLogger'

// ============================================================================
// 类型定义 —— WebSocket 消息载荷契约
// ============================================================================

/** 集控配置（存储在 configStore 中的 centralControl 字段下） */
export interface CentralControlConfig {
  /** 是否启用集控服务 */
  enabled: boolean
  /** 集控服务器 WSS 地址，例如 wss://cc.example.com/ws */
  serverUrl: string
  /** 可选：客户端标识名称（教室名/机器名），用于在集控面板中辨识 */
  clientName?: string
}

/** 连接状态枚举 */
export enum ConnectionStatus {
  /** 正在连接 */
  CONNECTING = 'CONNECTING',
  /** 已连接 */
  CONNECTED = 'CONNECTED',
  /** 已断开 */
  DISCONNECTED = 'DISCONNECTED'
}

// ---------- 客户端 → 服务器消息 ----------

/** 客户端注册消息 —— 连接成功后发送，向服务器报告设备元信息 */
export interface RegisterMessage {
  action: 'REGISTER'
  payload: {
    clientId: string
    clientName: string
    appVersion: string
    platform: NodeJS.Platform
    timestamp: number
  }
}

/** 心跳消息 */
export interface HeartbeatMessage {
  action: 'HEARTBEAT'
  payload: {
    timestamp: number
  }
}

// ---------- 服务器 → 客户端消息 ----------

/** 下发考试配置 */
export interface PushExamConfigCommand {
  action: 'PUSH_EXAM_CONFIG'
  payload: {
    /** 配置数据：纯文本 JSON 或 Base64 编码字符串 */
    data: string
    /** 编码方式：plain 为纯文本，base64 为 Base64 */
    encoding?: 'plain' | 'base64'
    /** 可选：文件名前缀 */
    filename?: string
    /** 是否自动打开放映窗口（默认 true）。设为 false 时仅预下发配置，不立即放映 */
    autoPlay?: boolean
  }
}

/** 时间同步指令 */
export interface SyncTimeCommand {
  action: 'SYNC_TIME'
  payload: {
    /** 目标时间戳（毫秒） */
    targetTimestamp?: number
    /** 手动偏移量（秒），与 timeService 的 manualOffsetSeconds 对应 */
    offsetSeconds?: number
  }
}

/** 修改应用设置 */
export interface UpdateSettingsCommand {
  action: 'UPDATE_SETTINGS'
  payload: {
    /** 要合并的配置对象，会直接传递给 patchConfig */
    settings: Record<string, any>
  }
}

/** 服务器通用响应 / 应答 */
export interface ServerAckMessage {
  action: 'ACK' | 'PONG'
  payload?: Record<string, any>
}

/** 所有可能的服务器下行消息联合类型 */
export type ServerMessage =
  | PushExamConfigCommand
  | SyncTimeCommand
  | UpdateSettingsCommand
  | ServerAckMessage
  | { action: string; payload?: any }

/** 所有可能的客户端上行消息联合类型 */
export type ClientMessage = RegisterMessage | HeartbeatMessage

// ============================================================================
// 常量
// ============================================================================

const LOG_TAG = '[CentralControl]'

/** 心跳发送间隔：10 秒 */
const HEARTBEAT_INTERVAL_MS = 10_000

/** 心跳超时：30 秒内未收到 Pong 则判定掉线 */
const HEARTBEAT_TIMEOUT_MS = 30_000

/** 重连初始延迟（毫秒） */
const RECONNECT_BASE_DELAY_MS = 1_000

/** 重连最大延迟（毫秒） */
const RECONNECT_MAX_DELAY_MS = 60_000

/** IPC 频道名：连接状态变化 */
const IPC_STATUS_CHANNEL = 'central-control:status-changed'

// ============================================================================
// CentralControlClient 类
// ============================================================================

export class CentralControlClient {
  /** 当前 WebSocket 实例 */
  private ws: WebSocket | null = null

  /** 当前连接状态 */
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED

  /** 心跳发送定时器 */
  private heartbeatTimer: NodeJS.Timeout | null = null

  /** 心跳超时定时器 —— 用于侦测服务器无响应 */
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null

  /** 重连定时器 */
  private reconnectTimer: NodeJS.Timeout | null = null

  /** 当前重连次数（用于计算指数退避延迟） */
  private reconnectAttempts = 0

  /** 是否已被 dispose（优雅退出后不再重连） */
  private disposed = false

  /** configStore 变化监听取消函数 */
  private unsubscribeConfig: (() => void) | null = null

  /** 当前生效的集控配置快照 */
  private currentConfig: CentralControlConfig = {
    enabled: false,
    serverUrl: ''
  }

  // --------------------------------------------------------------------------
  // 公共 API
  // --------------------------------------------------------------------------

  /**
   * 启动集控客户端服务。
   * 从 configStore 读取配置，如果 enabled 则发起连接，并监听后续配置变更。
   */
  start(): void {
    if (this.disposed) return

    appLogger.info(`${LOG_TAG} 服务启动`)

    // 读取初始配置
    this.loadConfig()

    // 监听配置变更，实现热切换
    this.unsubscribeConfig = onConfigChanged((cfg) => {
      try {
        const newCfg = (cfg?.centralControl ?? {}) as Partial<CentralControlConfig>
        const merged: CentralControlConfig = {
          enabled: newCfg.enabled ?? false,
          serverUrl: newCfg.serverUrl ?? '',
          clientName: newCfg.clientName
        }

        // 判断是否需要重启连接
        const needsRestart =
          merged.enabled !== this.currentConfig.enabled ||
          merged.serverUrl !== this.currentConfig.serverUrl

        this.currentConfig = merged

        if (needsRestart) {
          appLogger.info(`${LOG_TAG} 检测到集控配置变更，重新连接`)
          this.disconnect()
          if (merged.enabled && merged.serverUrl) {
            this.connect()
          }
        }
      } catch (error) {
        appLogger.error(`${LOG_TAG} 处理配置变更失败`, error as Error)
      }
    })

    // 如果配置已启用，则立即发起连接
    if (this.currentConfig.enabled && this.currentConfig.serverUrl) {
      this.connect()
    } else {
      appLogger.info(`${LOG_TAG} 集控服务未启用或未配置服务器地址，处于待命状态`)
    }
  }

  /**
   * 获取当前连接状态
   */
  getStatus(): ConnectionStatus {
    return this.status
  }

  /**
   * 优雅销毁。断开连接、清理所有定时器、移除监听。
   * 调用后不会再自动重连。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    appLogger.info(`${LOG_TAG} 服务销毁`)

    // 取消配置监听
    this.unsubscribeConfig?.()
    this.unsubscribeConfig = null

    // 断开连接（不触发重连）
    this.disconnect()
  }

  // --------------------------------------------------------------------------
  // 内部：配置读取
  // --------------------------------------------------------------------------

  private loadConfig(): void {
    try {
      const raw = getConfig('centralControl') ?? {}
      this.currentConfig = {
        enabled: raw.enabled ?? false,
        serverUrl: raw.serverUrl ?? '',
        clientName: raw.clientName
      }
    } catch (error) {
      appLogger.error(`${LOG_TAG} 读取集控配置失败`, error as Error)
      this.currentConfig = { enabled: false, serverUrl: '' }
    }
  }

  // --------------------------------------------------------------------------
  // 内部：WebSocket 连接管理
  // --------------------------------------------------------------------------

  /**
   * 发起 WebSocket 连接。
   * 状态流转：DISCONNECTED → CONNECTING → CONNECTED（或失败后回到 DISCONNECTED 并调度重连）
   */
  private connect(): void {
    if (this.disposed) return
    if (this.ws) {
      // 防止重复连接
      this.disconnect()
    }

    const url = this.currentConfig.serverUrl
    if (!url) {
      appLogger.warn(`${LOG_TAG} 服务器地址为空，无法连接`)
      return
    }

    this.setStatus(ConnectionStatus.CONNECTING)
    appLogger.info(`${LOG_TAG} 正在连接: ${url} (第 ${this.reconnectAttempts + 1} 次尝试)`)

    try {
      this.ws = new WebSocket(url, {
        // 10 秒连接超时
        handshakeTimeout: 10_000
      })

      // ----- 连接成功 -----
      this.ws.on('open', () => {
        appLogger.info(`${LOG_TAG} 连接成功`)
        this.reconnectAttempts = 0 // 重置退避计数
        this.setStatus(ConnectionStatus.CONNECTED)
        this.sendRegister()
        this.startHeartbeat()
      })

      // ----- 收到消息 -----
      this.ws.on('message', (rawData) => {
        try {
          const text = rawData.toString('utf-8')
          this.handleMessage(text)
        } catch (error) {
          appLogger.error(`${LOG_TAG} 消息解码失败`, error as Error)
        }
      })

      // ----- 收到 Pong（WebSocket 协议层心跳响应） -----
      this.ws.on('pong', () => {
        this.resetHeartbeatTimeout()
      })

      // ----- 连接关闭 -----
      this.ws.on('close', (code, reason) => {
        appLogger.warn(`${LOG_TAG} 连接关闭: code=${code}, reason=${reason?.toString() ?? 'N/A'}`)
        this.cleanup()
        this.setStatus(ConnectionStatus.DISCONNECTED)
        this.scheduleReconnect()
      })

      // ----- 连接错误 -----
      this.ws.on('error', (error) => {
        appLogger.error(`${LOG_TAG} 连接错误`, error as Error)
        // error 事件之后通常会紧跟 close 事件，所以这里不重复调度重连
      })
    } catch (error) {
      appLogger.error(`${LOG_TAG} 创建 WebSocket 实例失败`, error as Error)
      this.cleanup()
      this.setStatus(ConnectionStatus.DISCONNECTED)
      this.scheduleReconnect()
    }
  }

  /**
   * 主动断开连接，清理所有定时器。
   * 如果 disposed = false 则后续可能由 scheduleReconnect 重新连接。
   */
  private disconnect(): void {
    this.clearReconnectTimer()
    this.cleanup()
    this.setStatus(ConnectionStatus.DISCONNECTED)
  }

  /**
   * 清理 WebSocket 实例和心跳定时器（不改变状态）。
   */
  private cleanup(): void {
    this.stopHeartbeat()

    if (this.ws) {
      try {
        // 移除所有事件监听，防止 close 事件触发重连
        this.ws.removeAllListeners()
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client cleanup')
        }
        this.ws.terminate()
      } catch {
        // 忽略清理时的错误
      }
      this.ws = null
    }
  }

  // --------------------------------------------------------------------------
  // 内部：自动重连（指数退避）
  // --------------------------------------------------------------------------

  /**
   * 调度一次重连。延迟 = min(BASE * 2^attempts, MAX)
   *
   * 指数退避策略说明：
   *   第 1 次：1s
   *   第 2 次：2s
   *   第 3 次：4s
   *   第 4 次：8s
   *   ...
   *   上限：60s
   */
  private scheduleReconnect(): void {
    if (this.disposed) return
    if (!this.currentConfig.enabled || !this.currentConfig.serverUrl) return

    this.clearReconnectTimer()

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    )

    appLogger.info(
      `${LOG_TAG} 将在 ${(delay / 1000).toFixed(1)}s 后重连 (第 ${this.reconnectAttempts + 1} 次)`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // --------------------------------------------------------------------------
  // 内部：心跳保活
  // --------------------------------------------------------------------------

  /**
   * 启动心跳机制。
   *
   * 双重心跳策略：
   *   1. 应用层：每 10s 发送 HEARTBEAT JSON 消息
   *   2. 协议层：同时发送 WebSocket Ping 帧，监听 Pong 响应
   *
   * 如果 30s 内没有收到任何 Pong，则判定服务器无响应，主动断开并触发重连。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    // 发送心跳
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          // 应用层心跳
          this.sendMessage({
            action: 'HEARTBEAT',
            payload: { timestamp: Date.now() }
          })

          // 协议层 Ping
          this.ws.ping()
        } catch (error) {
          appLogger.warn(`${LOG_TAG} 发送心跳失败`, error as Error)
        }
      }
    }, HEARTBEAT_INTERVAL_MS)

    // 启动首次超时计时
    this.resetHeartbeatTimeout()
  }

  /**
   * 重置心跳超时计时器。
   * 每当收到 Pong 或 ACK 时调用，重置 30s 倒计时。
   */
  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      appLogger.warn(`${LOG_TAG} 心跳超时 (${HEARTBEAT_TIMEOUT_MS / 1000}s 无响应)，判定掉线`)
      this.cleanup()
      this.setStatus(ConnectionStatus.DISCONNECTED)
      this.scheduleReconnect()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /** 停止所有心跳定时器 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
  }

  // --------------------------------------------------------------------------
  // 内部：消息发送
  // --------------------------------------------------------------------------

  /** 发送结构化 JSON 消息到服务器 */
  private sendMessage(msg: ClientMessage | Record<string, any>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (error) {
      appLogger.error(`${LOG_TAG} 发送消息失败`, error as Error)
    }
  }

  /** 连接成功后向服务器发送注册信息 */
  private sendRegister(): void {
    const msg: RegisterMessage = {
      action: 'REGISTER',
      payload: {
        clientId: this.getClientId(),
        clientName: this.currentConfig.clientName || this.getClientId(),
        appVersion: this.getAppVersion(),
        platform: process.platform,
        timestamp: Date.now()
      }
    }
    this.sendMessage(msg)
    appLogger.info(`${LOG_TAG} 已发送注册信息: clientId=${msg.payload.clientId}`)
  }

  // --------------------------------------------------------------------------
  // 内部：消息接收 & 指令分发
  // --------------------------------------------------------------------------

  /**
   * 处理从服务器接收到的消息。
   * 包含严密的 try-catch 错误拦截，任何指令的解析/执行失败都不会导致主进程崩溃。
   */
  private handleMessage(rawText: string): void {
    let parsed: ServerMessage

    // 第一层防护：JSON 解析
    try {
      parsed = JSON.parse(rawText)
    } catch (error) {
      appLogger.warn(`${LOG_TAG} 收到非 JSON 消息，已忽略: ${rawText.slice(0, 200)}`)
      return
    }

    const action = parsed?.action
    if (!action || typeof action !== 'string') {
      appLogger.warn(`${LOG_TAG} 收到缺少 action 的消息，已忽略`)
      return
    }

    appLogger.debug(`${LOG_TAG} 收到指令: ${action}`)

    // 第二层防护：按 action 路由分发，每个 handler 独立 try-catch
    switch (action) {
      case 'PUSH_EXAM_CONFIG':
        this.handlePushExamConfig(parsed as PushExamConfigCommand)
        break

      case 'SYNC_TIME':
        this.handleSyncTime(parsed as SyncTimeCommand)
        break

      case 'UPDATE_SETTINGS':
        this.handleUpdateSettings(parsed as UpdateSettingsCommand)
        break

      case 'ACK':
      case 'PONG':
        // 服务器应答，重置心跳超时
        this.resetHeartbeatTimeout()
        break

      default:
        appLogger.debug(`${LOG_TAG} 收到未知指令: ${action}，已忽略`)
    }
  }

  // --------------------------------------------------------------------------
  // 指令处理器
  // --------------------------------------------------------------------------

  /**
   * 处理 PUSH_EXAM_CONFIG 指令：
   *   1. 根据 encoding 解码数据（Base64 或原文）
   *   2. 写入系统临时目录的 .ea2 文件
   *   3. 调用 setSharedConfig() 更新内存中的共享配置
   *   4. 通过 IPC 广播通知渲染进程刷新界面
   */
  private handlePushExamConfig(msg: PushExamConfigCommand): void {
    try {
      const { data, encoding = 'plain', filename, autoPlay = true } = msg.payload ?? {}

      if (!data) {
        appLogger.warn(`${LOG_TAG} PUSH_EXAM_CONFIG: payload.data 为空，已忽略`)
        return
      }

      // 解码
      let configContent: string
      if (encoding === 'base64') {
        configContent = Buffer.from(data, 'base64').toString('utf-8')
      } else {
        configContent = data
      }

      // 写入临时文件，然后根据 autoPlay 决定是否自动打开放映窗口
      const tempDir = path.join(app.getPath('temp'), 'examaware-central-control')
      const prefix = filename || 'central-push'
      const tempFile = path.join(
        tempDir,
        `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.ea2`
      )

      fs.promises
        .mkdir(tempDir, { recursive: true })
        .then(() => fs.promises.writeFile(tempFile, configContent, 'utf-8'))
        .then(() => {
          appLogger.info(`${LOG_TAG} PUSH_EXAM_CONFIG: 配置已写入临时文件: ${tempFile}`)

          // 自动打开放映窗口 —— 与从编辑器打开 Player 的逻辑一致
          // createPlayerWindow 内部会读取文件、setSharedConfig、并推送给渲染进程
          if (autoPlay) {
            appLogger.info(`${LOG_TAG} PUSH_EXAM_CONFIG: 自动打开放映窗口`)
            createPlayerWindow(tempFile)
          }
        })
        .catch((err) => {
          appLogger.warn(`${LOG_TAG} PUSH_EXAM_CONFIG: 写入临时文件失败`, err as Error)
        })

      // 更新内存中的共享配置（供其他窗口通过 IPC 获取）
      setSharedConfig(configContent)

      // 广播通知渲染进程（主窗口等）刷新配置列表
      this.broadcastToWindows('central-control:exam-config-pushed', {
        tempFile,
        autoPlay,
        timestamp: Date.now()
      })

      appLogger.info(`${LOG_TAG} PUSH_EXAM_CONFIG: 考试配置已下发 (autoPlay=${autoPlay})`)
    } catch (error) {
      appLogger.error(`${LOG_TAG} PUSH_EXAM_CONFIG 处理失败`, error as Error)
    }
  }

  /**
   * 处理 SYNC_TIME 指令：
   *   - 如果提供了 offsetSeconds，调用 saveTimeSyncConfig 设置手动偏移量
   *   - 如果提供了 targetTimestamp，计算偏移后调用 applyTimeConfig
   */
  private handleSyncTime(msg: SyncTimeCommand): void {
    try {
      const { targetTimestamp, offsetSeconds } = msg.payload ?? {}

      if (offsetSeconds !== undefined) {
        // 直接设置手动偏移量
        saveTimeSyncConfig({ manualOffsetSeconds: offsetSeconds })
        appLogger.info(`${LOG_TAG} SYNC_TIME: 已应用手动偏移量 ${offsetSeconds}s`)
      } else if (targetTimestamp !== undefined) {
        // 根据目标时间戳计算偏移量
        const currentMs = Date.now()
        const calcOffsetSeconds = (targetTimestamp - currentMs) / 1000
        applyTimeConfig({ manualOffsetSeconds: calcOffsetSeconds })
        appLogger.info(
          `${LOG_TAG} SYNC_TIME: 根据目标时间戳计算偏移量 ${calcOffsetSeconds.toFixed(2)}s`
        )
      } else {
        appLogger.warn(`${LOG_TAG} SYNC_TIME: payload 中无有效的时间参数，已忽略`)
      }
    } catch (error) {
      appLogger.error(`${LOG_TAG} SYNC_TIME 处理失败`, error as Error)
    }
  }

  /**
   * 处理 UPDATE_SETTINGS 指令：
   *   - 将 payload.settings 合并到 configStore 中并持久化
   */
  private handleUpdateSettings(msg: UpdateSettingsCommand): void {
    try {
      const { settings } = msg.payload ?? {}

      if (!settings || typeof settings !== 'object') {
        appLogger.warn(`${LOG_TAG} UPDATE_SETTINGS: payload.settings 无效，已忽略`)
        return
      }

      patchConfig(settings)
      appLogger.info(`${LOG_TAG} UPDATE_SETTINGS: 已合并 ${Object.keys(settings).length} 个配置项`)
    } catch (error) {
      appLogger.error(`${LOG_TAG} UPDATE_SETTINGS 处理失败`, error as Error)
    }
  }

  // --------------------------------------------------------------------------
  // 内部：状态管理与广播
  // --------------------------------------------------------------------------

  /**
   * 更新连接状态并广播给所有渲染进程窗口。
   * 渲染进程可在 preload 中通过 ipcRenderer.on('central-control:status-changed', ...) 监听。
   */
  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status === newStatus) return

    const oldStatus = this.status
    this.status = newStatus

    appLogger.info(`${LOG_TAG} 状态变更: ${oldStatus} → ${newStatus}`)

    // 广播到所有渲染进程窗口
    this.broadcastToWindows(IPC_STATUS_CHANNEL, newStatus)
  }

  /**
   * 向所有打开的 BrowserWindow 广播 IPC 消息。
   * 使用与 configStore.broadcastChanged() 相同的安全模式。
   */
  private broadcastToWindows(channel: string, data: any): void {
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        try {
          if (!win.isDestroyed()) {
            win.webContents.send(channel, data)
          }
        } catch {
          // 忽略单个窗口的发送失败
        }
      })
    } catch {
      // 忽略广播时的全局错误
    }
  }

  // --------------------------------------------------------------------------
  // 内部：工具方法
  // --------------------------------------------------------------------------

  /** 获取客户端唯一标识（使用 userData 路径的 hash 作为稳定 ID） */
  private getClientId(): string {
    try {
      // 使用 userData 路径生成一个简单但稳定的标识
      const userData = app.getPath('userData')
      let hash = 0
      for (let i = 0; i < userData.length; i++) {
        const char = userData.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash |= 0 // 转为 32 位整数
      }
      return `ea2-${Math.abs(hash).toString(16).padStart(8, '0')}`
    } catch {
      return `ea2-${Date.now().toString(16)}`
    }
  }

  /** 安全获取应用版本号 */
  private getAppVersion(): string {
    try {
      return app.getVersion()
    } catch {
      return 'unknown'
    }
  }
}
