import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRONTEND_PATH = [
  join(__dirname, '../../index.html'),
  join(__dirname, '../index.html'),
  join(process.cwd(), 'index.html'),
].find(existsSync) ?? join(__dirname, '../../index.html');

const STATIC_PATH = join(FRONTEND_PATH, '..');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(STATIC_PATH));
app.use(express.static(process.cwd()));
app.use(express.static(join(__dirname, '../../')));
app.use(express.static(join(__dirname, '../')));

const JWT_SECRET   = process.env.JWT_SECRET   || 'faro_copiloto_2026';
const DB_NAME      = process.env.DB_NAME      || 'faro_negocio';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const PRECIO_PLAN  = 150000; // COP

// ── EMAIL ─────────────────────────────────────────────────────────────────────
// Usa Mailjet HTTP API (HTTPS puerto 443, nunca bloqueado por firewalls)

function buildEmailHtml(nombre, token) {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:16px">
      <h2 style="color:#006d43">🔑 Tu token de acceso a <strong>Faro</strong></h2>
      <p>Hola <strong>${nombre}</strong>,</p>
      <p>Tu pago fue verificado. Usa este token para activar tu suscripción:</p>
      <div style="background:#f0faf5;border:2px dashed #006d43;border-radius:12px;padding:20px;text-align:center;margin:20px 0">
        <span style="font-size:28px;font-weight:900;letter-spacing:4px;color:#006d43">${token}</span>
      </div>
      <p style="font-size:13px;color:#666">• Válido por <strong>30 días</strong> a partir de su activación.<br>
      • Ingrésalo en la pantalla de activación de Faro.<br>
      • No lo compartas con nadie.</p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #eee"/>
      <p style="font-size:12px;color:#aaa">Faro — Tu Copiloto de Negocio</p>
    </div>`;
}

// Envía email vía Mailjet HTTP API (usa HTTPS, no SMTP)
async function sendEmail(to, toName, subject, html) {
  const apiKey    = process.env.SMTP_USER;  // Mailjet API Key
  const secretKey = process.env.SMTP_PASS;  // Mailjet Secret Key
  const fromEmail = process.env.MAIL_FROM;  // Correo remitente verificado en Mailjet

  if (!apiKey || !secretKey || !fromEmail) return false;

  const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
  const resp = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Messages: [{
        From: { Email: fromEmail, Name: 'Faro App' },
        To:   [{ Email: to, Name: toName || to }],
        Subject: subject,
        HTMLPart: html,
      }]
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const errMsg = data?.Messages?.[0]?.Errors?.[0]?.ErrorMessage || data?.ErrorMessage || `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }
  return true;
}

async function testSMTP() {
  const apiKey    = process.env.SMTP_USER;
  const secretKey = process.env.SMTP_PASS;
  const fromEmail = process.env.MAIL_FROM;
  if (!apiKey || !secretKey || !fromEmail) {
    console.warn('⚠️  Email no configurado. Faltan SMTP_USER, SMTP_PASS o MAIL_FROM.');
    return;
  }
  console.log(`✅ Email configurado — Mailjet API (from: ${fromEmail})`);
}

async function sendTokenEmail(email, nombre, token) {
  const html    = buildEmailHtml(nombre, token);
  const subject = `Tu token de acceso Faro: ${token}`;
  try {
    const sent = await sendEmail(email, nombre, subject, html);
    if (sent) { console.log(`✅ Token enviado a ${email}`); return true; }
    console.log(`📧 [SIMULADO] Token para ${email}: ${token}`);
    return false;
  } catch (err) {
    console.warn(`⚠️ Email falló (${err.message}). Token: ${token}`);
    return false;
  }
}

// ── DB POOL ───────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3308,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  waitForConnections: true,
  connectionLimit: 10,
  multipleStatements: true,
});

