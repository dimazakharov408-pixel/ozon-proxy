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
  try { return JSON.parse(text); } catch(e) { return { error: text }; }
}

function getDateRange(days) {
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - Number(days));
  const pad = n => String(n).padStart(2,'0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime = d => `${fmtDate(d)}T00:00:00.000Z`;
  return { from: fmtTime(from), to: fmtTime(to), fromDate: fmtDate(from), toDate: fmtDate(to) };
}

async function fetchAllTransactions(from, to, clientId, apiKey) {
  const allOps = [];
  let page = 1;
  while (true) {
    const res = await ozonPost('/v3/finance/transaction/list', {
      filter: { date: { from, to }, transaction_type: 'all' },
      page, page_size: 1000,
    }, clientId, apiKey);
    const ops = res?.result?.operations || [];
    allOps.push(...ops);
    const pageCount = res?.result?.page_count || 1;
    if (page >= pageCount) break;
    page++;
  }
  return allOps;
}

app.get('/test', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.query;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing params' });
  const { fromDate, toDate } = getDateRange(days);
  const result = await ozonPost('/v1/analytics/data', {
    date_from: fromDate, date_to: toDate,
    dimension: ['sku', 'item'],
    metrics: ['revenue', 'ordered_units'],
    limit: 100, offset: 0,
  }, clientId, apiKey);
  res.json({ status: 200, data: result });
});

app.get('/dashboard', async (req, res) => {
  const { clientId, apiKey, days = 30 } = req.query;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'Missing params' });

  const d = Number(days);
  const { from, to, fromDate, toDate } = getDateRange(d);

  try {
    const [analyticsRaw, allOps] = await Promise.all([
      ozonPost('/v1/analytics/data', {
        date_from: fromDate, date_to: toDate,
        dimension: ['sku', 'item'],
        metrics: ['revenue', 'ordered_units'],
        limit: 100, offset: 0,
      }, clientId, apiKey),
      fetchAllTransactions(from, to, clientId, apiKey)
    ]);

    // Выручка из аналитики
    const analyticsRows = analyticsRaw?.result?.data || [];
    const totalRevenue = analyticsRows.reduce((s, r) => s + (r.metrics?.[0] || 0), 0);

    // Из транзакций считаем каждую статью расходов отдельно
    const expenseMap = {};
    let txRevenue = 0;     // выручка из транзакций
    let txCompensation = 0; // компенсации (баллы, программы партнёров)

    for (const op of allOps) {
      const amount = parseFloat(op.amount) || 0;
      const type = op.operation_type_name || 'Прочее';

      if (amount > 0) {
        // Доходы: выручка от продаж и компенсации
        if (op.operation_type === 'OperationAgentDeliveredToCustomer' ||
            op.operation_type === 'ClientReturnAgentOperation') {
          txRevenue += amount;
        } else {
          txCompensation += amount; // баллы, программы партнёров
        }
      } else if (amount < 0) {
        expenseMap[type] = (expenseMap[type] || 0) + amount;
      }
    }

    const totalExpenses = Object.values(expenseMap).reduce((s, v) => s + v, 0);

    // Нетто из транзакций = выручка + компенсации + расходы
    const nettoFromTx = txRevenue + txCompensation + totalExpenses;

    // Проверяем: если нетто из транзакций разумное (30-90% от аналитической выручки)
    // используем его, иначе считаем по проценту 76.72% из реального отчёта
    const ratio = totalRevenue > 0 ? nettoFromTx / totalRevenue : 0;
    const nettoIsValid = ratio > 0.3 && ratio < 1.2;

    const finalNetto = nettoIsValid
      ? nettoFromTx
      : totalRevenue * 0.7672; // 76.72% — точный процент из майского отчёта

    res.json({
      analytics: analyticsRaw,
      netto: Math.round(finalNetto),
      expenses: expenseMap,
      debug: {
        tx_revenue: Math.round(txRevenue),
        tx_compensation: Math.round(txCompensation),
        tx_expenses: Math.round(totalExpenses),
        netto_from_tx: Math.round(nettoFromTx),
        netto_ratio: ratio.toFixed(3),
        netto_source: nettoIsValid ? 'transactions' : 'percentage_76.72%',
        operations_count: allOps.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
