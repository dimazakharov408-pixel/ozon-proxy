import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const OZON_API = "https://api-seller.ozon.ru";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ozon-proxy",
    endpoints: ["/health", "/api/ozon"]
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/ozon", async (req, res) => {
  try {
    const { endpoint, body, clientId, apiKey } = req.body || {};

    if (!endpoint || !clientId || !apiKey) {
      return res.status(400).json({
        error: "Нужны endpoint, clientId и apiKey"
      });
    }

    if (!endpoint.startsWith("/")) {
      return res.status(400).json({
        error: "endpoint должен начинаться с /"
      });
    }

    const ozonRes = await fetch(`${OZON_API}${endpoint}`, {
      method: "POST",
      headers: {
        "Client-Id": String(clientId),
        "Api-Key": String(apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });

    const text = await ozonRes.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!ozonRes.ok) {
      return res.status(ozonRes.status).json({
        error: "Ozon API error",
        status: ozonRes.status,
        details: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({
      error: "Proxy server error",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Ozon proxy started on port ${PORT}`);
});
