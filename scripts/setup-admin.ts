/**
 * setup-admin.ts
 *
 * A CLI script to initialize the first super admin via command line prompts.
 */

import readline from 'readline'
import bcrypt from 'bcryptjs'
import { createAdmin, hasAnyAdmin, getAdminByUsername } from '../src/db.js'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

console.log('='.repeat(50))
console.log(' ExamAware2 Central Control - Initial Admin Setup')
console.log('='.repeat(50))

if (hasAnyAdmin()) {
  console.log('\n[INFO] An admin already exists in the database. Setup skipped.')
  process.exit(0)
}

rl.question('\nEnter admin username: ', async (username) => {
  if (!username) {
    console.error('[ERROR] Username cannot be empty.')
    process.exit(1)
  }

  const existing = getAdminByUsername(username)
  if (existing) {
    console.error(`[ERROR] Username "${username}" already exists.`)
    process.exit(1)
  }

  rl.question('Enter admin password: ', async (password) => {
    if (!password) {
      console.error('[ERROR] Password cannot be empty.')
      process.exit(1)
    }

    try {
      const salt = await bcrypt.genSalt(10)
      const hash = await bcrypt.hash(password, salt)
      
      createAdmin(username, hash)
      
      console.log(`\n[SUCCESS] Super admin "${username}" created successfully!`)
      process.exit(0)
    } catch (err) {
      console.error('\n[ERROR] Failed to create admin:', err)
      process.exit(1)
    }
  })
})
