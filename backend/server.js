require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-in-production';
const MAX_ID = 2147483647;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cutting_supervisor','cutting_verifier','sewing_supervisor')),
  full_name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY, recipe_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
  std_fabric_yards DOUBLE PRECISION NOT NULL, wastage_cap DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS recipe_components (
  id SERIAL PRIMARY KEY, recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  component_name TEXT NOT NULL, pieces_per_garment INTEGER NOT NULL, image_url TEXT);
CREATE TABLE IF NOT EXISTS cutting_orders (
  id SERIAL PRIMARY KEY, order_no TEXT UNIQUE, recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  target_qty INTEGER NOT NULL CHECK (target_qty > 0), fabric_roll_id TEXT NOT NULL,
  actual_fabric_yds DOUBLE PRECISION NOT NULL CHECK (actual_fabric_yds > 0),
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('PENDING_VERIFICATION','REJECTED','VERIFIED')),
  created_by INTEGER NOT NULL REFERENCES users(id), sewing_started_at TIMESTAMPTZ, sewing_started_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS verification_items (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES cutting_orders(id),
  component_id INTEGER NOT NULL REFERENCES recipe_components(id), expected_qty INTEGER NOT NULL,
  actual_qty INTEGER NOT NULL CHECK (actual_qty >= 0), status TEXT NOT NULL CHECK (status IN ('GREEN','YELLOW','RED')),
  UNIQUE (order_id, component_id));
