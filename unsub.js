/*
 * Inbox Sweep — mailing lists for the Unsubscribe tab.
 * Pure logic: turns scanned emails into one entry per mailing list.
 */
(function (root) {
  "use strict";
  // Senders may take up to 10 business days; mail after this long means it didn't work.
  const GRACE_MS = 10 * 864e5;

  function listIdOf(header) {
    const s = String(header || "").toLowerCase();
    const m = s.match(/<([^<>]+)>/);
    return (m ? m[1] : s).replace(/\s+/g, "");
  }

  function nameOf(from, sender) {
    return String(from || "").replace(/<[^<>]*>\s*$/, "").replace(/^\s*"|"\s*$/g, "").trim() || sender;
  }

  /** The saved "done" entry for a list, or null. "sender|*" comes from the older per-sender format. */
  function doneKey(done, sender, key) {
    const has = (k) => Object.prototype.hasOwnProperty.call(done, k);
    return has(key) ? key : has(sender + "|*") ? sender + "|*" : null;
  }

  /**
   * rows: scanned emails { from, sender, date, state, reason, listId, unsub }
   * done: { key: { at, method, name } }
   * Returns { todo, done }: arrays of { key, doneKey, sender, name, listId, multi, count, latest, row, keeps, entry, still }.
   */
  function groupLists(rows, done) {
    const bySender = new Map();
    const keeps = new Set();
    for (const r of rows) {
      if (!r.sender) continue;
      if (r.state === "KEEP" && r.reason !== "No rule matched") keeps.add(r.sender);
      if (!r.unsub) continue;
      if (!bySender.has(r.sender)) bySender.set(r.sender, []);
      bySender.get(r.sender).push(r);
    }

    const lists = new Map();
    bySender.forEach((mail, sender) => {
      // Some senders put a new List-Id on nearly every email; those go by address alone.
      const ids = mail.map((r) => r.listId).filter(Boolean);
      const distinct = new Set(ids).size;
      const stable = distinct < 3 || distinct / ids.length <= 0.5;
      for (const r of mail) {
        const listId = stable ? r.listId || "" : "";
        const key = sender + "|" + listId;
        let g = lists.get(key);
        if (!g) lists.set(key, (g = { key, sender, listId, count: 0, latest: -1, row: null, keeps: keeps.has(sender) }));
        g.count++;
        if (r.date > g.latest) { g.latest = r.date; g.row = r; } // newest email has the freshest link
      }
    });

    const perSender = new Map();
    lists.forEach((g) => perSender.set(g.sender, (perSender.get(g.sender) || 0) + 1));
    const out = { todo: [], done: [] };
    const used = new Set();
    lists.forEach((g) => {
      g.name = nameOf(g.row.from, g.sender);
      g.multi = perSender.get(g.sender) > 1;
      g.doneKey = doneKey(done, g.sender, g.key);
      g.entry = g.doneKey ? done[g.doneKey] : null;
      g.still = !!g.entry && g.latest > g.entry.at + GRACE_MS;
      if (g.doneKey) used.add(g.doneKey);
      (g.entry && !g.still ? out.done : out.todo).push(g);
    });
    // Also list ones you unsubscribed from that weren't in this scan.
    for (const k of Object.keys(done)) {
      if (used.has(k)) continue;
      const bar = k.indexOf("|"), sender = k.slice(0, bar), id = k.slice(bar + 1);
      out.done.push({ key: k, doneKey: k, sender, listId: id === "*" ? "" : id, name: done[k].name || sender, multi: false,
        count: 0, latest: 0, row: null, keeps: false, entry: done[k], still: false });
    }
    out.todo.sort((a, b) => b.count - a.count || b.latest - a.latest || (a.key < b.key ? -1 : 1));
    out.done.sort((a, b) => b.entry.at - a.entry.at || (a.key < b.key ? -1 : 1));
    return out;
  }

  /** Reads the saved data, in the per-account or the older { sender: entry } format. */
  function parseStore(saved) {
    const store = { accounts: {}, legacy: {} };
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return store;
    const clean = (o) => {
      const out = {};
      for (const k of Object.keys(o || {})) if (k.includes("@") && o[k] && Number.isFinite(o[k].at)) out[k] = o[k];
      return out;
    };
    if (saved.accounts) {
      for (const a of Object.keys(saved.accounts)) store.accounts[a] = clean(saved.accounts[a]);
      store.legacy = clean(saved.legacy);
    } else {
      const old = clean(saved);
      for (const k of Object.keys(old)) store.legacy[k + "|*"] = old[k];
    }
    return store;
  }

  /** One account's list. Older entries had no account, so the first one to sign in gets them. */
  function openAccount(store, account) {
    store.accounts[account] = Object.assign({}, store.legacy, store.accounts[account]);
    store.legacy = {};
    return store.accounts[account];
  }

  const api = { groupLists, listIdOf, nameOf, parseStore, openAccount, GRACE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Unsub = api;
})(typeof window !== "undefined" ? window : globalThis);
