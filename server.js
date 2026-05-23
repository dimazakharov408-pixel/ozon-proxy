const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const BASE = 'https://api-seller.ozon.ru';

async function ozonPost(endpoint, body, clientId, apiKey) {
  const r = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch(e) { json = { raw: text }; }
  return { status: r.status, data: json };
}

function getDateRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00.000Z`;
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { from: fmt(from), to: fmt(to), fromDate: fmtDate(from), toDate: fmtDate(to) };
}

app.post('/dashboard', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.body;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing clientId or apiKey' });

  const { from, to, fromDate, toDate } = getDateRange(Number(days));
  const debug = {};

  try {
    // Analytics
    const a = await ozonPost('/v1/analytics/data', {
      date_from: fromDate,
      date_to: toDate,
      dimension: ['sku', 'item'],
      metrics: ['revenue', 'ordered_units'],
      limit: 100,
      offset: 0,
    }, clientId, apiKey);
    debug.analytics = { status: a.status, data: a.data };

    // Transactions
    const t = await ozonPost('/v3/finance/transaction/list', {
      filter: { date: { from, to }, transaction_type: 'all' },
      page: 1,
      page_size: 500,
    }, clientId, apiKey);
    debug.transactions = { status: t.status, data: t.data };

    res.json({
      ok: true,
      debug,
      analytics: a.data,
      transactions: t.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, debug });
  }
});

// Test endpoint — just check one simple call
app.post('/test', async (req, res) => {
  const { clientId, apiKey } = req.body;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing clientId or apiKey' });

  const today = new Date();
  const from = new Date(); from.setDate(today.getDate() - 7);
  const pad = n => String(n).padStart(2,'0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const result = await ozonPost('/v1/analytics/data', {
    date_from: fmtDate(from),
    date_to: fmtDate(today),
    dimension: ['sku'],
    metrics: ['revenue', 'ordered_units'],
    limit: 10,
    offset: 0,
  }, clientId, apiKey);

  res.json(result);
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
