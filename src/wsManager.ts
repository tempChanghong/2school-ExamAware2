/**
 * wsManager.ts
 *
 * WebSocket 服务端 —— 管理终端设备的长连接、心跳保活、指令下发
 *
 * 通信协议严格对齐客户端 `centralControlClient.ts` 定义的消息格式：
 *   - 客户端上行：REGISTER / HEARTBEAT
 *   - 服务端下行：ACK / PONG / PUSH_EXAM_CONFIG / SYNC_TIME / UPDATE_SETTINGS
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { upsertDevice, updateHeartbeat, setDeviceOffline } from './db.js'

// ============================================================================
// 类型定义
// ============================================================================

/** 客户端注册消息 */
interface RegisterMessage {
  action: 'REGISTER'
  payload: {
    clientId: string
    clientName: string
    appVersion: string
    platform: string
    timestamp: number
  }
}

/** 客户端心跳消息 */
interface HeartbeatMessage {
  action: 'HEARTBEAT'
  payload: {
    timestamp: number
  }
}

/** 服务端下行指令（透传给客户端） */
export interface ServerCommand {
  action: string
  payload?: Record<string, any>
}

/** 内存中维护的连接信息 */
interface ConnectedClient {
  ws: WebSocket
  deviceId: string
  clientName: string
  lastHeartbeat: number
}

// ============================================================================
// 常量
// ============================================================================

const LOG_TAG = '[WSManager]'

/** 心跳检查间隔：10 秒 */
const HEARTBEAT_CHECK_INTERVAL_MS = 10_000

/** 心跳超时阈值：30 秒无心跳则判定离线 */
const HEARTBEAT_TIMEOUT_MS = 30_000

// ============================================================================
// 模块状态
// ============================================================================

/** 已注册的连接 Map：deviceId → ConnectedClient */
const clients = new Map<string, ConnectedClient>()

/** 尚未完成注册的临时连接 Set（等待 REGISTER 消息） */
const pendingConnections = new Set<WebSocket>()

/** 心跳检查定时器 */
let reaperTimer: NodeJS.Timeout | null = null

/** WebSocketServer 实例 */
let wss: WebSocketServer | null = null

// ============================================================================
// 初始化
// ============================================================================

/**
 * 初始化 WebSocket 服务并挂载到 HTTP Server 上
 *
 * @param server Koa 创建的 HTTP Server 实例
 */
export function initWebSocketServer(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteIp = req.socket.remoteAddress ?? 'unknown'
    console.log(`${LOG_TAG} 新连接: ${remoteIp}`)

    // 加入待注册集合
    pendingConnections.add(ws)

    // 设置 60 秒注册超时 —— 如果客户端不发 REGISTER 则主动断开
    const registerTimeout = setTimeout(() => {
      if (pendingConnections.has(ws)) {
        console.warn(`${LOG_TAG} 连接 ${remoteIp} 注册超时，断开`)
        pendingConnections.delete(ws)
        ws.close(4001, 'Registration timeout')
      }
    }, 60_000)

    // ---- 消息处理 ----
    ws.on('message', (rawData) => {
      // 严格 try-catch，永远不会因为非法 JSON 导致进程崩溃
      try {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8')
        const msg = JSON.parse(text) as { action?: string; payload?: any }

        if (!msg || typeof msg.action !== 'string') {
          console.warn(`${LOG_TAG} 收到缺少 action 的消息，忽略`)
          return
        }

        switch (msg.action) {
          case 'REGISTER':
            handleRegister(ws, msg as RegisterMessage, remoteIp)
            clearTimeout(registerTimeout)
            pendingConnections.delete(ws)
            break

          case 'HEARTBEAT':
            handleHeartbeat(ws, msg as HeartbeatMessage)
            break

          default:
            console.debug(`${LOG_TAG} 收到未知上行指令: ${msg.action}`)
        }
      } catch (err) {
        // JSON.parse 失败或其他运行时错误 —— 安全忽略
        console.error(`${LOG_TAG} 消息处理异常:`, err)
      }
    })

    // ---- 协议层 Ping —— ws 库默认自动回复 Pong ----
    // 客户端也会发送 ws.ping()，ws 库会自动回 pong，无需额外代码

    // ---- 连接关闭 ----
    ws.on('close', (code, reason) => {
      clearTimeout(registerTimeout)
      pendingConnections.delete(ws)
      removeClientBySocket(ws)
      console.log(`${LOG_TAG} 连接断开: code=${code}, reason=${reason?.toString() ?? 'N/A'}`)
    })

    // ---- 错误 ----
    ws.on('error', (err) => {
      console.error(`${LOG_TAG} WebSocket 错误:`, err)
    })
  })

  // 启动心跳检查定时器
  startHeartbeatReaper()

  console.log(`${LOG_TAG} WebSocket 服务已启动 (路径: /ws)`)
}

// ============================================================================
// 消息处理器
// ============================================================================

