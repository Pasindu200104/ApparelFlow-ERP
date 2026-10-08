import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const ROLE_LABELS = { cutting_supervisor: 'Cutting Supervisor', cutting_verifier: 'Cutting Verifier', sewing_supervisor: 'Sewing Supervisor' };
const DEMO_ACCOUNTS = [
  { email: 'supervisor@apparelflow.test', role: 'cutting_supervisor', description: 'Creates cutting orders, logs fabric' },
  { email: 'verifier@apparelflow.test', role: 'cutting_verifier', description: 'Counts parts, approves or rejects' },
  { email: 'sewing@apparelflow.test', role: 'sewing_supervisor', description: 'Receives verified batches only' },
];
let authToken = sessionStorage.getItem('token');

async function api(path, method = 'GET', body = null) {
  const response = await fetch(API_URL + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authToken) window.dispatchEvent(new Event('session-expired'));
    const error = new Error(data.error || 'Request failed');
    error.fields = data.fields;
    throw error;
  }
  return data;
}

const isWholeText = (text) => /^\d+$/.test(String(text).trim());
const formatTime = (text) => (text ? new Date(text).toLocaleString() : '—');
const StatusPill = ({ status }) => <span className={'pill ' + status}>{status.replace('_', ' ')}</span>;
const FieldError = ({ message }) => <div className="error">{message || ''}</div>;

export default function App() {
  const [user, setUser] = useState(JSON.parse(sessionStorage.getItem('user') || 'null'));
  const [toast, setToast] = useState(null);

  function notify(message, isError = false) {
    setToast({ message, isError });
    setTimeout(() => setToast(null), 3500);
  }
  function logout() {
    sessionStorage.clear();
    authToken = null;
    setUser(null);
  }
  useEffect(() => {
    window.addEventListener('session-expired', logout);
    return () => window.removeEventListener('session-expired', logout);
  }, []);

  async function signIn(email, password) {
    const result = await api('/login', 'POST', { email, password });
    authToken = result.token;
    sessionStorage.setItem('token', result.token);
    sessionStorage.setItem('user', JSON.stringify(result.user));
    setUser(result.user);
  }

  return (
    <>
      <header>
        <div><h1>ApparelFlow ERP</h1><small>Cutting Operations &amp; Gatekeeper Verification Terminal</small></div>
        {user && (
          <div className="row">
            <span>{user.full_name} · <b>{ROLE_LABELS[user.role]}</b></span>
            <button className="secondary" onClick={logout}>Switch role / Logout</button>
          </div>
        )}
      </header>
      <main>
        {!user && <Login signIn={signIn} />}
        {user && user.role === 'cutting_supervisor' && <Supervisor notify={notify} />}
        {user && user.role === 'cutting_verifier' && <Verifier notify={notify} />}
        {user && user.role === 'sewing_supervisor' && <Sewing notify={notify} />}
      </main>
      {toast && <div className="toast" style={{ background: toast.isError ? '#b91c1c' : '#15803d' }}>{toast.message}</div>}
    </>
  );
}

