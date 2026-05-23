const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const OZON_BASE = 'https://api-seller.ozon.ru';

app.post('/api/ozon', async (req, res) => {
  const { endpoint, body, clientId, apiKey } = req.body;
  if (!endpoint || !clientId || !apiKey) {
    return res.status(400).json({ error: 'Missing endpoint, clientId or apiKey' });
  }
  try {
    const response = await fetch(`${OZON_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
