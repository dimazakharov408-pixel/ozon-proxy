const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const BASE = 'https://api-seller.ozon.ru';

function ozonPost(endpoint, body, clientId, apiKey) {
  return fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function getDateRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = d => d.toISOString().replace('T', ' ').slice(0, 19);
  const fmtDate = d => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to), fromDate: fmtDate(from), toDate: fmtDate(to) };
}

// Main dashboard endpoint
app.post('/dashboard', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.body;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing clientId or apiKey' });

  const { from, to, fromDate, toDate } = getDateRange(days);

  try {
    // 1. Analytics — sales by SKU
    const analytics = await ozonPost('/v1/analytics/data', {
      date_from: fromDate,
      date_to: toDate,
      dimension: ['sku', 'item'],
      metrics: ['revenue', 'ordered_units', 'returns'],
      limit: 100,
      offset: 0,
    }, clientId, apiKey);

    // 2. Transactions — all accruals
    const transactions = await ozonPost('/v3/finance/transaction/list', {
      filter: {
        date: { from, to },
        transaction_type: 'all',
      },
      page: 1,
      page_size: 1000,
    }, clientId, apiKey);

    // 3. Transaction totals
    const totals = await ozonPost('/v3/finance/transaction/totals', {
      filter: {
        date: { from, to },
        transaction_type: 'all',
      },
    }, clientId, apiKey);

    res.json({ analytics, transactions, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
