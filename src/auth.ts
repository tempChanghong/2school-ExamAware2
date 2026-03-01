/**
 * auth.ts
 *
 * Auth Middleware
 * Verifies JWT tokens from the Authorization header.
 */

import type { Context, Next } from 'koa'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'ea2-default-secret-change-me'

export const authMiddleware = async (ctx: Context, next: Next) => {
  const authHeader = ctx.header.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    ctx.status = 401
    ctx.body = { success: false, error: 'Unauthorized: Missing or invalid token' }
    return
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    ctx.state.user = decoded
    await next()
  } catch (err) {
    ctx.status = 401
    ctx.body = { success: false, error: 'Unauthorized: Invalid token' }
  }
}

export function generateToken(payload: object, expiresIn: any = '24h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn })
}
