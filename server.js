import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const OZON_API = "https://api-seller.ozon.ru";
const OZON_MIN_INTERVAL_MS = 650;
const OZON_MAX_RETRIES = 5;

let ozonQueue = Promise.resolve();
let lastOzonRequestAt = 0;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ozon-profit-proxy",
    endpoints: ["/health", "/api/ozon", "/dashboard"]
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/ozon", async (req, res) => {
  try {
    const { endpoint, body, clientId, apiKey } = req.body || {};
    if (!endpoint || !clientId || !apiKey) {
      return res.status(400).json({ error: "Нужны endpoint, clientId и apiKey" });
    }
    const data = await ozonPost(endpoint, body, clientId, apiKey);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      details: error.details || null
    });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const { clientId, apiKey, period = "month" } = req.query;
    if (!clientId || !apiKey) {
      return res.status(400).json({ error: "Нужны clientId и apiKey" });
    }

    const range = getDateRange(String(period));
    const [analytics, transactions] = await Promise.all([
      ozonPost(
        "/v1/analytics/data",
        {
          date_from: range.fromDate,
          date_to: range.toDate,
          dimension: ["sku", "item"],
          metrics: ["revenue", "ordered_units"],
          limit: 1000,
          offset: 0
        },
        clientId,
        apiKey
      ),
      fetchAllTransactions(range.from, range.to, clientId, apiKey)
    ]);

    const finance = summarizeTransactions(transactions);
    res.json({
      period: { from: range.fromDate, to: range.toDate },
      analytics,
      netto: finance.payout,
      expenses: finance.expenses,
      transactionsCount: transactions.length
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(error.status || 500).json({
      error: error.message,
      details: error.details || null
    });
  }
});

async function ozonPost(endpoint, body, clientId, apiKey) {
  let lastError;

  for (let attempt = 0; attempt <= OZON_MAX_RETRIES; attempt += 1) {
    const { response, data } = await throttledOzonFetch(endpoint, body, clientId, apiKey);

    if (response.ok) return data;

    const message = data?.message || data?.error || data?.details?.message || `Ozon API HTTP ${response.status}`;
    lastError = createOzonError(endpoint, message, response.status, data);

    if (!isRateLimitError(response.status, message) || attempt === OZON_MAX_RETRIES) {
      throw lastError;
    }

    await sleep(900 + attempt * 700);
  }

  throw lastError;
}

async function throttledOzonFetch(endpoint, body, clientId, apiKey) {
  const task = ozonQueue.then(async () => {
    const elapsed = Date.now() - lastOzonRequestAt;
    const waitMs = Math.max(0, OZON_MIN_INTERVAL_MS - elapsed);
    if (waitMs) await sleep(waitMs);
    lastOzonRequestAt = Date.now();

    const response = await fetch(`${OZON_API}${endpoint}`, {
      method: "POST",
      headers: {
        "Client-Id": String(clientId),
        "Api-Key": String(apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    return { response, data };
  });

  ozonQueue = task.catch(() => {});
  return task;
}

function createOzonError(endpoint, message, status, details) {
  const error = new Error(`${endpoint}: ${message}`);
  error.status = status;
  error.details = details;
  return error;
}

function isRateLimitError(status, message) {
  return status === 429 || String(message || "").toLowerCase().includes("rate limit");
}

async function fetchAllTransactions(from, to, clientId, apiKey) {
  const operations = [];
  for (const chunk of monthChunks(from, to)) {
    let page = 1;
    while (true) {
      const data = await ozonPost(
        "/v3/finance/transaction/list",
        {
          filter: {
            date: {
              from: `${chunk.fromDate}T00:00:00.000Z`,
              to: `${chunk.toDate}T23:59:59.999Z`
            },
            operation_type: [],
            posting_number: "",
            transaction_type: "all"
          },
          page,
          page_size: 1000
        },
        clientId,
        apiKey
      );
      operations.push(...(data?.result?.operations || []));
      const pageCount = Number(data?.result?.page_count || 1);
      if (page >= pageCount) break;
      page += 1;
    }
  }
  return operations;
}

function summarizeTransactions(transactions) {
  const expenses = {};
  let payout = 0;

  for (const operation of transactions) {
    const amount = toNumber(operation?.amount);
    payout += amount;

    if (amount < 0) {
      const name = operation?.operation_type_name || operation?.operation_type || "Расход Ozon";
      expenses[name] = round2((expenses[name] || 0) + amount);
    }

    if (Array.isArray(operation?.services)) {
      for (const service of operation.services) {
        const price = toNumber(service?.price);
        if (price < 0) {
          const name = service?.name || service?.type || "Услуга Ozon";
          expenses[name] = round2((expenses[name] || 0) + price);
        }
      }
    }
  }

  return { payout: round2(payout), expenses };
}

function getDateRange(period) {
  const to = new Date();
  const from = new Date();

  if (period === "month") {
    from.setDate(1);
  } else {
    const days = Number(period);
    from.setDate(from.getDate() - (Number.isFinite(days) ? days : 30));
  }

  return {
    from,
    to,
    fromDate: formatDate(from),
    toDate: formatDate(to)
  };
}

function monthChunks(from, to) {
  const chunks = [];
  let cursor = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const end = new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()));

  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ fromDate: formatDate(chunkStart), toDate: formatDate(chunkEnd) });
    cursor = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }

  return chunks;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`Ozon profit proxy started on port ${PORT}`);
});
