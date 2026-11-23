// Offline tests for the Unsubscribe tab. Run: node test/unsub.test.js
const U = require("../unsub.js");
let fail = 0, total = 0;
function check(name, ok) { total++; if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name); }
const DAY = 864e5, NOW = 1e12;
const row = (sender, o = {}) => ({ from: "Brand <" + sender + ">", sender, date: NOW, state: "DELETE", reason: "", listId: "", unsub: { https: "https://x.com/u" }, ...o });
const go = (rows, done = {}) => U.groupLists(rows, done);

let g = go([row("a@x.com", { date: NOW - DAY }), row("a@x.com", { id: "new" }), row("a@x.com", { date: NOW - 2 * DAY })]);
check("repeat emails become one entry", g.todo.length === 1 && g.todo[0].count === 3);
check("newest email's link is used", g.todo[0].row.id === "new" && g.todo[0].latest === NOW);
check("no unsubscribe option is left out", go([row("a@x.com", { unsub: null })]).todo.length === 0);
g = go([row("a@x.com"), row("b@x.com"), row("b@x.com")]);
check("most emails first", g.todo[0].sender === "b@x.com");

const two = [row("n@l.com", { listId: "jobs" }), row("n@l.com", { listId: "jobs" }), row("n@l.com", { listId: "news" })];
g = go(two);
check("separate lists are separate entries", g.todo.length === 2 && g.todo.every((x) => x.multi));
g = go(two, { "n@l.com|jobs": { at: NOW } });
check("done list hides only that list", g.todo.length === 1 && g.todo[0].listId === "news" && g.done.length === 1);
g = go([1, 2, 3, 4].map((i) => row("r@x.com", { listId: "id" + i })));
check("changing list ids are grouped by address", g.todo.length === 1 && g.todo[0].count === 4);

const done = { "a@x.com|": { at: NOW - 20 * DAY } };
check("unsubscribed is hidden", go([row("a@x.com", { date: NOW - 15 * DAY })], done).todo.length === 0);
check("mail within 10 days stays hidden", go([row("a@x.com", { date: NOW - 10 * DAY })], done).todo.length === 0);
g = go([row("a@x.com", { date: NOW - 9 * DAY })], done);
check("mail after 10 days comes back", g.todo.length === 1 && g.todo[0].still && g.done.length === 0);
g = go([], { "a@x.com|": { at: NOW, name: "Brand" } });
check("done entries not in this scan are listed", g.done.length === 1 && g.done[0].count === 0 && g.done[0].name === "Brand");

check("kept mail is labelled", go([row("a@x.com"), row("a@x.com", { state: "KEEP", reason: "Starred", unsub: null })]).todo[0].keeps);
check("no-rule mail isn't labelled", !go([row("a@x.com", { state: "KEEP", reason: "No rule matched" })]).todo[0].keeps);
check("list id parsing", U.listIdOf("My News <News.X.com>") === "news.x.com" && U.listIdOf("") === "");
check("name parsing", U.nameOf('"Old Navy" <d@o.com>', "d@o.com") === "Old Navy" && U.nameOf("d@o.com", "d@o.com") === "d@o.com");

let s = U.parseStore({ "a@x.com": { at: 5, method: "oneclick" } });
let mine = U.openAccount(s, "me@gmail.com");
check("older format moves to the first account", mine["a@x.com|*"].at === 5 && Object.keys(U.openAccount(s, "two@gmail.com")).length === 0);
check("older entry hides its sender", go([row("a@x.com", { listId: "z", date: 1 })], mine).todo.length === 0);
s = U.parseStore(JSON.parse(JSON.stringify(s)));
check("accounts survive saving and loading", U.openAccount(s, "me@gmail.com")["a@x.com|*"].at === 5);
check("bad saved data is ignored", [null, 3, "x", [], { "a@x.com": null, b: { at: 1 } }].every((x) => Object.keys(U.openAccount(U.parseStore(x), "m@g.com")).length === 0));

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