async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await conn.query(`USE \`${DB_NAME}\``);

    // ── Tablas base ────────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nombre_negocio VARCHAR(150) DEFAULT '',
        es_admin TINYINT(1) DEFAULT 0,
        estado_suscripcion VARCHAR(20) DEFAULT 'sin_plan',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    // Añadir columnas si no existen (migraciones seguras)
    for (const col of [
      `ADD COLUMN es_admin TINYINT(1) DEFAULT 0`,
      `ADD COLUMN estado_suscripcion VARCHAR(20) DEFAULT 'sin_plan'`,
    ]) {
      try { await conn.query(`ALTER TABLE usuarios ${col}`); } catch {}
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS suscripciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        estado VARCHAR(20) DEFAULT 'pendiente',
        metodo_pago VARCHAR(50) DEFAULT '',
        referencia_pago VARCHAR(500) DEFAULT '',
        token VARCHAR(25) DEFAULT NULL,
        token_enviado_en DATETIME DEFAULT NULL,
        fecha_inicio DATETIME DEFAULT NULL,
        fecha_fin DATETIME DEFAULT NULL,
        monto DECIMAL(10,2) DEFAULT 150000,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS finanzas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        tipo ENUM('ingreso','gasto') NOT NULL,
        descripcion VARCHAR(255) DEFAULT '',
        monto DECIMAL(12,2) NOT NULL,
        categoria VARCHAR(100) DEFAULT '',
        fecha DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS productos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        nombre VARCHAR(150) NOT NULL,
        categoria VARCHAR(100) DEFAULT '',
        precio_venta DECIMAL(12,2) NOT NULL DEFAULT 0,
        costo_compra DECIMAL(12,2) NOT NULL DEFAULT 0,
        stock INT NOT NULL DEFAULT 0,
        stock_minimo INT NOT NULL DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        nombre VARCHAR(150) NOT NULL,
        categoria VARCHAR(100) DEFAULT '',
        contacto VARCHAR(100) DEFAULT '',
        telefono VARCHAR(80) DEFAULT '',
        plazo_entrega_dias INT DEFAULT 3,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ventas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        producto_id INT,
        producto_nombre VARCHAR(150) NOT NULL,
        cantidad INT NOT NULL DEFAULT 1,
        precio_unitario DECIMAL(12,2) NOT NULL DEFAULT 0,
        costo_unitario DECIMAL(12,2) NOT NULL DEFAULT 0,
        total DECIMAL(12,2) NOT NULL DEFAULT 0,
        ganancia DECIMAL(12,2) NOT NULL DEFAULT 0,
        cliente VARCHAR(150) DEFAULT '',
        notas TEXT,
        fecha DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        titulo VARCHAR(200) NOT NULL,
        monto_objetivo DECIMAL(12,2) NOT NULL DEFAULT 0,
        monto_actual DECIMAL(12,2) NOT NULL DEFAULT 0,
        es_principal TINYINT(1) NOT NULL DEFAULT 0,
        fecha_limite DATE DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )`);

    // ── Auto-promover admins en cada arranque ──────────────────────────────────
    if (ADMIN_EMAILS.length) {
      for (const adminEmail of ADMIN_EMAILS) {
        try {
          await conn.query(
            `UPDATE usuarios SET es_admin=1, estado_suscripcion='activo' WHERE LOWER(email)=?`,
            [adminEmail]
          );
        } catch {}
      }
      console.log(`✅ Admins auto-promovidos: ${ADMIN_EMAILS.join(', ')}`);
    }

    console.log(`✅ DB "${DB_NAME}" inicializada`);
  } catch (err) {
    console.error('❌ Error init DB:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function q(sql, params = []) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE \`${DB_NAME}\``);
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

function generarTokenAlfanum() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let t = 'FARO-';
  for (let i = 0; i < 5; i++) t += chars[Math.floor(Math.random() * chars.length)];
  t += '-';
  for (let i = 0; i < 5; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t; // Ej: FARO-AB3K7-MN9QX
}

async function calcDiasRestantes(usuarioId) {
  const subs = await q(
    `SELECT fecha_fin FROM suscripciones WHERE usuario_id=? AND estado='activo' ORDER BY fecha_fin DESC LIMIT 1`,
    [usuarioId]);
  if (!subs.length) return null;
  return Math.ceil((new Date(subs[0].fecha_fin) - new Date()) / 86400000);
}

async function autoExpirar(usuarioId) {
  const subs = await q(
    `SELECT id FROM suscripciones WHERE usuario_id=? AND estado='activo' AND fecha_fin < NOW()`,
    [usuarioId]);
  if (subs.length) {
    await q(`UPDATE suscripciones SET estado='vencido' WHERE usuario_id=? AND estado='activo'`, [usuarioId]);
    await q(`UPDATE usuarios SET estado_suscripcion='vencido' WHERE id=?`, [usuarioId]);
    return true;
  }
  return false;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
};

