const test = require('node:test');
const assert = require('node:assert');
const { createApp, createPool, initializeDatabase } = require('../server');

let pool;
let server;
let baseUrl;
let blouseRecipeId;
const tokens = {};

async function call(path, method = 'GET', token = null, body = null) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

async function createPendingOrder(quantity = 10) {
  const result = await call('/api/orders', 'POST', tokens.supervisor,
    { recipeId: blouseRecipeId, targetQty: quantity, fabricRollId: 'FAB-ROLL-882', actualFabricYds: quantity * 1.8 });
  assert.strictEqual(result.status, 201);
  return result.data;
}

async function countAll(order, shortageComponentIndex = -1) {
  const counts = order.components.map((component, index) => ({
    componentId: component.component_id,
    actualQty: index === shortageComponentIndex ? component.expected_qty - 1 : component.expected_qty,
  }));
  return call('/api/orders/' + order.id + '/counts', 'POST', tokens.verifier, { counts });
}

test.before(async () => {
  // Use a throwaway database (local Postgres or a separate Supabase project), never your live data.
  pool = createPool(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  await initializeDatabase(pool);
  server = createApp(pool).listen(0);
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  for (const [name, email] of [['supervisor', 'supervisor@apparelflow.test'], ['verifier', 'verifier@apparelflow.test'], ['sewing', 'sewing@apparelflow.test']]) {
    tokens[name] = (await call('/api/login', 'POST', null, { email, password: 'Demo@1234' })).data.token;
  }
  const recipes = (await call('/api/recipes', 'GET', tokens.supervisor)).data;
  blouseRecipeId = recipes.find((recipe) => recipe.recipe_code === 'REC-BL01').id;
});
test.after(async () => { server.close(); await pool.end(); });

test('1. all-GREEN order can be approved by a verifier', async () => {
  const order = await createPendingOrder();
  await countAll(order);
  const result = await call('/api/orders/' + order.id + '/approve', 'POST', tokens.verifier);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.status, 'VERIFIED');
  assert.strictEqual(result.data.log[0].decision, 'APPROVED');
});

test('2. order with a RED component cannot be approved (422)', async () => {
  const order = await createPendingOrder();
  await countAll(order, 2);
  assert.strictEqual((await call('/api/orders/' + order.id + '/approve', 'POST', tokens.verifier)).status, 422);
  const uncounted = await createPendingOrder();
  assert.strictEqual((await call('/api/orders/' + uncounted.id + '/approve', 'POST', tokens.verifier)).status, 422);
});

test('3. rejecting without a reason note fails validation', async () => {
  const order = await createPendingOrder();
  for (const note of [undefined, '', '   ']) {
    assert.strictEqual((await call('/api/orders/' + order.id + '/reject', 'POST', tokens.verifier, { note })).status, 400);
  }
  const accepted = await call('/api/orders/' + order.id + '/reject', 'POST', tokens.verifier, { note: 'Cuffs have fabric defects' });
  assert.strictEqual(accepted.status, 200);
  assert.strictEqual(accepted.data.status, 'REJECTED');
});

test('4. non-verifier roles get 403 on approval', async () => {
  const order = await createPendingOrder();
  await countAll(order);
  assert.strictEqual((await call('/api/orders/' + order.id + '/approve', 'POST', tokens.supervisor)).status, 403);
  assert.strictEqual((await call('/api/orders/' + order.id + '/approve', 'POST', tokens.sewing)).status, 403);
  assert.strictEqual((await call('/api/orders/' + order.id + '/approve', 'POST')).status, 401);
});

test('5. unapproved orders never appear in the sewing queue', async () => {
  const pending = await createPendingOrder();
  const rejected = await createPendingOrder();
  await call('/api/orders/' + rejected.id + '/reject', 'POST', tokens.verifier, { note: 'Shortage' });
  const approved = await createPendingOrder();
  await countAll(approved);
  await call('/api/orders/' + approved.id + '/approve', 'POST', tokens.verifier);
  const queue = await call('/api/sewing/queue?status=PENDING_VERIFICATION', 'GET', tokens.sewing);
  const queueIds = queue.data.map((order) => order.id);
  assert.ok(queueIds.includes(approved.id));
  assert.ok(!queueIds.includes(pending.id));
  assert.ok(!queueIds.includes(rejected.id));
  assert.ok(queue.data.every((order) => order.status === 'VERIFIED'));
  assert.strictEqual((await call('/api/sewing/queue', 'GET', tokens.supervisor)).status, 403);
});

test('bonus: invalid inputs are rejected, audit log is immutable', async () => {
  const bad = await call('/api/orders', 'POST', tokens.supervisor, { recipeId: blouseRecipeId, targetQty: -5, fabricRollId: '', actualFabricYds: 'abc' });
  assert.strictEqual(bad.status, 400);
  const decimal = await call('/api/orders', 'POST', tokens.supervisor, { recipeId: blouseRecipeId, targetQty: 2.5, fabricRollId: 'R1', actualFabricYds: 5 });
  assert.strictEqual(decimal.status, 400);
  const order = await createPendingOrder(10);
  const negativeCount = await call('/api/orders/' + order.id + '/counts', 'POST', tokens.verifier, { counts: [{ componentId: order.components[0].component_id, actualQty: -1 }] });
  assert.strictEqual(negativeCount.status, 400);
  await countAll(order);
  const approved = await call('/api/orders/' + order.id + '/approve', 'POST', tokens.verifier);
  assert.strictEqual(approved.data.log[0].wastage_pct, 0);
  await assert.rejects(pool.query('UPDATE verification_logs SET wastage_pct = 99 WHERE order_id = $1', [order.id]), /immutable/);
});
