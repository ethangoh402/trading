const ALLOWED_USER_ID = 5849886042;
const clean = s => (s || '').replace(/^﻿/, '').trim();

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const update = await request.json();
    const message = update.message;
    if (!message) return ok();

    const chatId = message.chat.id;
    const userId = message.from.id;

    // Only respond to the owner
    if (userId !== ALLOWED_USER_ID) {
      await sendMessage(env, chatId, "Unauthorized.");
      return ok();
    }

    // Handle photo message
    if (message.photo) {
      await sendMessage(env, chatId, "Got your screenshot, reading it now...");

      try {
        // Get highest-res photo
        const photo = message.photo[message.photo.length - 1];
        const fileUrl = await getTelegramFileUrl(env, photo.file_id);
        const imageData = await fetchImageAsBase64(fileUrl);

        // Use Cloudflare AI to extract trade data
        const tradeData = await extractTradeFromImage(env, imageData);

        if (!tradeData) {
          await sendMessage(env, chatId, "Couldn't read trade data from that screenshot. Make sure it clearly shows entry price, exit price and PnL. Try the Bitget Share Card screenshot for best results.");
          return ok();
        }

        // Save to D1
        await saveTrade(env, tradeData);

        const pnlSign = parseFloat(tradeData.pnl) >= 0 ? '+' : '';
        const pnlDisplay = tradeData.pnlIsPercent
          ? `${pnlSign}${parseFloat(tradeData.pnl).toFixed(2)}%`
          : `${pnlSign}$${parseFloat(tradeData.pnl).toFixed(2)}`;
        const reply =
          `Trade logged!\n\n` +
          `${tradeData.symbol} ${tradeData.side.toUpperCase()}${tradeData.leverage ? ` ${tradeData.leverage}x` : ''}\n` +
          `Entry: $${tradeData.entry_price}\n` +
          `Exit: $${tradeData.exit_price}\n` +
          `PnL: ${pnlDisplay}\n\n` +
          `View dashboard: https://trading-journal-ghx.pages.dev`;

        await sendMessage(env, chatId, reply);
      } catch (e) {
        await sendMessage(env, chatId, `Error reading screenshot: ${e.message}`);
      }
      return ok();
    }

    // Handle text
    if (message.text) {
      const text = message.text.trim();
      if (text === '/start') {
        await sendMessage(env, chatId,
          "Trading Journal Bot ready!\n\nSend me a screenshot of your closed Bitget trade and I'll log it automatically.\n\nTip: Use Bitget's Share button for the clearest screenshot."
        );
      } else if (text === '/stats') {
        const stats = await getQuickStats(env);
        await sendMessage(env, chatId, stats);
      } else {
        await sendMessage(env, chatId, "Send me a trade screenshot to log it. Use /stats to see your summary.");
      }
    }

    return ok();
  } catch (e) {
    console.error(e);
    return ok();
  }
}

