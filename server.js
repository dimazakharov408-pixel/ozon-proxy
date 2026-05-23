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
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch(e) { return { status: r.status, data: text }; }
}

function getDateRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const pad = n => String(n).padStart(2,'0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime = d => `${fmtDate(d)}T00:00:00.000Z`;
  return { from: fmtTime(from), to: fmtTime(to), fromDate: fmtDate(from), toDate: fmtDate(to) };
}

// GET test — keys in URL params for easy browser testing
app.get('/test', async (req, res) => {
  const { clientId, apiKey } = req.query;
  if (!clientId || !apiKey) {
    return res.status(400).json({ error: 'Add ?clientId=XXX&apiKey=YYY to URL' });
  }
  const { fromDate, toDate } = getDateRange(30);
  const result = await ozonPost('/v1/analytics/data', {
    date_from: fromDate,
    date_to: toDate,
    dimension: ['sku', 'item'],
    metrics: ['revenue', 'ordered_units'],
    limit: 10,
    offset: 0,
  }, clientId, apiKey);
  res.json(result);
});

// POST dashboard — used by the app
app.post('/dashboard', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.body;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing clientId or apiKey' });

  const { from, to, fromDate, toDate } = getDateRange(Number(days));

  try {
    const [analytics, transactions] = await Promise.all([
      ozonPost('/v1/analytics/data', {
        date_from: fromDate,
        date_to: toDate,
        dimension: ['sku', 'item'],
        metrics: ['revenue', 'ordered_units'],
        limit: 100,
        offset: 0,
      }, clientId, apiKey),

      ozonPost('/v3/finance/transaction/list', {
        filter: { date: { from, to }, transaction_type: 'all' },
        page: 1,
        page_size: 500,
      }, clientId, apiKey),
    ]);

    res.json({ analytics: analytics.data, transactions: transactions.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
