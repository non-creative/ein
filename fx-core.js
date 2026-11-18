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
  var KEEP_DAYS = 270;   // history kept on-device
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
    for (var i = 0; i < 3; i++) {
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

  var FX = {
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
