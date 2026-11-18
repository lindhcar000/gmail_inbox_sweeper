// Offline tests for the deletion rules. Run: node test/rules.test.js
const Rules = require("../rules.js");

const ME = "carson.lindholm@gmail.com";
const NOW = Date.now();
const OLD = NOW - 400 * 864e5;
const RECENT = NOW - 5 * 864e5;

function msg(from, { to = ME, subject = "", snippet = "", labels = [], headers = {}, date = RECENT } = {}) {
  const hs = [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }];
  for (const [k, v] of Object.entries(headers)) hs.push({ name: k, value: v });
  return { id: "x", threadId: "t1", labelIds: labels, snippet, internalDate: String(date), payload: { headers: hs } };
}

const ALL = { oldUnread: true, marketing: true, social: true, notifications: true };
const unsub = { "List-Unsubscribe": "<mailto:u@x.com>" };

const cases = [
  ["promo email", "DELETE", msg("Old Navy <deals@oldnavy.com>", { subject: "40% off everything — today only!", labels: ["CATEGORY_PROMOTIONS"], headers: unsub })],
  ["newsletter + platform header", "DELETE", msg("Brand <newsletter@brand.com>", { subject: "New arrivals are here", headers: { ...unsub, "X-Mailchimp-Id": "1" } })],
  ["promo but starred", "KEEP", msg("deals@shop.com", { subject: "Flash sale", labels: ["CATEGORY_PROMOTIONS", "STARRED"], headers: unsub })],
  ["promo but replied", "KEEP", msg("deals@shop.com", { subject: "Flash sale", labels: ["CATEGORY_PROMOTIONS"], headers: unsub }), { replied: true }],
  ["order receipt", "KEEP", msg("no-reply@amazon.com", { subject: "Your order has shipped", labels: ["CATEGORY_UPDATES"], headers: unsub })],
  ["personal recent", "KEEP", msg("Mom <mom@yahoo.com>", { subject: "Dinner sunday?" })],
  ["personal old unread", "KEEP", msg("Friend <f@gmail.com>", { subject: "hey", labels: ["UNREAD"], date: OLD })],
  ["personal via gmail alias", "KEEP", msg("Friend <f@gmail.com>", { to: "Carson.Lindholm+x@gmail.com", subject: "hey", labels: ["UNREAD"], date: OLD })],
  ["group email old unread", "DELETE", msg("Club <club@uw.edu>", { to: `${ME}, a@b.com`, subject: "Meeting notes", labels: ["UNREAD"], date: OLD })],
  ["allowlisted domain", "KEEP", msg("deals@rei.com", { subject: "Member sale", labels: ["CATEGORY_PROMOTIONS"], headers: unsub }), { allow: ["rei.com"] }],
  ["allowlisted address", "KEEP", msg("deals@rei.com", { subject: "Member sale", labels: ["CATEGORY_PROMOTIONS"], headers: unsub }), { allow: ["deals@rei.com"] }],
  ["weak signal only", "KEEP", msg("info@company.com", { subject: "Quarterly update" })],
  ["facebook", "DELETE", msg("Facebook <notification@facebookmail.com>", { subject: "Alex commented", labels: ["CATEGORY_SOCIAL"] })],
  ["instagram subdomain", "DELETE", msg("Instagram <no-reply@mail.instagram.com>", { subject: "jess liked your photo" })],
  ["x/twitter", "DELETE", msg("X <info@x.com>", { subject: "See what's happening" })],
  ["social tab unknown site", "DELETE", msg("hi@newsite.io", { subject: "3 new members", labels: ["CATEGORY_SOCIAL"] })],
  ["custom social domain", "DELETE", msg("hi@mycommunity.app", { subject: "New post" }), { social: [...Rules.DEFAULT_SOCIAL_DOMAINS, "mycommunity.app"] }],
  ["social rule off", "KEEP", msg("hi@newsite.io", { subject: "3 new members", labels: ["CATEGORY_SOCIAL"] }), { rules: { ...ALL, social: false } }],
  ["instagram security", "KEEP", msg("security@mail.instagram.com", { subject: "New login to Instagram", labels: ["CATEGORY_SOCIAL"] })],
  ["linkedin application", "KEEP", msg("jobs-noreply@linkedin.com", { subject: "Your application was sent to Boston Children's Hospital" })],
  ["github notification", "DELETE", msg("GitHub <notifications@github.com>", { subject: "[repo] New issue", labels: ["CATEGORY_UPDATES"] })],
  ["auto-submitted alert", "DELETE", msg("alerts@weatherapp.com", { subject: "Rain tomorrow", headers: { "Auto-Submitted": "auto-generated" } })],
  ["no-reply, no machine signal", "KEEP", msg("noreply@dentist.com", { subject: "See you next week" })],
  ["bank statement", "KEEP", msg("alerts@chase.com", { subject: "Your statement is ready", labels: ["CATEGORY_UPDATES"] })],
  ["utility bill", "KEEP", msg("noreply@eversource.com", { subject: "Your bill is ready", labels: ["CATEGORY_UPDATES"] })],
  ["higher threshold spares weak promo", "KEEP", msg("Brand <hello@brand.com>", { subject: "New arrivals", headers: unsub }), { threshold: 6 }],
];

(async () => {
  let fail = 0;
  for (const [name, expected, m, opt = {}] of cases) {
    const r = await Rules.decide(m, {
      me: ME, nowMs: NOW, threshold: opt.threshold || 3,
      rules: opt.rules || ALL, allowlist: opt.allow || [],
      socialDomains: opt.social || Rules.DEFAULT_SOCIAL_DOMAINS,
      threadHasReply: async () => !!opt.replied,
    });
    const ok = r.action === expected;
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(38)} ${r.action.padEnd(6)} ${r.reason}`);
  }
  console.log(`\n${cases.length - fail}/${cases.length} passed`);
  process.exit(fail ? 1 : 0);
})();