function Login({ signIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  async function attempt(emailValue, passwordValue) {
    try { await signIn(emailValue, passwordValue); } catch (error) { setErrorMessage(error.message); }
  }
  return (
    <div className="login">
      <div className="card">
        <h2>Sign in</h2>
        <label htmlFor="loginEmail">Email</label>
        <input id="loginEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="loginPassword">Password</label>
        <input id="loginPassword" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <FieldError message={errorMessage} />
        <button onClick={() => attempt(email, password)}>Sign in</button>
      </div>
      <div className="card demo">
        <h3>Demo Credential Panel</h3>
        <p style={{ marginTop: 0, color: '#475569', fontSize: 14 }}>Click a persona to sign in instantly. Password for all: <b>Demo@1234</b></p>
        <div className="grid">
          {DEMO_ACCOUNTS.map((account) => (
            <button key={account.email} className="role-btn" onClick={() => attempt(account.email, 'Demo@1234')}>
              {ROLE_LABELS[account.role]}<span>{account.email}</span><span>{account.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Supervisor({ notify }) {
  const [recipes, setRecipes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState({ recipeId: '', targetQty: '', fabricRollId: '', actualFabricYds: '' });
  const [errors, setErrors] = useState({});

  async function loadData() {
    const [recipeList, orderList] = await Promise.all([api('/recipes'), api('/orders')]);
    setRecipes(recipeList);
    setOrders(orderList);
    setForm((current) => (current.recipeId ? current : { ...current, recipeId: String(recipeList[0].id) }));
  }
  useEffect(() => { loadData().catch((error) => notify(error.message, true)); }, []);

  const updateField = (field) => (event) => setForm({ ...form, [field]: event.target.value });
  const selectedRecipe = recipes.find((recipe) => String(recipe.id) === form.recipeId);
  const quantityIsValid = isWholeText(form.targetQty) && Number(form.targetQty) >= 1;

  async function createOrder() {
    const newErrors = {};
    if (!quantityIsValid) newErrors.targetQty = 'Whole number of 1 or more (no decimals, negatives or letters)';
    if (!form.fabricRollId.trim()) newErrors.fabricRollId = 'Fabric roll ID is required';
    if (!/^\d+(\.\d{1,2})?$/.test(form.actualFabricYds.trim()) || Number(form.actualFabricYds) <= 0) newErrors.actualFabricYds = 'Positive number, up to 2 decimals';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;
    try {
      await api('/orders', 'POST', {
        recipeId: Number(form.recipeId), targetQty: Number(form.targetQty),
        fabricRollId: form.fabricRollId.trim(), actualFabricYds: Number(form.actualFabricYds),
      });
      notify('Order submitted to QC');
      setForm({ ...form, targetQty: '', fabricRollId: '', actualFabricYds: '' });
      await loadData();
    } catch (error) {
      setErrors(error.fields || {});
      notify(error.message, true);
    }
  }
  async function resubmitOrder(orderId) {
    try { await api('/orders/' + orderId + '/resubmit', 'POST'); notify('Resubmitted for verification'); await loadData(); }
    catch (error) { notify(error.message, true); }
  }

  return (
    <>
      <div className="card">
        <h2>New Cutting Order</h2>
        <div className="grid">
          <div>
            <label htmlFor="recipeId">Recipe</label>
            <select id="recipeId" value={form.recipeId} onChange={updateField('recipeId')}>
              {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.recipe_code} — {recipe.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="targetQty">Target batch quantity (garments)</label>
            <input id="targetQty" inputMode="numeric" placeholder="e.g. 50" value={form.targetQty} onChange={updateField('targetQty')} className={errors.targetQty ? 'invalid' : ''} />
            <FieldError message={errors.targetQty} />
          </div>
          <div>
            <label htmlFor="fabricRollId">Fabric Roll ID</label>
            <input id="fabricRollId" placeholder="e.g. FAB-ROLL-882" value={form.fabricRollId} onChange={updateField('fabricRollId')} className={errors.fabricRollId ? 'invalid' : ''} />
            <FieldError message={errors.fabricRollId} />
          </div>
          <div>
            <label htmlFor="actualFabricYds">Actual fabric used (yards)</label>
            <input id="actualFabricYds" inputMode="decimal" placeholder="e.g. 92.5" value={form.actualFabricYds} onChange={updateField('actualFabricYds')} className={errors.actualFabricYds ? 'invalid' : ''} />
            <FieldError message={errors.actualFabricYds} />
          </div>
        </div>
        <div className="info">
          {selectedRecipe && quantityIsValid ? (
            <>
              <b>Expected components:</b>{' '}
              {selectedRecipe.components.map((component) => `${component.component_name}: ${component.pieces_per_garment * Number(form.targetQty)}`).join(' · ')}
              <br /><b>Expected fabric:</b> {(selectedRecipe.std_fabric_yards * Number(form.targetQty)).toFixed(2)} yds (wastage cap {selectedRecipe.wastage_cap}%)
            </>
          ) : 'Enter a quantity to see expected component counts.'}
        </div>
        <button onClick={createOrder}>Submit for Verification</button>
      </div>
      <div className="card">
        <h2>Cutting Orders</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Recipe</th><th>Qty</th><th>Fabric roll</th><th>Yards</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan="7">No orders yet.</td></tr>}
              {orders.map((order) => (
                <tr key={order.id}>
                  <td><b>{order.order_no}</b></td><td>{order.recipe_name}</td><td>{order.target_qty}</td><td>{order.fabric_roll_id}</td><td>{order.actual_fabric_yds}</td>
                  <td><StatusPill status={order.status} />{order.status === 'REJECTED' && <div className="note"><b>Reason:</b> {order.last_rejection_note}</div>}</td>
                  <td>{order.status === 'REJECTED' && <button className="secondary" onClick={() => resubmitOrder(order.id)}>Re-cut &amp; Resubmit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Verifier({ notify }) {
  const [orders, setOrders] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [countTexts, setCountTexts] = useState({});
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');

  async function loadOrders() { setOrders(await api('/orders')); }
  useEffect(() => { loadOrders().catch((error) => notify(error.message, true)); }, []);

  async function openTerminal(orderId) {
    try {
      const order = await api('/orders/' + orderId);
      setSelectedOrder(order);
      setCountTexts(Object.fromEntries(order.components.map((component) => [component.component_id, component.actual_qty === null ? '' : String(component.actual_qty)])));
      setNote('');
      setNoteError('');
    } catch (error) { notify(error.message, true); }
  }

  function evaluateRow(component) {
    const text = (countTexts[component.component_id] || '').trim();
    if (text === '') return { flag: null, error: '' };
    if (!isWholeText(text)) return { flag: null, error: 'Whole numbers only' };
    const actual = Number(text);
    const flag = actual === component.expected_qty ? 'GREEN' : actual > component.expected_qty ? 'YELLOW' : 'RED';
    return { flag, error: '' };
  }
  const rows = selectedOrder ? selectedOrder.components.map((component) => ({ component, ...evaluateRow(component) })) : [];
  const redCount = rows.filter((row) => row.flag === 'RED').length;
  const missingCount = rows.filter((row) => row.flag === null).length;
  const canApprove = rows.length > 0 && redCount === 0 && missingCount === 0;

  function collectCounts() {
    return Object.entries(countTexts).filter(([, text]) => isWholeText(text)).map(([componentId, text]) => ({ componentId: Number(componentId), actualQty: Number(text) }));
  }
  async function finishDecision(message) {
    notify(message);
    setSelectedOrder(null);
    await loadOrders();
  }
  async function approveBatch() {
    try {
      await api('/orders/' + selectedOrder.id + '/counts', 'POST', { counts: collectCounts() });
      await api('/orders/' + selectedOrder.id + '/approve', 'POST');
      await finishDecision('Batch verified and released to Sewing Queue');
    } catch (error) { notify(error.message, true); }
  }
  async function rejectBatch() {
    if (!note.trim()) { setNoteError('A reason note is required to reject a batch'); return; }
    setNoteError('');
    try {
      const counts = collectCounts();
      if (counts.length > 0) await api('/orders/' + selectedOrder.id + '/counts', 'POST', { counts });
      await api('/orders/' + selectedOrder.id + '/reject', 'POST', { note });
      await finishDecision('Batch rejected and returned to supervisor');
    } catch (error) { notify(error.message, true); }
  }

  const pending = orders.filter((order) => order.status === 'PENDING_VERIFICATION');
  const history = orders.filter((order) => order.status !== 'PENDING_VERIFICATION');
  const wastage = selectedOrder ? ((selectedOrder.actual_fabric_yds - selectedOrder.expected_fabric_yds) / selectedOrder.expected_fabric_yds * 100).toFixed(2) : 0;

  return (
    <>
      <div className="card">
        <h2>Awaiting Verification ({pending.length})</h2>
        <div className="grid">
          {pending.length === 0 && <p>No batches waiting at the QC station.</p>}
          {pending.map((order) => (
            <button key={order.id} className="role-btn" onClick={() => openTerminal(order.id)}>
              <b>{order.order_no}</b> {order.recipe_name}<span>{order.target_qty} garments · {order.fabric_roll_id}</span>
            </button>
          ))}
        </div>
      </div>
      {selectedOrder && (
        <div className="card">
          <h2>Verification Terminal — {selectedOrder.order_no} · {selectedOrder.recipe_name}</h2>
          <p>Target <b>{selectedOrder.target_qty}</b> garments · Roll {selectedOrder.fabric_roll_id} · Fabric used {selectedOrder.actual_fabric_yds} yds (expected {selectedOrder.expected_fabric_yds}) · Wastage <b>{wastage}%</b> (cap {selectedOrder.wastage_cap}%)</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Component</th><th>Expected</th><th>Actual count</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(({ component, flag, error }) => (
                  <tr key={component.component_id}>
                    <td>{component.component_name}</td><td><b>{component.expected_qty}</b></td>
                    <td>
                      <input className={'count-input' + (error ? ' invalid' : '')} inputMode="numeric" aria-label={'Actual count for ' + component.component_name}
                        value={countTexts[component.component_id] || ''} onChange={(event) => setCountTexts({ ...countTexts, [component.component_id]: event.target.value })} />
                      <FieldError message={error} />
                    </td>
                    <td>{flag ? <span className={'pill ' + flag}>{flag === 'GREEN' ? 'GREEN · MATCH' : flag === 'YELLOW' ? 'YELLOW · EXCESS' : 'RED · SHORTAGE'}</span> : <span className="pill">Not counted</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="info">
            {redCount > 0 ? <><b style={{ color: '#b91c1c' }}>HARD STOP:</b> {redCount} component(s) in shortage. Approval is blocked — reject the batch with a reason.</>
              : missingCount > 0 ? 'Count every component to enable approval.' : 'All components satisfied. Batch may be approved.'}
          </div>
          <label htmlFor="rejectNote">Rejection reason (required to reject)</label>
          <textarea id="rejectNote" rows="2" placeholder="e.g. 4 cuffs have fabric defects — please re-cut" value={note} onChange={(event) => setNote(event.target.value)} className={noteError ? 'invalid' : ''} />
          <FieldError message={noteError} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="success" disabled={!canApprove} onClick={approveBatch}>Approve Batch</button>
            <button className="danger" onClick={rejectBatch}>Reject Batch</button>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Recent decisions</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Recipe</th><th>Status</th></tr></thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan="3">None yet.</td></tr>}
              {history.map((order) => <tr key={order.id}><td>{order.order_no}</td><td>{order.recipe_name}</td><td><StatusPill status={order.status} /></td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Sewing({ notify }) {
  const [queue, setQueue] = useState([]);
  async function loadQueue() { setQueue(await api('/sewing/queue')); }
  useEffect(() => { loadQueue().catch((error) => notify(error.message, true)); }, []);
  async function startSewing(orderId) {
    try { await api('/sewing/' + orderId + '/start', 'POST'); notify('Sewing assembly started'); await loadQueue(); }
    catch (error) { notify(error.message, true); }
  }
  return (
    <>
      <div className="card"><h2>Sewing Queue — Verified Batches ({queue.length})</h2></div>
      {queue.length === 0 && <div className="card">No verified batches yet.</div>}
      {queue.map((order) => {
        const approval = order.log.find((entry) => entry.decision === 'APPROVED') || {};
        return (
          <div className="card" key={order.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{order.order_no} · {order.recipe_name} ({order.recipe_code})</h3><StatusPill status="VERIFIED" />
            </div>
            <p>{order.target_qty} garments · Roll {order.fabric_roll_id} · Verified by <b>{approval.verifier_name}</b> on {formatTime(approval.timestamp)} · Fabric wastage <b>{approval.wastage_pct}%</b> (cap {order.wastage_cap}%)</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Component</th><th>Expected</th><th>Counted</th><th>Status</th></tr></thead>
                <tbody>
                  {order.components.map((component) => (
                    <tr key={component.component_id}><td>{component.component_name}</td><td>{component.expected_qty}</td><td>{component.actual_qty}</td><td><span className={'pill ' + component.status}>{component.status}</span></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12 }}>
              {order.sewing_started_at ? <span className="pill GREEN">Sewing started {formatTime(order.sewing_started_at)}</span> : <button onClick={() => startSewing(order.id)}>Start Sewing Assembly</button>}
            </div>
          </div>
        );
      })}
    </>
  );
}
