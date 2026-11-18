/* Inbox Sweep — browser app. Talks directly to the Gmail API with the user's token. */
(function () {
  "use strict";

  const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
  const API = "https://gmail.googleapis.com/gmail/v1/users/me/";
  const STORE_KEY = "inboxSweep.settings.v1";
  const CONCURRENCY = 8;

  const DEFAULTS = {
    rules: { marketing: true, social: true, notifications: true, oldUnread: true },
    threshold: 3,
    allowlist: "",
    extraSocial: "",
    maxPerRule: 2000,
    clientId: "",
  };
  const STRICTNESS = { 2: "Aggressive", 3: "Balanced", 4: "Careful", 5: "Very careful", 6: "Only obvious ads" };

  const $ = (id) => document.getElementById(id);
  const state = {
    settings: loadSettings(),
    token: null, tokenExpiry: 0, tokenClient: null, pendingToken: null,
    me: "", rows: [], tab: "DELETE", filter: "", stop: false, busy: false, confirmTimer: null,
  };

  // ------------------------------------------------------------- settings --

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) return { ...DEFAULTS, ...saved, rules: { ...DEFAULTS.rules, ...(saved.rules || {}) } };
    } catch (e) { /* storage unavailable */ }
    return JSON.parse(JSON.stringify(DEFAULTS));
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
      const profile = await gmail("profile");
      state.me = profile.emailAddress;
      $("who").textContent = state.me + " · ";
      $("signin").classList.add("hidden");
      $("signout").classList.remove("hidden");
      $("scan").disabled = false;
      setStatus("Signed in. Choose what to clean up, then scan your inbox. Nothing is deleted until you confirm.");
    } catch (e) {
      setStatus("Sign-in failed: " + e.message);
    }
  }

  function signOut() {
    if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null; state.me = ""; state.rows = [];
    $("who").textContent = "";
    $("signin").classList.remove("hidden");
    $("signout").classList.add("hidden");
    $("scan").disabled = true;
    $("results").classList.add("hidden");
    $("export").classList.add("hidden");
    setProgress(0);
    setStatus("Signed out.");
  }

  // ------------------------------------------------------------ Gmail API --

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gmail(path, opts = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await ensureToken();
      const res = await fetch(API + path, {
        method: opts.method || "GET",
        headers: { Authorization: "Bearer " + state.token },
      });
      if (res.ok) return res.status === 204 ? {} : res.json();
      if (res.status === 401) { state.token = null; continue; }
      if (res.status === 429 || res.status >= 500 || res.status === 403) {
        // 403 here is usually a per-user rate limit; back off and retry.
        await sleep(Math.min(16000, 500 * 2 ** attempt) + Math.random() * 300);
        continue;
      }
      throw new Error("Gmail API error " + res.status);
    }
    throw new Error("Gmail is rate-limiting requests. Wait a minute and try again.");
  }

  async function listIds(query, limit) {
    const ids = [];
    let pageToken = "";
    while (ids.length < limit && !state.stop) {
      const n = Math.min(500, limit - ids.length);
      const r = await gmail("messages?maxResults=" + n + "&q=" + encodeURIComponent(query) + (pageToken ? "&pageToken=" + pageToken : ""));
      (r.messages || []).forEach((m) => ids.push(m.id));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  async function pool(items, worker, onEach) {
    let i = 0;
    const run = async () => {
      while (i < items.length && !state.stop) {
        const item = items[i++];
        try { await worker(item); } catch (e) { console.warn(e); }
        onEach && onEach();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, run));
  }

  // ----------------------------------------------------------------- scan --

  function buildQueries() {
    const s = state.settings;
    const base = "-is:starred -in:sent -in:chats";
    const q = [];
    if (s.rules.oldUnread) q.push("older_than:1y is:unread " + base);
    if (s.rules.marketing) q.push("(category:promotions OR unsubscribe) " + base);
    if (s.rules.social) q.push("(category:social OR from:(" + socialDomains().join(" OR ") + ")) " + base);
    if (s.rules.notifications) q.push("(category:updates OR category:forums OR unsubscribe) " + base);
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
      const ids = [];
      for (let k = 0; k < queries.length; k++) {
        setStatus("Searching your mailbox (" + (k + 1) + " of " + queries.length + ")…");
        for (const id of await listIds(queries[k], state.settings.maxPerRule)) {
          if (!seen.has(id)) { seen.add(id); ids.push(id); }
        }
      }

      const threadCache = new Map();
      const ctx = {
        me: state.me,
        nowMs: Date.now(),
        threshold: state.settings.threshold,
        rules: state.settings.rules,
        allowlist: allowlist(),
        socialDomains: socialDomains(),
        threadHasReply(tid) {
          if (!threadCache.has(tid)) {
            threadCache.set(tid, gmail("threads/" + tid + "?format=minimal").then((t) =>
              (t.messages || []).some((m) => (m.labelIds || []).includes("SENT"))));
          }
          return threadCache.get(tid);
        },
      };

      let done = 0;
      setStatus("Checking " + ids.length.toLocaleString() + " emails…");
      await pool(ids, async (id) => {
        const msg = await gmail("messages/" + id + "?format=metadata");
        const d = await Rules.decide(msg, ctx);
        const h = Rules.headerMap(msg);
        state.rows.push({
          id, from: h.from || "", sender: Rules.senderOf(h), subject: h.subject || "(no subject)",
          date: Number(msg.internalDate), state: d.action, reason: d.reason, category: d.category,
          selected: d.action === "DELETE",
        });
      }, () => {
        done++;
        setProgress(done / ids.length);
        if (done % 25 === 0) setStatus("Checked " + done.toLocaleString() + " of " + ids.length.toLocaleString() + " emails…");
      });

      state.rows.sort((a, b) => b.date - a.date);
      const del = state.rows.filter((r) => r.state === "DELETE").length;
      setStatus((state.stop ? "Stopped early. " : "Scan complete. ") +
        del.toLocaleString() + " emails ready to trash. Review them below. Nothing has been deleted yet.");
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
    let done = 0, failed = 0;
    setProgress(0);
    await pool(targets, async (r) => {
      try {
        await gmail("messages/" + r.id + "/trash", { method: "POST" });
        r.state = "TRASHED"; r.selected = false;
      } catch (e) { failed++; throw e; }
    }, () => {
      done++;
      setProgress(done / targets.length);
      setStatus("Moving to Trash: " + done + " of " + targets.length + "…");
    });
    state.busy = false;
    toggleBusy(false);
    const ok = done - failed;
    setStatus("Moved " + ok.toLocaleString() + " emails to Trash" + (failed ? " (" + failed + " failed — try again)" : "") +
      ". You can recover them from Gmail's Trash for 30 days.");
    render();
  }

  function resetTrashButton() {
    const btn = $("trash");
    delete btn.dataset.armed;
    btn.textContent = "Move selected to Trash";
  }

  // ------------------------------------------------------------- render ----

  function setStatus(t) { $("status").textContent = t; }
  function setProgress(f) { $("progressBar").style.width = Math.round(f * 100) + "%"; }

  function toggleBusy(on) {
    $("scan").disabled = on || !state.me;
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

    document.querySelectorAll(".tabs button").forEach((b) => {
      const n = rows.filter((r) => r.state === b.dataset.tab).length;
      b.textContent = { DELETE: "To trash", KEEP: "Kept", TRASHED: "Trashed" }[b.dataset.tab] + " (" + n.toLocaleString() + ")";
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
      const action = el("td");
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
    empty.classList.toggle("hidden", shown.length > 0);
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
  $("stop").addEventListener("click", () => { state.stop = true; setStatus("Stopping…"); });
  $("trash").addEventListener("click", trashSelected);
  $("export").addEventListener("click", exportCsv);
  $("selAll").addEventListener("click", () => setSelection(true));
  $("selNone").addEventListener("click", () => setSelection(false));
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
})();
