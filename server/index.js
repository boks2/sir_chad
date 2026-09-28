import 'dotenv/config'
import cors from 'cors'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import express from 'express'
import jwt from 'jsonwebtoken'
import nodemailer from 'nodemailer'

const app = express()
const port = Number(process.env.PORT || 4000)
const dataDir = path.resolve('server/data')
const dataFile = path.join(dataDir, 'store.json')
const databaseFile = path.join(dataDir, 'vaporly.sqlite')
fs.mkdirSync(dataDir, { recursive: true })
const db = new Database(databaseFile)

db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'buyer', approved INTEGER NOT NULL DEFAULT 1, verified INTEGER NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL, quantity INTEGER NOT NULL, nicotine TEXT, flavor TEXT, description TEXT, image TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', items_json TEXT NOT NULL, created_at TEXT NOT NULL, shipped_at TEXT, FOREIGN KEY (user_id) REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, items_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
`)
for (const statement of [
  'ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN credit REAL NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT \'Cash on delivery\'',
]) { try { db.exec(statement) } catch (error) { if (!error.message.includes('duplicate column name')) throw error } }

function productFromRow(row) { return row && { ...row, active: Boolean(row.active) } }
function userFromRow(row) { return row && { id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash, role: row.role, approved: Boolean(row.approved), verified: Boolean(row.verified), createdAt: row.created_at } }
function importLegacyStore() {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0 || db.prepare('SELECT COUNT(*) AS count FROM products').get().count > 0 || !fs.existsSync(dataFile)) return
  try {
    const store = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    db.transaction(() => {
      const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, name, email, password_hash, role, approved, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const user of store.users || []) insertUser.run(user.id, user.name, user.email, user.passwordHash, user.role, user.approved ? 1 : 0, user.verified ? 1 : 0, user.createdAt)
      const insertToken = db.prepare('INSERT INTO tokens (user_id, type, code, expires_at) VALUES (?, ?, ?, ?)')
      for (const token of store.tokens || []) insertToken.run(token.userId, token.type, token.code, token.expiresAt)
      const insertProduct = db.prepare('INSERT OR IGNORE INTO products (id, name, category, price, stock, quantity, nicotine, flavor, description, image, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const product of store.products || []) insertProduct.run(product.id, product.name || 'Unnamed product', product.category || 'Accessories', Number(product.price) || 0, Number(product.stock ?? product.quantity) || 0, Number(product.quantity ?? product.stock) || 0, product.nicotine || '', product.flavor || '', product.description || '', product.image || '', product.active === false ? 0 : 1)
    })()
    console.log('Imported legacy store.json data into SQLite.')
  } catch (error) { console.warn(`Could not import legacy store.json: ${error.message}`) }
}
importLegacyStore()

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '12mb' }))
async function sendCode(email, subject, code) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || process.env.SMTP_PASS.includes('PASTE_YOUR_16_CHARACTER')) throw new Error('Gmail is almost configured. Open .env and replace SMTP_PASS with the 16-character Gmail App Password for tristanbalagtas1@gmail.com.')
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), secure: process.env.SMTP_SECURE !== 'false', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: email, subject, text: `Your Vaporly verification code is ${code}. It expires in 10 minutes.` })
}
function issueToken(user) { return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'development-only-secret', { expiresIn: '2h' }) }
function auth(req, res, next) { try { req.user = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), process.env.JWT_SECRET || 'development-only-secret'); next() } catch { res.status(401).json({ message: 'Please log in again.' }) } }
function adminOnly(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' }); next() }
function createCode() { return String(crypto.randomInt(100000, 999999)) }
async function createXenditInvoice({ amount, email, description, externalId }) {
  if (!process.env.XENDIT_SECRET_KEY || process.env.XENDIT_SECRET_KEY.includes('your_secret_key')) throw new Error('Xendit is not configured. Add XENDIT_SECRET_KEY to .env.')
  const encoded = Buffer.from(`${process.env.XENDIT_SECRET_KEY}:`).toString('base64')
  const response = await fetch('https://api.xendit.co/v2/invoices', { method: 'POST', headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ external_id: externalId || `vaporly-${Date.now()}`, payer_email: email, description: description || 'Vaporly vape shop order', amount: Number(amount), success_redirect_url: process.env.XENDIT_SUCCESS_REDIRECT_URL, failure_redirect_url: process.env.XENDIT_FAILURE_REDIRECT_URL }) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || 'Xendit invoice creation failed.')
  return { invoiceUrl: data.invoice_url, invoiceId: data.id }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Vaporly API', database: 'sqlite' }))
app.get('/api/products', (_req, res) => res.json(db.prepare('SELECT id, name, category, price, stock, quantity, nicotine, flavor, description, image, active FROM products WHERE active = 1 ORDER BY rowid DESC').all().map(productFromRow)))

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body; const normalized = email?.trim().toLowerCase()
  if (!name || !normalized || !normalized.endsWith('@gmail.com') || !password || password.length < 8) return res.status(400).json({ message: 'Use a valid Gmail address and a password with at least 8 characters.' })
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalized)) return res.status(409).json({ message: 'An account with that email already exists.' })
  const code = createCode(); const user = { id: crypto.randomUUID(), name: name.trim(), email: normalized, passwordHash: await bcrypt.hash(password, 12), role: 'buyer', approved: true, verified: false, createdAt: new Date().toISOString() }
  db.transaction(() => { db.prepare('INSERT INTO users (id, name, email, password_hash, role, approved, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, user.name, user.email, user.passwordHash, user.role, 1, 0, user.createdAt); db.prepare('INSERT INTO tokens (user_id, type, code, expires_at) VALUES (?, ?, ?, ?)').run(user.id, 'verify', code, Date.now() + 600000) })()
  try { await sendCode(normalized, 'Verify your Vaporly account', code) } catch (error) { db.prepare('DELETE FROM users WHERE id = ?').run(user.id); return res.status(503).json({ message: error.message }) }
  res.status(201).json({ message: 'Registration accepted by admin. Check your Gmail for the verification code.', userId: user.id })
})
app.post('/api/auth/verify-email', (req, res) => {
  const email = req.body.email?.trim().toLowerCase(); const row = db.prepare('SELECT u.id FROM users u JOIN tokens t ON t.user_id = u.id WHERE u.email = ? AND t.type = ? AND t.code = ? AND t.expires_at > ?').get(email, 'verify', req.body.code, Date.now())
  if (!row) return res.status(400).json({ message: 'Invalid or expired verification code.' })
  db.transaction(() => { db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(row.id); db.prepare('DELETE FROM tokens WHERE user_id = ? AND type = ?').run(row.id, 'verify') })()
  res.json({ message: 'Email verified. You can now log in.' })
})
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase(); const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (user) { const code = createCode(); db.prepare('DELETE FROM tokens WHERE user_id = ? AND type = ?').run(user.id, 'reset'); db.prepare('INSERT INTO tokens (user_id, type, code, expires_at) VALUES (?, ?, ?, ?)').run(user.id, 'reset', code, Date.now() + 600000); try { await sendCode(email, 'Reset your Vaporly password', code) } catch (error) { return res.status(503).json({ message: error.message }) } }
  res.json({ message: 'If that email is registered, a reset code has been sent.' })
})
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, password } = req.body; const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email?.trim().toLowerCase()); const token = user && db.prepare('SELECT id FROM tokens WHERE user_id = ? AND type = ? AND code = ? AND expires_at > ?').get(user.id, 'reset', code, Date.now())
  if (!user || !token || !password || password.length < 8) return res.status(400).json({ message: 'Invalid code or password. Use a valid 8-character password.' })
  const passwordHash = await bcrypt.hash(password, 12); db.transaction(() => { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id); db.prepare('DELETE FROM tokens WHERE id = ?').run(token.id) })()
  res.json({ message: 'Password changed successfully.' })
})
app.post('/api/auth/login', async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email?.trim().toLowerCase()); const user = userFromRow(row)
  if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ message: 'Incorrect email or password.' })
  if (!user.verified && user.role !== 'admin') return res.status(403).json({ message: 'Verify your email before logging in.' })
  res.json({ token: issueToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

function buyerOnly(req, res, next) { if (req.user.role !== 'buyer') return res.status(403).json({ message: 'Buyer access required.' }); next() }
app.get('/api/buyer/profile', auth, buyerOnly, (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone, address FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ message: 'Buyer account not found.' })
  res.json(user)
})
app.put('/api/buyer/profile', auth, buyerOnly, (req, res) => {
  const name = req.body.name?.trim(); const email = req.body.email?.trim().toLowerCase(); const phone = req.body.phone?.trim(); const address = req.body.address?.trim()
  if (!name || !email || !phone || !address) return res.status(400).json({ message: 'Name, email, phone, and address are required before ordering.' })
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id)
  if (existing) return res.status(409).json({ message: 'That email is already in use.' })
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, address = ? WHERE id = ?').run(name, email, phone, address, req.user.id)
  res.json({ id: req.user.id, name, email, phone, address })
})
app.get('/api/buyer/cart', auth, buyerOnly, (req, res) => {
  const row = db.prepare('SELECT items_json FROM carts WHERE user_id = ?').get(req.user.id)
  res.json({ items: row ? JSON.parse(row.items_json || '[]') : [] })
})
app.put('/api/buyer/cart', auth, buyerOnly, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const sanitized = items.map((item) => ({
    id: item.id,
    name: item.name || 'Product',
    price: Number(item.price) || 0,
    quantity: Math.max(1, Number(item.quantity) || 1),
    image: item.image || '',
    stock: Number(item.stock) || 0,
    category: item.category || 'Unknown',
    flavor: item.flavor || '',
  }))
  const payload = JSON.stringify(sanitized)
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM carts WHERE user_id = ?').get(req.user.id)
  if (existing) db.prepare('UPDATE carts SET items_json = ?, updated_at = ? WHERE user_id = ?').run(payload, now, req.user.id)
  else db.prepare('INSERT INTO carts (id, user_id, items_json, updated_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), req.user.id, payload, now)
  res.json({ items: sanitized })
})
app.delete('/api/buyer/cart', auth, buyerOnly, (req, res) => {
  db.prepare('DELETE FROM carts WHERE user_id = ?').run(req.user.id)
  res.json({ items: [] })
})
app.get('/api/buyer/orders', auth, buyerOnly, (_req, res) => res.json(db.prepare('SELECT id, total, status, items_json AS items, created_at AS createdAt, shipped_at AS shippedAt, payment_method AS paymentMethod FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(_req.user.id).map((order) => ({ ...order, items: JSON.parse(order.items) }))))
app.post('/api/buyer/orders', auth, buyerOnly, (req, res) => {
  const { items, paymentMethod } = req.body
  const normalizedPayment = String(paymentMethod || '').trim()
  const allowedMethods = ['Online Payment', 'COD']

  if (!Array.isArray(items) || !items.length || !allowedMethods.includes(normalizedPayment)) {
    return res.status(400).json({ message: 'Your cart and a valid payment method are required.' })
  }

  const buyer = db.prepare('SELECT name, email, phone, address FROM users WHERE id = ?').get(req.user.id)
  if (!buyer?.name || !buyer.email || !buyer.phone || !buyer.address) {
    return res.status(400).json({ message: 'Complete your buyer profile in Settings before ordering.' })
  }

  const total = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0)
  const orderId = crypto.randomUUID(); const createdAt = new Date().toISOString()
  const createOrder = db.transaction(() => {
    for (const item of items) {
      const product = db.prepare('SELECT stock FROM products WHERE id = ? AND active = 1').get(item.id)
      if (!product || product.stock < Number(item.quantity)) throw new Error(`Not enough stock for ${item.name}.`)
    }

    for (const item of items) {
      db.prepare('UPDATE products SET stock = stock - ?, quantity = quantity - ? WHERE id = ?').run(Number(item.quantity), Number(item.quantity), item.id)
    }

    db.prepare('INSERT INTO orders (id, user_id, customer_name, customer_email, total, status, items_json, created_at, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(orderId, req.user.id, buyer.name, buyer.email, total, 'Pending', JSON.stringify(items), createdAt, normalizedPayment)
  })

  try {
    createOrder()
  } catch (error) {
    return res.status(400).json({ message: error.message })
  }

  db.prepare('DELETE FROM carts WHERE user_id = ?').run(req.user.id)
  res.status(201).json({ id: orderId, total, status: 'Pending', paymentMethod: normalizedPayment, createdAt, items })
})

app.post('/api/payments/xendit/invoice', auth, async (req, res) => {
  if (!process.env.XENDIT_SECRET_KEY) return res.status(503).json({ message: 'Xendit is not configured. Add XENDIT_SECRET_KEY to .env.' })
  const { amount, description, externalId } = req.body; if (!amount || amount < 1) return res.status(400).json({ message: 'A valid amount is required.' })
  const encoded = Buffer.from(`${process.env.XENDIT_SECRET_KEY}:`).toString('base64'); const response = await fetch('https://api.xendit.co/v2/invoices', { method: 'POST', headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ external_id: externalId || `vaporly-${Date.now()}`, payer_email: req.user.email, description: description || 'Vaporly vape shop order', amount: Number(amount), success_redirect_url: process.env.XENDIT_SUCCESS_REDIRECT_URL, failure_redirect_url: process.env.XENDIT_FAILURE_REDIRECT_URL }) })
  const data = await response.json(); if (!response.ok) return res.status(response.status).json({ message: data.message || 'Xendit invoice creation failed.' }); res.status(201).json({ invoiceUrl: data.invoice_url, invoiceId: data.id })
})
app.get('/api/admin/registrations', auth, adminOnly, (_req, res) => res.json(db.prepare("SELECT id, name, email, role, approved, verified, created_at AS createdAt FROM users WHERE role = 'buyer' ORDER BY rowid DESC").all().map((user) => ({ ...user, approved: Boolean(user.approved), verified: Boolean(user.verified) }))))
app.get('/api/admin/profile', auth, adminOnly, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ message: 'Admin account not found.' })
  res.json(user)
})
app.put('/api/admin/profile', auth, adminOnly, async (req, res) => {
  const name = req.body.name?.trim()
  const email = req.body.email?.trim().toLowerCase()
  const password = req.body.password
  if (!name || !email) return res.status(400).json({ message: 'Manager name and email are required.' })
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id)
  if (existing) return res.status(409).json({ message: 'That email is already being used by another account.' })
  const passwordHash = password ? await bcrypt.hash(password, 12) : null
  if (password && password.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters.' })
  if (passwordHash) db.prepare('UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?').run(name, email, passwordHash, req.user.id)
  else db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.user.id)
  res.json({ id: req.user.id, name, email, role: 'admin' })
})
app.post('/api/admin/products', auth, adminOnly, (req, res) => {
  const product = { id: crypto.randomUUID(), ...req.body, price: Number(req.body.price) || 0, stock: Number(req.body.stock ?? req.body.quantity) || 0, quantity: Number(req.body.quantity ?? req.body.stock) || 0, active: true }
  db.prepare('INSERT INTO products (id, name, category, price, stock, quantity, nicotine, flavor, description, image, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(product.id, product.name || 'Unnamed product', product.category || 'Accessories', product.price, product.stock, product.quantity, product.nicotine || '', product.flavor || '', product.description || '', product.image || '', 1)
  res.status(201).json(product)
})
app.put('/api/admin/products/:id', auth, adminOnly, (req, res) => {
  const product = { ...req.body, price: Number(req.body.price) || 0, stock: Number(req.body.stock ?? req.body.quantity) || 0, quantity: Number(req.body.quantity ?? req.body.stock) || 0 }
  const result = db.prepare('UPDATE products SET name = ?, category = ?, price = ?, stock = ?, quantity = ?, nicotine = ?, flavor = ?, description = ?, image = ?, active = ? WHERE id = ?').run(product.name || 'Unnamed product', product.category || 'Accessories', product.price, product.stock, product.quantity, product.nicotine || '', product.flavor || '', product.description || '', product.image || '', product.active === false ? 0 : 1, req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Product not found.' })
  res.json({ id: req.params.id, ...product, active: product.active !== false })
})
app.get('/api/admin/orders', auth, adminOnly, (_req, res) => res.json(db.prepare('SELECT id, customer_name AS customerName, customer_email AS customerEmail, total, status, items_json AS items, created_at AS createdAt, shipped_at AS shippedAt FROM orders ORDER BY created_at DESC').all().map((order) => ({ ...order, items: JSON.parse(order.items) }))))
app.get('/api/admin/credit', auth, adminOnly, (_req, res) => {
  const admin = db.prepare('SELECT id, name, email, credit FROM users WHERE role = ? ORDER BY rowid LIMIT 1').get('admin')
  if (!admin) return res.json({ credit: 0 })
  res.json({ id: admin.id, name: admin.name, email: admin.email, credit: Number(admin.credit || 0) })
})
app.put('/api/admin/orders/:id/status', auth, adminOnly, (req, res) => {
  const status = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].includes(req.body.status) ? req.body.status : 'Pending'
  const order = db.prepare('SELECT id, total, status FROM orders WHERE id = ?').get(req.params.id)
  if (!order) return res.status(404).json({ message: 'Order not found.' })
  const previousStatus = order.status
  if (previousStatus === 'Delivered' || previousStatus === 'Cancelled') {
    return res.status(400).json({ message: `This order is already ${previousStatus}. No further updates are allowed.` })
  }
  const shippedAt = status === 'Shipped' || status === 'Delivered' ? new Date().toISOString() : null
  const adminCredit = () => db.prepare('SELECT credit FROM users WHERE role = ? ORDER BY rowid LIMIT 1').get('admin')
  if (previousStatus !== status) {
    if (status === 'Delivered' && previousStatus !== 'Delivered') {
      db.prepare('UPDATE users SET credit = COALESCE(credit, 0) + ? WHERE role = ? AND id = (SELECT id FROM users WHERE role = ? ORDER BY rowid LIMIT 1)').run(Number(order.total), 'admin', 'admin')
    }
    if (previousStatus === 'Delivered' && status !== 'Delivered') {
      db.prepare('UPDATE users SET credit = COALESCE(credit, 0) - ? WHERE role = ? AND id = (SELECT id FROM users WHERE role = ? ORDER BY rowid LIMIT 1)').run(Number(order.total), 'admin', 'admin')
    }
    if (status === 'Cancelled' && previousStatus === 'Delivered') {
      db.prepare('UPDATE users SET credit = COALESCE(credit, 0) - ? WHERE role = ? AND id = (SELECT id FROM users WHERE role = ? ORDER BY rowid LIMIT 1)').run(Number(order.total), 'admin', 'admin')
    }
    if (previousStatus === 'Cancelled' && status === 'Delivered') {
      db.prepare('UPDATE users SET credit = COALESCE(credit, 0) + ? WHERE role = ? AND id = (SELECT id FROM users WHERE role = ? ORDER BY rowid LIMIT 1)').run(Number(order.total), 'admin', 'admin')
    }
  }
  const result = db.prepare('UPDATE orders SET status = ?, shipped_at = ? WHERE id = ?').run(status, shippedAt, req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Order not found.' })
  res.json({ id: req.params.id, status, shippedAt, credit: Number(adminCredit()?.credit || 0) })
})

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'tristanbalagtas1@gmail.com').toLowerCase(); const password = process.env.ADMIN_PASSWORD || 'admin123'; const passwordHash = await bcrypt.hash(password, 12)
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY rowid LIMIT 1").get()
  if (existing) { db.prepare('UPDATE users SET email = ?, password_hash = ?, verified = 1, approved = 1 WHERE id = ?').run(email, passwordHash, existing.id); return }
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, approved, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'Vaporly Admin', email, passwordHash, 'admin', 1, 1, new Date().toISOString())
}
seedAdmin().then(() => app.listen(port, () => console.log(`Vaporly API running at http://localhost:${port} using SQLite`)))
