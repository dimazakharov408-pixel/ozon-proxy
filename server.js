import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const OZON_API = "https://api-seller.ozon.ru";

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ozon-proxy",
    endpoints: ["/health", "/api/ozon", "/dashboard"]
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

async function ozonPost(endpoint, body, clientId, apiKey) {
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

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.details?.message ||
      `Ozon API HTTP ${response.status}`;

    const err = new Error(`${endpoint}: ${message}`);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

function getDateRange(period) {
  const to = new Date();
  const from = new Date();

  if (period === "month") {
    from.setDate(1);
  } else if (period === "90") {
    from.setDate(from.getDate() - 90);
  } else {
    from.setDate(from.getDate() - 30);
  }

  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

function monthChunks(from, to) {
  const chunks = [];
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  while (start <= end) {
    const chunkStart = new Date(start);
    const chunkEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));

    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10)
    });

    start = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }

  return chunks;
}

function summarizeTransactions(transactions) {
  let netto = 0;
  const expenses = {};

  for (const t of transactions) {
    const amount = Number(
      t?.amount ||
      t?.accruals_for_sale ||
      t?.sale_commission ||
      t?.services?.reduce?.((s, x) => s + Number(x.price || 0), 0) ||
      0
    );

    if (typeof t?.amount !== "undefined") {
      netto += Number(t.amount || 0);
    }

    if (Array.isArray(t?.services)) {
      for (const service of t.services) {
        const name = service.name || service.type || "Расход Ozon";
        const price = Number(service.price || 0);
        if (price < 0) expenses[name] = (expenses[name] || 0) + price;
      }
    }

    if (Number(t?.sale_commission || 0) < 0) {
      expenses["Комиссия за продажу"] = (expenses["Комиссия за продажу"] || 0) + Number(t.sale_commission);
    }

    if (Number(t?.delivery_charge || 0) < 0) {
      expenses["Доставка"] = (expenses["Доставка"] || 0) + Number(t.delivery_charge);
    }

    if (Number(t?.return_delivery_charge || 0) < 0) {
      expenses["Обратная доставка"] = (expenses["Обратная доставка"] || 0) + Number(t.return_delivery_charge);
    }
  }

  return { netto, expenses };
}

app.post("/api/ozon", async (req, res) => {
  try {
    const { endpoint, body, clientId, apiKey } = req.body || {};

    if (!endpoint || !clientId || !apiKey) {
      return res.status(400).json({ error: "Нужны endpoint, clientId и apiKey" });
    }

    const data = await ozonPost(endpoint, body, clientId, apiKey);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.details || null
    });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const { clientId, apiKey, period = "month" } = req.query;

    if (!clientId || !apiKey) {
      return res.status(400).json({ error: "Нужны clientId и apiKey" });
    }

    const { from, to } = getDateRange(String(period));

    const analytics = await ozonPost(
      "/v1/analytics/data",
      {
        date_from: from,
        date_to: to,
        dimension: ["sku"],
        metrics: ["revenue", "ordered_units"],
        limit: 1000,
        offset: 0
      },
      clientId,
      apiKey
    );

    let allTransactions = [];

    for (const chunk of monthChunks(from, to)) {
      let page = 1;
      let hasNext = true;

      while (hasNext) {
        const fin = await ozonPost(
          "/v3/finance/transaction/list",
          {
            filter: {
              date: {
                from: `${chunk.from}T00:00:00.000Z`,
                to: `${chunk.to}T23:59:59.999Z`
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

        const operations = fin?.result?.operations || [];
        allTransactions.push(...operations);

        hasNext = Boolean(fin?.result?.page_count && page < fin.result.page_count);
        page += 1;
      }
    }

    const { netto, expenses } = summarizeTransactions(allTransactions);

    res.json({
      period: { from, to },
      analytics,
      netto,
      expenses,
      transactionsCount: allTransactions.length
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(err.status || 500).json({
      error: err.message,
      details: err.details || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Ozon proxy started on port ${PORT}`);
});
