const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8735;

// --- Static file serving (same pattern as the Roulette Wallet app) ---
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.join(root, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
      '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
    };
    const type = types[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// --- RailRadar proxy ---
// Keeps the API key off the wire to any third party other than the provider
// itself. Docs: https://railradar.in/docs
// Free sandbox tier is capped at 1,000 requests/month — every caller of this
// helper is expected to throttle/debounce on the client side.
function railRadarGet(upstreamPath, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.railradar.in',
      path: upstreamPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    };
    const req = https.request(options, (upstreamRes) => {
      let body = '';
      upstreamRes.on('data', (chunk) => { body += chunk; });
      upstreamRes.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          reject({ status: 502, error: 'upstream response was not valid JSON' });
          return;
        }
        if (json.success === false) {
          const status = upstreamRes.statusCode && upstreamRes.statusCode >= 400 ? upstreamRes.statusCode : 502;
          reject({ status, error: (json.error && json.error.message) || 'upstream error', code: json.error && json.error.code });
          return;
        }
        resolve(json);
      });
    });
    req.on('error', () => reject({ status: 502, error: 'could not reach RailRadar' }));
    req.end();
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function handleError(res, err) {
  if (err && err.status) sendJson(res, err.status, { error: err.error, code: err.code });
  else sendJson(res, 502, { error: 'unexpected proxy error' });
}

// Normalizes a /v1/trains/{number}/live response to:
// { stationName, delayMinutes, distanceRemainingKm, updatedAt }
function normalizeLiveStatus(json) {
  const d = json.data;
  if (!d) return null;
  const cur = d.currentLocation || {};
  const prev = d.previousHalt || {};
  const next = d.nextHalt || {};

  let distanceRemainingKm = null;
  const totalDistance = d.train && typeof d.train.distance === 'number' ? d.train.distance : null;
  if (totalDistance != null && typeof prev.distance === 'number') {
    const segSpan = (typeof next.distance === 'number' ? next.distance : prev.distance) - prev.distance;
    const covered = prev.distance + (cur.segmentProgress || 0) * segSpan;
    distanceRemainingKm = Math.max(0, Math.round(totalDistance - covered));
  }

  const stationName = cur.status === 'halted'
    ? (prev.stationName || cur.stationCode || null)
    : (next.stationName ? `en route to ${next.stationName}` : (cur.stationCode || null));

  return {
    stationName,
    delayMinutes: typeof d.delayMinutes === 'number' ? d.delayMinutes : 0,
    distanceRemainingKm,
    updatedAt: d.lastUpdatedAt || new Date().toISOString(),
  };
}

async function handleLiveStatus(req, res, query) {
  const trainNumber = (query.get('number') || '').replace(/[^0-9]/g, '');
  const apiKey = query.get('key') || '';
  const date = (query.get('date') || '').trim(); // optional YYYY-MM-DD; omit to let RailRadar auto-detect the current run

  if (!trainNumber || !apiKey) return sendJson(res, 400, { error: 'missing number or key' });

  let upstreamPath = `/v1/trains/${encodeURIComponent(trainNumber)}/live`;
  if (date) upstreamPath += `?date=${encodeURIComponent(date)}`;

  try {
    const json = await railRadarGet(upstreamPath, apiKey);
    const normalized = normalizeLiveStatus(json);
    if (!normalized) return sendJson(res, 502, { error: 'upstream returned no usable status' });
    sendJson(res, 200, normalized);
  } catch (err) {
    handleError(res, err);
  }
}

// Station autocomplete — https://railradar.in/docs/search-stations
// Normalizes to: [{ code, name, city }]
async function handleStationSearch(req, res, query) {
  const q = (query.get('q') || '').trim();
  const apiKey = query.get('key') || '';
  const limit = query.get('limit') || '10';

  if (!q || !apiKey) return sendJson(res, 400, { error: 'missing q or key' });

  try {
    const json = await railRadarGet(`/v1/lookup/search/stations?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`, apiKey);
    sendJson(res, 200, Array.isArray(json.data) ? json.data : []);
  } catch (err) {
    handleError(res, err);
  }
}

// Trains running between two station codes — https://railradar.in/docs/trains-between-stations
// Normalizes to: [{ number, name, type, departure, arrival, fromDay, toDay, delayMinutes, platform }]
async function handleTrainsBetween(req, res, query) {
  const from = (query.get('from') || '').trim().toUpperCase();
  const to = (query.get('to') || '').trim().toUpperCase();
  const apiKey = query.get('key') || '';
  const date = (query.get('date') || '').trim();

  if (!from || !to || !apiKey) return sendJson(res, 400, { error: 'missing from, to, or key' });

  let upstreamPath = `/v1/trains/between/${encodeURIComponent(from)}/${encodeURIComponent(to)}?live=true`;
  if (date) upstreamPath += `&date=${encodeURIComponent(date)}`;

  try {
    const json = await railRadarGet(upstreamPath, apiKey);
    const trains = (json.data && json.data.trains) || [];
    const normalized = trains.map((t) => ({
      number: t.train.number,
      name: t.train.name,
      type: t.train.type || null,
      departure: t.from && t.from.departure,
      arrival: t.to && t.to.arrival,
      fromDay: (t.from && t.from.day) || 1,
      toDay: (t.to && t.to.day) || 1,
      delayMinutes: t.live && typeof t.live.delayMinutes === 'number' ? t.live.delayMinutes : null,
      platform: t.live && t.live.platform || null,
    }));
    sendJson(res, 200, normalized);
  } catch (err) {
    handleError(res, err);
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api/live-status') return handleLiveStatus(req, res, url.searchParams);
  if (url.pathname === '/api/station-search') return handleStationSearch(req, res, url.searchParams);
  if (url.pathname === '/api/trains-between') return handleTrainsBetween(req, res, url.searchParams);
  serveStatic(req, res);
}).listen(port, () => console.log('listening on ' + port));
