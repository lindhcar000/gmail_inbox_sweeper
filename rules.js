/*
 * Inbox Sweep — deletion rules.
 * Pure logic, no network calls. Used by the web app (window.Rules) and by
 * the Node tests (require('./rules.js')).
 */
(function (root) {
  "use strict";

  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  const PROMO_RE = [
    /\d{1,3}\s?% off/i, /\bsale\b/i, /\bdeals?\b/i, /\bdiscount/i, /\bcoupon/i,
    /\bpromo code/i, /\blimited[- ]time/i, /\bfree shipping/i, /\bexclusive offer/i,
    /\bshop now/i, /\blast chance/i, /\bends (tonight|today|soon)/i, /\bdon'?t miss/i,
    /\bsave up to/i, /\bnew arrivals/i, /\bblack friday/i, /\bcyber monday/i,
    /\bflash sale/i, /\bspecial offer/i, /\bbuy one/i, /\bclearance/i, /\bbogo\b/i,
    /\bact now/i, /\btoday only/i, /\bshop the/i, /\bspend \$?\d+/i,
  ];

  const TRANSACTIONAL_RE = new RegExp(
    "\\b(receipts?|order (confirmation|#|number|has shipped)|your order|shipped|" +
    "delivery|tracking|invoices?|statements?|payments?|refund(s|ed)?|" +
    "passwords?|verification code|verify your|security (alert|notice|notification|warning|code|update)s?|sign-?in attempt|" +
    "new (login|sign-?in)|login attempt|unusual activity|two-factor|2fa|" +
    "confirm your (email|account)|2-step|one-time code|appointments?|reservations?|" +
    "itinerary|boarding pass(es)?|(flight|booking) (confirmation|confirmed|change|changed|cancell?ed|delayed|update)|" +
    "bills?|autopay|tax (document|form|return|statement|notice)s?|1099|1098|w-2|" +
    "interviews?|offer letter|your application|thank you for applying|" +
    "application (received|status|update))\\b",
    "i"
  );

  const MARKETING_LOCALPART_RE = new RegExp(
    "^(no-?reply|do-?not-?reply|newsletters?|news|marketing|promo(tions)?|offers?|" +
    "deals|sales?|hello|mailer|e?mail|enews|specials|rewards|shop|store|" +
    "team|updates?|info|community|events)([._+-]|$)",
    "i"
  );

  const NOTIFY_LOCALPART_RE = new RegExp(
    "^(notifications?|notify|alerts?|no-?reply|noreply|do-?not-?reply|donotreply|" +
    "updates?|digest|automated|auto|mailer|accounts?|system|bot|activity|" +
    "reminders?|community|info|news)([._+-]|$)",
    "i"
  );

  const ESP_MARKERS = [
    "mailchimp", "x-mc-user", "sendgrid", "x-sg-", "mailgun", "klaviyo", "marketo",
    "x-sfmc", "hubspot", "braze", "campaign", "x-feedback-id", "x-mailer-recptid",
    "x-csa-complaints", "constantcontact", "iterable", "x-emarsys",
  ];

  const BULK_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

  const DEFAULT_SOCIAL_DOMAINS = [
    "facebook.com", "facebookmail.com", "instagram.com", "twitter.com", "x.com",
    "tiktok.com", "snapchat.com", "pinterest.com", "reddit.com", "redditmail.com",
    "tumblr.com", "threads.net", "linkedin.com", "discord.com", "nextdoor.com",
    "quora.com", "youtube.com", "bsky.app", "whatsapp.com", "messenger.com",
    "meetup.com", "strava.com", "goodreads.com", "medium.com", "twitch.tv",
  ];

  // ------------------------------------------------------------ helpers ----

  function formatDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function headerMap(msg) {
    const out = {};
    const hs = (msg.payload && msg.payload.headers) || [];
    for (const h of hs) out[h.name.toLowerCase()] = h.value;
    return out;
  }

  function extractAddrs(s) {
    return ((s || "").match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map((a) => a.toLowerCase());
  }

  function senderOf(h) {
    return extractAddrs(h.from)[0] || "";
  }

  function normalizeAddr(addr) {
    addr = (addr || "").trim().toLowerCase();
    const at = addr.lastIndexOf("@");
    if (at < 0) return addr;
    let local = addr.slice(0, at).split("+")[0];
    let domain = addr.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      local = local.replace(/\./g, "");
      domain = "gmail.com";
    }
    return local + "@" + domain;
  }

  function cleanList(list) {
    return (list || [])
      .map((s) => String(s).split("#")[0].trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  }

  function domainIn(sender, domains) {
    const domain = sender.split("@").pop().toLowerCase();
    return domains.some((d) => domain === d || domain.endsWith("." + d));
  }

  function isAllowlisted(sender, allowlist) {
    sender = sender.toLowerCase();
    return allowlist.includes(sender) || domainIn(sender, allowlist.filter((a) => !a.includes("@")));
  }

  function hasBulkSignals(h, labels) {
    return Boolean(
      "list-unsubscribe" in h ||
      "list-id" in h ||
      ["bulk", "list", "junk"].includes((h.precedence || "").toLowerCase()) ||
      BULK_CATEGORIES.some((c) => labels.has(c))
    );
  }

  function isAutomatedSender(sender, socialDomains) {
    const local = sender.split("@")[0];
    return NOTIFY_LOCALPART_RE.test(local) || MARKETING_LOCALPART_RE.test(local) || domainIn(sender, socialDomains);
  }

  function isPersonal(h, labels, me, socialDomains) {
    const to = new Set(extractAddrs(h.to).map(normalizeAddr));
    const cc = extractAddrs(h.cc);
    if (to.size !== 1 || !to.has(normalizeAddr(me)) || cc.length) return false;
    if (isAutomatedSender(senderOf(h), socialDomains)) return false;
    return !hasBulkSignals(h, labels);
  }

  function socialReason(sender, labels, socialDomains) {
    if (domainIn(sender, socialDomains)) return "Social media (" + sender.split("@").pop() + ")";
    if (labels.has("CATEGORY_SOCIAL")) return "Social media (Social tab)";
    return null;
  }

  function websiteNotificationReason(sender, h, labels) {
    if (!NOTIFY_LOCALPART_RE.test(sender.split("@")[0])) return null;
    const signs = [];
    if (labels.has("CATEGORY_UPDATES") || labels.has("CATEGORY_FORUMS")) signs.push("Updates/Forums tab");
    if ("list-unsubscribe" in h) signs.push("unsubscribe header");
    if ((h["auto-submitted"] || "no").toLowerCase() !== "no") signs.push("auto-submitted");
    if (["bulk", "list", "junk"].includes((h.precedence || "").toLowerCase())) signs.push("bulk header");
    if (!signs.length) return null;
    return "Website notification: " + signs.join(", ");
  }

  function marketingScore(msg, h, labels) {
    let score = 0;
    const reasons = [];
    if (labels.has("CATEGORY_PROMOTIONS")) { score += 3; reasons.push("Promotions tab"); }
    if ("list-unsubscribe" in h) { score += 2; reasons.push("unsubscribe header"); }
    if (["bulk", "list", "junk"].includes((h.precedence || "").toLowerCase())) { score += 1; reasons.push("bulk header"); }
    if (MARKETING_LOCALPART_RE.test(senderOf(h).split("@")[0])) { score += 1; reasons.push("marketing address"); }
    const names = Object.keys(h);
    if (names.some((n) => ESP_MARKERS.some((m) => n.includes(m)))) { score += 1; reasons.push("marketing platform"); }
    const text = (h.subject || "") + " " + (msg.snippet || "");
    const hits = PROMO_RE.filter((re) => re.test(text)).length;
    if (hits) { score += Math.min(hits, 2); reasons.push("promo language"); }
    if (labels.has("CATEGORY_PERSONAL")) { score -= 2; reasons.push("Primary tab (−2)"); }
    return { score, reasons };
  }

  // ----------------------------------------------------------- decision ----

  /**
   * ctx: { me, threadHasReply(threadId) -> Promise<bool>, allowlist[], socialDomains[],
   *        threshold, nowMs, oldBeforeMs (optional cutoff, epoch ms),
   *        rules: {oldUnread, marketing, social, notifications} }
   * Returns Promise<{action: 'DELETE'|'KEEP', reason, category}>
   */
  async function decide(msg, ctx) {
    const h = headerMap(msg);
    const labels = new Set(msg.labelIds || []);
    const sender = senderOf(h);
    const subject = h.subject || "";
    const rules = ctx.rules || {};
    const social = ctx.socialDomains || DEFAULT_SOCIAL_DOMAINS;

    // Before every rule, so no rule (including old unopened mail) can flag these.
    if (TRANSACTIONAL_RE.test(subject)) {
      return { action: "KEEP", reason: "Receipt, bill, security or application email", category: null };
    }

    let flagged = null;
    let category = null;
    // Unopened mail received before the user's chosen cutoff (default: 1 year ago).
    const cutoff = ctx.oldBeforeMs != null ? ctx.oldBeforeMs : ctx.nowMs - ONE_YEAR_MS;
    const received = Number(msg.internalDate || ctx.nowMs);

    if (rules.oldUnread && labels.has("UNREAD") && received < cutoff) {
      flagged = "Never opened, received before " + formatDate(cutoff);
      category = "old";
    }

    if (!flagged && rules.social) {
      flagged = socialReason(sender, labels, social);
      if (flagged) category = "social";
    }
    if (!flagged && rules.notifications) {
      flagged = websiteNotificationReason(sender, h, labels);
      if (flagged) category = "notification";
    }
    if (!flagged && rules.marketing) {
      const { score, reasons } = marketingScore(msg, h, labels);
      if (score >= ctx.threshold) {
        flagged = "Marketing (score " + score + "): " + reasons.join(", ");
        category = "marketing";
      }
    }

    if (!flagged) return { action: "KEEP", reason: "No rule matched", category: null };

    if (labels.has("STARRED")) return { action: "KEEP", reason: "Starred", category };
    if (isAllowlisted(sender, ctx.allowlist || [])) return { action: "KEEP", reason: "On your keep list", category };
    if (isPersonal(h, labels, ctx.me, social)) return { action: "KEEP", reason: "Personal email sent only to you", category };
    if (await ctx.threadHasReply(msg.threadId)) return { action: "KEEP", reason: "You replied in this thread", category };

    return { action: "DELETE", reason: flagged, category };
  }

  // -------------------------------------------------------- unsubscribe ----

  const EMAIL_RE = /^[^\s@<>,;"'()\[\]\\]+@[^\s@<>,;"'()\[\]\\]+\.[a-z0-9-]{2,}$/i;
  const stripLines = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

  function parseMailto(raw) {
    let url;
    try { url = new URL(raw); } catch (e) { return null; }
    if (url.protocol !== "mailto:") return null;
    let to;
    try { to = decodeURIComponent(url.pathname).split(",")[0].trim(); } catch (e) { return null; }
    if (!EMAIL_RE.test(to)) return null;
    return {
      to,
      subject: stripLines(url.searchParams.get("subject")) || "unsubscribe",
      body: String(url.searchParams.get("body") || "unsubscribe").slice(0, 2000),
    };
  }

  /**
   * Reads List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058).
   * Only https: URLs and mailto: addresses are accepted; everything else is ignored.
   * Returns { https, oneClick, mailto } or null if there's no usable option.
   *   https:    the first https unsubscribe URL (string) or null
   *   oneClick: true if the sender supports RFC 8058 one-click POST to `https`
   *   mailto:   { to, subject, body } or null
   */
  function parseUnsubscribe(listUnsub, listUnsubPost) {
    const items = String(listUnsub || "").match(/<[^<>]*>/g) || [];
    let https = null, mailto = null;
    for (const item of items) {
      const raw = item.slice(1, -1).replace(/\s+/g, "");
      if (!https && /^https:/i.test(raw)) {
        try {
          const u = new URL(raw);
          if (u.protocol === "https:" && u.hostname) https = u.href;
        } catch (e) { /* malformed */ }
      } else if (!mailto && /^mailto:/i.test(raw)) {
        mailto = parseMailto(raw);
      }
    }
    if (!https && !mailto) return null;
    const oneClick = !!https && /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubPost || "");
    return { https, oneClick, mailto };
  }

  // --------------------------------------------------------- API errors ----

  /** True if a Gmail error means "slow down and retry", not a permission problem. */
  function isRateLimit(status, body) {
    if (status === 429) return true;
    if (status !== 403) return false;
    const err = (body && body.error) || {};
    const reasons = [].concat(err.details || [], err.errors || []).map((d) => d && d.reason);
    return reasons.some((r) => ["RATE_LIMIT_EXCEEDED", "rateLimitExceeded", "userRateLimitExceeded"].includes(r));
  }

  const api = {
    decide, headerMap, senderOf, cleanList, normalizeAddr, isAllowlisted, formatDate, parseUnsubscribe, isRateLimit, hasBulkSignals,
    DEFAULT_SOCIAL_DOMAINS, ONE_YEAR_MS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof window !== "undefined" ? window : globalThis);
