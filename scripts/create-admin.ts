import { hash } from 'bcryptjs'

const password = process.argv[2]
if (!password) {
  console.error('Usage: npm run create-admin <password>')
  process.exit(1)
}

const hashed = await hash(password, 12)
console.log('\nAdd to your .env file:')
console.log(`ADMIN_PASSWORD_HASH=${hashed}`)
