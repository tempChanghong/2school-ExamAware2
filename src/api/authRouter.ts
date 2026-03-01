/**
 * authRouter.ts
 *
 * Authentication Routes
 * POST /api/auth/login
 * POST /api/auth/register (protected)
 */

import Router from '@koa/router'
import bcrypt from 'bcryptjs'
import { getAdminByUsername, createAdmin, hasAnyAdmin } from '../db.js'
import { authMiddleware, generateToken } from '../auth.js'

const authRouter = new Router({ prefix: '/api/auth' })

// ============================================================================
// POST /api/auth/login
// ============================================================================

authRouter.post('/login', async (ctx) => {
  const body = ctx.request.body as Record<string, any> | undefined

  if (!body || !body.username || !body.password) {
    ctx.status = 400
    ctx.body = { success: false, error: 'Missing username or password' }
    return
  }

  const { username, password } = body

  // Lookup user
  const admin = getAdminByUsername(username)
  if (!admin) {
    ctx.status = 401
    ctx.body = { success: false, error: 'Invalid username or password' }
    return
  }

  // Verify password
  const isMatch = await bcrypt.compare(password, admin.password_hash)
  if (!isMatch) {
    ctx.status = 401
    ctx.body = { success: false, error: 'Invalid username or password' }
    return
  }

  // Generate token
  const token = generateToken({ id: admin.id, username: admin.username })

  ctx.body = {
    success: true,
    data: {
      token,
      user: {
        id: admin.id,
        username: admin.username
      }
    }
  }
})

// ============================================================================
// POST /api/auth/register (Protected by JWT)
// ============================================================================

// If there are no admins, potentially we could allow registration without token
// However, the setup spec is to use a CLI script for the first admin.
// So this endpoint enforces auth unconditionally.
authRouter.post('/register', authMiddleware, async (ctx) => {
  const body = ctx.request.body as Record<string, any> | undefined

  if (!body || !body.username || !body.password) {
    ctx.status = 400
    ctx.body = { success: false, error: 'Missing username or password' }
    return
  }

  const { username, password } = body

  // Check if admin already exists
  const existing = getAdminByUsername(username)
  if (existing) {
    ctx.status = 409
    ctx.body = { success: false, error: 'Username already exists' }
    return
  }

  // Hash password
  const salt = await bcrypt.genSalt(10)
  const hash = await bcrypt.hash(password, salt)

  // Create admin
  try {
    createAdmin(username, hash)
    ctx.body = { success: true, message: 'Admin user created successfully' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: 'Failed to create admin user' }
  }
})

export default authRouter
