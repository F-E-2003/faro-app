import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// Busca index.html en varias ubicaciones posibles según el entorno
const FRONTEND_PATH = [
  join(__dirname, '../../index.html'),   // local: Faro/backend/src → Faro/
  join(__dirname, '../index.html'),      // Railway root = backend/
  join(process.cwd(), 'index.html'),     // Railway cwd
].find(existsSync) ?? join(__dirname, '../../index.html');

const STATIC_PATH = join(FRONTEND_PATH, '..');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(STATIC_PATH));

const JWT_SECRET = process.env.JWT_SECRET || 'faro_copiloto_2026';
const DB_NAME = process.env.DB_NAME || 'faro_negocio';

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

    await conn.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nombre_negocio VARCHAR(150) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
      )
    `);

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
      )
    `);

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
      )
    `);

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
      )
    `);

    console.log(`✅ DB "${DB_NAME}" inicializada correctamente`);
  } catch (err) {
    console.error('❌ Error init DB:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

// helper para pool con DB seleccionada
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

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { nombre, email, password, nombre_negocio } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await q(
      'INSERT INTO usuarios (nombre, email, password_hash, nombre_negocio) VALUES (?, ?, ?, ?)',
      [nombre.trim(), email.trim().toLowerCase(), hash, (nombre_negocio || '').trim()]
    );
    const usuario = { id: result.insertId, nombre: nombre.trim(), email: email.trim().toLowerCase(), nombre_negocio: (nombre_negocio || '').trim() };
    const token = jwt.sign(usuario, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, usuario });
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
    const rows = await q('SELECT * FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const usuario = { id: user.id, nombre: user.nombre, email: user.email, nombre_negocio: user.nombre_negocio };
    const token = jwt.sign(usuario, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, usuario });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
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
    const [{ stock_bajo }] = await q(`SELECT COUNT(*) AS stock_bajo FROM productos WHERE usuario_id=? AND stock <= stock_minimo`, [uid]);
    const [{ total_proveedores }] = await q(`SELECT COUNT(*) AS total_proveedores FROM proveedores WHERE usuario_id=?`, [uid]);
    const metas = await q(`SELECT * FROM metas WHERE usuario_id=? ORDER BY es_principal DESC, created_at ASC LIMIT 1`, [uid]);

    res.json({
      ingresos: parseFloat(ingresos),
      gastos: parseFloat(gastos),
      flujo_caja: parseFloat(ingresos) - parseFloat(gastos),
      total_productos,
      stock_bajo,
      total_proveedores,
      meta_principal: metas[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── FINANZAS ──────────────────────────────────────────────────────────────────
app.get('/api/finanzas', auth, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM finanzas WHERE usuario_id=? ORDER BY fecha DESC, created_at DESC LIMIT 100`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finanzas', auth, async (req, res) => {
  const { tipo, descripcion, monto, categoria, fecha } = req.body;
  if (!tipo || monto == null) return res.status(400).json({ error: 'Tipo y monto son requeridos' });
  try {
    const result = await q(
      `INSERT INTO finanzas (usuario_id, tipo, descripcion, monto, categoria, fecha) VALUES (?,?,?,?,?,?)`,
      [req.user.id, tipo, descripcion || '', parseFloat(monto), categoria || '', fecha || new Date().toISOString().split('T')[0]]
    );
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finanzas/:id', auth, async (req, res) => {
  try {
    await q(`DELETE FROM finanzas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCTOS ─────────────────────────────────────────────────────────────────
app.get('/api/productos', auth, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM productos WHERE usuario_id=? ORDER BY nombre`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/productos', auth, async (req, res) => {
  const { nombre, categoria, precio_venta, costo_compra, stock, stock_minimo } = req.body;
  if (!nombre || precio_venta == null) return res.status(400).json({ error: 'Nombre y precio son requeridos' });
  try {
    const result = await q(
      `INSERT INTO productos (usuario_id, nombre, categoria, precio_venta, costo_compra, stock, stock_minimo) VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, nombre.trim(), categoria || '', parseFloat(precio_venta), parseFloat(costo_compra || 0), parseInt(stock || 0), parseInt(stock_minimo || 5)]
    );
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', auth, async (req, res) => {
  const { nombre, categoria, precio_venta, costo_compra, stock, stock_minimo } = req.body;
  try {
    await q(
      `UPDATE productos SET nombre=?, categoria=?, precio_venta=?, costo_compra=?, stock=?, stock_minimo=? WHERE id=? AND usuario_id=?`,
      [nombre, categoria || '', parseFloat(precio_venta), parseFloat(costo_compra || 0), parseInt(stock), parseInt(stock_minimo || 5), req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', auth, async (req, res) => {
  try {
    await q(`DELETE FROM productos WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PROVEEDORES ───────────────────────────────────────────────────────────────
app.get('/api/proveedores', auth, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM proveedores WHERE usuario_id=? ORDER BY nombre`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proveedores', auth, async (req, res) => {
  const { nombre, categoria, contacto, telefono, plazo_entrega_dias } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const result = await q(
      `INSERT INTO proveedores (usuario_id, nombre, categoria, contacto, telefono, plazo_entrega_dias) VALUES (?,?,?,?,?,?)`,
      [req.user.id, nombre.trim(), categoria || '', contacto || '', telefono || '', parseInt(plazo_entrega_dias || 3)]
    );
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/proveedores/:id', auth, async (req, res) => {
  try {
    await q(`DELETE FROM proveedores WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── METAS ─────────────────────────────────────────────────────────────────────
app.get('/api/metas', auth, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM metas WHERE usuario_id=? ORDER BY es_principal DESC, created_at ASC`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/metas', auth, async (req, res) => {
  const { titulo, monto_objetivo, monto_actual, es_principal, fecha_limite } = req.body;
  if (!titulo || monto_objetivo == null) return res.status(400).json({ error: 'Título y objetivo requeridos' });
  try {
    // Si esta será la principal, quitar es_principal de las demás
    if (es_principal) {
      await q(`UPDATE metas SET es_principal=0 WHERE usuario_id=?`, [req.user.id]);
    }
    const result = await q(
      `INSERT INTO metas (usuario_id, titulo, monto_objetivo, monto_actual, es_principal, fecha_limite) VALUES (?,?,?,?,?,?)`,
      [req.user.id, titulo.trim(), parseFloat(monto_objetivo), parseFloat(monto_actual || 0), es_principal ? 1 : 0, fecha_limite || null]
    );
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/metas/:id', auth, async (req, res) => {
  const { monto_actual, es_principal } = req.body;
  try {
    if (es_principal) {
      await q(`UPDATE metas SET es_principal=0 WHERE usuario_id=?`, [req.user.id]);
    }
    await q(
      `UPDATE metas SET monto_actual=?, es_principal=? WHERE id=? AND usuario_id=?`,
      [parseFloat(monto_actual), es_principal ? 1 : 0, req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/metas/:id', auth, async (req, res) => {
  try {
    await q(`DELETE FROM metas WHERE id=? AND usuario_id=?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHATBOT ───────────────────────────────────────────────────────────────────
app.post('/api/chat', auth, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje requerido' });
  const uid = req.user.id;
  try {
    const productos = await q(`SELECT * FROM productos WHERE usuario_id=?`, [uid]);
    const proveedores = await q(`SELECT * FROM proveedores WHERE usuario_id=?`, [uid]);
    const metas = await q(`SELECT * FROM metas WHERE usuario_id=?`, [uid]);
    const finanzas = await q(
      `SELECT * FROM finanzas WHERE usuario_id=? AND MONTH(fecha)=MONTH(NOW()) AND YEAR(fecha)=YEAR(NOW())`, [uid]
    );
    const ingresos = finanzas.filter(f => f.tipo === 'ingreso').reduce((s, f) => s + parseFloat(f.monto), 0);
    const gastos = finanzas.filter(f => f.tipo === 'gasto').reduce((s, f) => s + parseFloat(f.monto), 0);
    const stockBajo = productos.filter(p => parseInt(p.stock) <= parseInt(p.stock_minimo));
    const respuesta = generarRespuesta(mensaje, { usuario: req.user, ingresos, gastos, productos, stockBajo, proveedores, metas });
    res.json({ respuesta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function generarRespuesta(mensaje, ctx) {
  const msg = mensaje.toLowerCase().trim();
  const { usuario, ingresos, gastos, productos, stockBajo, proveedores, metas } = ctx;
  const flujo = ingresos - gastos;
  const nombre = (usuario.nombre || 'Empresario').split(' ')[0];
  const fmt = n => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n || 0);
  const $$ = n => `$${fmt(n)}`;

  // Saludo
  if (/^(hola|hey|buenos|buen\s|qué\s*tal|buenas|saludo|hi\b)/i.test(msg)) {
    const alertas = [];
    if (stockBajo.length) alertas.push(`⚠️ ${stockBajo.length} producto(s) con stock bajo`);
    if (flujo < 0 && ingresos > 0) alertas.push(`📉 Flujo de caja negativo este mes`);
    let r = `¡Hola, ${nombre}! 👋 Soy tu **Mentor de Bolsillo**.\n\n`;
    if (alertas.length) r += `**Alertas:**\n${alertas.map(a => `• ${a}`).join('\n')}\n\n`;
    r += `Puedo ayudarte con:\n• "¿Cómo están mis finanzas?"\n• "¿Qué stock tengo bajo?"\n• "Dame un consejo"\n• "¿Cuál es mi mejor producto?"`;
    return r;
  }

  // Finanzas
  if (/finanza|dinero|caja|flujo|cuánto.*queda|cuánto.*gan|ingreso|gasto|plata/i.test(msg)) {
    if (!ingresos && !gastos)
      return `${nombre}, aún no hay movimientos este mes. Ve a **Mi Dinero** y registra tus primeros ingresos y gastos. 📊`;
    const margen = ingresos > 0 ? ((flujo / ingresos) * 100).toFixed(1) : 0;
    let r = `📊 **Finanzas de este mes:**\n\n• Ingresos: **${$$(ingresos)}**\n• Gastos: **${$$(gastos)}**\n• Flujo neto: **${flujo >= 0 ? '+' : ''}${$$(Math.abs(flujo))}** (${margen}%)\n\n`;
    if (flujo > 0) r += `✅ ¡Rentable! Guarda **${$$(flujo * 0.3)}** (30%) para reinvertir en stock.`;
    else if (flujo < 0) r += `⚠️ Estás gastando más de lo que ingresas. Revisa qué gastos puedes reducir.`;
    else r += `⚖️ Equilibrio exacto. Aumenta ingresos o reduce un gasto para generar utilidad.`;
    return r;
  }

  // Stock
  if (/stock|inventario|producto|existencia|agot|cuántos.*producto/i.test(msg)) {
    if (!productos.length)
      return `${nombre}, aún no tienes productos en inventario. Ve a **Stock Visual** para agregarlos. 📦`;
    let r = `📦 **Inventario:**\n\n• Productos registrados: **${productos.length}**\n• Stock OK: **${productos.length - stockBajo.length}**\n`;
    if (stockBajo.length) {
      r += `• ⚠️ Stock bajo: **${stockBajo.length}** → ${stockBajo.map(p => p.nombre).join(', ')}\n\n🚨 Repón estos productos pronto para no perder ventas.`;
    } else {
      r += `\n✅ ¡Todo tu inventario tiene stock suficiente!`;
    }
    return r;
  }

  // Margen / rentabilidad
  if (/margen|rentab|utilidad|ganancia.*product|product.*mejor|más.*vend/i.test(msg)) {
    if (!productos.length)
      return `${nombre}, registra tus productos en **Stock Visual** con costo y precio para calcular márgenes. 📦`;
    const conMargen = productos
      .map(p => ({ ...p, margen: p.precio_venta > 0 ? ((p.precio_venta - p.costo_compra) / p.precio_venta * 100) : 0 }))
      .sort((a, b) => b.margen - a.margen);
    const top = conMargen[0];
    const avg = (conMargen.reduce((s, p) => s + p.margen, 0) / conMargen.length).toFixed(1);
    let r = `📈 **Márgenes de tus productos:**\n\n• Promedio: **${avg}%**\n• Más rentable: **${top.nombre}** (${top.margen.toFixed(1)}%)\n\n`;
    r += `💡 Enfócate en vender más **"${top.nombre}"** — es tu producto estrella.`;
    if (conMargen.length > 1) {
      const bajo = conMargen[conMargen.length - 1];
      if (bajo.margen < 15) r += `\n⚠️ **"${bajo.nombre}"** tiene bajo margen (${bajo.margen.toFixed(1)}%). Considera subir su precio.`;
    }
    return r;
  }

  // Proveedores
  if (/proveedor|insumo|surtir|materia prima|quién.*vende/i.test(msg)) {
    if (!proveedores.length)
      return `${nombre}, aún no tienes proveedores registrados. Ve a **Tus Aliados** para agregarlos. 🚚`;
    return `🚚 **Tus proveedores:**\n\n• Total registrados: **${proveedores.length}**\n${proveedores.map(p => `• ${p.nombre}${p.plazo_entrega_dias ? ` (${p.plazo_entrega_dias} días entrega)` : ''}`).join('\n')}\n\n💡 Mantén buena relación con ellos para negociar mejores precios y plazos.`;
  }

  // Metas
  if (/meta|objetivo|progreso|logro|cuánto.*falta|cuándo.*llego/i.test(msg)) {
    if (!metas.length)
      return `${nombre}, aún no tienes metas definidas. Ve a **Tu Norte** y crea tu primera meta. ¡Los negocios con metas claras crecen 2x más! 🎯`;
    const m = metas.find(x => x.es_principal) || metas[0];
    const pct = m.monto_objetivo > 0 ? (m.monto_actual / m.monto_objetivo * 100).toFixed(0) : 0;
    const falta = Math.max(0, parseFloat(m.monto_objetivo) - parseFloat(m.monto_actual));
    let r = `🎯 **Meta principal:**\n\n• "${m.titulo}"\n• Progreso: **${$$(m.monto_actual)} / ${$$(m.monto_objetivo)}** (${pct}%)\n• Falta: **${$$(falta)}**\n\n`;
    r += parseInt(pct) >= 70 ? `🚀 ¡Excelente avance! Mantén el ritmo.` : parseInt(pct) >= 40 ? `💪 Vas bien. Enfócate en tus productos más rentables para acelerar.` : `💡 Aún hay camino. Define 3 acciones concretas para esta semana.`;
    return r;
  }

  // Consejo
  if (/consejo|ayuda|qué.*hago|qué.*debo|cómo.*mejo|estrategia|recomienda|qué.*puedo|qué.*hacer/i.test(msg)) {
    const tips = [];
    if (stockBajo.length) tips.push(`⚠️ **Reponer stock:** ${stockBajo.map(p => `"${p.nombre}"`).join(', ')} están por agotarse.`);
    if (flujo > 0) tips.push(`💰 **Regla del 30%:** Tienes ${$$(flujo)} de flujo positivo. Guarda ${$$(flujo * 0.3)} para reinvertir.`);
    if (productos.length) {
      const top = [...productos].sort((a, b) => (parseFloat(b.precio_venta) - parseFloat(b.costo_compra)) - (parseFloat(a.precio_venta) - parseFloat(a.costo_compra)))[0];
      tips.push(`🚀 **Producto estrella:** "${top.nombre}" tiene el mejor margen. ¡Véndelo más!`);
    }
    if (metas.length) {
      const m = metas.find(x => x.es_principal) || metas[0];
      const pct = m.monto_objetivo > 0 ? (m.monto_actual / m.monto_objetivo * 100) : 0;
      if (pct < 50) tips.push(`🎯 **Meta rezagada:** Solo llevas el ${pct.toFixed(0)}% de "${m.titulo}". Define acciones concretas esta semana.`);
    }
    if (!tips.length) return `${nombre}, todo luce bien. ¡Sigue registrando datos para consejos más precisos! 🌟\n\n**Principios clave:**\n• Registra cada movimiento diariamente\n• Revisa márgenes cada semana\n• Nunca dejes stock en cero\n• Guarda el 30% de tu ganancia`;
    return `💡 **Mis consejos para ti, ${nombre}:**\n\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n\n')}`;
  }

  // Cómo usar la app
  if (/cómo.*uso|cómo.*funciona|qué.*hace|dónde.*registro|cómo.*agrego/i.test(msg)) {
    return `📱 **Cómo usar Faro, ${nombre}:**\n\n💵 **Mi Dinero** → Registra ingresos y gastos\n📦 **Stock Visual** → Gestiona productos e inventario\n🚚 **Proveedores** → Registra a quién te surte\n🎯 **Metas** → Define y sigue tus objetivos\n🔧 **Herramientas** → Calculadoras financieras\n🤖 **Yo (Mentor)** → Consejos personalizados\n\n¿Sobre qué sección necesitas ayuda?`;
  }

  // Agradecimiento
  if (/gracias|perfecto|excelente|genial|muy bien|chévere|bacano|buenísimo/i.test(msg)) {
    return `¡Con gusto, ${nombre}! 😊 Para eso estoy aquí. ¿Hay algo más en lo que pueda ayudarte?`;
  }

  // Escenarios
  if (/qué pasa.*si|qué pasaría|simula|escenario|si subiera|si bajara|si vendiera/i.test(msg)) {
    return `🔮 ¡Buena pregunta, ${nombre}! Para simular escenarios usa la **Calculadora de Margen** en Herramientas.\n\nO cuéntame el escenario específico, por ejemplo:\n• "¿Qué pasa si subo el precio 10%?"\n• "¿Cuánto necesito vender para cubrir $X gastos?"\n\nY yo te ayudo a calcularlo.`;
  }

  // Default
  return `${nombre}, entendí tu pregunta. Puedo ayudarte con:\n\n• 💵 **Finanzas** y flujo de caja\n• 📦 **Inventario** y stock\n• 🚚 **Proveedores** y pagos\n• 🎯 **Metas** y progreso\n• 📈 **Estrategias** para mejorar ventas\n\n¿Cuál de estos temas te interesa?`;
}

// ── FRONTEND ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(FRONTEND_PATH));

// ── START ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    const port = parseInt(process.env.PORT) || 3002;
    app.listen(port, () => {
      console.log(`🚀 Faro Backend → http://localhost:${port}`);
      console.log(`   DB: ${DB_NAME} | Puerto MySQL: ${process.env.DB_PORT || 3308}`);
    });
  })
  .catch(err => {
    console.error('No se pudo iniciar:', err.message);
    process.exit(1);
  });
