"use strict";
// LifeOS front end.
// Safety: all text that comes from files or from the AI is shown with textContent / text nodes, never innerHTML.
// innerHTML is only used for our own constant SVG icon paths.

const $ = (id) => document.getElementById(id);
let DEMO_DATE = "2026-10-12"; // replaced by the backend setting from /api/info
const RUNWAY_BACK = 7;        // the runway also shows the last 7 days...
const RUNWAY_DAYS = 35;       // ...and the next five weeks

const state = {
  files: [],
  items: [],
  queue: [],            // files waiting / being read
  running: false,
  filter: "all",        // plan filter: all | task | event | decide
  open: new Set(),      // plan items the user expanded
  closed: new Set(),    // conflict items the user collapsed
  flash: new Set(),     // plan items changed by the latest file
  flashFile: null,
};

// ---------- helpers ----------

const ICONS = {
  tray: '<path d="M4 13.5 6.2 5.6A1.5 1.5 0 0 1 7.6 4.5h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13.5"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M12 7v5M9.8 9.8 12 12l2.2-2.2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5V9H9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M14 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7.5z"/><path d="M14 3v4.5h4.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || ""; // constant strings only
  return svg;
}

// el("p", {class: "x", text: "hello", onclick: fn}, child, "text child")
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    node.append(kid instanceof Node ? kid : String(kid)); // strings become safe text nodes
  }
  return node;
}

const str = (v) => (v === null || v === undefined ? "" : String(v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function announce(msg) {
  $("live").textContent = "";
  setTimeout(() => { $("live").textContent = msg; }, 40);
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    throw new Error("Can't reach the LifeOS server. Is it still running?");
  }
  let data = null;
  try { data = await res.json(); } catch (err) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `Server error (${res.status}). Please try again.`);
  return data;
}

const postJSON = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------- dates (parsed as LOCAL dates so they never shift by a day) ----------

function parseDate(s) {
  // the backend always sends YYYY-MM-DD; build it as a LOCAL date (new Date("2026-10-19") would be UTC
  // and can show the day before in some timezones). Anything after the date (a time) is ignored.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(str(s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null; // rejects 31 Feb
}

function daysFromDemo(s) {
  const d = parseDate(s);
  const today = parseDate(DEMO_DATE);
  return d && today ? Math.round((d - today) / 86400000) : null;
}