CREATE TABLE IF NOT EXISTS verification_logs (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES cutting_orders(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id), decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  rejection_note TEXT, wastage_pct DOUBLE PRECISION NOT NULL, variance_json TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL);
CREATE OR REPLACE FUNCTION block_log_changes() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'verification logs are immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS verification_logs_immutable ON verification_logs;
CREATE TRIGGER verification_logs_immutable BEFORE UPDATE OR DELETE ON verification_logs
FOR EACH ROW EXECUTE FUNCTION block_log_changes();
`;

function createPool(connectionString = process.env.DATABASE_URL) {
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString || '');
  return new Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

async function initializeDatabase(pool) {
  await pool.query(SCHEMA);
  const existing = await pool.query('SELECT COUNT(*)::int AS total FROM users');
  if (existing.rows[0].total > 0) return;
  const passwordHash = bcrypt.hashSync('Demo@1234', 10);
  const insertUser = 'INSERT INTO users (email, password_hash, role, full_name) VALUES ($1, $2, $3, $4)';
  await pool.query(insertUser, ['supervisor@apparelflow.test', passwordHash, 'cutting_supervisor', 'Nimal Perera']);
  await pool.query(insertUser, ['verifier@apparelflow.test', passwordHash, 'cutting_verifier', 'Kamala Silva']);
  await pool.query(insertUser, ['sewing@apparelflow.test', passwordHash, 'sewing_supervisor', 'Sunil Fernando']);
  const recipeData = [
    ['REC-BL01', 'Casual Blouse', 'Blouse', 1.8, 5.0, [['Front Body Panel', 1], ['Back Body Panel', 1], ['Sleeves (Left & Right)', 2], ['Collar & Stand', 1], ['Sleeve Cuffs', 2]]],
    ['REC-CT02', 'Crop Top', 'Crop Top', 1.1, 8.0, [['Front Chest Panel', 1], ['Back Support Panel', 1], ['Neck Binding Strip', 1], ['Hem Elastic Casing', 1], ['Side Strap Accents', 2]]],
  ];
  for (const [code, name, category, yards, cap, components] of recipeData) {
    const inserted = await pool.query(
      'INSERT INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [code, name, category, yards, cap]);
    for (const [componentName, pieces] of components) {
      await pool.query('INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment) VALUES ($1,$2,$3)',
        [inserted.rows[0].id, componentName, pieces]);
    }
  }
}

function trafficLight(expectedQty, actualQty) {
  if (actualQty === expectedQty) return 'GREEN';
  return actualQty > expectedQty ? 'YELLOW' : 'RED';
}

function isWholeNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ID;
}

function parseId(value) {
  const text = String(value);
  return /^\d+$/.test(text) && Number(text) <= MAX_ID ? Number(text) : null;
}

const asyncHandler = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

function createApp(pool) {
  const app = express();
  const allowedOrigins = (process.env.CLIENT_ORIGIN || '*').split(',').map((origin) => origin.trim());
  app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
  app.use(express.json());

  // Server-side authentication and role check. The role comes from the signed token, never from the request body.
  function requireRole(...allowedRoles) {
    return (request, response, next) => {
      const header = request.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      try {
        request.user = jwt.verify(token, JWT_SECRET);
      } catch (error) {
        return response.status(401).json({ error: 'Authentication required' });
      }
      if (!allowedRoles.includes(request.user.role)) {
        return response.status(403).json({ error: 'Forbidden: your role cannot perform this action' });
      }
      next();
    };
  }

  async function loadOrderDetail(orderId) {
    if (orderId === null) return null;
    const orderResult = await pool.query(`
      SELECT o.*, r.name AS recipe_name, r.recipe_code, r.std_fabric_yards, r.wastage_cap, u.full_name AS created_by_name
      FROM cutting_orders o JOIN recipes r ON r.id = o.recipe_id JOIN users u ON u.id = o.created_by WHERE o.id = $1`, [orderId]);
    const order = orderResult.rows[0];
    if (!order) return null;
    order.expected_fabric_yds = Math.round(order.std_fabric_yards * order.target_qty * 100) / 100;
    const components = await pool.query(`
      SELECT c.id AS component_id, c.component_name, c.pieces_per_garment, c.pieces_per_garment * $1::int AS expected_qty,
             i.actual_qty, i.status
      FROM recipe_components c LEFT JOIN verification_items i ON i.component_id = c.id AND i.order_id = $2
      WHERE c.recipe_id = $3 ORDER BY c.id`, [order.target_qty, orderId, order.recipe_id]);
    order.components = components.rows;
    const logs = await pool.query(`
      SELECT l.*, u.full_name AS verifier_name FROM verification_logs l JOIN users u ON u.id = l.verifier_id
      WHERE l.order_id = $1 ORDER BY l.id DESC`, [orderId]);
    order.log = logs.rows;
    return order;
  }

  function calculateWastagePercent(order) {
    const expectedFabric = order.std_fabric_yards * order.target_qty;
    return Math.round(((order.actual_fabric_yds - expectedFabric) / expectedFabric) * 10000) / 100;
  }

  app.get('/api/health', (request, response) => response.json({ ok: true }));

  app.post('/api/login', asyncHandler(async (request, response) => {
    const { email, password } = request.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return response.status(400).json({ error: 'Email and password are required' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return response.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, role: user.role, name: user.full_name }, JWT_SECRET, { expiresIn: '8h' });
    response.json({ token, user: { id: user.id, role: user.role, full_name: user.full_name } });
  }));

  app.get('/api/recipes', requireRole('cutting_supervisor', 'cutting_verifier'), asyncHandler(async (request, response) => {
    const recipes = (await pool.query('SELECT * FROM recipes ORDER BY id')).rows;
    for (const recipe of recipes) {
      recipe.components = (await pool.query('SELECT * FROM recipe_components WHERE recipe_id = $1 ORDER BY id', [recipe.id])).rows;
    }
    response.json(recipes);
  }));

  app.get('/api/orders', requireRole('cutting_supervisor', 'cutting_verifier'), asyncHandler(async (request, response) => {
    const result = await pool.query(`
      SELECT o.*, r.name AS recipe_name, r.recipe_code,
        (SELECT rejection_note FROM verification_logs WHERE order_id = o.id AND decision = 'REJECTED' ORDER BY id DESC LIMIT 1) AS last_rejection_note
      FROM cutting_orders o JOIN recipes r ON r.id = o.recipe_id ORDER BY o.id DESC`);
    response.json(result.rows);
  }));

  app.get('/api/orders/:id', requireRole('cutting_supervisor', 'cutting_verifier'), asyncHandler(async (request, response) => {
    const order = await loadOrderDetail(parseId(request.params.id));
    if (!order) return response.status(404).json({ error: 'Order not found' });
    response.json(order);
  }));

  app.post('/api/orders', requireRole('cutting_supervisor'), asyncHandler(async (request, response) => {
    const { recipeId, targetQty, fabricRollId, actualFabricYds } = request.body || {};
    const errors = {};
    const recipe = Number.isInteger(recipeId) && recipeId <= MAX_ID ? (await pool.query('SELECT id FROM recipes WHERE id = $1', [recipeId])).rows[0] : null;
    if (!recipe) errors.recipeId = 'Choose a valid recipe';
    if (!Number.isInteger(targetQty) || targetQty < 1 || targetQty > 100000) errors.targetQty = 'Enter a whole number between 1 and 100000';
    if (typeof fabricRollId !== 'string' || !fabricRollId.trim() || fabricRollId.length > 50) errors.fabricRollId = 'Fabric roll ID is required';
    if (typeof actualFabricYds !== 'number' || !Number.isFinite(actualFabricYds) || actualFabricYds <= 0 || actualFabricYds > 1000000) errors.actualFabricYds = 'Enter fabric yards greater than 0';
    if (Object.keys(errors).length > 0) return response.status(400).json({ error: 'Validation failed', fields: errors });

    const inserted = await pool.query(
      'INSERT INTO cutting_orders (recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [recipeId, targetQty, fabricRollId.trim(), actualFabricYds, request.user.id]);
    const orderId = inserted.rows[0].id;
    await pool.query('UPDATE cutting_orders SET order_no = $1 WHERE id = $2', ['CUT-' + String(orderId).padStart(5, '0'), orderId]);
    response.status(201).json(await loadOrderDetail(orderId));
  }));

  // After a rejection, the supervisor re-cuts and sends the batch back to the QC station.
  app.post('/api/orders/:id/resubmit', requireRole('cutting_supervisor'), asyncHandler(async (request, response) => {
    const orderId = parseId(request.params.id);
    const order = orderId === null ? null : (await pool.query('SELECT status FROM cutting_orders WHERE id = $1', [orderId])).rows[0];
    if (!order) return response.status(404).json({ error: 'Order not found' });
    if (order.status !== 'REJECTED') return response.status(409).json({ error: 'Only rejected orders can be resubmitted' });
    await pool.query('DELETE FROM verification_items WHERE order_id = $1', [orderId]);
    await pool.query("UPDATE cutting_orders SET status = 'PENDING_VERIFICATION', updated_at = NOW() WHERE id = $1 AND status = 'REJECTED'", [orderId]);
    response.json(await loadOrderDetail(orderId));
  }));

  // Verifier records physical counts. The traffic-light status is always computed on the server.
  app.post('/api/orders/:id/counts', requireRole('cutting_verifier'), asyncHandler(async (request, response) => {
    const orderId = parseId(request.params.id);
    const order = orderId === null ? null : (await pool.query('SELECT * FROM cutting_orders WHERE id = $1', [orderId])).rows[0];
    if (!order) return response.status(404).json({ error: 'Order not found' });
    if (order.status !== 'PENDING_VERIFICATION') return response.status(409).json({ error: 'Order is not awaiting verification' });
    const counts = request.body && request.body.counts;
    if (!Array.isArray(counts) || counts.length === 0) return response.status(400).json({ error: 'Counts are required' });

    const components = (await pool.query('SELECT * FROM recipe_components WHERE recipe_id = $1', [order.recipe_id])).rows;
    const validated = [];
    for (const entry of counts) {
      const component = components.find((item) => item.id === (entry && entry.componentId));
      if (!component) return response.status(400).json({ error: 'Unknown component in counts' });
      if (!isWholeNumber(entry.actualQty)) return response.status(400).json({ error: component.component_name + ': count must be a whole number, 0 or more' });
      validated.push({ component, actualQty: entry.actualQty });
    }
    for (const { component, actualQty } of validated) {
      const expectedQty = component.pieces_per_garment * order.target_qty;
      await pool.query(`
        INSERT INTO verification_items (order_id, component_id, expected_qty, actual_qty, status) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (order_id, component_id) DO UPDATE SET expected_qty = EXCLUDED.expected_qty, actual_qty = EXCLUDED.actual_qty, status = EXCLUDED.status`,
      [orderId, component.id, expectedQty, actualQty, trafficLight(expectedQty, actualQty)]);
    }
    response.json(await loadOrderDetail(orderId));
  }));

  async function recordDecision(request, response, decision) {
    const orderId = parseId(request.params.id);
    const orderDetail = await loadOrderDetail(orderId);
    if (!orderDetail) return response.status(404).json({ error: 'Order not found' });
    if (orderDetail.status !== 'PENDING_VERIFICATION') return response.status(409).json({ error: 'Order is not awaiting verification' });

    let rejectionNote = null;
    if (decision === 'REJECTED') {
      rejectionNote = typeof (request.body && request.body.note) === 'string' ? request.body.note.trim() : '';
      if (!rejectionNote) return response.status(400).json({ error: 'A rejection reason note is required' });
    } else {
      // HARD STOP: every component must be counted and none may be RED.
      const blockedComponents = orderDetail.components.filter((component) => component.status === null || component.status === 'RED');
      if (blockedComponents.length > 0) {
        return response.status(422).json({
          error: 'Approval blocked: shortage or uncounted components',
          blocked: blockedComponents.map((component) => component.component_name),
        });
      }
    }
    const variance = orderDetail.components.map((component) => ({
      component: component.component_name, expected: component.expected_qty, actual: component.actual_qty,
      variance: component.actual_qty === null ? null : component.actual_qty - component.expected_qty,
    }));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The status condition makes double-submits safe: only one decision can win.
      const updated = await client.query(
        "UPDATE cutting_orders SET status = $1, updated_at = NOW() WHERE id = $2 AND status = 'PENDING_VERIFICATION' RETURNING id",
        [decision === 'APPROVED' ? 'VERIFIED' : 'REJECTED', orderId]);
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return response.status(409).json({ error: 'Order is not awaiting verification' });
      }
      // Verifier identity and timestamp come from the server session, never from the request body.
      await client.query(`INSERT INTO verification_logs (order_id, verifier_id, decision, rejection_note, wastage_pct, variance_json, timestamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orderId, request.user.id, decision, rejectionNote, calculateWastagePercent(orderDetail), JSON.stringify(variance), new Date().toISOString()]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    response.json(await loadOrderDetail(orderId));
  }

  app.post('/api/orders/:id/approve', requireRole('cutting_verifier'), asyncHandler((request, response) => recordDecision(request, response, 'APPROVED')));
  app.post('/api/orders/:id/reject', requireRole('cutting_verifier'), asyncHandler((request, response) => recordDecision(request, response, 'REJECTED')));

  // Query isolation: status = 'VERIFIED' is enforced in SQL, and no query parameters are accepted.
  app.get('/api/sewing/queue', requireRole('sewing_supervisor'), asyncHandler(async (request, response) => {
    const verified = await pool.query("SELECT id FROM cutting_orders WHERE status = 'VERIFIED' ORDER BY updated_at DESC, id DESC");
    const orders = [];
    for (const row of verified.rows) orders.push(await loadOrderDetail(row.id));
    response.json(orders);
  }));

  app.post('/api/sewing/:id/start', requireRole('sewing_supervisor'), asyncHandler(async (request, response) => {
    const orderId = parseId(request.params.id);
    const result = orderId === null ? { rowCount: 0 } : await pool.query(
      "UPDATE cutting_orders SET sewing_started_at = NOW(), sewing_started_by = $1 WHERE id = $2 AND status = 'VERIFIED' AND sewing_started_at IS NULL RETURNING id",
      [request.user.id, orderId]);
    if (result.rowCount === 0) return response.status(404).json({ error: 'No verified order available to start' });
    response.json(await loadOrderDetail(orderId));
  }));

  app.use((error, request, response, next) => {
    console.error(error);
    response.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

if (require.main === module) {
  const pool = createPool();
  initializeDatabase(pool).then(() => {
    const port = process.env.PORT || 3000;
    createApp(pool).listen(port, () => console.log('ApparelFlow API running on port ' + port));
  }).catch((error) => { console.error('Database setup failed:', error.message); process.exit(1); });
}

module.exports = { createApp, createPool, initializeDatabase, trafficLight };
