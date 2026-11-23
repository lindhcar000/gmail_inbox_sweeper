/* Inbox Sweep — browser app. Talks directly to the Gmail API with the user's token. */
(function () {
  "use strict";

  const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
  const API = "https://gmail.googleapis.com/gmail/v1/users/me/";
  const STORE_KEY = "inboxSweep.settings.v1";
  const UNSUB_KEY = "inboxSweep.unsubscribed.v1"; // see Unsub.parseStore
  const CONCURRENCY = 10;
  // Projects created since May 2026 get 6,000 quota units per user per minute (100/sec).
  // Start at 90% of that. Older projects may allow more, so the limiter probes upward
  // to MAX_RATE, and settles lower if Gmail objects.
  const START_RATE = 90, MIN_RATE = 20, MAX_RATE = 200; // units per second
  const MAX_PAUSED_MS = 5 * 60 * 1000; // give up on a request after waiting this long
  // https://developers.google.com/workspace/gmail/api/reference/quota
  const COST = { profile: 1, list: 5, get: 20, trash: 20, batchModify: 50, send: 100 };
  // Only the headers the rules need, instead of every header on every email.
  const HEADERS = [
    "From", "To", "Cc", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Precedence",
    "Auto-Submitted", "X-Mailchimp-Id", "X-MC-User", "X-SG-EID", "X-SG-ID", "X-Mailgun-Sid",
    "X-Feedback-ID", "X-CSA-Complaints", "X-Mailer-RecptId", "X-Campaign", "X-CampaignID",
    "X-SFMC-Stack", "X-Marketo-ID", "X-Klaviyo-Id", "X-HubSpot-Id", "X-Emarsys-Id",
  ];
  const HEADER_QS = HEADERS.map((h) => "&metadataHeaders=" + encodeURIComponent(h)).join("");

  const DEFAULTS = {
    rules: { marketing: true, social: true, notifications: true, oldUnread: true },
    threshold: 3,
    allowlist: "",
    extraSocial: "",
    maxPerRule: 2000,
    clientId: "",
    oldMonths: 12, // slider value: delete unopened mail older than this many months
    oldDate: "",   // exact cutoff date (YYYY-MM-DD) from the date picker; overrides oldMonths
  };
  // Slider stops, in months. Finer steps for recent dates, wider for older ones.
  const OLD_STEPS = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120];
  const STRICTNESS ={ 2: "Aggressive", 3: "Balanced", 4: "Careful", 5: "Very careful", 6: "Only obvious ads" };

  const $ = (id) => document.getElementById(id);
  const state = {
    settings: loadSettings(),
    token: null, tokenExpiry: 0, tokenClient: null, pendingToken: null,
    me: "", rows: [], tab: "DELETE", filter: "", stop: false, busy: false, confirmTimer: null,
    unsubStore: loadUnsubscribed(), unsubscribed: {}, unsubView: "todo", unsubOpened: new Set(),
    unsubArmed: null, unsubTimer: null, unsubBusy: new Set(),
  };

  // ------------------------------------------------------------- settings --

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) return { ...DEFAULTS, ...saved, rules: { ...DEFAULTS.rules, ...(saved.rules || {}) } };
    } catch (e) { /* storage unavailable */ }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function loadUnsubscribed() {
    try {
      return Unsub.parseStore(JSON.parse(localStorage.getItem(UNSUB_KEY) || "null"));
    } catch (e) { /* storage unavailable */ }
    return Unsub.parseStore(null);
  }

  function saveUnsubscribed() {
    try { localStorage.setItem(UNSUB_KEY, JSON.stringify(state.unsubStore)); } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  function bindSettings() {
    const s = state.settings;
    for (const r of Object.keys(DEFAULTS.rules)) {
      const el = $("r-" + r);
      el.checked = !!s.rules[r];
      el.addEventListener("change", () => { s.rules[r] = el.checked; changed(); });
    }
    const th = $("threshold");
    th.value = s.threshold;
    const showTh = () => ($("thresholdLabel").textContent = STRICTNESS[th.value] + " (score ≥ " + th.value + ")");
    showTh();
    th.addEventListener("input", () => { s.threshold = Number(th.value); showTh(); changed(); });

    for (const key of ["allowlist", "extraSocial", "clientId"]) {
      const el = $(key);
      el.value = s[key];
      el.addEventListener("input", () => { s[key] = el.value; changed(key === "allowlist"); });
    }
    // --- "unopened before" date slider + exact date picker
    const slider = $("oldSlider"), picker = $("oldDate");
    slider.max = OLD_STEPS.length - 1;
    slider.value = nearestStep(s.oldMonths);
    picker.max = isoDate(Date.now());
    slider.addEventListener("input", () => {
      s.oldMonths = OLD_STEPS[slider.value];
      s.oldDate = "";
      showOldCutoff(); changed();
    });
    picker.addEventListener("change", () => {
      const v = picker.value;
      if (!v || new Date(v + "T00:00:00").getTime() > Date.now()) { showOldCutoff(); return; }
      s.oldDate = v;
      slider.value = nearestStep(monthsAgo(new Date(v + "T00:00:00").getTime()));
      showOldCutoff(); changed();
    });
    $("r-oldUnread").addEventListener("change", showOldCutoff);
    showOldCutoff();

    const mx = $("maxPerRule");
    mx.value = s.maxPerRule;
    mx.addEventListener("input", () => { s.maxPerRule = Math.max(50, Number(mx.value) || DEFAULTS.maxPerRule); changed(); });

    $("resetSettings").addEventListener("click", () => {
      state.settings = JSON.parse(JSON.stringify(DEFAULTS));
      saveSettings();
      location.reload();
    });
  }

  function changed(isAllowlist) {
    saveSettings();
    checkClientId();
    if (state.rows.length && !state.busy) {
      if (isAllowlist) applyAllowlist();
      else setStatus("Settings changed. Scan again to apply them.");
    }
  }

  // ------------------------------------------------- unopened-mail cutoff --

  function isoDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function monthsAgo(ms) { return (Date.now() - ms) / (30.44 * 864e5); }
  function nearestStep(months) {
    let best = 0;
    OLD_STEPS.forEach((m, i) => { if (Math.abs(m - months) < Math.abs(OLD_STEPS[best] - months)) best = i; });
    return best;
  }
  function ageLabel(months) {
    if (months < 12) return months + (months === 1 ? " month" : " months");
    const y = months / 12;
    return (Number.isInteger(y) ? y : y.toFixed(1)) + (y === 1 ? " year" : " years");
  }

  /** The cutoff as epoch ms: unopened mail received before this is flagged. */
  function oldCutoffMs() {
    const s = state.settings;
    if (s.oldDate) return new Date(s.oldDate + "T00:00:00").getTime();
    const d = new Date();
    d.setMonth(d.getMonth() - (Number(s.oldMonths) || 12));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function showOldCutoff() {
    const s = state.settings, cutoff = oldCutoffMs();
    $("oldLabel").textContent = Rules.formatDate(cutoff);
    $("oldAgo").textContent = s.oldDate ? "exact date" : ageLabel(Number(s.oldMonths) || 12) + " ago";
    $("oldDate").value = isoDate(cutoff);
    $("oldBlock").classList.toggle("off", !$("r-oldUnread").checked);
  }

  function allowlist() { return Rules.cleanList(state.settings.allowlist.split("\n")); }
  function socialDomains() {
    return Rules.DEFAULT_SOCIAL_DOMAINS.concat(Rules.cleanList(state.settings.extraSocial.split("\n")));
  }
  function clientId() {
    return (state.settings.clientId || "").trim() || (window.APP_CONFIG && window.APP_CONFIG.clientId) || "";
  }
  function checkClientId() {
    const ok = /\.apps\.googleusercontent\.com$/.test(clientId()) && !/PASTE/.test(clientId());
    $("setupNotice").classList.toggle("hidden", ok);
    return ok;
  }

  // ----------------------------------------------------------------- auth --

  function waitForGoogle() {
    return new Promise((resolve) => {
      const tick = () => (window.google && google.accounts && google.accounts.oauth2 ? resolve() : setTimeout(tick, 100));
      tick();
    });
  }

  async function getTokenClient() {
    await waitForGoogle();
    if (!state.tokenClient || state.tokenClient._cid !== clientId()) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        callback: (resp) => {
          const p = state.pendingToken; state.pendingToken = null;
          if (resp.error) return p && p.reject(new Error(resp.error_description || resp.error));
          state.token = resp.access_token;
          state.tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          p && p.resolve();
        },
        error_callback: (err) => {
          const p = state.pendingToken; state.pendingToken = null;
          p && p.reject(new Error(err.message || err.type || "Sign-in was cancelled"));
        },
      });
      state.tokenClient._cid = clientId();
    }
    return state.tokenClient;
  }

  async function requestToken(prompt) {
    const tc = await getTokenClient();
    return new Promise((resolve, reject) => {
      state.pendingToken = { resolve, reject };
      tc.requestAccessToken({ prompt: prompt, hint: state.me || undefined });
    });
  }

  async function ensureToken() {
    if (state.token && Date.now() < state.tokenExpiry) return;
    await requestToken("");
  }

  async function signIn() {
    if (!checkClientId()) return setStatus("Add a Google Client ID first (see the notice above).");
    try {
      setStatus("Waiting for Google sign-in…");
      await requestToken(state.me ? "" : "consent");
      const profile = await gmail("profile", { units: COST.profile });
      state.me = profile.emailAddress;
      state.unsubscribed = Unsub.openAccount(state.unsubStore, state.me.toLowerCase());
      saveUnsubscribed();
      $("who").textContent = state.me + " · ";
      $("signin").classList.add("hidden");
      $("signout").classList.remove("hidden");
      $("scan").disabled = $("compare").disabled = false;
      setStatus("Signed in. Choose what to clean up, then scan your inbox. Nothing is deleted until you confirm.");
    } catch (e) {
      setStatus("Sign-in failed: " + e.message);
    }
  }

  function signOut() {
    if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null; state.me = ""; state.rows = [];
    state.unsubscribed = {}; state.unsubOpened.clear(); state.unsubArmed = null;
    $("who").textContent = "";
    $("signin").classList.remove("hidden");
    $("signout").classList.add("hidden");
    $("scan").disabled = $("compare").disabled = true;
    $("results").classList.add("hidden");
    $("export").classList.add("hidden");
    setProgress(0);
    setStatus("Signed out.");
  }

  // ------------------------------------------------------------ Gmail API --

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Token-bucket rate limiter shared by every request. When Gmail reports a rate
  // limit, all requests pause together and the rate drops; it recovers slowly.
  const limiter = {
    rate: START_RATE, ceiling: MAX_RATE, units: START_RATE, at: performance.now(),
    pausedUntil: 0, strikes: 0, lastPenalty: -1, lastRaise: performance.now(),
  };

  function checkStop(opts) {
    if (opts.stoppable && state.stop) throw new Error("Stopped");
  }

  async function takeQuota(units, opts) {
    for (;;) {
      checkStop(opts);
      const now = performance.now();
      let wait = limiter.pausedUntil - now;
      if (wait <= 0) {
        const cap = Math.max(limiter.rate, units); // so a 100-unit call can always go through
        limiter.units = Math.min(cap, limiter.units + ((now - limiter.at) / 1000) * limiter.rate);
        limiter.at = now;
        if (limiter.units >= units) { limiter.units -= units; return; }
        wait = ((units - limiter.units) / limiter.rate) * 1000;
      }
      await sleep(Math.min(Math.max(wait, 5), 500)); // short naps, so Stop works during a pause
    }
  }

  function slowDown(sentAt) {
    // Requests already in flight fail together; count them as one penalty.
    if (sentAt <= limiter.lastPenalty) return;
    const now = performance.now();
    limiter.rate = Math.max(MIN_RATE, limiter.rate * 0.85);
    limiter.ceiling = limiter.rate; // don't probe past a speed Gmail has refused
    limiter.strikes++;
    const pause = Math.min(60000, 5000 * 2 ** (limiter.strikes - 1)) + Math.random() * 1000;
    limiter.units = 0;
    limiter.lastPenalty = limiter.lastRaise = now;
    limiter.pausedUntil = limiter.at = now + pause;
    if (state.busy && !state.stop) setStatus("Gmail asked us to slow down. Continuing in " + Math.ceil(pause / 1000) + " seconds…");
  }

  function speedUp() {
    const now = performance.now();
    if (now < limiter.pausedUntil) return; // a late success from before the pause
    limiter.strikes = 0;
    if (now - limiter.lastRaise < 30000) return;
    limiter.lastRaise = now;
    limiter.rate = Math.min(limiter.ceiling, limiter.rate * 1.05);
  }

  async function gmail(path, opts = {}) {
    const started = performance.now();
    let attempt = 0;
    for (;;) {
      checkStop(opts);
      await ensureToken();
      await takeQuota(opts.units || COST.list, opts);
      const headers = { Authorization: "Bearer " + state.token };
      if (opts.body) headers["Content-Type"] = "application/json";
      const sentAt = performance.now();
      const res = await fetch(API + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text(); // batchModify returns an empty body
      if (res.ok) {
        speedUp();
        return text ? JSON.parse(text) : {};
      }
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
      const rateLimited = Rules.isRateLimit(res.status, body);
      if (rateLimited) {
        slowDown(sentAt);
        if (performance.now() - started < MAX_PAUSED_MS) continue;
      } else if (res.status === 401 && attempt++ < 5) {
        state.token = null;
        continue;
      } else if (res.status >= 500 && attempt++ < 5) {
        await sleep(Math.min(32000, 1000 * 2 ** (attempt - 1)) + Math.random() * 1000);
        continue;
      }
      const err = new Error(rateLimited
        ? "Gmail is rate-limiting requests. Wait a minute and try again."
        : "Gmail API error " + res.status + (body && body.error && body.error.message ? ": " + body.error.message : ""));
      err.status = res.status;
      err.rateLimited = rateLimited;
      throw err;
    }
  }

  async function listMessages(query, limit) {
    const found = [];
    let pageToken = "";
    while (found.length < limit && !state.stop) {
      const n = Math.min(500, limit - found.length);
      const r = await gmail("messages?maxResults=" + n + "&q=" + encodeURIComponent(query) + (pageToken ? "&pageToken=" + pageToken : ""),
        { stoppable: true });
      found.push(...(r.messages || []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return found;
  }

  /** Runs worker over items. Returns the items that failed, so callers can retry or report them. */
  async function pool(items, worker, onEach) {
    let i = 0;
    const failed = [];
    const run = async () => {
      while (i < items.length && !state.stop) {
        const item = items[i++];
        let ok = true;
        try { await worker(item); } catch (e) { ok = false; failed.push(item); if (!state.stop) console.warn(e); }
        onEach && onEach(ok);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, run));
    return failed;
  }

  // ----------------------------------------------------------------- scan --

  function buildQueries() {
    const s = state.settings;
    // Skip keep-list senders in the search itself, so no quota goes on fetching them.
    // Only plain addresses and domains are safe to put in a query; decide() still checks the rest.
    const keep = allowlist().filter((a) => /^[a-z0-9._%+-]*@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a)).slice(0, 50);
    const base = "-is:starred -in:sent -in:chats" + (keep.length ? " -from:(" + keep.join(" OR ") + ")" : "");
    const q = [];
    const add = (rule, query) => q.push({ rule, query, base });
    if (s.rules.oldUnread) {
      // One day of slack: Gmail's before: works in whole days and its own time zone.
      // The exact cutoff is enforced per email by the rules.
      const d = new Date(oldCutoffMs() + 864e5);
      add("oldUnread", "is:unread before:" + d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + base);
    }
    if (s.rules.marketing) add("marketing", "(category:promotions OR unsubscribe) " + base);
    if (s.rules.social) add("social", "(category:social OR from:(" + socialDomains().join(" OR ") + ")) " + base);
    // "unsubscribe" is already covered by the marketing search when that rule is on.
    if (s.rules.notifications) add("notifications", "(category:updates OR category:forums" + (s.rules.marketing ? "" : " OR unsubscribe") + ") " + base);
    return q;
  }

  async function scan() {
    const queries = buildQueries();
    if (!queries.length) return setStatus("Turn on at least one rule first.");
    state.busy = true; state.stop = false; state.rows = [];
    toggleBusy(true);
    setProgress(0);

    try {
      const seen = new Set();
      const found = [];
      for (let k = 0; k < queries.length; k++) {
        setStatus("Searching your mailbox (" + (k + 1) + " of " + queries.length + ")…");
        for (const m of await listMessages(queries[k].query, state.settings.maxPerRule)) {
          if (!seen.has(m.id)) { seen.add(m.id); found.push(m); }
        }
      }

      // One pass over Sent mail gives every conversation you've replied in.
      // This replaces a separate (and costly) thread lookup for each flagged email.
      setStatus("Finding conversations you've replied to…");
      const repliedThreads = new Set();
      let pageToken = "";
      do {
        const r = await gmail("messages?maxResults=500&q=in%3Asent" + (pageToken ? "&pageToken=" + pageToken : ""), { stoppable: true });
        (r.messages || []).forEach((m) => repliedThreads.add(m.threadId));
        pageToken = r.nextPageToken;
      } while (pageToken && !state.stop);
      if (state.stop) throw new Error("stopped before your replies were checked, so nothing was marked for deletion");

      // Conversations you replied in are always kept, so don't spend quota fetching them.
      const ids = found.filter((m) => !repliedThreads.has(m.threadId)).map((m) => m.id);
      const skipped = found.length - ids.length;

      const ctx = {
        me: state.me,
        nowMs: Date.now(),
        threshold: state.settings.threshold,
        oldBeforeMs: oldCutoffMs(),
        rules: state.settings.rules,
        // A getter, so "Always keep" clicks made mid-scan apply to emails still coming in.
        get allowlist() { return allowlist(); },
        socialDomains: socialDomains(),
        threadHasReply: async (tid) => repliedThreads.has(tid),
      };

      let done = 0;
      const started = performance.now();
      let lastPaint = 0;
      $("results").classList.remove("hidden");
      setStatus("Checking " + ids.length.toLocaleString() + " emails…");
      const check = async (id) => {
        const msg = await gmail("messages/" + id + "?format=metadata" + HEADER_QS, { units: COST.get, stoppable: true });
        const d = await Rules.decide(msg, ctx);
        const h = Rules.headerMap(msg);
        state.rows.push({
          id, from: h.from || "", sender: Rules.senderOf(h), subject: h.subject || "(no subject)",
          date: Number(msg.internalDate), state: d.action, reason: d.reason, category: d.category,
          selected: d.action === "DELETE",
          listId: Unsub.listIdOf(h["list-id"]),
          unsub: Rules.parseUnsubscribe(h["list-unsubscribe"], h["list-unsubscribe-post"]),
        });
      };
      const progress = (ok) => {
        if (!ok) return;
        done++;
        setProgress(done / ids.length);
        const now = performance.now();
        if (now - lastPaint > 1000 || done === ids.length) {
          // Show results as they arrive so you can start reviewing right away.
          lastPaint = now;
          const perSec = done / ((now - started) / 1000);
          const left = Math.max(0, Math.round((ids.length - done) / perSec));
          setStatus("Checked " + done.toLocaleString() + " of " + ids.length.toLocaleString() +
            " emails (about " + (left > 90 ? Math.round(left / 60) + " min" : left + " sec") + " left). You can start reviewing below.");
          state.rows.sort((a, b) => b.date - a.date);
          render();
        }
      };
      let failed = await pool(ids, check, progress);
      if (failed.length && !state.stop) {
        setStatus("Retrying " + failed.length.toLocaleString() + " emails that couldn't be checked…");
        failed = await pool(failed, check, progress);
      }

      state.rows.sort((a, b) => b.date - a.date);
      const del = state.rows.filter((r) => r.state === "DELETE").length;
      setStatus((state.stop ? "Stopped early. " : "Scan complete. ") +
        del.toLocaleString() + " emails ready to trash. Review them below. Nothing has been deleted yet." +
        (skipped ? " Skipped " + skipped.toLocaleString() + " in conversations you replied to." : "") +
        (failed.length && !state.stop ? " " + failed.length.toLocaleString() + " couldn't be checked; scan again to retry them." : ""));
      setProgress(1);
      $("results").classList.remove("hidden");
      $("export").classList.remove("hidden");
      setTab("DELETE");
    } catch (e) {
      setStatus("Scan failed: " + e.message);
    } finally {
      state.busy = false;
      toggleBusy(false);
    }
  }

  // ----------------------------------------------- sender grouping (test) --
  // Open the page with ?compare to use this. It groups mail by sender, then fully checks
  // a random sample of the grouped emails to see whether the groups were right. Read-only.

  async function compareGrouping() {
    const queries = buildQueries();
    if (!queries.length) return setStatus("Turn on at least one rule first.");
    const SAMPLE = 500;
    state.busy = true; state.stop = false;
    toggleBusy(true); setProgress(0);
    try {
      const started = performance.now();
      const found = new Map(); // id -> { threadId, rules }
      for (const q of queries) {
        setStatus("Test: searching your mailbox (" + q.rule + ")…");
        for (const m of await listMessages(q.query, Infinity)) {
          if (!found.has(m.id)) found.set(m.id, { threadId: m.threadId, rules: new Set() });
          found.get(m.id).rules.add(q.rule);
        }
      }
      const search = async (q) => (await listMessages(q, Infinity)).map((m) => m.id);
      setStatus("Test: finding protected email…");
      const base = queries[0].base;
      const protectedIds = new Set(await search(Sweep.protectedQuery(base)));
      const replied = new Set((await listMessages("in:sent", Infinity)).map((m) => m.threadId));
      if (state.stop) return setStatus("Test stopped.");

      const candidates = new Map();
      found.forEach((m, id) => { if (!replied.has(m.threadId)) candidates.set(id, m.rules); });
      const ctx = {
        me: state.me, nowMs: Date.now(), threshold: state.settings.threshold, oldBeforeMs: oldCutoffMs(),
        rules: state.settings.rules, allowlist: allowlist(), socialDomains: socialDomains(),
        threadHasReply: async (tid) => replied.has(tid),
      };
      const fetchMsg = (id) => gmail("messages/" + id + "?format=metadata" + HEADER_QS, { units: COST.get, stoppable: true });
      const decide = (m) => Rules.decide(m, ctx);
      const r = await Sweep.bySender({
        candidates, protectedIds, base, search, fetch: fetchMsg, decide, batch: CONCURRENCY, stopped: () => state.stop,
        onProgress: (done, total) => {
          setProgress(done / total);
          setStatus("Test: grouped or checked " + done.toLocaleString() + " of " + total.toLocaleString() + " emails…");
        },
      });
      if (state.stop) return setStatus("Test stopped.");
      const minutes = ((performance.now() - started) / 60000).toFixed(1);

      const grouped = r.rows.filter((x) => !x.checked);
      for (let i = grouped.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [grouped[i], grouped[j]] = [grouped[j], grouped[i]];
      }
      const sample = grouped.slice(0, SAMPLE);
      let done = 0, wrongSender = 0;
      const wrong = [];
      const missed = await pool(sample, async (x) => {
        const msg = await fetchMsg(x.id), d = await decide(msg);
        const h = Rules.headerMap(msg);
        if (Rules.senderOf(h) !== x.sender) wrongSender++;
        if (d.action !== "DELETE") wrong.push({ group: x.sender, sender: Rules.senderOf(h), subject: h.subject, kept: d.reason });
      }, () => { setProgress(++done / sample.length); setStatus("Test: verifying " + done + " of " + sample.length + " grouped emails…"); });
      if (state.stop) return setStatus("Test stopped.");
      console.table(wrong);
      setStatus("Test done. Grouping " + candidates.size.toLocaleString() + " emails took " + minutes + " min (" +
        r.fetched.toLocaleString() + " fetched, " + r.searches.toLocaleString() + " sender searches, " +
        grouped.length.toLocaleString() + " grouped without fetching, " + r.failed.length + " failed). Of " +
        (sample.length - missed.length) + " grouped emails verified, " + wrong.length + " should have been kept and " +
        wrongSender + " came from a different sender. Nothing was changed. Details are in the browser console.");
    } catch (e) {
      setStatus("Test failed: " + e.message);
    } finally {
      state.busy = false;
      toggleBusy(false);
    }
  }

  function applyAllowlist() {
    const allow = allowlist();
    let n = 0;
    for (const r of state.rows) {
      if (r.state === "DELETE" && Rules.isAllowlisted(r.sender, allow)) {
        r.state = "KEEP"; r.reason = "On your keep list"; r.selected = false; n++;
      }
    }
    if (n) setStatus(n + " email" + (n > 1 ? "s" : "") + " moved to Kept because of your keep list.");
    render();
  }

  function keepSender(sender) {
    const list = state.settings.allowlist.trim();
    state.settings.allowlist = (list ? list + "\n" : "") + sender;
    $("allowlist").value = state.settings.allowlist;
    saveSettings();
    applyAllowlist();
  }

  // ---------------------------------------------------------------- trash --

  async function trashSelected() {
    const targets = state.rows.filter((r) => r.state === "DELETE" && r.selected);
    if (!targets.length) return;
    const btn = $("trash");
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to trash " + targets.length.toLocaleString() + " emails";
      clearTimeout(state.confirmTimer);
      state.confirmTimer = setTimeout(resetTrashButton, 5000);
      return;
    }
    resetTrashButton();
    state.busy = true; state.stop = false;
    toggleBusy(true);
    setProgress(0);
    const { ok, failed } = await trashRows(targets);
    state.busy = false;
    toggleBusy(false);
    setStatus("Moved " + ok.toLocaleString() + " emails to Trash" + (failed ? " (" + failed + " failed — try again)" : "") +
      ". You can recover them from Gmail's Trash for 30 days.");
    render();
  }

  // Bulk trash: one batchModify request moves up to 1,000 emails (Gmail's limit)
  // instead of one request per email. Falls back to per-email trashing if the
  // bulk call is refused.
  const BULK_SIZE = 500; // under the 1,000 cap, so the progress bar still moves
  async function trashRows(targets) {
    let ok = 0, failed = 0;
    const report = () => {
      setProgress((ok + failed) / targets.length);
      setStatus("Moving to Trash: " + (ok + failed).toLocaleString() + " of " + targets.length.toLocaleString() + "…");
    };
    const mark = (r) => { r.state = "TRASHED"; r.selected = false; ok++; };

    let rest = targets;
    for (let i = 0; i < targets.length && !state.stop; i += BULK_SIZE) {
      const chunk = targets.slice(i, i + BULK_SIZE);
      try {
        await gmail("messages/batchModify", {
          method: "POST", units: COST.batchModify, stoppable: true,
          body: { ids: chunk.map((r) => r.id), addLabelIds: ["TRASH"] },
        });
        chunk.forEach(mark);
        report();
        rest = targets.slice(i + BULK_SIZE);
      } catch (e) {
        if (state.stop) break;
        // One at a time costs far more quota, so it can't help with a rate limit.
        if (e.rateLimited) return { ok, failed: targets.length - ok };
        console.warn("Bulk trash failed; switching to one-at-a-time", e);
        rest = targets.slice(i);
        break;
      }
    }

    if (rest.length && !state.stop) {
      await pool(rest, async (r) => {
        try {
          await gmail("messages/" + r.id + "/trash", { method: "POST", units: COST.trash, stoppable: true });
          mark(r);
        } catch (e) { if (!state.stop) failed++; }
      }, report);
    }
    return { ok, failed };
  }

  function resetTrashButton() {
    const btn = $("trash");
    delete btn.dataset.armed;
    btn.textContent = "Move selected to Trash";
  }

  // ---------------------------------------------------------- unsubscribe --
  // Options come only from the List-Unsubscribe header (https: and mailto: only,
  // see Rules.parseUnsubscribe). Preference: RFC 8058 one-click POST, then an
  // unsubscribe email sent from your Gmail, then opening the sender's page.

  function unsubMethod(u) {
    if (u.oneClick) return "oneclick";
    if (u.mailto) return "mailto";
    return "page";
  }

  const UNSUB_HINT = {
    oneclick: "Sends the sender's one-click unsubscribe request",
    mailto: "Sends an unsubscribe email from your Gmail to ",
    page: "Opens the sender's unsubscribe page in a new tab",
  };

  function unsubscribeClick(g) {
    if (state.unsubArmed !== g.key) {
      // First click arms the button; a second click within 5 seconds confirms.
      state.unsubArmed = g.key;
      clearTimeout(state.unsubTimer);
      state.unsubTimer = setTimeout(() => { state.unsubArmed = null; render(); }, 5000);
      render();
      return;
    }
    clearTimeout(state.unsubTimer);
    state.unsubArmed = null;
    unsubscribe(g);
  }

  function markDone(g, method, done) {
    done[g.key] = { at: Date.now(), method, name: g.name };
    saveUnsubscribed();
  }

  async function unsubscribe(g) {
    const r = g.row, u = r.unsub, sender = g.sender, method = unsubMethod(u);
    const done = state.unsubscribed; // this account's list, even if you sign out meanwhile
    if (method === "page") {
      // Opening a page changes nothing by itself; the user finishes on the sender's site.
      window.open(u.https, "_blank", "noopener,noreferrer");
      state.unsubOpened.add(g.key);
      setStatus("Opened " + sender + "'s unsubscribe page in a new tab. Finish there, then click Mark as done.");
      render();
      return;
    }
    state.unsubBusy.add(g.key);
    render();
    try {
      if (method === "oneclick") {
        // RFC 8058: a POST with this exact body. no-cors means we can't read the
        // response, so success is "the request was delivered", not confirmed.
        await fetch(u.https, {
          method: "POST",
          mode: "no-cors",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }),
        });
      } else {
        await gmail("messages/send", { method: "POST", units: COST.send, body: { raw: unsubEmail(u.mailto) } });
      }
      markDone(g, method, done);
      setStatus(method === "oneclick"
        ? "Unsubscribe request sent to " + sender + ". Senders can take a few days to stop."
        : "Unsubscribe email sent to " + u.mailto.to + " (it's in your Sent folder). Senders can take a few days to stop.");
    } catch (e) {
      console.warn("Unsubscribe failed", e);
      setStatus("Couldn't unsubscribe from " + sender + ": " + e.message + ". Try again.");
      // If one-click failed (network or blocked), the next try falls back to email or the page.
      if (method === "oneclick") r.unsub = { ...u, oneClick: false };
    } finally {
      state.unsubBusy.delete(g.key);
      render();
    }
  }

  // A minimal RFC 2822 message, base64url-encoded for messages.send.
  // Gmail fills in From. Header values were already stripped of line breaks.
  function unsubEmail(m) {
    const b64 = (str) => {
      const bytes = new TextEncoder().encode(str);
      let bin = "";
      bytes.forEach((b) => (bin += String.fromCharCode(b)));
      return btoa(bin);
    };
    const subject = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : "=?UTF-8?B?" + b64(m.subject) + "?=";
    const msg = [
      "To: " + m.to,
      "Subject: " + subject,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(m.body),
    ].join("\r\n");
    return b64(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const METHOD_LABEL = { oneclick: "One-click", mailto: "Email", page: "Web page" };
  const DONE_LABEL = { oneclick: "One-click request", mailto: "Unsubscribe email", page: "Marked as done" };

  function unsubActions(g) {
    const small = (text, onclick, title) => {
      const b = el("button", { className: "small", textContent: text, title: title || "" });
      b.addEventListener("click", onclick);
      return b;
    };
    if (state.unsubView === "done") {
      return [small("Move back", () => {
        delete state.unsubscribed[g.doneKey];
        state.unsubOpened.delete(g.key);
        saveUnsubscribed();
        render();
      }, "Show this in To do again. This doesn't resubscribe you.")];
    }
    const u = g.row.unsub, method = unsubMethod(u);
    const busy = state.unsubBusy.has(g.key), armed = state.unsubArmed === g.key;
    const b = small(
      busy ? "Unsubscribing…" : armed ? (method === "page" ? "Click to open page" : "Click to confirm") :
        method === "page" ? "Open page ↗" : "Unsubscribe",
      () => unsubscribeClick(g),
      UNSUB_HINT[method] + (method === "mailto" ? u.mailto.to : ""));
    b.disabled = busy;
    b.classList.toggle("armed", armed);
    const out = [b];
    if (state.unsubOpened.has(g.key)) {
      out.push(small("Mark as done", () => { markDone(g, "page", state.unsubscribed); render(); }));
    }
    return out;
  }

  function renderUnsub(lists) {
    const view = state.unsubView, f = state.filter.toLowerCase();
    const shown = lists[view].filter((g) => !f || (g.name + " " + g.sender + " " + g.listId).toLowerCase().includes(f));
    $("unsubTodo").textContent = "To do (" + lists.todo.length.toLocaleString() + ")";
    $("unsubDone").textContent = "Done (" + lists.done.length.toLocaleString() + ")";
    $("unsubTodo").classList.toggle("on", view === "todo");
    $("unsubDone").classList.toggle("on", view === "done");
    $("unsubRows").replaceChildren(...shown.map((g) => {
      const who = el("td", { className: "lists" }, [
        el("b", { textContent: g.name }),
        el("div", { className: "reason", textContent: g.sender + (g.multi && g.listId ? " · list: " + g.listId : "") }),
      ]);
      if (g.still) who.append(el("span", { className: "tag warn", textContent: "Still emailing you" }));
      if (g.keeps) who.append(el("span", { className: "tag", textContent: "Also sends mail you keep" }));
      return el("tr", null, [
        who,
        el("td", { textContent: g.count.toLocaleString() }),
        el("td", { className: "date", textContent: view === "done" ? new Date(g.entry.at).toLocaleDateString() : new Date(g.latest).toLocaleDateString() }),
        el("td", { className: "reason", textContent: view === "done" ? DONE_LABEL[g.entry.method] || "" : METHOD_LABEL[unsubMethod(g.row.unsub)] }),
        el("td", { className: "actions" }, unsubActions(g)),
      ]);
    }));
    $("unsubDate").textContent = view === "done" ? "Done on" : "Latest";
    return shown.length;
  }

  // ------------------------------------------------------------- render ----

  function setStatus(t) { $("status").textContent = t; }
  function setProgress(f) { $("progressBar").style.width = Math.round(f * 100) + "%"; }

  function toggleBusy(on) {
    $("scan").disabled = $("compare").disabled = on || !state.me;
    $("stop").classList.toggle("hidden", !on);
    $("trash").disabled = on;
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    render();
  }

  const CAT_LABEL = { marketing: "Marketing", social: "Social", notification: "Notification", old: "Old unread" };

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    (children || []).forEach((c) => e.append(c));
    return e;
  }

  function render() {
    const rows = state.rows;
    const del = rows.filter((r) => r.state === "DELETE");
    const count = (c) => del.filter((r) => r.category === c).length;
    const stats = [
      [rows.length, "emails checked"],
      [del.length, "ready to trash"],
      [count("marketing"), "marketing"],
      [count("social") + count("notification"), "social & notifications"],
      [count("old"), "old unread"],
    ];
    $("stats").replaceChildren(...stats.map(([n, l]) => el("div", { className: "stat" }, [el("b", { textContent: n.toLocaleString() }), el("span", { textContent: l })])));

    const lists = Unsub.groupLists(rows, state.unsubscribed);
    const unsubTab = state.tab === "UNSUB";
    document.querySelectorAll(".tabs button").forEach((b) => {
      const n = b.dataset.tab === "UNSUB" ? lists.todo.length : rows.filter((r) => r.state === b.dataset.tab).length;
      b.textContent = { DELETE: "To trash", KEEP: "Kept", TRASHED: "Trashed", UNSUB: "Unsubscribe" }[b.dataset.tab] + " (" + n.toLocaleString() + ")";
    });

    const f = state.filter.toLowerCase();
    const shown = rows.filter((r) => r.state === state.tab && (!f || (r.from + " " + r.subject).toLowerCase().includes(f)));
    const LIMIT = 1500;
    const body = $("rows");
    body.replaceChildren(...shown.slice(0, LIMIT).map((r) => {
      const cb = el("input", { type: "checkbox", checked: r.selected, disabled: r.state !== "DELETE" });
      cb.addEventListener("change", () => { r.selected = cb.checked; updateSelCount(); });
      const reason = el("td", { className: "reason" });
      if (r.category && r.state !== "KEEP") {
        reason.append(el("span", { className: "tag", textContent: CAT_LABEL[r.category] }));
        reason.append(r.reason.replace(/^(Marketing|Social media|Website notification:)\s*/, "").replace(/^\((.*)\)$/, "$1"));
      } else {
        reason.append(r.reason);
      }
      const action = el("td", { className: "actions" });
      if (r.state === "DELETE" && r.sender) {
        const b = el("button", { className: "small", textContent: "Always keep", title: "Add " + r.sender + " to your keep list" });
        b.addEventListener("click", () => keepSender(r.sender));
        action.append(b);
      }
      return el("tr", { className: r.state === "TRASHED" ? "trashed" : "" }, [
        el("td", null, [cb]),
        el("td", { className: "from", textContent: r.from, title: r.from }),
        el("td", { className: "subj" }, [el("div", { textContent: r.subject, title: r.subject })]),
        reason,
        el("td", { className: "date", textContent: new Date(r.date).toLocaleDateString() }),
        action,
      ]);
    }));
    const empty = $("empty");
    const visible = unsubTab ? renderUnsub(lists) : shown.length;
    $("unsubWrap").classList.toggle("hidden", !unsubTab);
    $("unsubNav").classList.toggle("hidden", !unsubTab);
    $("mailTable").classList.toggle("hidden", unsubTab);
    empty.classList.toggle("hidden", visible > 0);
    if (shown.length > LIMIT) {
      body.append(el("tr", null, [el("td", { colSpan: 6, className: "reason", textContent:
        "Showing the first " + LIMIT.toLocaleString() + " of " + shown.length.toLocaleString() + ". Selection and trashing still apply to all of them." })]));
    }
    ["selAll", "selNone"].forEach((id) => $(id).classList.toggle("hidden", state.tab !== "DELETE"));
    $("trash").classList.toggle("hidden", state.tab !== "DELETE");
    updateSelCount();
  }

  function updateSelCount() {
    const n = state.rows.filter((r) => r.state === "DELETE" && r.selected).length;
    $("selCount").textContent = state.tab === "DELETE" ? n.toLocaleString() + " selected" : "";
    $("trash").disabled = state.busy || n === 0;
  }

  function setSelection(on) {
    const f = state.filter.toLowerCase();
    state.rows.forEach((r) => {
      if (r.state === "DELETE" && (!f || (r.from + " " + r.subject).toLowerCase().includes(f))) r.selected = on;
    });
    render();
  }

  function exportCsv() {
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [["date", "from", "subject", "status", "reason"].join(",")].concat(
      state.rows.map((r) => [new Date(r.date).toISOString(), r.from, r.subject, r.state, r.reason].map(esc).join(",")));
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = el("a", { href: url, download: "inbox-sweep-report.csv" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------- init ---

  bindSettings();
  checkClientId();
  $("signin").addEventListener("click", signIn);
  $("signout").addEventListener("click", signOut);
  $("scan").addEventListener("click", scan);
  $("compare").classList.toggle("hidden", !new URLSearchParams(location.search).has("compare"));
  $("compare").addEventListener("click", compareGrouping);
  $("stop").addEventListener("click", () => { state.stop = true; setStatus("Stopping…"); });
  $("trash").addEventListener("click", trashSelected);
  $("export").addEventListener("click", exportCsv);
  for (const [id, view] of [["unsubTodo", "todo"], ["unsubDone", "done"]]) {
    $(id).addEventListener("click", () => { state.unsubView = view; render(); });
  }
  $("selAll").addEventListener("click", () => setSelection(true));
  $("selNone").addEventListener("click", () => setSelection(false));
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
})();
