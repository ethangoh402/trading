/**
 * Trading Journal - Bitget Sync Script
 * Run: node sync.js
 * This fetches your closed futures trades from Bitget and pushes them to your dashboard.
 */

const crypto = require('crypto');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const BITGET_API_KEY    = 'bg_310d7c839c7128ae174d2900bb84edfe';
const BITGET_API_SECRET = '58b7b475db95c39c4651825e69e4bea5946a79af0523c0f18ee8c210ba4002d4';
const BITGET_PASSPHRASE = 'Roundroomba09';
const DASHBOARD_URL     = 'https://trading-journal-ghx.pages.dev';
// ────────────────────────────────────────────────────────────────────────────

function sign(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

async function bitgetGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const timestamp = Date.now().toString();
  const prehash = timestamp + 'GET' + path + (query ? `?${query}` : '');
  const signature = sign(BITGET_API_SECRET, prehash);

  const url = `https://api.bitget.com${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'ACCESS-KEY':        BITGET_API_KEY,
      'ACCESS-SIGN':       signature,
      'ACCESS-TIMESTAMP':  timestamp,
      'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
      'Content-Type':      'application/json',
      'locale':            'en-US',
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} from Bitget`);
  return res.json();
}

async function fetchTrades() {
  const trades = [];
  let endId = null;
  let page = 1;

  while (true) {
    process.stdout.write(`  Fetching page ${page}...`);
    const params = { productType: 'USDT-FUTURES', limit: '100' };
    if (endId) params.idLessThan = endId;

    const data = await bitgetGet('/api/v2/mix/position/history-position', params);

    if (data.code !== '00000') {
      throw new Error(`Bitget error: ${data.msg} (${data.code})`);
    }

    const list = data.data?.list || [];
    console.log(` got ${list.length} trades`);

    list.forEach(p => trades.push({
      id:          p.positionId,
      symbol:      p.symbol.replace('USDT', '').replace(/_UMCBL|_DMCBL|_CMCBL/g, ''),
      side:        p.holdSide,
      size:        p.openTotalPos,
      leverage:    p.leverage,
      entry_price: p.openAvgPrice,
      exit_price:  p.closeAvgPrice,
      pnl:         parseFloat(p.pnl || 0),
      fee:         Math.abs(parseFloat(p.openFee || 0)) + Math.abs(parseFloat(p.closeFee || 0)),
      open_time:   parseInt(p.uTime || 0),
      close_time:  parseInt(p.cTime || 0),
    }));

    if (list.length < 100) break;
    endId = data.data?.endId;
    if (!endId) break;
    page++;
  }

  return trades;
}

async function pushToDashboard(trades) {
  const res = await fetch(`${DASHBOARD_URL}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trades }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Dashboard error: ${data.error}`);
  return data.imported;
}

async function main() {
  console.log('\n📈 Trading Journal Sync\n');

  console.log('① Fetching trades from Bitget...');
  const trades = await fetchTrades();
  console.log(`  ✓ Found ${trades.length} total closed trades\n`);

  if (trades.length === 0) {
    console.log('No closed trades found. Make sure you have closed futures positions.');
    return;
  }

  console.log('② Pushing to dashboard...');
  const imported = await pushToDashboard(trades);
  console.log(`  ✓ Imported ${imported} trades\n`);

  console.log(`✅ Done! Open your dashboard: ${DASHBOARD_URL}\n`);
}

main().catch(e => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
});
