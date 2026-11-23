// Offline tests for sender grouping, using a fake mailbox. Run: node test/sweep.test.js
const Rules = require("../rules.js");
const Sweep = require("../sweep.js");
let fail = 0, total = 0;
function check(name, ok) { total++; if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name); }

const NOW = Date.now(), ME = "me@gmail.com";
let n = 0;
function mail(from, subject, o = {}) {
  const headers = [{ name: "From", value: from }, { name: "To", value: ME }, { name: "Subject", value: subject }];
  if (o.unsub !== false) headers.push({ name: "List-Unsubscribe", value: "<https://x.com/u>" });
  return { id: "m" + n++, threadId: "t" + n, labelIds: o.labels || ["CATEGORY_PROMOTIONS"], snippet: "",
    internalDate: String(NOW - (o.days || 5) * 864e5), payload: { headers }, hits: o.hits || ["marketing"] };
}
async function run(box, opt = {}) {
  const byId = new Map(box.map((m) => [m.id, m]));
  const ctx = { me: ME, nowMs: NOW, threshold: 3, allowlist: opt.allow || [], rules: opt.rules || { marketing: true, oldUnread: true },
    threadHasReply: async () => false };
  return Sweep.bySender({
    candidates: new Map(box.map((m) => [m.id, new Set(m.hits)])),
    protectedIds: new Set(opt.protectedIds || []), base: "", batch: opt.batch || 2,
    search: async (q) => {
      if (opt.searchFails) throw new Error("x");
      return box.filter((m) => "from:" + Rules.senderOf(Rules.headerMap(m)) === q.trim()).map((m) => m.id).concat("other");
    },
    fetch: async (id) => { if (id === opt.badId) throw new Error("x"); return byId.get(id); },
    decide: (m) => Rules.decide(m, ctx), stopped: opt.stopped || (() => false),
  });
}
const many = (k, f) => Array.from({ length: k }, f);

(async () => {
  let box = many(50, () => mail("deals@shop.com", "Sale"));
  let r = await run(box);
  check("bulk sender is grouped", r.rows.length === 50 && r.fetched <= 2 && r.rows.filter((x) => !x.checked).length >= 48);
  check("ids outside the candidates are ignored", !r.rows.some((x) => x.id === "other"));

  box = many(10, () => mail("deals@shop.com", "Sale"));
  r = await run(box, { protectedIds: [box[7].id] });
  check("sender with protected mail is checked individually", r.fetched === 10 && r.rows.every((x) => x.checked));

  box = many(5, () => mail("friend@example.com", "hi", { unsub: false, labels: ["UNREAD"], days: 400, hits: ["oldUnread"] }));
  r = await run(box);
  check("personal mail is checked and kept", r.fetched === 5 && r.rows.every((x) => x.action === "KEEP"));

  box = many(8, () => mail("deals@rei.com", "Sale"));
  r = await run(box, { allow: ["rei.com"] });
  check("keep list is kept", r.rows.every((x) => x.checked && x.action === "KEEP"));

  box = many(3, () => mail("deals@shop.com", "Sale", { labels: ["UNREAD"], days: 400, hits: ["oldUnread"] }))
    .concat(many(4, () => mail("deals@shop.com", "Hello", { labels: [], hits: ["marketing"] })));
  r = await run(box, { rules: { oldUnread: true }, batch: 1 });
  check("old-mail group excludes newer mail", r.rows.length === 7 && r.rows.filter((x) => x.action === "DELETE").length === 3);

  box = [mail("deals@shop.com", "Sale")].concat(many(4, () => mail("deals@shop.com", "Sale")), mail("deals@shop.com", "Your order has shipped"));
  r = await run([box[0], box[5], ...box.slice(1, 5)]);
  check("kept email in same batch prevents grouping", r.fetched === 6 && r.rows.filter((x) => x.action === "KEEP").length === 1);

  box = many(6, () => mail("deals@shop.com", "Sale"));
  r = await run(box, { searchFails: true });
  check("failed search falls back to checking each", r.fetched === 6);
  r = await run([mail("a@x.com", "Sale"), mail("b@x.com", "Sale")].map((m, i) => (i ? m : Object.assign(m, { id: "bad" }))), { badId: "bad" });
  check("failed fetch is reported", r.failed.length === 1 && r.rows.length === 1);
  r = await run(box, { stopped: () => true });
  check("stop does nothing", r.fetched === 0 && r.rows.length === 0);

  // ungroup: a late sender search misses one email, which then turns out to be kept
  const late = [mail("deals@shop.com", "Sale"), ...many(4, () => mail("deals@shop.com", "Sale")), mail("deals@shop.com", "Your order has shipped")];
  const ids = new Map(late.map((m) => [m.id, m]));
  r = await Sweep.bySender({ candidates: new Map(late.map((m) => [m.id, new Set(["marketing"])])), protectedIds: new Set(), base: "", batch: 1,
    search: async () => late.slice(0, 5).map((m) => m.id), fetch: async (id) => ids.get(id), stopped: () => false,
    decide: (m) => Rules.decide(m, { me: ME, nowMs: NOW, threshold: 3, rules: { marketing: true }, threadHasReply: async () => false }) });
  check("late kept email breaks up the group", r.fetched === 6 && r.rows.length === 6 && r.rows.every((x) => x.checked));

  check("unsafe sender is not searched", Sweep.senderQuery("a@x.com)", "") === null && Sweep.senderQuery("", "") === null);
  for (const s of ["Your receipt", "Order confirmation", "Your order has shipped", "Invoice", "Payment due", "Verify your email", "Security alert",
    "New sign-in", "New login", "Unusual activity", "Confirm your account", "Your bill is ready", "Interview", "Thank you for applying", "Application update",
    ...["Your receipts", "Invoices for May", "Your statements are available", "Payment failed", "Payment declined",
    "Your payment was received", "Refund issued", "Your bill for June", "Tax document available", "Your 1099 is ready",
    "Security notice", "Flight confirmation", "Your W-2 is available", "Booking confirmed"]])
    check("protected terms cover: " + s, Sweep.PROTECTED_TERMS.some((t) => new RegExp("\\b" + t + "\\b", "i").test(s)));

  console.log(`\n${total - fail}/${total} passed`);
  process.exit(fail ? 1 : 0);
})();