/**
 * 处理客户端注册消息
 */
function handleRegister(ws: WebSocket, msg: RegisterMessage, remoteIp: string): void {
  const { clientId, clientName, appVersion, platform, timestamp } = msg.payload

  if (!clientId) {
    console.warn(`${LOG_TAG} REGISTER 缺少 clientId，忽略`)
    return
  }

  // 如果该 deviceId 已有旧连接，先关闭旧连接（同一设备重连场景）
  const existing = clients.get(clientId)
  if (existing) {
    console.warn(`${LOG_TAG} 设备 ${clientId} 重复注册，关闭旧连接`)
    try {
      existing.ws.close(4000, 'Replaced by new connection')
    } catch {
      // 忽略
    }
  }

  const now = Date.now()

  // 存入内存
  clients.set(clientId, {
    ws,
    deviceId: clientId,
    clientName: clientName || clientId,
    lastHeartbeat: now
  })

  // 存入数据库
  upsertDevice({
    deviceId: clientId,
    clientName: clientName || clientId,
    status: 'ONLINE',
    ipAddress: remoteIp,
    appVersion: appVersion || '',
    platform: platform || '',
    lastHeartbeat: now
  })

  // 回复 ACK
  sendJson(ws, { action: 'ACK', payload: { timestamp: now, message: 'Registered' } })

  console.log(`${LOG_TAG} 设备注册: ${clientId} (${clientName}) [${remoteIp}]`)
}

/**
 * 处理客户端心跳消息 —— 回复 ACK 并更新心跳时间
 */
function handleHeartbeat(ws: WebSocket, _msg: HeartbeatMessage): void {
  const client = findClientBySocket(ws)
  if (!client) {
    // 未注册的连接发心跳，忽略
    return
  }

  const now = Date.now()
  client.lastHeartbeat = now

  // 更新数据库
  updateHeartbeat(client.deviceId, now)

  // 回复 ACK（客户端在 handleMessage 中将 ACK 视为心跳应答）
  sendJson(ws, { action: 'ACK', payload: { timestamp: now } })
}

// ============================================================================
// 心跳检查定时器（Reaper）
// ============================================================================

/**
 * 每 10 秒扫描一次连接状态，超过 30 秒无心跳的设备标记为 OFFLINE 并断开
 */
function startHeartbeatReaper(): void {
  if (reaperTimer) clearInterval(reaperTimer)

  reaperTimer = setInterval(() => {
    const now = Date.now()

    for (const [deviceId, client] of clients) {
      if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`${LOG_TAG} 设备 ${deviceId} 心跳超时，标记为 OFFLINE`)

        // 更新数据库
        setDeviceOffline(deviceId)

        // 断开连接
        try {
          client.ws.close(4002, 'Heartbeat timeout')
          client.ws.terminate()
        } catch {
          // 忽略
        }

        // 从内存移除
        clients.delete(deviceId)
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS)
}

// ============================================================================
// 公共 API —— 供 api.ts 调用
// ============================================================================

/**
 * 向指定设备发送指令
 *
 * @returns true 发送成功，false 设备不在线
 */
export function sendToDevice(deviceId: string, command: ServerCommand): boolean {
  const client = clients.get(deviceId)
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return false
  }
  sendJson(client.ws, command)
  return true
}

/**
 * 向所有在线设备广播指令
 *
 * @returns 成功发送的设备数量
 */
export function broadcastAll(command: ServerCommand): number {
  let count = 0
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      sendJson(client.ws, command)
      count++
    }
  }
  return count
}

/**
 * 获取当前在线设备数量
 */
export function getOnlineCount(): number {
  return clients.size
}

/**
 * 销毁 WebSocket 服务（进程退出时调用）
 */
export function shutdownWebSocket(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer)
    reaperTimer = null
  }

  // 关闭所有连接
  for (const [, client] of clients) {
    try {
      client.ws.close(1001, 'Server shutting down')
    } catch {
      // 忽略
    }
  }
  clients.clear()

  // 关闭 WSS
  wss?.close()
  wss = null
}

// ============================================================================
// 内部工具方法
// ============================================================================

/** 安全发送 JSON 消息 */
function sendJson(ws: WebSocket, data: Record<string, any>): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
    }
  } catch (err) {
    console.error(`${LOG_TAG} 发送消息失败:`, err)
  }
}

/** 根据 WebSocket 实例查找对应的客户端 */
function findClientBySocket(ws: WebSocket): ConnectedClient | undefined {
  for (const [, client] of clients) {
    if (client.ws === ws) return client
  }
  return undefined
}

/** 根据 WebSocket 实例移除客户端 */
function removeClientBySocket(ws: WebSocket): void {
  for (const [deviceId, client] of clients) {
    if (client.ws === ws) {
      // 更新数据库状态
      setDeviceOffline(deviceId)
      clients.delete(deviceId)
      console.log(`${LOG_TAG} 设备 ${deviceId} 已移除`)
      return
    }
  }
}
