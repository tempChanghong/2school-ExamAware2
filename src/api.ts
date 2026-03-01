/**
 * api.ts
 *
 * RESTful API 路由层 —— 供未来的 Admin Web 后台调用
 *
 * 路由：
 *   GET  /api/devices                   获取所有设备列表及在线状态
 *   POST /api/devices/:deviceId/command  向指定设备发送指令
 *   POST /api/broadcast                 向所有在线设备广播指令
 */

import Router from '@koa/router'
import { getAllDevices, getDevice } from './db.js'
import { sendToDevice, broadcastAll } from './wsManager.js'
import { authMiddleware } from './auth.js'

const router = new Router({ prefix: '/api' })

// Appy auth middleware to all routes in this router
router.use(authMiddleware)

// ============================================================================
// GET /api/devices
// ============================================================================

router.get('/devices', (ctx) => {
  const devices = getAllDevices()
  ctx.body = {
    success: true,
    data: devices,
    total: devices.length
  }
})

// ============================================================================
// POST /api/devices/:deviceId/command
// ============================================================================

router.post('/devices/:deviceId/command', (ctx) => {
  const { deviceId } = ctx.params
  const body = ctx.request.body as Record<string, any> | undefined

  // 校验参数
  if (!body || typeof body.action !== 'string') {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: '请求体必须包含 action 字段（字符串）'
    }
    return
  }

  // 检查设备是否存在
  const device = getDevice(deviceId)
  if (!device) {
    ctx.status = 404
    ctx.body = {
      success: false,
      error: `设备 ${deviceId} 不存在`
    }
    return
  }

  // 尝试发送指令
  const sent = sendToDevice(deviceId, {
    action: body.action,
    payload: body.payload
  })

  if (!sent) {
    ctx.status = 503
    ctx.body = {
      success: false,
      error: `设备 ${deviceId} 当前不在线`
    }
    return
  }

  ctx.body = {
    success: true,
    message: `指令 ${body.action} 已发送至设备 ${deviceId}`
  }
})

// ============================================================================
// POST /api/broadcast
// ============================================================================

router.post('/broadcast', (ctx) => {
  const body = ctx.request.body as Record<string, any> | undefined

  // 校验参数
  if (!body || typeof body.action !== 'string') {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: '请求体必须包含 action 字段（字符串）'
    }
    return
  }

  const count = broadcastAll({
    action: body.action,
    payload: body.payload
  })

  ctx.body = {
    success: true,
    message: `指令 ${body.action} 已广播至 ${count} 个在线设备`,
    sentCount: count
  }
})

export default router