async function getTelegramFileUrl(env, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${clean(env.TELEGRAM_TOKEN)}/getFile?file_id=${fileId}`);
  const data = await res.json();
  const filePath = data.result.file_path;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`;
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function extractTradeFromImage(env, base64Image) {
  // OCR the image via ocr.space
  const ocrRes = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      apikey: clean(env.OCRSPACE_API_KEY),
      base64Image: `data:image/jpeg;base64,${base64Image}`,
      language: 'eng',
      isOverlayRequired: 'false',
      detectOrientation: 'true',
      scale: 'true',
      OCREngine: '2',
    }).toString(),
  });

  const ocrRaw = await ocrRes.text();
  let ocrData;
  try { ocrData = JSON.parse(ocrRaw); } catch(e) { throw new Error(`OCR non-JSON: ${ocrRaw.slice(0, 300)}`); }
  throw new Error(`OCR_RAW: ${ocrRaw.slice(0, 600)}`);
  const text = ocrData.ParsedResults?.[0]?.ParsedText || '';

  // Parse trade data from OCR text (handles both Order History and Share Card formats)
  // Share Card format: "ADAUSDT\nPerp | Short | 75x\n31.81%\nEntry price\n0.1886\nExit price\n0.1878"
  const symbolMatch = text.match(/([A-Z]{2,10})USDT/i);
  const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : null;

  // Side: "Close short/long" (Order History) or "| Short |" or standalone "Short/Long" (Share Card)
  const sideMatch = text.match(/(Open|Close)\s+(long|short)/i)
    || text.match(/[|\|]\s*(long|short)\s*[|\|]/i)
    || text.match(/\b(long|short)\b/i);
  const side = sideMatch ? (sideMatch[2] || sideMatch[1]).toLowerCase() : null;

  const leverageMatch = text.match(/(\d+)\s*[xX]/);
  const leverage = leverageMatch ? leverageMatch[1] : null;

  // Entry price — Share Card puts value on next line after "Entry price"
  const entryMatch = text.match(/Entry\s+price[\s\n:]*([0-9,\.]+)/i)
    || text.match(/Entry[\s\n]+([0-9,\.]+)/i);
  const entry_price = entryMatch ? entryMatch[1].replace(/,/g, '') : null;

  // Exit price — Share Card puts value on next line after "Exit price"
  const exitMatch = text.match(/Exit\s+price[\s\n:]*([0-9,\.]+)/i)
    || text.match(/Exit[\s\n]+([0-9,\.]+)/i)
    || text.match(/Avg\.?\s*filled\s+price[\s\n:]*([0-9,\.]+)/i);
  const exit_price = exitMatch ? exitMatch[1].replace(/,/g, '') : null;

  // PnL — Share Card shows ROI% as the big number, Order History has "Realized PnL"
  const pnlUsdtMatch = text.match(/Realized\s+PnL[\s\n:]*([+-]?[0-9,\.]+)/i);
  const roiMatch = text.match(/([+-]?[0-9]+\.[0-9]+)%/);
  const pnlRaw = pnlUsdtMatch ? pnlUsdtMatch[1].replace(/,/g, '') : (roiMatch ? roiMatch[1] : null);
  const pnl = pnlRaw !== null ? parseFloat(pnlRaw) : null;
  const pnlIsPercent = !pnlUsdtMatch && !!roiMatch;

  const feeMatch = text.match(/Fee[\s\n:]*([0-9,\.]+)/i);
  const fee = feeMatch ? parseFloat(feeMatch[1].replace(/,/g, '')) : 0;

  if (!symbol || pnl === null) throw new Error(`OCR_DEBUG | text: ${text.slice(0, 600)} | symbol: ${symbol} | side: ${side} | entry: ${entry_price} | exit: ${exit_price} | pnl: ${pnl}`);

  return {
    id: `tg_${Date.now()}`,
    symbol,
    side: side || 'long',
    size: null,
    leverage,
    entry_price,
    exit_price,
    pnl,
    pnlIsPercent,
    fee,
    open_time: Date.now(),
    close_time: Date.now(),
  };
}

async function saveTrade(env, trade) {
  await env.DB.prepare(`
    INSERT OR REPLACE INTO trades
      (id, symbol, side, size, leverage, entry_price, exit_price, pnl, fee, open_time, close_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    trade.id, trade.symbol, trade.side, trade.size, trade.leverage,
    trade.entry_price, trade.exit_price, trade.pnl, trade.fee,
    trade.open_time, trade.close_time
  ).run();
}

async function getQuickStats(env) {
  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) as total, SUM(pnl) as pnl, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins FROM trades'
  ).all();
  const r = results[0];
  if (!r.total) return 'No trades logged yet. Send me a screenshot!';
  const wr = ((r.wins / r.total) * 100).toFixed(1);
  const pnl = parseFloat(r.pnl || 0).toFixed(2);
  const sign = r.pnl >= 0 ? '+' : '';
  return `Your stats:\n\nTotal trades: ${r.total}\nWin rate: ${wr}%\nTotal PnL: ${sign}$${pnl}\n\nhttps://trading-journal-ghx.pages.dev`;
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${clean(env.TELEGRAM_TOKEN)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function ok() {
  return new Response('ok', { status: 200 });
}
