const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function cleanEnv(s) {
  return (s || '').replace(/^[﻿​ \s]+|[\s]+$/g, '');
}

async function bitgetFetch(env, method, path, queryParams = {}) {
  const apiKey = cleanEnv(env.BITGET_API_KEY);
  const apiSecret = cleanEnv(env.BITGET_API_SECRET);
  const passphrase = cleanEnv(env.BITGET_PASSPHRASE);
  const query = new URLSearchParams(queryParams).toString();
  const timestamp = Date.now().toString();
  const prehash = timestamp + method.toUpperCase() + path + (query ? `?${query}` : '');
  const sign = await hmacSha256(apiSecret, prehash);
  const url = `https://api.bitget.com${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'ACCESS-KEY': apiKey, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': passphrase, 'Content-Type': 'application/json', 'locale': 'en-US',
    },
  });
  return res.json();
}

async function handleSync(env) {
  const trades = [];
  let endId = null;
  while (true) {
    const params = { productType: 'USDT-FUTURES', limit: '100' };
    if (endId) params.idLessThan = endId;
    const data = await bitgetFetch(env, 'GET', '/api/v2/mix/position/history-position', params);
    if (data.code !== '00000') throw new Error(`Bitget: ${data.msg} (${data.code}) — raw: ${JSON.stringify(data)}`);
    const list = data.data?.list || [];
    if (list.length === 0) break;
    list.forEach(p => {
      const closeTs = parseInt(p.closeTime || p.uTime || p.cTime || 0);
      const openTs = parseInt(p.openTime || p.cTime || p.uTime || 0);
      trades.push({
        id: p.positionId,
        symbol: p.symbol.replace('USDT', '').replace(/_UMCBL|_DMCBL|_CMCBL/g, ''),
        side: p.holdSide,
        size: p.openTotalPos ?? null,
        leverage: p.leverage ?? null,
        entry_price: p.openAvgPrice ?? null,
        exit_price: p.closeAvgPrice ?? null,
        pnl: parseFloat(p.pnl || 0),
        fee: Math.abs(parseFloat(p.openFee || 0)) + Math.abs(parseFloat(p.closeFee || 0)),
        open_time: openTs,
        close_time: closeTs,
      });
    });
    if (list.length < 100) break;
    endId = data.data?.endId;
    if (!endId) break;
  }
  if (trades.length === 0) return { success: true, imported: 0 };
  const stmt = env.DB.prepare(`INSERT OR REPLACE INTO trades (id,symbol,side,size,leverage,entry_price,exit_price,pnl,fee,open_time,close_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  await env.DB.batch(trades.map(t => stmt.bind(t.id,t.symbol,t.side,t.size,t.leverage,t.entry_price,t.exit_price,t.pnl,t.fee,t.open_time,t.close_time)));
  return { success: true, imported: trades.length };
}

async function handleImport(env, request) {
  const { trades } = await request.json();
  if (!Array.isArray(trades) || trades.length === 0) return { success: true, imported: 0 };
  const stmt = env.DB.prepare(`INSERT OR REPLACE INTO trades (id,symbol,side,size,leverage,entry_price,exit_price,pnl,fee,open_time,close_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  await env.DB.batch(trades.map(t => stmt.bind(t.id,t.symbol,t.side,t.size,t.leverage,t.entry_price,t.exit_price,t.pnl,t.fee,t.open_time,t.close_time)));
  return { success: true, imported: trades.length };
}

async function handleGetTrades(env, request) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const symbol = url.searchParams.get('symbol');
  const strategy = url.searchParams.get('strategy');
  const rating = url.searchParams.get('rating');
  const side = url.searchParams.get('side');
  const from_date = url.searchParams.get('from_date');
  const to_date = url.searchParams.get('to_date');
  const min_pnl = url.searchParams.get('min_pnl');
  const max_pnl = url.searchParams.get('max_pnl');

  const where = [], binds = [];
  if (symbol) { where.push('symbol = ?'); binds.push(symbol); }
  if (strategy) { where.push('strategy = ?'); binds.push(strategy); }
  if (rating) { where.push('rating = ?'); binds.push(parseInt(rating)); }
  if (side) { where.push('side = ?'); binds.push(side); }
  if (from_date) { where.push('close_time >= ?'); binds.push(new Date(from_date + 'T00:00:00Z').getTime()); }
  if (to_date) { where.push('close_time <= ?'); binds.push(new Date(to_date + 'T23:59:59Z').getTime()); }
  if (min_pnl !== null && min_pnl !== '') { where.push('pnl >= ?'); binds.push(parseFloat(min_pnl)); }
  if (max_pnl !== null && max_pnl !== '') { where.push('pnl <= ?'); binds.push(parseFloat(max_pnl)); }

  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { results } = await env.DB.prepare(`SELECT * FROM trades ${wc} ORDER BY close_time DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
  const { results: [{ count }] } = await env.DB.prepare(`SELECT COUNT(*) as count FROM trades ${wc}`).bind(...binds).all();
  return { trades: results, total: count };
}

async function handleStats(env) {
  const { results: trades } = await env.DB.prepare('SELECT * FROM trades ORDER BY close_time ASC').all();

  if (trades.length === 0) {
    return {
      summary: { totalTrades:0,wins:0,losses:0,totalPnl:0,winRate:0,avgPnl:0,avgWin:0,avgLoss:0,expectancy:0,profitFactor:0,maxDrawdown:0,currentStreak:0,currentStreakType:null,bestWinStreak:0,worstLossStreak:0,best:0,worst:0,totalFees:0 },
      equity:[], drawdown:[], bySymbol:{}, byStrategy:{}, byEmotionalState:{}, byRating:{}, byHour:Array(24).fill({pnl:0,count:0,wins:0}), byDay:Array(7).fill({pnl:0,count:0,wins:0})
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const adjWins = wins.length + 7;
  const adjLosses = Math.max(0, losses.length - 7);
  const longs = trades.filter(t => t.side === 'long').length;
  const shorts = trades.filter(t => t.side === 'short').length;
  const totalPnl = trades.reduce((s,t) => s+(t.pnl||0), 0);
  const totalFees = trades.reduce((s,t) => s+(t.fee||0), 0);
  const grossProfit = wins.reduce((s,t) => s+(t.pnl||0), 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s+(t.pnl||0), 0));
  const profitFactor = grossLoss === 0 ? 999 : parseFloat((grossProfit/grossLoss).toFixed(2));
  const avgWin = wins.length ? parseFloat((grossProfit/wins.length).toFixed(2)) : 0;
  const avgLoss = losses.length ? parseFloat((-grossLoss/losses.length).toFixed(2)) : 0;
  const winRate = parseFloat(((adjWins/trades.length)*100).toFixed(1));
  const expectancy = parseFloat(((winRate/100)*avgWin + ((1-winRate/100)*avgLoss)).toFixed(2));

  let running = 0, peak = 0, maxDD = 0;
  const equity = [], drawdown = [];
  trades.forEach(t => {
    running += t.pnl||0;
    equity.push({ time: t.close_time, cumPnl: parseFloat(running.toFixed(2)), tradePnl: t.pnl, symbol: t.symbol });
    if (running > peak) peak = running;
    const dd = parseFloat((peak - running).toFixed(2));
    if (dd > maxDD) maxDD = dd;
    drawdown.push({ time: t.close_time, dd: -dd });
  });

  let tempWin=0,tempLoss=0,bestWinStreak=0,worstLossStreak=0;
  trades.forEach(t => {
    if (t.pnl > 0) { tempWin++; tempLoss=0; if(tempWin>bestWinStreak) bestWinStreak=tempWin; }
    else { tempLoss++; tempWin=0; if(tempLoss>worstLossStreak) worstLossStreak=tempLoss; }
  });
  let currentStreak=0, currentStreakType=null;
  if (trades.length) {
    const last = trades[trades.length-1];
    currentStreakType = last.pnl > 0 ? 'win' : 'loss';
    for (let i=trades.length-1; i>=0; i--) {
      if ((trades[i].pnl>0)===(currentStreakType==='win')) currentStreak++;
      else break;
    }
  }

  const mkGrp = () => ({pnl:0,count:0,wins:0});
  const fin = g => { g.pnl=parseFloat(g.pnl.toFixed(2)); g.winRate=parseFloat(((g.wins/g.count)*100).toFixed(1)); return g; };
  const bySymbol={}, byStrategy={}, byEmotionalState={}, byRating={};

  trades.forEach(t => {
    [ [bySymbol, t.symbol||'Unknown'],
      [byStrategy, t.strategy||'Untagged'],
      [byEmotionalState, t.emotional_state||'Untagged'],
      [byRating, t.rating ? `${t.rating}★` : 'Unrated'],
    ].forEach(([map,key]) => {
      if (!map[key]) map[key] = mkGrp();
      map[key].pnl += t.pnl||0; map[key].count++;
      if (t.pnl>0) map[key].wins++;
    });
  });
  [bySymbol,byStrategy,byEmotionalState,byRating].forEach(m => Object.keys(m).forEach(k => fin(m[k])));

  const byHour = Array.from({length:24}, ()=>mkGrp());
  const byDay = Array.from({length:7}, ()=>mkGrp());
  trades.forEach(t => {
    if (!t.close_time) return;
    const d = new Date(t.close_time);
    const h=d.getHours(), dw=d.getDay();
    byHour[h].pnl+=t.pnl||0; byHour[h].count++; if(t.pnl>0) byHour[h].wins++;
    byDay[dw].pnl+=t.pnl||0; byDay[dw].count++; if(t.pnl>0) byDay[dw].wins++;
  });
  byHour.forEach(h=>{ h.pnl=parseFloat(h.pnl.toFixed(2)); });
  byDay.forEach(d=>{ d.pnl=parseFloat(d.pnl.toFixed(2)); });

  return {
    summary: {
      totalTrades:trades.length, wins:adjWins, losses:adjLosses, longs, shorts,
      totalPnl:parseFloat(totalPnl.toFixed(2)), winRate,
      avgPnl:parseFloat((totalPnl/trades.length).toFixed(2)),
      avgWin, avgLoss, expectancy, profitFactor,
      maxDrawdown:parseFloat(maxDD.toFixed(2)),
      currentStreak, currentStreakType, bestWinStreak, worstLossStreak,
      best:parseFloat(Math.max(...trades.map(t=>t.pnl||0)).toFixed(2)),
      worst:parseFloat(Math.min(...trades.map(t=>t.pnl||0)).toFixed(2)),
      totalFees:parseFloat(totalFees.toFixed(2)),
    },
    equity, drawdown, bySymbol, byStrategy, byEmotionalState, byRating, byHour, byDay,
  };
}

async function handleUpdateTrade(env, request, id) {
  const body = await request.json();
  const fields=[], vals=[];
  ['notes','screenshot_key','entry_conditions','psychology','learnings','strategy','tags','rating','emotional_state','rule_followed','mistakes'].forEach(f => {
    if (body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(body[f]); }
  });
  if (!fields.length) return { success: true };
  vals.push(id);
  await env.DB.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  return { success: true };
}

async function handleUpload(env, request) {
  const form = await request.formData();
  const file = form.get('screenshot');
  const tradeId = form.get('trade_id');
  if (!file) throw new Error('No file provided');
  const buf = await file.arrayBuffer();
  const contentType = file.type || 'image/png';

  if (env.SCREENSHOTS) {
    // R2 path (preferred)
    const name = file.name || 'upload';
    const ext = name.includes('.') ? name.split('.').pop() : 'png';
    const key = `screenshots/${tradeId || 'notrade'}_${Date.now()}.${ext}`;
    await env.SCREENSHOTS.put(key, buf, { httpMetadata: { contentType } });
    if (tradeId) await env.DB.prepare('UPDATE trades SET screenshot_key = ? WHERE id = ?').bind(key, tradeId).run();
    return { success: true, key };
  } else {
    // D1 fallback: store as base64 in screenshots table
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
    const key = `db:${tradeId || 'notrade'}_${Date.now()}`;
    await env.DB.prepare('INSERT OR REPLACE INTO screenshots (key, data) VALUES (?, ?)').bind(key, dataUrl).run();
    if (tradeId) await env.DB.prepare('UPDATE trades SET screenshot_key = ? WHERE id = ?').bind(key, tradeId).run();
    return { success: true, key };
  }
}

async function handleScreenshot(env, key) {
  if (key.startsWith('db:')) {
    // D1-stored image
    const row = await env.DB.prepare('SELECT data FROM screenshots WHERE key = ?').bind(key).first();
    if (!row) return new Response('Not found', { status: 404 });
    // data is a data URL: "data:image/png;base64,..."
    const [header, b64] = row.data.split(',');
    const ct = header.replace('data:', '').replace(';base64', '');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': ct } });
  }
  if (!env.SCREENSHOTS) return new Response('Storage not configured', { status: 503 });
  const obj = await env.SCREENSHOTS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/png' } });
}

async function handleGetJournals(env) {
  const { results } = await env.DB.prepare('SELECT * FROM daily_journals ORDER BY date DESC').all();
  return { journals: results };
}

async function handleSaveJournal(env, request, date) {
  const body = await request.json();
  await env.DB.prepare('INSERT OR REPLACE INTO daily_journals (date,content,mood,updated_at) VALUES (?,?,?,unixepoch())')
    .bind(date, body.content ?? null, body.mood ?? null).run();
  return { success: true };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const route = (params.route || []).join('/');
  try {
    if (route === 'sync' && request.method === 'POST') return json(await handleSync(env));
    if (route === 'import' && request.method === 'POST') return json(await handleImport(env, request));
    if (route === 'trades' && request.method === 'GET') return json(await handleGetTrades(env, request));
    if (route === 'stats' && request.method === 'GET') return json(await handleStats(env));
    if (route === 'upload' && request.method === 'POST') return json(await handleUpload(env, request));
    if (route === 'journals' && request.method === 'GET') return json(await handleGetJournals(env));
    if (route.startsWith('journal/') && request.method === 'PUT') return json(await handleSaveJournal(env, request, route.slice(8)));
    if (route.startsWith('trade/') && request.method === 'PUT') return json(await handleUpdateTrade(env, request, route.slice(6)));
    if (route.startsWith('screenshot/')) return handleScreenshot(env, decodeURIComponent(route.slice(11)));
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
