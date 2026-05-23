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
  try { return JSON.parse(text); }
  catch(e) { return { error: text }; }
}

function getDateRange(days) {
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - Number(days));
  const pad = n => String(n).padStart(2,'0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime = d => `${fmtDate(d)}T00:00:00.000Z`;
  return { from: fmtTime(from), to: fmtTime(to), fromDate: fmtDate(from), toDate: fmtDate(to) };
}

// Fetch ALL pages of transactions
async function fetchAllTransactions(from, to, clientId, apiKey) {
  const allOps = [];
  let page = 1;
  while (true) {
    const res = await ozonPost('/v3/finance/transaction/list', {
      filter: { date: { from, to }, transaction_type: 'all' },
      page,
      page_size: 1000,
    }, clientId, apiKey);

    const ops = res?.result?.operations || [];
    allOps.push(...ops);

    const pageCount = res?.result?.page_count || 1;
    if (page >= pageCount) break;
    page++;
  }
  return allOps;
}

// Analytics endpoint (GET for easy testing)
app.get('/test', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.query;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Add ?clientId=XXX&apiKey=YYY' });
  const { fromDate, toDate } = getDateRange(days);
  const result = await ozonPost('/v1/analytics/data', {
    date_from: fromDate,
    date_to: toDate,
    dimension: ['sku', 'item'],
    metrics: ['revenue', 'ordered_units'],
    limit: 100,
    offset: 0,
  }, clientId, apiKey);
  res.json({ status: 200, data: result });
});

// Full dashboard: analytics + ALL transaction pages
app.get('/dashboard', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.query;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Add ?clientId=XXX&apiKey=YYY' });

  const { from, to, fromDate, toDate } = getDateRange(days);

  try {
    const [analyticsRaw, allOps] = await Promise.all([
      ozonPost('/v1/analytics/data', {
        date_from: fromDate,
        date_to: toDate,
        dimension: ['sku', 'item'],
        metrics: ['revenue', 'ordered_units'],
        limit: 100,
        offset: 0,
      }, clientId, apiKey),
      fetchAllTransactions(from, to, clientId, apiKey)
    ]);

    // Calculate netto and expenses from real transactions
    let totalNetto = 0;
    const expenseMap = {};

    for (const op of allOps) {
      const amount = parseFloat(op.amount) || 0;
      totalNetto += amount;
      if (amount < 0) {
        const type = op.operation_type_name || 'Прочее';
        expenseMap[type] = (expenseMap[type] || 0) + amount;
      }
    }

    res.json({
      analytics: analyticsRaw,
      netto: Math.round(totalNetto * 100) / 100,
      expenses: expenseMap,
      operations_count: allOps.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
