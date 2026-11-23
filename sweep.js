/*
 * Inbox Sweep — sender grouping.
 * Finds senders by sampling one email each, so most bulk mail doesn't have to be
 * fetched one by one. Pure logic: searching and fetching are passed in.
 * Grouped emails are NOT fully checked. Run Rules.decide() on each before trashing it.
 */
(function (root) {
  "use strict";
  const Rules = typeof module !== "undefined" && module.exports ? require("./rules.js") : root.Rules;

  // Broader than Rules' TRANSACTIONAL_RE on purpose: a match only means "check it individually".
  const PROTECTED_TERMS = [
    "receipt", "order", "orders", "shipped", "delivery", "tracking", "invoice", "statement", "payment",
    "password", "verification", "verify", "security", "sign-in", "signin", "login", "unusual activity",
    "two-factor", "2fa", "confirm", "2-step", "one-time code", "appointment", "reservation", "itinerary",
    "boarding pass", "bill", "autopay", "interview", "offer letter", "application", "applying",
  ];

  function protectedQuery(base) {
    return "subject:(" + PROTECTED_TERMS.map((t) => (/^\w+$/.test(t) ? t : '"' + t + '"')).join(" OR ") + ") " + base;
  }

  function senderQuery(sender, base) {
    // Anything but a plain address could change the meaning of the search.
    return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(sender) ? "from:" + sender + " " + base : null;
  }

  /**
   * opts: {
   *   candidates: Map id -> Set of rule names whose search found it
   *   protectedIds: Set of ids to check individually
   *   base: search terms added to every sender search
   *   search(query) -> Promise<id[]>, fetch(id) -> Promise<message>, decide(msg) -> Promise<decision>
   *   stopped() -> bool, onProgress(resolved, total), batch
   * }
   * Returns { rows, failed, fetched, searches }. Each row is { id, sender, action, category, reason, checked }.
   */
  async function bySender(opts) {
    const { candidates, protectedIds } = opts;
    const total = candidates.size;
    // Protected mail goes last, so samples come from mail that could form a group.
    const all = [...candidates.keys()];
    const pending = new Set(all.filter((id) => !protectedIds.has(id)).concat(all.filter((id) => protectedIds.has(id))));
    const rows = new Map(), groups = new Map(), known = new Set(), kept = new Set(), failed = [];
    let fetched = 0, searches = 0;

    // A kept email means this sender is mixed: send its grouped mail back for individual checks.
    const ungroup = (sender) => {
      for (const id of groups.get(sender) || []) { rows.delete(id); pending.add(id); }
      groups.delete(sender);
    };

    while (pending.size && !opts.stopped()) {
      const ids = [...pending].slice(0, opts.batch || 10);
      ids.forEach((id) => pending.delete(id));
      const samples = [];
      await Promise.all(ids.map(async (id) => {
        try {
          const msg = await opts.fetch(id);
          const d = await opts.decide(msg);
          const h = Rules.headerMap(msg), sender = Rules.senderOf(h);
          fetched++;
          rows.set(id, { id, sender, action: d.action, category: d.category, reason: d.reason, checked: true });
          if (d.action !== "DELETE") { kept.add(sender); ungroup(sender); }
          samples.push({ sender, d, bulk: Rules.hasBulkSignals(h, new Set(msg.labelIds || [])) });
        } catch (e) { failed.push(id); }
      }));

      const fresh = new Map();
      for (const s of samples) if (!known.has(s.sender) && !fresh.has(s.sender)) fresh.set(s.sender, s);
      await Promise.all([...fresh.values()].map(async ({ sender, d, bulk }) => {
        known.add(sender);
        const query = senderQuery(sender, opts.base);
        if (d.action !== "DELETE" || !bulk || !query || kept.has(sender) || opts.stopped()) return;
        let found;
        try { searches++; found = await opts.search(query); } catch (e) { return; } // falls back to individual checks
        if (found.some((id) => protectedIds.has(id))) return;
        // "Old" depends on each email's age, so it only extends to mail the old-mail search found.
        const mine = found.filter((id) => pending.has(id) && (d.category !== "old" || candidates.get(id).has("oldUnread")));
        for (const id of mine) {
          pending.delete(id);
          rows.set(id, { id, sender, action: "DELETE", category: d.category, reason: d.reason, checked: false });
        }
        if (mine.length) groups.set(sender, mine);
      }));
      opts.onProgress && opts.onProgress(total - pending.size, total);
    }
    return { rows: [...rows.values()], failed, fetched, searches };
  }

  const api = { bySender, protectedQuery, senderQuery, PROTECTED_TERMS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Sweep = api;
})(typeof window !== "undefined" ? window : globalThis);