const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.es_admin) return res.status(403).json({ error: 'Acceso denegado' });
    req.user = payload;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
};

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { nombre, email, password, nombre_negocio } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
  try {
    const emailLow = email.trim().toLowerCase();
    const esAdmin = ADMIN_EMAILS.includes(emailLow) ? 1 : 0;
    const hash = await bcrypt.hash(password, 10);
    const result = await q(
      `INSERT INTO usuarios (nombre, email, password_hash, nombre_negocio, es_admin, estado_suscripcion)
       VALUES (?,?,?,?,?, ?)`,
      [nombre.trim(), emailLow, hash, (nombre_negocio||'').trim(), esAdmin,
       esAdmin ? 'activo' : 'sin_plan']
    );
    const usuario = {
      id: result.insertId, nombre: nombre.trim(), email: emailLow,
      nombre_negocio: (nombre_negocio||'').trim(),
      es_admin: !!esAdmin,
      estado_suscripcion: esAdmin ? 'activo' : 'sin_plan',
    };
    const token = jwt.sign(usuario, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, usuario, dias_restantes: null });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Ya existe una cuenta con ese correo' });
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const rows = await q('SELECT * FROM usuarios WHERE email=?', [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });

    // Promover admin si email en ADMIN_EMAILS
    if (!user.es_admin && ADMIN_EMAILS.includes(user.email)) {
      await q(`UPDATE usuarios SET es_admin=1, estado_suscripcion='activo' WHERE id=?`, [user.id]);
      user.es_admin = 1; user.estado_suscripcion = 'activo';
    }

    // Auto-expirar si corresponde
    if (user.estado_suscripcion === 'activo') {
      const expirado = await autoExpirar(user.id);
      if (expirado) user.estado_suscripcion = 'vencido';
    }

    const dias_restantes = user.estado_suscripcion === 'activo'
      ? await calcDiasRestantes(user.id) : null;

    const usuario = {
      id: user.id, nombre: user.nombre, email: user.email,
      nombre_negocio: user.nombre_negocio,
      es_admin: !!user.es_admin,
      estado_suscripcion: user.estado_suscripcion,
    };
    const token = jwt.sign(usuario, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, usuario, dias_restantes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── SUSCRIPCIÓN ───────────────────────────────────────────────────────────────
app.get('/api/suscripcion/estado', auth, async (req, res) => {
  try {
    const users = await q(`SELECT estado_suscripcion, es_admin FROM usuarios WHERE id=?`, [req.user.id]);
    if (!users.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = users[0];

    if (user.estado_suscripcion === 'activo') {
      const expirado = await autoExpirar(req.user.id);
      if (expirado) user.estado_suscripcion = 'vencido';
    }

    const dias_restantes = user.estado_suscripcion === 'activo'
      ? await calcDiasRestantes(req.user.id) : null;

    const solicitud = user.estado_suscripcion === 'pendiente'
      ? (await q(`SELECT id, metodo_pago, referencia_pago, created_at FROM suscripciones
                  WHERE usuario_id=? AND estado='pendiente' ORDER BY created_at DESC LIMIT 1`,
                  [req.user.id]))[0] || null
      : null;

    res.json({ estado: user.estado_suscripcion, es_admin: !!user.es_admin, dias_restantes, solicitud });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suscripcion/solicitar', auth, async (req, res) => {
  const { metodo_pago, referencia_pago } = req.body;
  if (!metodo_pago || !referencia_pago)
    return res.status(400).json({ error: 'Método y referencia de pago son requeridos' });
  try {
    await q(`DELETE FROM suscripciones WHERE usuario_id=? AND estado='pendiente'`, [req.user.id]);
    const result = await q(
      `INSERT INTO suscripciones (usuario_id, estado, metodo_pago, referencia_pago, monto)
       VALUES (?, 'pendiente', ?, ?, ?)`,
      [req.user.id, metodo_pago, referencia_pago.trim(), PRECIO_PLAN]
    );
    await q(`UPDATE usuarios SET estado_suscripcion='pendiente' WHERE id=?`, [req.user.id]);
    res.json({ ok: true, id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suscripcion/activar', auth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  try {
    const subs = await q(
      `SELECT * FROM suscripciones WHERE usuario_id=? AND token=? AND estado='pendiente'`,
      [req.user.id, token.trim().toUpperCase()]
    );
    if (!subs.length) return res.status(400).json({ error: 'Token inválido o ya utilizado' });

    const fechaFin = new Date();
    fechaFin.setDate(fechaFin.getDate() + 30);

    await q(
      `UPDATE suscripciones SET estado='activo', fecha_inicio=NOW(), fecha_fin=? WHERE id=?`,
      [fechaFin, subs[0].id]
    );
    await q(`UPDATE usuarios SET estado_suscripcion='activo' WHERE id=?`, [req.user.id]);

    res.json({ ok: true, fecha_fin: fechaFin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/usuarios', adminAuth, async (req, res) => {
  try {
    const rows = await q(`
      SELECT u.id, u.nombre, u.email, u.nombre_negocio, u.estado_suscripcion, u.created_at,
             s.fecha_fin, s.metodo_pago
      FROM usuarios u
      LEFT JOIN suscripciones s ON s.usuario_id = u.id
        AND s.estado IN ('activo','pendiente')
        AND s.id = (SELECT MAX(s2.id) FROM suscripciones s2 WHERE s2.usuario_id = u.id)
      WHERE u.es_admin = 0
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/usuarios/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const users = await q(`SELECT es_admin FROM usuarios WHERE id=?`, [id]);
    if (!users.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (users[0].es_admin) return res.status(403).json({ error: 'No puedes eliminar un administrador' });
    await q(`DELETE FROM usuarios WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Endpoint para probar configuración de email desde el panel admin
app.post('/api/admin/test-email', adminAuth, async (req, res) => {
  const { email_destino } = req.body;
  const destino = email_destino || process.env.SMTP_USER || process.env.RESEND_FROM;
  if (!destino) return res.status(400).json({ error: 'Ingresa un correo de destino.' });

  const apiKey    = process.env.SMTP_USER;
  const secretKey = process.env.SMTP_PASS;
  const fromEmail = process.env.MAIL_FROM;

  if (!apiKey || !secretKey || !fromEmail) {
    return res.json({
      ok: false,
      diagnostico: {
        SMTP_USER:  apiKey    ? `✅ (${apiKey.length} chars)`    : '❌ NO DEFINIDA',
        SMTP_PASS:  secretKey ? `✅ (${secretKey.length} chars)` : '❌ NO DEFINIDA',
        MAIL_FROM:  fromEmail || '❌ NO DEFINIDA — agrega esta variable',
      },
      mensaje: !fromEmail
        ? 'Falta la variable MAIL_FROM. Agrégala en Railway con tu correo de Mailjet.'
        : 'Faltan credenciales de Mailjet (SMTP_USER / SMTP_PASS).'
    });
  }

  const html = `<div style="font-family:sans-serif;padding:24px;max-width:480px">
    <h2 style="color:#006d43">✅ Email de prueba — Faro App</h2>
    <p>Si ves este mensaje, el servidor está enviando emails correctamente vía Mailjet API.</p>
    <p style="color:#888;font-size:12px">Faro — Tu Copiloto de Negocio</p>
  </div>`;
  try {
    await sendEmail(destino, destino, '✅ Prueba de email — Faro App', html);
    console.log(`✅ Test email enviado a ${destino}`);
    res.json({ ok: true, mensaje: `Email enviado a ${destino} ✅` });
  } catch (err) {
    console.error(`❌ Test email falló: ${err.message}`);
    res.json({ ok: false, mensaje: `Error Mailjet: ${err.message}` });
  }
});

app.get('/api/admin/suscripciones', adminAuth, async (req, res) => {
  try {
    const rows = await q(`
      SELECT s.id, s.estado, s.metodo_pago, s.referencia_pago, s.token,
             s.token_enviado_en, s.fecha_inicio, s.fecha_fin, s.monto, s.created_at,
             u.nombre, u.email, u.nombre_negocio
      FROM suscripciones s
      JOIN usuarios u ON s.usuario_id = u.id
      ORDER BY
        CASE s.estado WHEN 'pendiente' THEN 0 WHEN 'activo' THEN 1 ELSE 2 END,
        s.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/generar-token/:id', adminAuth, async (req, res) => {
  try {
    const subs = await q(
      `SELECT s.*, u.email, u.nombre FROM suscripciones s
       JOIN usuarios u ON s.usuario_id = u.id WHERE s.id=?`,
      [req.params.id]
    );
    if (!subs.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const sub = subs[0];
    if (sub.estado !== 'pendiente')
      return res.status(400).json({ error: 'Esta solicitud no está pendiente' });

    const token = generarTokenAlfanum();
    await q(`UPDATE suscripciones SET token=?, token_enviado_en=NOW() WHERE id=?`, [token, sub.id]);
    const emailEnviado = await sendTokenEmail(sub.email, sub.nombre, token);

    res.json({ ok: true, token, email_enviado: emailEnviado, email_usuario: sub.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/alertas', adminAuth, async (req, res) => {
  try {
    const pendientes = await q(`
      SELECT s.id, s.metodo_pago, s.referencia_pago, s.created_at, s.monto,
             u.nombre, u.email, u.nombre_negocio
      FROM suscripciones s JOIN usuarios u ON s.usuario_id=u.id
      WHERE s.estado='pendiente' ORDER BY s.created_at ASC`);

    const por_vencer = await q(`
      SELECT s.id, s.fecha_fin, u.nombre, u.email,
             DATEDIFF(s.fecha_fin, NOW()) AS dias_restantes
      FROM suscripciones s JOIN usuarios u ON s.usuario_id=u.id
      WHERE s.estado='activo' AND s.fecha_fin BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 5 DAY)
      ORDER BY s.fecha_fin ASC`);

    const activas = await q(`
      SELECT COUNT(*) AS total FROM suscripciones WHERE estado='activo'`);

    res.json({ pendientes, por_vencer, activas: activas[0].total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  const uid = req.user.id;
  try {
    const [{ ingresos }] = await q(
      `SELECT COALESCE(SUM(monto),0) AS ingresos FROM finanzas
       WHERE usuario_id=? AND tipo='ingreso' AND MONTH(fecha)=MONTH(NOW()) AND YEAR(fecha)=YEAR(NOW())`, [uid]);
    const [{ gastos }] = await q(
      `SELECT COALESCE(SUM(monto),0) AS gastos FROM finanzas
       WHERE usuario_id=? AND tipo='gasto' AND MONTH(fecha)=MONTH(NOW()) AND YEAR(fecha)=YEAR(NOW())`, [uid]);
    const [{ total_productos }] = await q(`SELECT COUNT(*) AS total_productos FROM productos WHERE usuario_id=?`, [uid]);
    const [{ stock_bajo }] = await q(`SELECT COUNT(*) AS stock_bajo FROM productos WHERE usuario_id=? AND stock<=stock_minimo`, [uid]);
    const [{ total_proveedores }] = await q(`SELECT COUNT(*) AS total_proveedores FROM proveedores WHERE usuario_id=?`, [uid]);
    const metas = await q(`SELECT * FROM metas WHERE usuario_id=? ORDER BY es_principal DESC, created_at ASC LIMIT 1`, [uid]);
    res.json({
      ingresos: parseFloat(ingresos), gastos: parseFloat(gastos),
      flujo_caja: parseFloat(ingresos) - parseFloat(gastos),
      total_productos, stock_bajo, total_proveedores,
      meta_principal: metas[0] || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FINANZAS ──────────────────────────────────────────────────────────────────
app.get('/api/finanzas', auth, async (req, res) => {
  try { res.json(await q(`SELECT * FROM finanzas WHERE usuario_id=? ORDER BY fecha DESC, created_at DESC LIMIT 100`, [req.user.id])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/finanzas', auth, async (req, res) => {
  const { tipo, descripcion, monto, categoria, fecha } = req.body;
  if (!tipo || monto==null) return res.status(400).json({ error: 'Tipo y monto requeridos' });
  try {
    const r = await q(`INSERT INTO finanzas (usuario_id,tipo,descripcion,monto,categoria,fecha) VALUES (?,?,?,?,?,?)`,
      [req.user.id, tipo, descripcion||'', parseFloat(monto), categoria||'', fecha||new Date().toISOString().split('T')[0]]);
    res.json({ id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/finanzas/:id', auth, async (req, res) => {
  try { await q(`DELETE FROM finanzas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCTOS ─────────────────────────────────────────────────────────────────
app.get('/api/productos', auth, async (req, res) => {
  try { res.json(await q(`SELECT * FROM productos WHERE usuario_id=? ORDER BY nombre`, [req.user.id])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/productos', auth, async (req, res) => {
  const { nombre, categoria, precio_venta, costo_compra, stock, stock_minimo } = req.body;
  if (!nombre||precio_venta==null) return res.status(400).json({ error: 'Nombre y precio requeridos' });
  try {
    const r = await q(`INSERT INTO productos (usuario_id,nombre,categoria,precio_venta,costo_compra,stock,stock_minimo) VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, nombre.trim(), categoria||'', parseFloat(precio_venta), parseFloat(costo_compra||0), parseInt(stock||0), parseInt(stock_minimo||5)]);
    res.json({ id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/productos/:id', auth, async (req, res) => {
  const { nombre, categoria, precio_venta, costo_compra, stock, stock_minimo } = req.body;
  try {
    await q(`UPDATE productos SET nombre=?,categoria=?,precio_venta=?,costo_compra=?,stock=?,stock_minimo=? WHERE id=? AND usuario_id=?`,
      [nombre, categoria||'', parseFloat(precio_venta), parseFloat(costo_compra||0), parseInt(stock), parseInt(stock_minimo||5), req.params.id, req.user.id]);
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/productos/:id', auth, async (req, res) => {
  try { await q(`DELETE FROM productos WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VENTAS ────────────────────────────────────────────────────────────────────
app.get('/api/ventas', auth, async (req, res) => {
  try {
    const { desde, hasta, limite } = req.query;
    let sql = `SELECT * FROM ventas WHERE usuario_id=?`;
    const params = [req.user.id];
    if (desde) { sql += ` AND fecha >= ?`; params.push(desde); }
    if (hasta) { sql += ` AND fecha <= ?`; params.push(hasta); }
    sql += ` ORDER BY created_at DESC`;
    if (limite) { sql += ` LIMIT ?`; params.push(parseInt(limite)); }
    res.json(await q(sql, params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ventas', auth, async (req, res) => {
  const { producto_id, cantidad, precio_unitario, cliente, notas, fecha } = req.body;
  if (!cantidad || !precio_unitario) return res.status(400).json({ error: 'Cantidad y precio requeridos' });
  const uid = req.user.id;
  try {
    let producto_nombre = req.body.producto_nombre || 'Producto manual';
    let costo_unitario = parseFloat(req.body.costo_unitario || 0);

    if (producto_id) {
      const prods = await q(`SELECT nombre, costo_compra, stock FROM productos WHERE id=? AND usuario_id=?`, [producto_id, uid]);
      if (!prods.length) return res.status(404).json({ error: 'Producto no encontrado' });
      const prod = prods[0];
      if (prod.stock < parseInt(cantidad)) return res.status(400).json({ error: `Stock insuficiente. Disponible: ${prod.stock}` });
      producto_nombre = prod.nombre;
      costo_unitario = parseFloat(prod.costo_compra || 0);
      // Descontar del stock
      await q(`UPDATE productos SET stock = stock - ? WHERE id=? AND usuario_id=?`, [parseInt(cantidad), producto_id, uid]);
    }

    const cant = parseInt(cantidad);
    const precio = parseFloat(precio_unitario);
    const total = cant * precio;
    const ganancia = cant * (precio - costo_unitario);
    const fechaVenta = fecha || new Date().toISOString().split('T')[0];

    const r = await q(
      `INSERT INTO ventas (usuario_id,producto_id,producto_nombre,cantidad,precio_unitario,costo_unitario,total,ganancia,cliente,notas,fecha) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, producto_id || null, producto_nombre, cant, precio, costo_unitario, total, ganancia, cliente||'', notas||'', fechaVenta]
    );

    // Auto-registrar el TOTAL de la venta como ingreso en finanzas
    const descFinanza = `Venta: ${producto_nombre}${cant > 1 ? ' x'+cant : ''}`;
    await q(
      `INSERT INTO finanzas (usuario_id, tipo, monto, descripcion, categoria, fecha) VALUES (?,?,?,?,?,?)`,
      [uid, 'ingreso', total, descFinanza, 'Ventas', fechaVenta]
    );

    res.json({ id: r.insertId, total, ganancia });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ventas/:id', auth, async (req, res) => {
  try {
    const ventas = await q(`SELECT * FROM ventas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    if (!ventas.length) return res.status(404).json({ error: 'Venta no encontrada' });
    const v = ventas[0];

    // Devolver stock al producto si aplica
    if (v.producto_id) {
      await q(`UPDATE productos SET stock = stock + ? WHERE id=? AND usuario_id=?`, [v.cantidad, v.producto_id, req.user.id]);
    }

    // Eliminar el ingreso auto-registrado en finanzas
    // Normalizar fecha: MySQL puede devolver Date o string
    const fechaStr = v.fecha instanceof Date
      ? v.fecha.toISOString().split('T')[0]
      : String(v.fecha).slice(0, 10);
    const descFinanza = `Venta: ${v.producto_nombre}${parseInt(v.cantidad) > 1 ? ' x'+v.cantidad : ''}`;
    await q(
      `DELETE FROM finanzas WHERE usuario_id=? AND categoria='Ventas' AND descripcion=? AND fecha=? AND tipo='ingreso' LIMIT 1`,
      [req.user.id, descFinanza, fechaStr]
    );

    await q(`DELETE FROM ventas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PROVEEDORES ───────────────────────────────────────────────────────────────
app.get('/api/proveedores', auth, async (req, res) => {
  try { res.json(await q(`SELECT * FROM proveedores WHERE usuario_id=? ORDER BY nombre`, [req.user.id])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/proveedores', auth, async (req, res) => {
  const { nombre, categoria, contacto, telefono, plazo_entrega_dias } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const r = await q(`INSERT INTO proveedores (usuario_id,nombre,categoria,contacto,telefono,plazo_entrega_dias) VALUES (?,?,?,?,?,?)`,
      [req.user.id, nombre.trim(), categoria||'', contacto||'', telefono||'', parseInt(plazo_entrega_dias||3)]);
    res.json({ id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/proveedores/:id', auth, async (req, res) => {
  try { await q(`DELETE FROM proveedores WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── METAS ─────────────────────────────────────────────────────────────────────
app.get('/api/metas', auth, async (req, res) => {
  try { res.json(await q(`SELECT * FROM metas WHERE usuario_id=? ORDER BY es_principal DESC, created_at ASC`, [req.user.id])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/metas', auth, async (req, res) => {
  const { titulo, monto_objetivo, monto_actual, es_principal, fecha_limite } = req.body;
  if (!titulo||monto_objetivo==null) return res.status(400).json({ error: 'Título y objetivo requeridos' });
  try {
    if (es_principal) await q(`UPDATE metas SET es_principal=0 WHERE usuario_id=?`, [req.user.id]);
    const r = await q(`INSERT INTO metas (usuario_id,titulo,monto_objetivo,monto_actual,es_principal,fecha_limite) VALUES (?,?,?,?,?,?)`,
      [req.user.id, titulo.trim(), parseFloat(monto_objetivo), parseFloat(monto_actual||0), es_principal?1:0, fecha_limite||null]);
    res.json({ id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/metas/:id', auth, async (req, res) => {
  const { monto_actual, es_principal } = req.body;
  try {
    if (es_principal) await q(`UPDATE metas SET es_principal=0 WHERE usuario_id=?`, [req.user.id]);
    await q(`UPDATE metas SET monto_actual=?,es_principal=? WHERE id=? AND usuario_id=?`,
      [parseFloat(monto_actual), es_principal?1:0, req.params.id, req.user.id]);
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/metas/:id', auth, async (req, res) => {
  try { await q(`DELETE FROM metas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHATBOT ───────────────────────────────────────────────────────────────────
app.post('/api/chat', auth, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje requerido' });
  const uid = req.user.id;
  try {
    const productos  = await q(`SELECT * FROM productos WHERE usuario_id=?`, [uid]);
    const proveedores= await q(`SELECT * FROM proveedores WHERE usuario_id=?`, [uid]);
    const metas      = await q(`SELECT * FROM metas WHERE usuario_id=?`, [uid]);
    const finanzas   = await q(`SELECT * FROM finanzas WHERE usuario_id=? AND MONTH(fecha)=MONTH(NOW()) AND YEAR(fecha)=YEAR(NOW())`, [uid]);
    const ingresos   = finanzas.filter(f=>f.tipo==='ingreso').reduce((s,f)=>s+parseFloat(f.monto),0);
    const gastos     = finanzas.filter(f=>f.tipo==='gasto').reduce((s,f)=>s+parseFloat(f.monto),0);
    const stockBajo  = productos.filter(p=>parseInt(p.stock)<=parseInt(p.stock_minimo));
    res.json({ respuesta: generarRespuesta(mensaje, { usuario:req.user, ingresos, gastos, productos, stockBajo, proveedores, metas }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function generarRespuesta(mensaje, ctx) {
  const msg = mensaje.toLowerCase().trim();
  const { usuario, ingresos, gastos, productos, stockBajo, proveedores, metas } = ctx;
  const flujo = ingresos - gastos;
  const nombre = (usuario.nombre||'Empresario').split(' ')[0];
  const fmt = n => new Intl.NumberFormat('es-CO',{maximumFractionDigits:0}).format(n||0);
  const $$ = n => `$${fmt(n)}`;

  if (/^(hola|hey|buenos|buen\s|qué\s*tal|buenas|saludo|hi\b)/i.test(msg)) {
    const alertas=[];
    if (stockBajo.length) alertas.push(`⚠️ ${stockBajo.length} producto(s) con stock bajo`);
    if (flujo<0&&ingresos>0) alertas.push(`📉 Flujo de caja negativo este mes`);
    let r=`¡Hola, ${nombre}! 👋 Soy tu **Mentor de Bolsillo**.\n\n`;
    if (alertas.length) r+=`**Alertas:**\n${alertas.map(a=>`• ${a}`).join('\n')}\n\n`;
    r+=`Puedo ayudarte con:\n• "¿Cómo están mis finanzas?"\n• "¿Qué stock tengo bajo?"\n• "Dame un consejo"`;
    return r;
  }
  if (/finanza|dinero|caja|flujo|ingreso|gasto|plata/i.test(msg)) {
    if (!ingresos&&!gastos) return `${nombre}, aún no hay movimientos este mes. Ve a **Mi Dinero** y registra tus primeros datos. 📊`;
    const margen=ingresos>0?((flujo/ingresos)*100).toFixed(1):0;
    let r=`📊 **Finanzas de este mes:**\n\n• Ingresos: **${$$(ingresos)}**\n• Gastos: **${$$(gastos)}**\n• Flujo neto: **${flujo>=0?'+':''}${$$(Math.abs(flujo))}** (${margen}%)\n\n`;
    if (flujo>0) r+=`✅ ¡Rentable! Guarda **${$$(flujo*0.3)}** (30%) para reinvertir.`;
    else if (flujo<0) r+=`⚠️ Estás gastando más de lo que ingresas. Revisa qué gastos reducir.`;
    else r+=`⚖️ Equilibrio exacto. Aumenta ingresos o reduce gastos.`;
    return r;
  }
  if (/stock|inventario|producto|existencia|agot/i.test(msg)) {
    if (!productos.length) return `${nombre}, aún no tienes productos. Ve a **Stock Visual** para agregarlos. 📦`;
    let r=`📦 **Inventario:**\n\n• Registrados: **${productos.length}**\n• OK: **${productos.length-stockBajo.length}**\n`;
    if (stockBajo.length) r+=`• ⚠️ Stock bajo: **${stockBajo.length}** → ${stockBajo.map(p=>p.nombre).join(', ')}\n\n🚨 Repón estos productos pronto.`;
    else r+=`\n✅ Todo el inventario tiene stock suficiente.`;
    return r;
  }
  if (/margen|rentab|utilidad|ganancia|product.*mejor/i.test(msg)) {
    if (!productos.length) return `${nombre}, registra productos con costo y precio para calcular márgenes. 📦`;
    const conMargen=productos.map(p=>({...p,margen:p.precio_venta>0?((p.precio_venta-p.costo_compra)/p.precio_venta*100):0})).sort((a,b)=>b.margen-a.margen);
    const top=conMargen[0];
    const avg=(conMargen.reduce((s,p)=>s+p.margen,0)/conMargen.length).toFixed(1);
    let r=`📈 **Márgenes:**\n\n• Promedio: **${avg}%**\n• Más rentable: **${top.nombre}** (${top.margen.toFixed(1)}%)\n\n💡 Enfócate en vender más **"${top.nombre}"**.`;
    return r;
  }
  if (/proveedor|insumo|surtir/i.test(msg)) {
    if (!proveedores.length) return `${nombre}, aún no tienes proveedores. Ve a **Tus Aliados**. 🚚`;
    return `🚚 **Proveedores:** ${proveedores.length} registrados\n${proveedores.map(p=>`• ${p.nombre}${p.plazo_entrega_dias?` (${p.plazo_entrega_dias}d)`:''}`).join('\n')}`;
  }
  if (/meta|objetivo|progreso|logro/i.test(msg)) {
    if (!metas.length) return `${nombre}, crea tu primera meta en **Tu Norte**. 🎯`;
    const m=metas.find(x=>x.es_principal)||metas[0];
    const pct=m.monto_objetivo>0?(m.monto_actual/m.monto_objetivo*100).toFixed(0):0;
    const falta=Math.max(0,parseFloat(m.monto_objetivo)-parseFloat(m.monto_actual));
    return `🎯 **"${m.titulo}"**\n• ${$$(m.monto_actual)} / ${$$(m.monto_objetivo)} (${pct}%)\n• Falta: **${$$(falta)}**\n\n${parseInt(pct)>=70?'🚀 ¡Excelente avance!':parseInt(pct)>=40?'💪 Vas bien, sigue adelante.':'💡 Define 3 acciones concretas esta semana.'}`;
  }
  if (/consejo|ayuda|qué.*hago|estrategia|recomienda/i.test(msg)) {
    const tips=[];
    if (stockBajo.length) tips.push(`⚠️ **Reponer stock:** ${stockBajo.map(p=>`"${p.nombre}"`).join(', ')}`);
    if (flujo>0) tips.push(`💰 **Regla 30%:** Guarda ${$$(flujo*0.3)} para reinvertir`);
    if (productos.length) { const top=[...productos].sort((a,b)=>(parseFloat(b.precio_venta)-parseFloat(b.costo_compra))-(parseFloat(a.precio_venta)-parseFloat(a.costo_compra)))[0]; tips.push(`🚀 **Producto estrella:** "${top.nombre}" tiene el mejor margen`); }
    if (!tips.length) return `${nombre}, todo luce bien. Sigue registrando datos para consejos más precisos. 🌟`;
    return `💡 **Mis consejos, ${nombre}:**\n\n${tips.map((t,i)=>`${i+1}. ${t}`).join('\n\n')}`;
  }
  if (/gracias|perfecto|excelente|genial/i.test(msg)) return `¡Con gusto, ${nombre}! 😊 ¿En qué más puedo ayudarte?`;
  return `${nombre}, puedo ayudarte con:\n\n• 💵 Finanzas\n• 📦 Inventario\n• 🚚 Proveedores\n• 🎯 Metas\n• 📈 Estrategias\n\n¿Sobre qué quieres saber?`;
}

// ── FRONTEND ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(FRONTEND_PATH));

// ── START ─────────────────────────────────────────────────────────────────────
initDB()
  .then(async () => {
    await testSMTP();
    const port = parseInt(process.env.PORT) || 3002;
    app.listen(port, () => {
      console.log(`🚀 Faro Backend → http://localhost:${port}`);
      console.log(`   DB: ${DB_NAME} | ADMIN_EMAILS: ${ADMIN_EMAILS.join(',') || '(ninguno)'}`);
      console.log(`   SMTP_USER: ${process.env.SMTP_USER || '(no configurado)'}`);
    });
  })
  .catch(err => { console.error('No se pudo iniciar:', err.message); process.exit(1); });
