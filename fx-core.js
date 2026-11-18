/* fx-core.js
   Logic shared by the page (index.html) and the service worker (sw.js).
   Nothing in here touches the DOM. */
(function (root) {
  'use strict';

  // Frankfurter (ECB reference rates). v1 is the documented stable API; the
  // older .app host is kept as a fallback.
  var API_BASES = [
    { url: 'https://api.frankfurter.dev/v1/', query: '?base=EUR&symbols=INR' },
    { url: 'https://api.frankfurter.app/', query: '?from=EUR&to=INR' }
  ];
  var CHUNK_DAYS = 80;   // every request spans < 90 days so the API returns daily points
  var KEEP_DAYS = 330;   // history kept on-device (6 months for the forecast + room to backtest it)
  var HIGH_DAYS = 90;    // "new high" means highest in this many days

  var DATA_CACHE = 'fx-data';
  var HISTORY_URL = 'https://fx-data.invalid/history.json';
  var STATE_URL = 'https://fx-data.invalid/state.json';
  var LS_HISTORY = 'fx-history-eur-inr';
  var LS_STATE = 'fx-state-eur-inr';

  // ---------- dates ----------
  function parseISO(s) { return new Date(s + 'T00:00:00Z'); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

  // Entries within the last n calendar days of the series (inclusive of the latest day).
  function windowDays(history, n) {
    if (!history || !history.length) return [];
    var cutoff = isoDate(addDays(parseISO(history[history.length - 1].date), -n));
    return history.filter(function (e) { return e.date >= cutoff; });
  }

  function mergeEntries(a, b) {
    var map = {};
    (a || []).forEach(function (e) { map[e.date] = e.rate; });
    (b || []).forEach(function (e) { map[e.date] = e.rate; });
    return Object.keys(map).sort().map(function (d) { return { date: d, rate: map[d] }; });
  }

  // ---------- storage: Cache API (readable by the service worker) + localStorage mirror ----------
  async function cacheRead(url) {
    try {
      if (typeof caches === 'undefined') return null;
      var c = await caches.open(DATA_CACHE);
      var r = await c.match(url);
      return r ? await r.json() : null;
    } catch (e) { return null; }
  }
  async function cacheWrite(url, obj) {
    try {
      if (typeof caches === 'undefined') return;
      var c = await caches.open(DATA_CACHE);
      await c.put(url, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { /* best effort */ }
  }
  function lsRead(key) {
    try { var s = root.localStorage && root.localStorage.getItem(key); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function lsWrite(key, obj) {
    try { if (root.localStorage) root.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  // ---------- history ----------
  function newerSeries(a, b) {
    if (!a || !a.length) return b;
    if (!b || !b.length) return a;
    return a[a.length - 1].date >= b[b.length - 1].date ? a : b;
  }
  async function loadHistory() {
    return newerSeries(await cacheRead(HISTORY_URL), lsRead(LS_HISTORY)) || null;
  }
  async function saveHistory(h) {
    lsWrite(LS_HISTORY, h);
    await cacheWrite(HISTORY_URL, h);
  }

  function parseRange(data) {
    var rates = (data && data.rates) || {};
    return Object.keys(rates)
      .filter(function (d) { return rates[d] && typeof rates[d].INR === 'number'; })
      .map(function (d) { return { date: d, rate: rates[d].INR }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  async function fetchRange(start, end) {
    var lastErr = null;
    for (var i = 0; i < API_BASES.length; i++) {
      try {
        var res = await fetch(API_BASES[i].url + start + '..' + end + API_BASES[i].query);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var out = parseRange(await res.json());
        if (out.length) return out;
        throw new Error('No rates in response');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Rate request failed');
  }

  async function fetchFull() {
    var today = new Date();
    var chunks = [];
    for (var i = 0; i < 4; i++) {
      var end = addDays(today, -i * (CHUNK_DAYS + 1));
      chunks.push([isoDate(addDays(end, -CHUNK_DAYS)), isoDate(end)]);
    }
    var results = await Promise.all(chunks.map(function (c, i) {
      var p = fetchRange(c[0], c[1]);
      return i === 0 ? p : p.catch(function () { return []; }); // older chunks are best-effort
    }));
    return results.reduce(function (acc, r) { return mergeEntries(acc, r); }, []);
  }

  // Fetches only what's missing when a recent history is already on-device.
  async function syncHistory() {
    var existing = await loadHistory();
    var todayIso = isoDate(new Date());
    var hist;
    var canTopUp = existing && existing.length > 1 &&
      daysBetween(existing[0].date, existing[existing.length - 1].date) >= 170 &&
      daysBetween(existing[existing.length - 1].date, todayIso) <= 60;
    if (canTopUp) {
      var from = isoDate(addDays(parseISO(existing[existing.length - 1].date), -7));
      hist = mergeEntries(existing, await fetchRange(from, todayIso));
    } else {
      hist = await fetchFull();
    }
    hist = windowDays(hist, KEEP_DAYS);
    await saveHistory(hist);
    return hist;
  }

  // ---------- state (settings + alert bookkeeping) ----------
  function defaultState() {
    return {
      updatedAt: 0,            // bumps only when a synced field changes (targetRate, theme, amount)
      targetRate: null,
      theme: null,
      amount: 1000,
      notifyEnabled: false,    // per device
      lastHighAlertDate: null, // per device
      targetFired: false       // per device; re-arms when the rate drops back under the target
    };
  }
  async function loadState() {
    var a = await cacheRead(STATE_URL);
    var b = lsRead(LS_STATE);
    var best = (a && b) ? ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a) : (a || b);
    return Object.assign(defaultState(), best || {});
  }
  async function saveState(s) {
    lsWrite(LS_STATE, s);
    await cacheWrite(STATE_URL, s);
  }
  // Read-modify-write in one go so a stale copy can't overwrite a newer setting.
  async function updateState(fn, touch) {
    var s = await loadState();
    fn(s);
    if (touch) s.updatedAt = Date.now();
    await saveState(s);
    return s;
  }

  // ---------- alerts ----------
  function inr(n, d) {
    return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // Is the rate already at/above the target right now? (Used so setting a target never fires instantly.)
  function targetFiredFor(history, target) {
    if (target == null || !history || !history.length) return false;
    return history[history.length - 1].rate >= target;
  }

  // Treat whatever is true right now as already seen.
  function acknowledge(history, state) {
    if (!history || !history.length) return {};
    var latest = history[history.length - 1];
    return { lastHighAlertDate: latest.date, targetFired: targetFiredFor(history, state.targetRate) };
  }

  function evaluateAlerts(history, state) {
    var notes = [], patch = {};
    if (!history || history.length < 2) return { notes: notes, patch: patch };
    var latest = history[history.length - 1];
    var amount = state.amount > 0 ? state.amount : 1000;

    // New high: strictly above everything in the previous HIGH_DAYS days, once per data date.
    var prior = windowDays(history, HIGH_DAYS).filter(function (e) { return e.date < latest.date; });
    if (prior.length >= 15 && state.lastHighAlertDate !== latest.date) {
      var priorMax = Math.max.apply(null, prior.map(function (e) { return e.rate; }));
      if (latest.rate > priorMax) {
        notes.push({
          tag: 'fx-high',
          title: 'EUR → INR is at a ' + HIGH_DAYS + '-day high',
          body: '1 EUR = ' + inr(latest.rate, 2) + ' · ' + amount.toLocaleString('en-IN') + ' EUR ≈ ' + inr(latest.rate * amount, 0)
        });
        patch.lastHighAlertDate = latest.date;
      }
    }

    // Target: fires once on the way up, re-arms once the rate falls back under it.
    if (state.targetRate != null) {
      if (latest.rate >= state.targetRate) {
        if (!state.targetFired) {
          notes.push({
            tag: 'fx-target',
            title: 'EUR → INR reached your target',
            body: '1 EUR = ' + inr(latest.rate, 2) + ' (target ' + inr(state.targetRate, 2) + ')'
          });
          patch.targetFired = true;
        }
      } else if (state.targetFired) {
        patch.targetFired = false;
      }
    }
    return { notes: notes, patch: patch };
  }

  async function showNotes(notes) {
    if (!notes || !notes.length) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var reg = root.registration || null; // set inside a service worker
    if (!reg && root.navigator && root.navigator.serviceWorker) {
      try { reg = await root.navigator.serviceWorker.getRegistration(); } catch (e) { /* ignore */ }
    }
    var icon = reg && reg.scope ? new URL('icons/icon-192.png', reg.scope).href : 'icons/icon-192.png';
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var opts = { body: n.body, tag: n.tag, icon: icon, badge: icon };
      try {
        if (reg && reg.showNotification) await reg.showNotification(n.title, opts);
        else new Notification(n.title, opts);
      } catch (e) {
        try { new Notification(n.title, opts); } catch (e2) { /* nothing more to try */ }
      }
    }
  }

  // Evaluate + notify. State is saved first so a second context can't send the same alert.
  async function checkAlerts(history) {
    var state = await loadState();
    if (!state.notifyEnabled) return [];
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return [];
    var r = evaluateAlerts(history, state);
    if (Object.keys(r.patch).length) await updateState(function (s) { Object.assign(s, r.patch); }, false);
    await showNotes(r.notes);
    return r.notes;
  }

  // Used by the service worker's periodic background sync.
  async function backgroundCheck() {
    try {
      var hist = await syncHistory();
      await checkAlerts(hist);
    } catch (e) { /* offline or API down: try again next time */ }
  }

  // ---------- forecast ----------
  // Simulates the next `horizon` business days by replaying chunks of the last 6 months of
  // daily moves (block bootstrap), plus a small, heavily shrunk version of the recent trend.
  // FX rates are close to a random walk, so the useful output is the range and the odds,
  // not a single predicted number.
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashSeed(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function quantile(sorted, q) {
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return quantile(s, 0.5);
  }
  function logSlope(entries) {
    var n = entries.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) {
      var y = Math.log(entries[i].rate);
      sx += i; sy += y; sxy += i * y; sxx += i * i;
    }
    var d = n * sxx - sx * sx;
    return d ? (n * sxy - sx * sy) / d : 0;
  }
  // Business days after an ISO date, skipping weekends.
  function addBusinessDays(iso, n) {
    var d = parseISO(iso), added = 0;
    while (added < n) {
      d = addDays(d, 1);
      var dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return isoDate(d);
  }

  var FC_LOOKBACK = 180, FC_BLOCK = 5, FC_SHRINK = 0.25, FC_BEAT = 0.005;

  function forecast(history, opts) {
    opts = opts || {};
    var horizon = opts.horizon || 20;
    var nPaths = opts.paths || 4000;
    var win = windowDays(history, FC_LOOKBACK);
    if (win.length < 60) return null;

    var rets = [];
    for (var i = 1; i < win.length; i++) rets.push(Math.log(win[i].rate / win[i - 1].rate));
    var mean = rets.reduce(function (s, r) { return s + r; }, 0) / rets.length;
    var sigma = Math.sqrt(rets.reduce(function (s, r) { return s + (r - mean) * (r - mean); }, 0) / (rets.length - 1));
    var centered = rets.map(function (r) { return r - mean; });

    // Recent 30-day trend, shrunk to a quarter and capped at a quarter of a day's typical move.
    var drift = FC_SHRINK * logSlope(windowDays(history, 30));
    var cap = FC_SHRINK * sigma;
    drift = Math.max(-cap, Math.min(cap, drift));

    var last = history[history.length - 1];
    var start = last.rate;
    var high90 = Math.max.apply(null, windowDays(history, 90).map(function (e) { return e.rate; }));
    var target = opts.target != null && opts.target > start ? opts.target : null;
    var beatLevel = start * (1 + FC_BEAT);

    var rng = mulberry32(hashSeed(last.date + ':' + start.toFixed(4) + ':' + win.length));
    var steps = [];
    for (var k = 0; k < horizon; k++) steps.push(new Float64Array(nPaths));
    var beatDays = [], highDays = [], targetDays = [];
    var maxStart = centered.length - FC_BLOCK;

    for (var p = 0; p < nPaths; p++) {
      var logR = Math.log(start), b = 0, idx = 0;
      var hitBeat = false, hitHigh = false, hitTarget = false;
      for (var s = 0; s < horizon; s++) {
        if (b === 0) idx = Math.floor(rng() * (maxStart + 1));
        logR += centered[idx + b] + drift;
        b = (b + 1) % FC_BLOCK;
        var r = Math.exp(logR);
        steps[s][p] = r;
        if (!hitBeat && r >= beatLevel) { hitBeat = true; beatDays.push(s + 1); }
        if (!hitHigh && r > high90) { hitHigh = true; highDays.push(s + 1); }
        if (target && !hitTarget && r >= target) { hitTarget = true; targetDays.push(s + 1); }
      }
    }

    var bands = [], higher = [];
    for (var j = 0; j < horizon; j++) {
      var col = Array.prototype.slice.call(steps[j]).sort(function (a, b) { return a - b; });
      bands.push({
        date: addBusinessDays(last.date, j + 1),
        p10: quantile(col, 0.10), p50: quantile(col, 0.50), p90: quantile(col, 0.90)
      });
      var above = 0;
      for (var q = 0; q < nPaths; q++) if (steps[j][q] > start) above++;
      higher.push(above / nPaths);
    }

    function hitInfo(days) {
      var d = median(days);
      return { p: days.length / nPaths, typicalDay: d, typicalDate: d ? addBusinessDays(last.date, Math.round(d)) : null };
    }

    return {
      start: start,
      from: last.date,
      horizon: horizon,
      sigma: sigma,
      drift: drift,
      bands: bands,
      pHigher: higher,                // index k = after k+1 business days
      beatLevel: beatLevel,
      beat: hitInfo(beatDays),        // climbs 0.5%+ above today at some point
      high90: high90,
      newHigh: hitInfo(highDays),     // tops the 90-day high at some point
      target: target,
      targetHit: target ? hitInfo(targetDays) : null
    };
  }

  // Re-runs the model at past dates and checks how often the real rate `horizon` business
  // days later landed inside the 10–90% range. A well-calibrated model lands near 80%.
  // Yields between tests so it never freezes the page.
  async function backtestForecast(history, opts) {
    opts = opts || {};
    var horizon = opts.horizon || 20;
    var maxTests = opts.maxTests || 60;
    var tests = 0, inside = 0, dirRight = 0, dirTests = 0;
    for (var i = history.length - 1 - horizon; i >= 0 && tests < maxTests; i--) {
      var past = history.slice(0, i + 1);
      if (daysBetween(past[0].date, past[past.length - 1].date) < FC_LOOKBACK - 5) break;
      var f = forecast(past, { horizon: horizon, paths: opts.paths || 600 });
      if (!f) break;
      var actual = history[i + horizon].rate;
      var band = f.bands[horizon - 1];
      tests++;
      if (actual >= band.p10 && actual <= band.p90) inside++;
      var pUp = f.pHigher[horizon - 1];
      if (Math.abs(pUp - 0.5) >= 0.05) {
        dirTests++;
        if ((pUp > 0.5) === (actual > past[past.length - 1].rate)) dirRight++;
      }
      if (tests % 4 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return { tests: tests, coverage: tests ? inside / tests : null, dirTests: dirTests, dirHit: dirTests ? dirRight / dirTests : null };
  }

  var FX = {
    forecast: forecast,
    backtestForecast: backtestForecast,
    addBusinessDays: addBusinessDays,
    windowDays: windowDays,
    mergeEntries: mergeEntries,
    loadHistory: loadHistory,
    syncHistory: syncHistory,
    loadState: loadState,
    updateState: updateState,
    evaluateAlerts: evaluateAlerts,
    targetFiredFor: targetFiredFor,
    acknowledge: acknowledge,
    showNotes: showNotes,
    checkAlerts: checkAlerts,
    backgroundCheck: backgroundCheck,
    // exposed for tests
    _fetchRange: fetchRange,
    _parseRange: parseRange
  };

  root.FX = FX;
  if (typeof module !== 'undefined' && module.exports) module.exports = FX;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
