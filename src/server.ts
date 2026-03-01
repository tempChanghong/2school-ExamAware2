/**
 * server.ts
 *
 * ExamAware2 集控服务端入口
 *
 * 将 Koa HTTP 服务和 WebSocket 服务合并到同一端口启动
 */

import http from 'node:http'
import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import apiRouter from './api.js'
import authRouter from './api/authRouter.js'
import { initWebSocketServer, shutdownWebSocket } from './wsManager.js'
import { closeDatabase } from './db.js'

// ============================================================================
// 配置
// ============================================================================

const PORT = parseInt(process.env.PORT ?? '3000', 10)

// ============================================================================
// Koa 应用
// ============================================================================

const app = new Koa()

// ---- 全局错误处理 ----
app.on('error', (err, ctx) => {
  console.error('[Koa] 服务器异常:', err.message, ctx?.url)
})

// ---- 中间件 ----

// CORS —— 允许所有来源（方便 Admin Web 后台跨域访问）
app.use(cors({ origin: '*' }))

// Body 解析 —— 解析 JSON 请求体
app.use(bodyParser())

// 请求日志
app.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  console.log(`[HTTP] ${ctx.method} ${ctx.url} → ${ctx.status} (${ms}ms)`)
})

// ---- 路由 ----
// Mount authRouter (unprotected endpoints, internal auth endpoints protected by module)
app.use(authRouter.routes())
app.use(authRouter.allowedMethods())

// Mount apiRouter (protected endpoints)
app.use(apiRouter.routes())
app.use(apiRouter.allowedMethods())

// ============================================================================
// 启动服务
// ============================================================================

const server = http.createServer(app.callback())

// 挂载 WebSocket 服务到同一 HTTP Server
initWebSocketServer(server)

server.listen(PORT, () => {
  console.log('='.repeat(60))
  console.log(`  ExamAware2 Central Control Server`)
  console.log(`  HTTP API:    http://localhost:${PORT}/api/devices`)
  console.log(`  WebSocket:   ws://localhost:${PORT}/ws`)
  console.log('='.repeat(60))
})

// ============================================================================
// 优雅退出
// ============================================================================

function gracefulShutdown(signal: string): void {
  console.log(`\n[Server] 收到 ${signal}，正在优雅关闭...`)

  shutdownWebSocket()
  closeDatabase()

  server.close(() => {
    console.log('[Server] 已关闭')
    process.exit(0)
  })

  // 5 秒强制退出
  setTimeout(() => {
    console.error('[Server] 强制退出')
    process.exit(1)
  }, 5000)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