function relLabel(n) {
  if (n === null) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

// red = within 3 days, amber = within a week, green = later
const urgency = (n) => (n === null ? "" : n < 0 ? "past" : n <= 3 ? "hot" : n <= 7 ? "warm" : "cool");

function fmtDate(s) {
  const d = parseDate(s);
  if (!d) return "No date";
  const demo = parseDate(DEMO_DATE);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (!demo || d.getFullYear() !== demo.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

const timeRange = (t, end) => (t ? (end ? `${t}–${end}` : t) : "");

function when(date, time, end) {
  const t = timeRange(time, end);
  if (!date) return t || "No date";
  return t ? `${fmtDate(date)}, ${t}` : fmtDate(date);
}

const byDate = (a, b) =>
  str(a.date || "9999").localeCompare(str(b.date || "9999")) || str(a.time || "99").localeCompare(str(b.time || "99"));

function safeHref(link) {
  const s = str(link).trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^www\.\S+$/i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return `mailto:${s}`;
  return null;
}

const sel = (cls, attr, id) => document.querySelectorAll(`.${cls}[${attr}="${CSS.escape(str(id))}"]`);

function scrollToFile(fileId) {
  const card = sel("file", "data-id", fileId)[0];
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

function scrollToItem(itemId) {
  if (state.filter !== "all" && !sel("item", "data-id", itemId).length) setFilter("all");
  const row = sel("item", "data-id", itemId)[0];
  if (!row) return;
  row.open = true;
  state.open.add(itemId);
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

// hovering a fact in a file lights up the same item in the plan, and the other way round
function link(itemId, on) {
  for (const node of sel("item", "data-id", itemId)) node.classList.toggle("linked", on);
  for (const node of document.querySelectorAll(`.facts li[data-item="${CSS.escape(str(itemId))}"]`)) node.classList.toggle("linked", on);
}

// ---------- runway: the last week and the next five weeks at a glance ----------

const itemFiles = (it) => [...new Set((Array.isArray(it.sources) ? it.sources : []).map((s) => str(s.file)).filter(Boolean))];

function renderRunway() {
  hidePop(true);
  const box = $("runway");
  box.replaceChildren();
  const today = parseDate(DEMO_DATE);
  const span = RUNWAY_BACK + RUNWAY_DAYS - 1;
  const pct = (n) => (((n + RUNWAY_BACK) / span) * 100).toFixed(3);
  const pos = (n) => `left:${pct(n)}%`;

  box.append(el("span", { class: "past-zone", style: `width:${pct(0)}%` }, el("span", { text: "Last 7 days" })));
  box.append(el("span", { class: "track" }));
  for (let n = -RUNWAY_BACK; n < RUNWAY_DAYS; n++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    const dow = d.getDay();
    box.append(el("span", { class: `tick${dow === 1 ? " major" : ""}${dow === 0 || dow === 6 ? " weekend" : ""}`, style: pos(n) }));
    if (dow === 1 && n !== 0) {
      box.append(el("span", { class: "tick-label", style: pos(n), text: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) }));
    }
  }
  box.append(el("span", { class: "today", style: pos(0) }, el("span", { text: "Today" })));

  // one pin per day; every event of that day is listed in its card
  const days = new Map();
  const earlier = [];
  const later = [];
  for (const it of state.items) {
    const n = daysFromDemo(it.date);
    if (n === null) continue;
    if (n < -RUNWAY_BACK) earlier.push(it);
    else if (n >= RUNWAY_DAYS) later.push(it);
    else {
      if (!days.has(n)) days.set(n, []);
      days.get(n).push(it);
    }
  }
  for (const [n, list] of days) {
    list.sort(byDate);
    const conflict = list.some((i) => i.status === "conflict");
    const fresh = list.some((i) => state.flash.has(i.id));
    const pin = el("button", {
      type: "button", class: `pin ${conflict ? "conflict" : urgency(n)}${list.length > 1 ? " multi" : ""}${fresh ? " is-new" : ""}`,
      style: pos(n), "aria-haspopup": "true", "aria-expanded": "false",
      "aria-label": `${fmtDate(list[0].date)}, ${plural(list.length, "item", "items")}: ${list.map((i) => i.title).join("; ")}`,
    }, String(list.length));
    pin.addEventListener("mouseenter", () => showPop(pin, n, list, false));
    pin.addEventListener("mouseleave", schedHide);
    pin.addEventListener("focus", () => showPop(pin, n, list, false));
    pin.addEventListener("blur", schedHide);
    pin.addEventListener("click", (e) => { e.stopPropagation(); showPop(pin, n, list, true); });
    box.append(pin);
  }
  if (!state.items.some((i) => parseDate(i.date))) box.append(el("p", { class: "runway-empty", text: "Dated events from your files will line up here." }));
  else if (!days.size) box.append(el("p", { class: "runway-empty", text: "Nothing in these weeks. Your dates are listed below." }));
  renderRunwayExtra(earlier, later);
}

function renderRunwayExtra(earlier, later) {
  // dated events outside the runway are never dropped: they are listed here
  const box = $("runway-extra");
  box.replaceChildren();
  const chip = (it, cls) => el("button", {
    type: "button", class: `ev-chip ${cls}`, title: `${it.title} (from ${itemFiles(it).join(", ") || "a file"})`,
    onclick: () => scrollToItem(it.id),
  }, el("b", { text: fmtDate(it.date) }), el("span", { text: it.title }));
  if (earlier.length) box.append(el("div", { class: "extra-group" }, el("span", { class: "extra-label", text: "Earlier" }), earlier.sort(byDate).map((it) => chip(it, "past"))));
  if (later.length) box.append(el("div", { class: "extra-group" }, el("span", { class: "extra-label", text: "Later" }), later.sort(byDate).map((it) => chip(it, ""))));
}

// the card that opens on a pin: hover or focus shows it, a click keeps it open
let popTimer = null;
let popPinned = false;
let popAnchor = null;

function showPop(pin, n, list, pinned) {
  clearTimeout(popTimer);
  const pop = $("runway-pop");
  if (pinned && popPinned && popAnchor === pin) { hidePop(true); return; } // a second click closes it
  popPinned = pinned || (popPinned && popAnchor === pin);
  if (popAnchor && popAnchor !== pin) popAnchor.setAttribute("aria-expanded", "false");
  popAnchor = pin;
  pin.setAttribute("aria-expanded", "true");
  pop.replaceChildren(
    el("p", { class: "pop-date", text: `${fmtDate(list[0].date)} · ${relLabel(n)}` }),
    ...list.map((it) => el("button", { type: "button", class: "pop-item", onclick: () => { hidePop(true); scrollToItem(it.id); } },
      el("b", { text: it.title }),
      el("span", { text: [timeRange(it.time, it.end_time), it.location, `from ${itemFiles(it).join(", ") || "a file"}`].filter(Boolean).join(" · ") }),
      it.status === "conflict" ? el("span", { class: "warn", text: "Date not confirmed: choose one in your plan" }) : null)));
  pop.hidden = false;
  // place it above the pin, kept inside the band
  const wrap = pop.parentElement.getBoundingClientRect();
  const p = pin.getBoundingClientRect();
  const left = Math.max(8, Math.min(p.left + p.width / 2 - wrap.left - pop.offsetWidth / 2, wrap.width - pop.offsetWidth - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${p.top - wrap.top - pop.offsetHeight - 10}px`;
  if (pinned) {
    const first = pop.querySelector(".pop-item");
    if (first) first.focus({ preventScroll: true });
  }
}

function schedHide() {
  if (popPinned) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => hidePop(false), 200);
}

function hidePop(force) {
  clearTimeout(popTimer);
  if (popPinned && !force) return;
  popPinned = false;
  $("runway-pop").hidden = true;
  if (popAnchor) popAnchor.setAttribute("aria-expanded", "false");
  popAnchor = null;
}

function renderBriefing() {
  const p = $("briefing");
  p.replaceChildren();
  if (!state.items.length) { p.textContent = "Nothing planned yet."; return; }
  const days = (i) => daysFromDemo(i.date);
  const dated = state.items.filter((i) => days(i) !== null);
  const week = dated.filter((i) => days(i) >= 0 && days(i) <= 6);
  const recent = dated.filter((i) => days(i) < 0 && days(i) >= -RUNWAY_BACK);
  const next = dated.filter((i) => days(i) > 6).sort(byDate)[0];
  const short = (t) => (t.length > 42 ? `${t.slice(0, 40)}…` : t);
  const parts = [];
  if (week.length) parts.push(`${plural(week.length, "thing", "things")} due this week`);
  else if (next) parts.push(`Nothing due this week. Next: ${short(next.title)}, ${fmtDate(next.date)}`);
  else parts.push("Nothing due this week");
  if (recent.length) parts.push(`${recent.length} in the last 7 days`);
  const undated = state.items.length - dated.length;
  if (undated) parts.push(`${undated} without a date`);
  p.append(parts.join(" · "));
  const decide = state.items.filter((i) => i.status === "conflict").length;
  if (decide) {
    p.append(" · ", el("button", {
      type: "button", class: "brief-link", text: `${decide === 1 ? "1 date needs" : `${decide} dates need`} your decision`,
      onclick: () => { setFilter("decide"); $("plan-title").scrollIntoView({ behavior: "smooth", block: "start" }); },
    }));
  }
}

// ---------- plan ----------

const FILTERS = [["all", "All"], ["task", "Tasks"], ["event", "Events"], ["decide", "To decide"]];

function filterTest(key, it) {
  if (key === "task") return it.type !== "event";
  if (key === "event") return it.type === "event";
  if (key === "decide") return it.status === "conflict";
  return true;
}

function setFilter(f) {
  state.filter = f;
  renderFilters();
  renderPlan();
}

function renderFilters() {
  const box = $("filters");
  box.replaceChildren();
  if (!state.items.length) return;
  for (const [key, label] of FILTERS) {
    const n = state.items.filter((it) => filterTest(key, it)).length;
    if (key === "decide" && !n && state.filter !== "decide") continue;
    box.append(el("button", { type: "button", "aria-pressed": state.filter === key ? "true" : "false", onclick: () => setFilter(key) },
      label, el("span", { class: "n", text: n })));
  }
}

function historyLine(line) {
  // "Thu 15 Oct 23:59 -> Mon 19 Oct 23:59 (prof_notice.png)"
  const m = /^(.+?) -> (.+?)(?: \(([^()]*)\))?((?: \([^()]*\))*)$/.exec(str(line));
  if (!m) return el("li", { text: line });
  return el("li", {}, el("s", { text: m[1] }), " → ", el("span", { class: "now", text: m[2] }),
    m[3] ? ` (${m[3]})` : "", m[4] || "");
}

function conflictEl(it) {
  const c = it.conflict;
  const msg = el("p", { text: "Your files disagree on this date. Which one is right?" });
  const choices = el("div", { class: "choices" });
  c.options.forEach((o, i) => {
    const suggested = i === c.suggested;
    choices.append(el("button", {
      type: "button", class: `choice${suggested ? " suggested" : ""}`,
      onclick: () => resolveConflict(it.id, i, choices, msg),
    }, suggested ? el("span", { class: "sugg", text: "Suggested" }) : null,
    el("b", { text: when(o.date, o.time) }),
    el("span", { text: `${str(o.source_type)} · ${str(o.file)}` })));
  });
  return el("div", { class: "conflict-box" }, msg, choices);
}

async function resolveConflict(id, choice, box, msg) {
  for (const b of box.querySelectorAll("button")) b.disabled = true;
  try {
    applyState(await postJSON("/api/resolve", { item_id: id, choice }));
    state.flash = new Set([id]);
    if (state.filter === "decide" && !state.items.some((i) => i.status === "conflict")) state.filter = "all";
    render();
    const it = state.items.find((i) => i.id === id);
    if (it) announce(`Confirmed ${fmtDate(it.date)} for ${it.title}.`);
  } catch (err) {
    msg.textContent = err.message;
    for (const b of box.querySelectorAll("button")) b.disabled = false;
  }
}

function itemEl(it, depth) {
  const parent = it.parent_id ? state.items.find((p) => p.id === it.parent_id) : null;
  const conflict = it.status === "conflict" && it.conflict && Array.isArray(it.conflict.options) && it.conflict.options.length;
  const srcs = Array.isArray(it.sources) ? it.sources : [];

  const tags = el("span", { class: "tags" });
  if (conflict) tags.append(el("span", { class: "tag conflict", text: "Conflict" }));
  if (it.updated) tags.append(el("span", { class: "tag updated", text: "Updated" }));
  if (srcs.some((s) => !s.verified)) tags.append(el("span", { class: "tag check", text: "Check quote" }));

  const meta = conflict
    ? [`${it.conflict.options.map((o) => fmtDate(o.date)).join(" or ")}: not confirmed`]
    : [timeRange(it.time, it.end_time), it.location, plural(srcs.length, "file", "files")];

  const summary = el("summary", {},
    el("span", { class: `kind ${it.type === "event" ? "event" : "task"}`, title: it.type === "event" ? "Event" : "Task" }),
    el("span", { class: "item-main" },
      el("span", { class: "item-title", text: it.title }),
      parent ? el("span", { class: "item-for", text: `For: ${parent.title}` }) : null,
      el("span", { class: "item-meta", text: meta.filter(Boolean).join(" · ") })),
    tags,
    el("span", { class: "chev" }, icon("chevron")));

  const href = safeHref(it.link);
  const body = el("div", { class: "item-body" },
    href ? el("p", {}, "Link: ", el("a", { href, target: "_blank", rel: "noopener", text: it.link })) : null,
    el("h4", { text: "Where it says so" }),
    el("ul", {}, srcs.map((s) => el("li", {},
      el("button", { type: "button", class: "cite", text: str(s.file), onclick: () => scrollToFile(s.file_id) }), " ",
      str(s.source_type), s.quote ? ": " : "", s.quote ? el("q", { text: str(s.quote).replace(/\s+/g, " ") }) : null,
      s.verified ? "" : " (not found word for word in the file, please check it)"))),
    el("h4", { text: "History" }),
    el("ol", {}, (Array.isArray(it.history) ? it.history : []).map(historyLine)));

  const d = el("details", { class: `item${depth ? " child" : ""}${state.flash.has(it.id) ? " flash" : ""}`, "data-id": it.id },
    summary, conflict ? conflictEl(it) : null, body);
  d.open = state.open.has(it.id) || (conflict && !state.closed.has(it.id));
  d.addEventListener("toggle", () => {
    if (d.open) { state.open.add(it.id); state.closed.delete(it.id); }
    else { state.open.delete(it.id); if (conflict) state.closed.add(it.id); }
  });
  summary.addEventListener("mouseenter", () => link(it.id, true));
  summary.addEventListener("mouseleave", () => link(it.id, false));
  return d;
}

function renderPlan() {
  const box = $("plan");
  box.replaceChildren();
  $("plan-count").textContent = state.items.length ? String(state.items.length) : "";
  if (!state.items.length) {
    box.append(el("div", { class: "empty-note" }, el("strong", { text: "Nothing planned yet" }),
      "Add a notice, poster or chat above. Every task and event lands here in date order."));
    return;
  }
  const items = state.items.filter((it) => filterTest(state.filter, it));
  if (!items.length) {
    box.append(el("div", { class: "empty-note" }, el("strong", { text: "Nothing here" }), "No items match this filter."));
    return;
  }
  const ids = new Set(items.map((i) => i.id));
  const top = items.filter((i) => !i.parent_id || !ids.has(i.parent_id)).sort(byDate);
  const groups = new Map();
  for (const it of top) {
    const key = parseDate(it.date) ? it.date : "none";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "none") - (b === "none") || a.localeCompare(b));
  keys.forEach((key, index) => {
    let badge;
    if (key === "none") {
      badge = el("div", { class: "day-badge" }, el("span", { class: "day-num", text: "No date" }));
    } else {
      const d = parseDate(key);
      const n = daysFromDemo(key);
      badge = el("div", { class: "day-badge" },
        el("span", { class: "day-num", text: d.getDate() }),
        el("span", { class: "day-wk", text: `${d.toLocaleDateString("en-GB", { weekday: "short" })} · ${d.toLocaleDateString("en-GB", { month: "short" })}` }),
        el("span", { class: `due ${urgency(n)}`, text: relLabel(n) }));
    }
    const list = el("div", { class: "day-items" });
    const seen = new Set();
    const addTree = (it, depth) => { // an item, then its helper tasks right below it
      if (seen.has(it.id) || depth > 3) return;
      seen.add(it.id);
      list.append(itemEl(it, depth));
      items.filter((c) => c.parent_id === it.id).sort(byDate).forEach((c) => addTree(c, depth + 1));
    };
    groups.get(key).forEach((it) => addTree(it, 0));
    box.append(el("section", { class: `day${key === "none" ? " nodate" : ""}`, style: `animation-delay:${Math.min(index, 8) * 40}ms` }, badge, list));
  });
}

// ---------- files ----------

function resultText(fact) {
  const it = state.items.find((i) => i.id === fact.item_id);
  const title = it ? `“${it.title}”` : "your plan";
  switch (fact.result) {
    case "same": return { text: `Matches ${title}`, cls: "" };
    case "update": return { text: `Changed the date of ${title}`, cls: "update" };
    case "conflict":
      return it && it.status === "conflict"
        ? { text: `Disagrees with ${title}: choose a date`, cls: "conflict" }
        : { text: `Disagreed with ${title} (settled)`, cls: "" };
    case "related": {
      const parent = it && it.parent_id ? state.items.find((p) => p.id === it.parent_id) : null;
      return { text: parent ? `Helper task for “${parent.title}”` : "Helper task", cls: "" };
    }
    default: return { text: "Added to your plan", cls: "" };
  }
}

function highlightedText(text, spans) {
  // full text with every extracted quote marked
  const pre = el("pre");
  const valid = (Array.isArray(spans) ? spans : [])
    .filter((s) => Array.isArray(s) && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 0 && s[0] < s[1] && s[1] <= text.length)
    .sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of valid) {
    if (a < pos) continue; // skip overlaps
    pre.append(text.slice(pos, a), el("mark", { text: text.slice(a, b) }));
    pos = b;
  }
  pre.append(text.slice(pos));
  return pre;
}

function fileEl(f, index) {
  const kind = str(f.kind);
  const url = str(f.url).startsWith("/") ? f.url : null; // only links to our own server
  const thumb = el("a", { class: "thumb", href: url, target: "_blank", rel: "noopener", "aria-label": `Open ${str(f.name)}` },
    kind === "image" && url ? el("img", { src: url, alt: "", loading: "lazy" }) : (kind === "pdf" ? "PDF" : "TXT"));
  const kindText = kind === "pdf" ? (f.pages > 1 ? `PDF, ${f.pages} pages` : "PDF") : kind === "image" ? "Image" : "Text";
  const head = el("div", { class: "file-head" }, thumb, el("div", {},
    el("p", { class: "file-name" }, url ? el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }) : str(f.name)),
    el("p", { class: "file-meta" },
      el("span", { class: `src src-${str(f.source) || "other"}`, text: str(f.source_label) || "Other" }),
      [kindText, f.seconds ? `read in ${f.seconds}s` : ""].filter(Boolean).join(" · "))));

  const facts = Array.isArray(f.facts) ? f.facts : [];
  const factList = facts.length
    ? el("ul", { class: "facts" }, facts.map((x) => {
      const res = resultText(x);
      const href = safeHref(x.link);
      const more = el("p", { class: "fact-more" });
      const parts = [x.location ? str(x.location) : null,
        href ? el("a", { href, target: "_blank", rel: "noopener", text: x.link }) : null,
        el("button", { type: "button", class: `res ${res.cls}`, text: res.text, onclick: () => scrollToItem(x.item_id) }),
        x.verified ? null : "quote not found word for word, please check"].filter(Boolean);
      parts.forEach((p, k) => { if (k) more.append(" · "); more.append(p); });
      return el("li", { "data-item": x.item_id, onmouseenter: () => link(x.item_id, true), onmouseleave: () => link(x.item_id, false) },
        el("div", { class: "fact-main" }, el("mark", { class: "fact-when", text: when(x.date, x.time, x.end_time) }),
          el("span", { class: "fact-title", text: x.title })),
        more);
    }))
    : el("p", { class: "no-facts", text: "No dates or tasks in this file. Its text is still searchable." });

  const text = str(f.text);
  const full = el("details", { class: "fulltext" }, el("summary", {}, "Show the text we read", icon("chevron")));
  full.addEventListener("toggle", () => { // build the (possibly long) text only when opened
    if (full.open && full.children.length === 1) full.append(highlightedText(text, facts.map((x) => x.quote_span)));
  });

  return el("article", { class: `file${state.flashFile === f.id ? " flash" : ""}`, "data-id": f.id, style: `animation-delay:${Math.min(index, 8) * 50}ms` },
    head, factList,
    f.summary ? el("p", { class: "summary-label", text: "Summary" }) : null,
    f.summary ? el("p", { class: "summary", text: f.summary }) : null,
    text ? full : null);
}

function renderFiles() {
  const box = $("files");
  box.replaceChildren();
  $("files-count").textContent = state.files.length ? String(state.files.length) : "";
  if (!state.files.length) {
    box.append(el("div", { class: "empty-note" }, el("strong", { text: "No files yet" }),
      "Each file you add shows its key dates highlighted here, with a short summary and the text we read."));
    return;
  }
  [...state.files].sort((a, b) => (b.order || 0) - (a.order || 0)).forEach((f, i) => box.append(fileEl(f, i)));
}

function applyState(s) {
  if (!s) return;
  state.files = Array.isArray(s.files) ? s.files : [];
  state.items = Array.isArray(s.items) ? s.items : [];
}

function render() {
  renderBriefing();
  renderRunway();
  renderFilters();
  renderPlan();
  renderFiles();
  // flashes play once
  state.flash = new Set();
  state.flashFile = null;
}

// ---------- the upload queue (one file at a time, in the order you added them) ----------

let qid = 0;
let timer = null;

function enqueue(jobs) {
  if (!state.running) state.queue = state.queue.filter((j) => j.status === "waiting");
  for (const job of jobs) state.queue.push({ id: ++qid, status: "waiting", ...job });
  renderQueue();
  runQueue();
}

const addFiles = (list) => enqueue([...list].map((file) => ({ name: file.name || "file", file })));

function statusText(job) {
  if (job.status === "waiting") return "Waiting";
  if (job.status === "busy") return `Reading ${((performance.now() - job.started) / 1000).toFixed(0)}s`;
  return job.message || "";
}

function renderQueue() {
  const icons = { waiting: "clock", busy: "file", done: "check", error: "alert" };
  $("queue").replaceChildren(...state.queue.map((job) => el("li", { class: `q ${job.status}` },
    el("span", { class: "q-icon" }, icon(icons[job.status] || "file")),
    el("span", { class: "q-name", text: job.name }),
    el("span", { class: "q-status", text: statusText(job) }),
    el("span", { class: "q-bar" }))));
}

function tickQueue() { // update the timers without rebuilding the list (keeps the bar animation smooth)
  const rows = $("queue").children;
  state.queue.forEach((job, i) => {
    const status = rows[i] && rows[i].querySelector(".q-status");
    if (job.status === "busy" && status) status.textContent = statusText(job);
  });
}

const RESULT_TEXT = { new: "new", same: "merged", update: "updated", conflict: "conflict", related: "linked" };

function describe(out) {
  const counts = {};
  for (const c of out.changes || []) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const parts = Object.keys(counts).map((k) => `${counts[k]} ${RESULT_TEXT[k] || k}`);
  const secs = out.file && out.file.seconds ? ` · ${out.file.seconds}s` : "";
  return (parts.length ? parts.join(", ") : "No dates found") + secs + (out.backup_used ? " (backup model)" : "");
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  timer = setInterval(tickQueue, 500);
  try {
    let job;
    while ((job = state.queue.find((j) => j.status === "waiting"))) {
      job.status = "busy";
      job.started = performance.now();
      renderQueue();
      try {
        const form = new FormData();
        if (job.file) form.append("file", job.file, job.file.name);
        else form.append("text", job.text);
        const out = await api("/api/process", { method: "POST", body: form });
        applyState(out.state);
        job.status = "done";
        if (out.duplicate) {
          job.message = "Already added";
        } else {
          job.message = describe(out);
          state.flash = new Set((out.changes || []).map((c) => c.item_id));
          state.flashFile = out.file ? out.file.id : null;
        }
        render();
        announce(`${job.name}: ${job.message}`);
      } catch (err) {
        job.status = "error";
        job.message = err.message;
        announce(`${job.name}: ${err.message}`);
      }
      renderQueue();
    }
  } finally {
    clearInterval(timer);
    state.running = false;
    renderQueue();
  }
}

// ---------- adding files: buttons, drag and drop anywhere, Ctrl+V ----------

$("browse").addEventListener("click", () => $("file-input").click());
$("drop").addEventListener("click", (e) => {
  if (e.target.closest("button") || e.target === $("file-input")) return;
  $("file-input").click();
});
$("file-input").addEventListener("change", (e) => {
  if (e.target.files && e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
});

let dragDepth = 0;
const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
function showMask(on, count) {
  $("dropmask").classList.toggle("on", on);
  $("drop").classList.toggle("over", on);
  if (on) $("dropmask-text").textContent = count > 1 ? `Drop to add ${count} files` : "Drop to add the file";
}
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  showMask(true, e.dataTransfer.items ? e.dataTransfer.items.length : 1);
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showMask(false);
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  showMask(false);
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addFiles(files);
});

document.addEventListener("paste", (e) => {
  if (e.target === $("paste-text")) return; // normal text paste
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  addFiles(files.map((f, i) => new File([f], `pasted_screenshot${i ? "_" + (i + 1) : ""}.${f.type === "image/jpeg" ? "jpg" : "png"}`, { type: f.type })));
});

function closePaste() {
  $("paste").hidden = true;
  $("paste-toggle").setAttribute("aria-expanded", "false");
}
$("paste-toggle").addEventListener("click", () => {
  if (!$("paste").hidden) { closePaste(); return; }
  $("paste").hidden = false;
  $("paste-toggle").setAttribute("aria-expanded", "true");
  $("paste-text").focus();
});
$("paste-cancel").addEventListener("click", closePaste);
$("paste").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("paste-text").value.trim();
  if (!text) { $("paste-text").focus(); return; }
  enqueue([{ name: "Pasted text", text }]);
  $("paste-text").value = "";
  closePaste();
});

// ---------- ask / search ----------

const STOP = new Set(("what when where which who whom how why the and for are is was were do does did need needs should could would " +
  "can will to of in on at by my me i you your our we it its this that these those with from about have has had any there " +
  "file files summarize summary tell show give list all before after next week today date dates not yet confirmed").split(" "));

function localSearch(q) {
  // instant keyword search in the files' text (works even if the AI is busy)
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) || []).filter((w) => !STOP.has(w)))];
  if (!words.length) return [];
  const hits = [];
  for (const f of state.files) {
    const text = str(f.text);
    const low = text.toLowerCase();
    const found = words.filter((w) => low.includes(w));
    if (!found.length) continue;
    const at = low.indexOf(found[0]);
    let a = Math.max(0, at - 70);
    let b = Math.min(text.length, at + found[0].length + 90);
    while (a > 0 && /\S/.test(text[a - 1])) a--;
    while (b < text.length && /\S/.test(text[b])) b++;
    hits.push({ f, score: found.length, snippet: (a ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ").trim() + (b < text.length ? "…" : ""), found });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, 4);
}

function markWords(snippet, words) {
  const span = el("span");
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let last = 0;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    span.append(snippet.slice(last, m.index), el("mark", { text: m[0] }));
    last = m.index + m[0].length;
  }
  span.append(snippet.slice(last));
  return span;
}

function citeButton(name) {
  const f = state.files.find((x) => x.name === name);
  return f ? el("button", { type: "button", class: "cite", text: name, onclick: () => scrollToFile(f.id) }) : `[${name}]`;
}

function answerLine(line) {
  // "[file.pdf]" or "[a.png, b.pdf]" -> clickable file names
  const p = el("p");
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    p.append(line.slice(last, m.index));
    m[1].split(/\s*,\s*/).forEach((name, i) => { if (i) p.append(" "); p.append(citeButton(name.trim())); });
    last = m.index + m[0].length;
  }
  p.append(line.slice(last));
  return p;
}

async function ask(q) {
  q = str(q).trim();
  if (!q) { $("question").focus(); return; }
  $("answer").hidden = false;
  const hits = localSearch(q);
  $("matches").replaceChildren(...(hits.length ? [el("h3", { text: "Found in your files" }),
    el("ul", {}, hits.map((h) => el("li", {}, citeButton(h.f.name), markWords(h.snippet, h.found))))] : []));
  $("answer-body").replaceChildren(el("p", { class: "wait", text: state.files.length ? "Reading your files…" : "Add a file first, then ask about it." }));
  if (!state.files.length) return;
  $("ask-btn").disabled = true;
  try {
    const out = await postJSON("/api/ask", { question: q });
    const lines = str(out && out.answer).replace(/\*\*/g, "").split(/\n+/).map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
    $("answer-body").replaceChildren(...(lines.length ? lines : ["No answer."]).map(answerLine));
    announce("Answer ready.");
  } catch (err) {
    $("answer-body").replaceChildren(el("p", { class: "wait", text: err.message }));
  } finally {
    $("ask-btn").disabled = false;
  }
}

$("ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("question").value); });
for (const b of $("suggest").querySelectorAll("button")) {
  b.addEventListener("click", () => { $("question").value = b.textContent; ask(b.textContent); });
}
$("answer-close").addEventListener("click", () => { $("answer").hidden = true; });

$("runway-pop").addEventListener("mouseenter", () => clearTimeout(popTimer));
$("runway-pop").addEventListener("mouseleave", schedHide);
$("runway-pop").addEventListener("focusin", () => clearTimeout(popTimer));
document.addEventListener("click", (e) => { if (!$("runway-pop").contains(e.target)) hidePop(true); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("runway-pop").hidden) return;
  const anchor = popAnchor;
  hidePop(true);
  if (anchor) anchor.focus();
});
document.querySelector(".runway-scroll").addEventListener("scroll", () => hidePop(true), { passive: true });
window.addEventListener("resize", () => hidePop(true));

// "/" jumps to the search box
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  $("question").focus();
});

// ---------- header actions ----------

$("export").addEventListener("click", (e) => {
  if (!state.items.some((i) => i.date)) {
    e.preventDefault();
    announce("Nothing with a date to export yet.");
    alert("Nothing with a date to export yet. Add a file first.");
  }
});

$("reset").addEventListener("click", async () => {
  if (state.running) { alert("Please wait until the files are read."); return; }
  if (!confirm("Remove all files and start again?")) return;
  try {
    applyState(await api("/api/reset", { method: "POST" }));
  } catch (err) {
    alert(err.message);
    return;
  }
  state.queue = [];
  state.filter = "all";
  state.open.clear();
  state.closed.clear();
  $("answer").hidden = true;
  $("question").value = "";
  renderQueue();
  render();
  announce("Everything was cleared.");
});

// ---------- start ----------

for (const holder of document.querySelectorAll("[data-icon]")) holder.prepend(icon(holder.dataset.icon));

(async function start() {
  try {
    const info = await api("/api/info");
    if (info && parseDate(info.demo_date)) DEMO_DATE = info.demo_date;
    if (info && info.model) $("model-name").textContent = `Gemma 4 (${info.model})`;
  } catch (err) { /* keep defaults */ }
  $("demo-date").textContent = parseDate(DEMO_DATE).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  try {
    applyState(await api("/api/state"));
  } catch (err) {
    $("files").replaceChildren(el("p", { class: "empty-note", text: err.message }));
  }
  render();
})();
