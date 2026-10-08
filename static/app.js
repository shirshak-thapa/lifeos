"use strict";
// LifeOS front end — "evidence desk".
// Safety: every piece of text that comes from a source (images, PDFs, pastes, AI) is shown with
// textContent / text nodes. innerHTML is only used for our own constant SVG icon paths.

const $ = (id) => document.getElementById(id);
let DEMO_DATE = "2026-10-12"; // replaced by the backend setting from /api/info

const state = {
  items: [],
  selected: null,
  file: null,
  busy: false,
  fresh: new Set(),    // rows changed by the latest upload (one-time highlighter sweep)
  entered: new Set(),  // rows created by the latest upload (slide in)
  demo: [],
};

// ---------- tiny helpers ----------

const ICONS = {
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  file: '<path d="M14 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7.5z"/><path d="M14 3v4.5h4.5M9 13h6M9 16.5h4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8 8.5"/>',
  text: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.2M12 17v.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5V9H9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  branch: '<path d="M7 4v9a4 4 0 0 0 4 4h6"/><path d="m14 14 3 3-3 3"/>',
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || ""; // constant strings only
  return svg;
}

// el("div", {class: "x", text: "hello", onclick: fn}, child, "text child", ...)
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
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid)); // strings become safe text nodes
  }
  return node;
}

const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const isNarrow = () => window.matchMedia("(max-width: 1100px)").matches;

function announce(msg) {
  const live = $("live");
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 40);
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

// ---------- dates (always parsed as LOCAL dates, so they never shift by a day) ----------

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d) ? null : d;
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

function fmtDate(s, long) {
  const d = parseDate(s);
  if (!d) return "No date";
  const opts = long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" };
  return d.toLocaleDateString("en-GB", opts);
}

const byDate = (a, b) =>
  str(a.date || "9999").localeCompare(str(b.date || "9999")) || str(a.time || "99").localeCompare(str(b.time || "99"));

// ---------- the evidence highlighter ----------

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// [start, end] of phrase in text, ignoring case and extra whitespace
function findSpan(phrase, text) {
  const words = str(phrase).trim().split(/\s+/).filter(Boolean);
  if (!words.length || !text) return null;
  const m = new RegExp(words.map(escapeRe).join("\\s+"), "i").exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

function validSpan(span, text) {
  return Array.isArray(span) && span.length === 2 && Number.isInteger(span[0]) && Number.isInteger(span[1]) &&
    span[0] >= 0 && span[0] < span[1] && span[1] <= text.length ? span : null;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAYS = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
const DAYS_FULL = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DATE_RE = new RegExp(
  `\\b(?:(?:this|next|on)\\s+)?(?:(?:${DAYS})\\b,?\\s*)?(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b(?:,?\\s+\\d{4})?` +
  `|(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)\\b)` +
  `|\\b(?:(?:this|next)\\s+)?(?:${DAYS_FULL})\\b|\\b(?:today|tomorrow|tonight)\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "gi");
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/gi;
const PLACE_RE = /\b(?:room|rm|hall|lab|building|block|auditorium)\s+[a-z]?\d+[a-z]?\b/gi;

/** Show text in mono: quote = lime highlighter, date/time/place phrases = cyan underline + tiny label. */
function evidenceText(text, quoteSpan, places, cls) {
  text = str(text);
  const n = text.length;
  const hl = new Uint8Array(n);
  const kind = new Array(n).fill(null);
  const rangeId = new Int32Array(n).fill(-1);
  const starts = new Set();
  const span = validSpan(quoteSpan, text);
  if (span) hl.fill(1, span[0], span[1]);

  let id = 0;
  const mark = (s, e, k) => {
    for (let i = s; i < e; i++) if (kind[i]) return; // skip overlaps
    for (let i = s; i < e; i++) { kind[i] = k; rangeId[i] = id; }
    starts.add(s);
    id++;
  };
  for (const p of places || []) { const sp = findSpan(p, text); if (sp) mark(sp[0], sp[1], "place"); }
  for (const [re, k] of [[DATE_RE, "date"], [TIME_RE, "time"], [PLACE_RE, "place"]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      mark(m.index, m.index + m[0].length, k);
    }
  }

  const box = el("p", { class: cls || "text" });
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && hl[j] === hl[i] && rangeId[j] === rangeId[i]) j++;
    const piece = text.slice(i, j);
    if (!hl[i] && !kind[i]) box.append(piece);
    else {
      const classes = [hl[i] ? "hl" : "", kind[i] ? "ul" : ""].filter(Boolean).join(" ");
      box.append(el("span", { class: classes, "data-label": kind[i] && starts.has(i) ? kind[i] : null, text: piece }));
    }
    i = j;
  }
  return box;
}

// ---------- shared pieces ----------

function rankEl(rank) {
  const r = Math.max(0, Math.min(4, Number(rank) || 0));
  return el("i", { class: "rank", "data-rank": r, title: `Trust rank ${r} of 4`, "aria-label": `rank ${r} of 4` });
}

function chip(cls, label, iconName) {
  return el("span", { class: `chip ${cls}` }, iconName ? icon(iconName) : null, label);
}

function sourcesOf(it) { return Array.isArray(it.sources) ? it.sources : []; }

function statusChips(it) {
  const chips = [];
  if (it.status === "conflict") chips.push(chip("conflict", "Conflict", "alert"));
  if (it.updated) chips.push(chip("updated", "Updated"));
  if (it.parent_id) chips.push(chip("related", "Related", "branch"));
  const srcs = sourcesOf(it);
  if (srcs.length && srcs.every((s) => s.verified)) chips.push(chip("verified", "Verified", "check"));
  else if (srcs.length) chips.push(chip("check", "Check this", "alert"));
  return chips;
}

function primarySource(it) {
  const srcs = sourcesOf(it);
  return srcs[Number(it.date_source) || 0] || srcs[srcs.length - 1] || null;
}

// ---------- timeline ----------

function rowEl(it, depth) {
  const sel = state.selected === it.id;
  const classes = ["row", depth ? "child" : "", sel ? "selected" : "",
    state.fresh.has(it.id) ? "sweep" : "", state.entered.has(it.id) ? "enter" : ""].filter(Boolean).join(" ");
  const parent = it.parent_id ? state.items.find((p) => p.id === it.parent_id) : null;

  const meta = [];
  if (it.status === "conflict" && it.conflict && Array.isArray(it.conflict.options)) {
    meta.push(el("span", { text: it.conflict.options.map((o) => fmtDate(o.date)).join(" or ") + " — not confirmed" }));
  } else {
    if (it.time) meta.push(el("b", { text: it.time }));
    if (it.location) meta.push(el("span", { text: it.location }));
  }
  meta.push(el("span", { text: it.type === "event" ? "event" : "task" }));
  const metaLine = el("div", { class: "row-meta" });
  meta.forEach((m, k) => { if (k) metaLine.append(" · "); metaLine.append(m); });

  const src = primarySource(it);
  const quote = src && str(src.quote) ? el("div", { class: "row-quote" },
    el("span", { class: "src", text: str(src.source_type) }), el("span", { class: "hl", text: str(src.quote).replace(/\s+/g, " ") })) : null;

  return el("div", {
    class: classes, role: "option", tabindex: sel ? "0" : "-1", "aria-selected": sel ? "true" : "false", "data-id": it.id,
    onclick: () => selectItem(it.id, { openTab: true }),
  },
  el("div", { class: "row-top" },
    el("span", { class: "row-title", text: it.title }),
    parent ? el("span", { class: "row-for", text: `For: ${parent.title}` }) : null,
    el("span", { class: "row-chips" }, statusChips(it))),
  metaLine, quote);
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();
  const items = state.items;
  $("empty").hidden = items.length > 0 || state.busy;
  if (state.busy) {
    board.append(el("div", { class: "skeleton", "aria-hidden": "true" }, el("div"), el("div"), el("div")));
  }
  const ids = new Set(items.map((i) => i.id));
  const top = items.filter((i) => !i.parent_id || !ids.has(i.parent_id)).sort(byDate);

  // group top-level items by day; "No date yet" goes last
  const groups = new Map();
  for (const it of top) {
    const key = parseDate(it.date) ? it.date : "none";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "none") - (b === "none") || a.localeCompare(b));

  for (const key of keys) {
    let head;
    if (key === "none") {
      head = el("div", { class: "day-head" }, el("span", { class: "day-num", text: "No date yet" }));
    } else {
      const d = parseDate(key);
      const n = daysFromDemo(key);
      head = el("div", { class: "day-head" },
        el("span", { class: "day-num", text: d.getDate() }),
        el("span", { class: "day-wk", text: d.toLocaleDateString("en-GB", { weekday: "short", month: "short" }) }),
        el("span", { class: `day-rel${n !== null && n >= 0 && n <= 3 ? " soon" : ""}`, text: relLabel(n) }));
    }
    const day = el("div", { class: `day${key === "none" ? " nodate" : ""}` }, head, el("span", { class: "day-node" }));
    const seen = new Set();
    const addTree = (it, depth) => { // parent, then its helper tasks right below it
      if (seen.has(it.id) || depth > 3) return;
      seen.add(it.id);
      day.append(rowEl(it, depth));
      items.filter((c) => c.parent_id === it.id).sort(byDate).forEach((c) => addTree(c, depth + 1));
    };
    groups.get(key).forEach((it) => addTree(it, 0));
    board.append(day);
  }
  // roving tabindex: make sure one row can be reached with Tab
  const rows = board.querySelectorAll(".row");
  if (rows.length && !board.querySelector('.row[tabindex="0"]')) rows[0].setAttribute("tabindex", "0");
}

function selectItem(id, opts) {
  opts = opts || {};
  state.selected = id;
  for (const row of $("board").querySelectorAll(".row")) {
    const on = row.dataset.id === id;
    row.classList.toggle("selected", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
    row.setAttribute("tabindex", on ? "0" : "-1");
    if (on && opts.focus) row.focus();
    if (on && opts.scroll) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  renderEvidence();
  if (opts.openTab && isNarrow()) setTab("evidence");
}

// arrow keys move between rows
$("board").addEventListener("keydown", (e) => {
  const row = e.target.closest && e.target.closest(".row");
  if (!row) return;
  const rows = [...$("board").querySelectorAll(".row")];
  const i = rows.indexOf(row);
  let next = null;
  if (e.key === "ArrowDown") next = rows[i + 1];
  else if (e.key === "ArrowUp") next = rows[i - 1];
  else if (e.key === "Home") next = rows[0];
  else if (e.key === "End") next = rows[rows.length - 1];
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectItem(row.dataset.id, { openTab: true }); return; }
  if (next) { e.preventDefault(); selectItem(next.dataset.id, { focus: true }); }
});

// ---------- evidence panel ----------

function section(title, ...kids) {
  return el("section", { class: "ev-section" }, el("h3", { class: "label", text: title }), kids);
}

function fieldsEl(it) {
  const srcs = sourcesOf(it);
  const verified = srcs.filter((s) => s.verified);
  const inText = (v) => srcs.some((s) => findSpan(v, str(s.source_text) || str(s.quote)));
  const conflict = it.status === "conflict";
  const rows = [
    ["Title", it.title, verified.length > 0],
    ["Type", it.type === "event" ? "Event" : "Task", srcs.length > 0],
    ["Date", it.date ? `${fmtDate(it.date, true)}${conflict ? " (not confirmed)" : ""}` : "", !conflict && verified.some((s) => s.date === it.date) && !!it.date],
    ["Time", it.time, !!it.time && srcs.some((s) => s.time === it.time)],
    ["Place", it.location, !!it.location && inText(it.location)],
  ];
  const dl = el("dl", { class: "fields" });
  for (const [name, value, ok] of rows) {
    dl.append(
      el("dt", { text: name }),
      el("dd", { class: value ? null : "empty-val", text: value || "—" }),
      el("dd", { class: `tick${ok ? "" : " off"}`, title: ok ? "Backed by a source" : "Not backed by a source" }, ok ? icon("check") : "–"));
  }
  return dl;
}

function openLightbox(url, name) {
  const box = $("lightbox");
  $("lightbox-img").src = url;
  $("lightbox-img").alt = name || "Source image";
  if (typeof box.showModal === "function") box.showModal();
  else window.open(url, "_blank", "noopener");
}

function sourceEl(s, it) {
  const kind = str(s.kind) || (/\.(png|jpe?g)$/i.test(str(s.file)) ? "image" : /\.pdf$/i.test(str(s.file)) ? "pdf" : "text");
  const url = str(s.url).startsWith("/") ? s.url : null; // only our own server's links
  const head = el("div", { class: "source-head" },
    icon(kind === "image" ? "image" : kind === "pdf" ? "file" : "text"),
    el("span", { class: "type", text: str(s.source_type) || "Source" }),
    rankEl(s.rank),
    url ? el("a", { class: "file", href: url, target: "_blank", rel: "noopener", text: str(s.file) }) : el("span", { class: "file", text: str(s.file) }),
    s.verified ? chip("verified", "Verified", "check") : chip("check", "Check this", "alert"));

  const text = str(s.source_text);
  const quote = str(s.quote);
  let body;
  if (text) body = evidenceText(text, validSpan(s.quote_span, text) || findSpan(quote, text), [it.location]);
  else if (quote) body = evidenceText(quote, [0, quote.length], [it.location]);
  else body = el("p", { class: "text", text: "(no quote)" });

  const thumb = kind === "image" && url
    ? el("button", { class: "thumb", type: "button", title: "Enlarge", onclick: () => openLightbox(url, s.file) },
      el("img", { src: url, alt: `Source image ${str(s.file)}`, loading: "lazy" }))
    : null;
  const card = el("div", { class: "source" }, head, el("div", { class: "source-body" }, thumb, body));

  // scroll the highlighted quote into view inside long texts
  requestAnimationFrame(() => {
    const m = body.querySelector(".hl");
    if (m && body.scrollHeight > body.clientHeight) {
      body.scrollTop += m.getBoundingClientRect().top - body.getBoundingClientRect().top - 40;
    }
  });
  return card;
}

function conflictEl(it) {
  const c = it.conflict;
  const options = c.options;
  const split = el("div", { class: "split" });
  options.forEach((o, i) => {
    const src = sourcesOf(it)[o.source_index] || sourcesOf(it).find((s) => s.file === o.file) || {};
    const suggested = i === c.suggested;
    const quote = str(src.quote);
    split.append(el("div", { class: `side${suggested ? " suggested" : ""}` },
      el("div", { class: "who" }, str(o.source_type) || "Source", rankEl(o.rank), suggested ? el("span", { class: "sugg", text: "Suggested" }) : null),
      el("div", { class: "big" }, fmtDate(o.date),
        el("small", { text: [o.time, relLabel(daysFromDemo(o.date))].filter(Boolean).join(" · ") })),
      quote ? evidenceText(quote, [0, quote.length], [], "q") : el("p", { class: "q", text: "(no quote)" }),
      el("div", { class: "file", text: str(o.file) }),
      el("button", { class: "choose", type: "button", onclick: (e) => resolveConflict(it.id, i, e.currentTarget) },
        `Choose ${fmtDate(o.date)}`)));
  });
  return el("div", { class: "conflict" },
    el("div", { class: "conflict-head" }, el("strong", { text: "Conflict" }),
      `${options.length} sources disagree on the date. Which one is right?`),
    split);
}

function historyEl(lines) {
  const list = el("ol", { class: "history" });
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = str(line);
    // "Thu 15 Oct 23:59 -> Mon 19 Oct 23:59 (prof_notice.png)"
    const m = /^(.+?) -> (.+?)(?: \(([^()]*)\))?((?: \([^()]*\))*)$/.exec(text);
    if (m) {
      list.append(el("li", {}, el("s", { text: m[1] }), " → ", el("span", { class: "new-val", text: m[2] }), " ",
        m[3] ? el("span", { class: "h-file", text: m[3] }) : null, m[4] || ""));
    } else {
      list.append(el("li", { text }));
    }
  }
  return list;
}

function renderEvidence() {
  const box = $("evidence");
  box.replaceChildren();
  const it = state.items.find((i) => i.id === state.selected);
  if (!it) {
    box.append(el("p", { class: "hint", text: state.items.length ? "Select a row to see where it came from." : "Evidence for each item shows up here." }));
    return;
  }
  box.classList.add("sweep");
  const srcs = sourcesOf(it);
  box.append(
    el("p", { class: "label", text: `${it.type === "event" ? "Event" : "Task"} · evidence` }),
    el("h2", { class: "ev-title", text: it.title }),
    el("div", { class: "ev-chips" }, statusChips(it)));
  if (it.status === "conflict" && it.conflict && Array.isArray(it.conflict.options) && it.conflict.options.length) {
    box.append(conflictEl(it));
  }
  box.append(
    section("Fields", fieldsEl(it)),
    section(`Sources (${srcs.length})`, srcs.map((s) => sourceEl(s, it))),
    section("History", historyEl(it.history)));
}

async function resolveConflict(id, choice, button) {
  for (const b of document.querySelectorAll(".choose")) b.disabled = true;
  try {
    await postJSON("/api/resolve", { item_id: id, choice });
    state.fresh = new Set([id]);
    await loadItems();
    setTimeout(() => state.fresh.clear(), 800);
    const it = state.items.find((i) => i.id === id);
    announce(it ? `Confirmed ${fmtDate(it.date)} for ${it.title}.` : "Conflict resolved.");
  } catch (err) {
    showError(err.message);
    await loadItems();
  }
  if (button) button.disabled = false;
}

// ---------- inbox: file, paste, source type ----------

let thumbUrl = null;

function setFile(f) {
  hideError();
  if (f && !/\.(png|jpe?g|pdf)$/i.test(f.name) && !/^(image\/(png|jpeg)|application\/pdf)$/.test(f.type)) {
    showError("Please use a PNG, JPG or PDF file.");
    f = null;
  }
  state.file = f || null;
  if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }
  $("drop-empty").hidden = !!f;
  $("drop-file").hidden = !f;
  $("drop-clear").hidden = !f;
  if (!f) { $("file").value = ""; return; }
  $("drop-name").textContent = f.name;
  $("drop-size").textContent = `${Math.max(1, Math.round(f.size / 1024))} KB · ${/pdf/i.test(f.type) || /\.pdf$/i.test(f.name) ? "PDF" : "image"}`;
  const isImg = /^image\//.test(f.type);
  $("drop-thumb").hidden = !isImg;
  $("drop-icon").hidden = isImg;
  if (isImg) { thumbUrl = URL.createObjectURL(f); $("drop-thumb").src = thumbUrl; }
}

$("file").addEventListener("change", (e) => setFile(e.target.files && e.target.files[0]));
$("drop-clear").addEventListener("click", () => setFile(null));
const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "dragend"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setFile(f);
});
// don't let the browser open a file that misses the drop zone
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Ctrl+V a screenshot anywhere -> it goes into the drop zone
document.addEventListener("paste", (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\/(png|jpeg)$/.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  const f = files[0];
  const ext = f.type === "image/png" ? "png" : "jpg";
  setFile(new File([f], `pasted_screenshot.${ext}`, { type: f.type }));
  if (isNarrow()) setTab("inbox");
  announce("Screenshot added to the drop zone. Choose where it is from, then press Process.");
});

const sourceType = () => (document.querySelector('input[name="source"]:checked') || {}).value || "note";
function setSourceType(value) {
  const input = document.querySelector(`input[name="source"][value="${value}"]`);
  if (input) input.checked = true;
}

// ---------- processing ----------

let timer = null;
const STAGES = [0, 3, 7, 11]; // estimated start (seconds) of Reading, Extracting, Matching, Verifying

function setBusy(on) {
  state.busy = on;
  $("process").disabled = on;
  $("process").textContent = on ? "Working…" : "Process";
  for (const b of document.querySelectorAll(".demo-steps button")) b.disabled = on;
  const bar = $("progress");
  const steps = [...$("stepper").querySelectorAll("li:not(.elapsed)")];
  clearInterval(timer);
  if (on) {
    bar.className = "progress";
    void bar.offsetWidth; // restart the animation
    bar.className = "progress on";
    $("stepper").hidden = false;
    const start = performance.now();
    const tick = () => {
      const s = (performance.now() - start) / 1000;
      $("elapsed").textContent = `${s.toFixed(1)}s`;
      const stage = STAGES.filter((t) => s >= t).length - 1;
      steps.forEach((li, k) => { li.className = k < stage ? "done" : k === stage ? "active" : ""; });
    };
    tick();
    timer = setInterval(tick, 100);
  } else {
    bar.className = "progress done";
    steps.forEach((li) => { li.className = "done"; });
  }
  renderBoard();
}

const KIND_LABELS = { new: "New", same: "Merged", update: "Updated", conflict: "Conflict", related: "Related" };
const KIND_CLASS = { new: "new", same: "same", update: "updated", conflict: "conflict", related: "related" };

async function afterResult(out) {
  out = out || {};
  state.items = Array.isArray(out.items) ? out.items : state.items;
  const changes = Array.isArray(out.changes) ? out.changes : [];
  const results = $("results");
  results.replaceChildren();
  $("log").replaceChildren(...(Array.isArray(out.log) ? out.log : []).map((l) => el("li", { text: l })));
  if (out.backup_used) $("log").append(el("li", { text: `Main model unavailable, used backup ${str(out.model)}.` }));

  let summary;
  if (out.duplicate) {
    results.append(chip("dup", "Already added"));
    summary = `Already added: ${str(out.file)}. Nothing changed.`;
  } else {
    const counts = {};
    changes.forEach((c) => { counts[c.kind] = (counts[c.kind] || 0) + 1; });
    for (const k of Object.keys(KIND_LABELS)) {
      if (counts[k]) results.append(el("span", { class: `chip ${KIND_CLASS[k]}` }, el("span", { class: "num", text: counts[k] }), KIND_LABELS[k]));
    }
    summary = changes.length
      ? `Processed ${str(out.file)}: ` + Object.keys(counts).map((k) => `${counts[k]} ${KIND_LABELS[k].toLowerCase()}`).join(", ") + "."
      : "No tasks or events found.";
    if (!changes.length) results.append(chip("dup", "Nothing found"));
  }

  state.fresh = new Set(changes.map((c) => c.item_id));
  state.entered = new Set(changes.filter((c) => c.kind === "new" || c.kind === "related").map((c) => c.item_id));
  const focus = changes.find((c) => c.kind === "conflict") || changes.find((c) => c.kind === "update") || changes[0];
  if (focus) state.selected = focus.item_id;
  setFile(null);
  $("text").value = "";
  renderAll();
  setTimeout(() => { state.fresh.clear(); state.entered.clear(); }, 800);
  if (isNarrow()) setTab("timeline");
  if (focus) selectItem(focus.item_id, { scroll: true });
  announce(summary);
}

async function runJob(request) {
  if (state.busy) return;
  hideError();
  $("results").replaceChildren();
  $("log").replaceChildren();
  setBusy(true);
  try {
    const out = await request();
    setBusy(false);
    await afterResult(out);
  } catch (err) {
    setBusy(false);
    showError(err.message);
    announce(err.message);
    if (isNarrow()) setTab("inbox");
  }
}

$("process").addEventListener("click", () => {
  const text = $("text").value.trim();
  if (!state.file && !text) { showError("Choose a file, paste a screenshot, or paste some text first."); return; }
  const form = new FormData();
  form.append("source_type", sourceType());
  if (state.file) form.append("file", state.file, state.file.name);
  else form.append("text", text);
  runJob(() => api("/api/process", { method: "POST", body: form }));
});

function showError(msg) { $("error").textContent = msg || "Something went wrong."; $("error").hidden = false; }
function hideError() { $("error").hidden = true; $("error").textContent = ""; }

// ---------- demo story ----------

function renderDemo() {
  const list = $("demo-steps");
  list.replaceChildren();
  if (!state.demo.length) { $("demo").hidden = true; return; }
  $("demo").hidden = false;
  const files = new Set(state.items.flatMap((i) => sourcesOf(i).map((s) => s.file)));
  let n = 1;
  state.demo.forEach((step, k) => {
    const done = files.has(step.file);
    list.append(el("li", { class: done ? "done" : null }, el("button", {
      type: "button", disabled: state.busy, title: `Process ${str(step.file)} as ${str(step.source_label)}`,
      onclick: () => { setSourceType(step.source_type); runJob(() => api(`/api/demo/${Number(step.step)}`, { method: "POST" })); },
    }, el("span", { class: "n", text: done ? "✓" : n }), el("span", { class: "f", text: step.file }),
    el("span", { class: "x", text: `${str(step.source_label)} — ${str(step.expect)}` }))));
    n++;
    if (k === 3) { // the "ask" moment of the story, between the note and the professor's notice
      const q = "What do I need to do before Tuesday?";
      list.append(el("li", {}, el("button", { type: "button", onclick: () => { $("question").value = q; ask(q); } },
        el("span", { class: "n", text: n }), el("span", { class: "f", text: "Ask the list" }), el("span", { class: "x", text: q }))));
      n++;
    }
  });
}

// ---------- ask ----------

function linkify(line) {
  // item titles and source file names in the answer become chips that select the row
  const terms = [];
  for (const it of state.items) {
    if (str(it.title).length >= 3) terms.push({ term: it.title, id: it.id, file: false });
    for (const s of sourcesOf(it)) if (str(s.file).length >= 3) terms.push({ term: s.file, id: it.id, file: true });
  }
  const seen = new Set();
  const uniq = terms.filter((t) => { const k = t.term.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.term.length - a.term.length);
  const p = el("p");
  if (!uniq.length) { p.textContent = line; return p; }
  const re = new RegExp(uniq.map((t) => escapeRe(t.term)).join("|"), "gi");
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    const hit = uniq.find((t) => t.term.toLowerCase() === m[0].toLowerCase());
    p.append(line.slice(last, m.index));
    p.append(el("button", { type: "button", class: `ref${hit.file ? " file" : ""}`, text: m[0],
      onclick: () => { if (isNarrow()) setTab("timeline"); selectItem(hit.id, { scroll: true, focus: !isNarrow() }); } }));
    last = m.index + m[0].length;
  }
  p.append(line.slice(last));
  return p;
}

async function ask(q) {
  q = str(q).trim();
  if (!q) return;
  const body = $("answer-body");
  $("answer").hidden = false;
  body.replaceChildren(el("p", { class: "wait", text: "Reading your list…" }));
  try {
    const out = await postJSON("/api/ask", { question: q });
    const lines = str(out && out.answer).split(/\n+/).map((l) => l.trim()).filter(Boolean);
    body.replaceChildren(...(lines.length ? lines : ["No answer."]).map((l) => linkify(l.replace(/^[-*•]\s*/, ""))));
    announce("Answer ready.");
  } catch (err) {
    body.replaceChildren(el("p", { class: "wait", text: err.message }));
  }
}

$("ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("question").value); });
for (const b of $("examples").querySelectorAll("button")) {
  b.addEventListener("click", () => { $("question").value = b.textContent; ask(b.textContent); });
}
$("answer-close").addEventListener("click", () => { $("answer").hidden = true; });

// ---------- tabs, lightbox, reset ----------

function setTab(name) { document.body.dataset.tab = name; }
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));

$("lightbox").addEventListener("click", () => $("lightbox").close());

$("reset").addEventListener("click", async () => {
  if (state.busy || !confirm("Clear all items and start the demo again?")) return;
  try {
    await api("/api/reset", { method: "POST" });
  } catch (err) {
    showError(err.message);
    return;
  }
  state.items = [];
  state.selected = null;
  state.fresh.clear();
  state.entered.clear();
  setFile(null);
  hideError();
  $("text").value = "";
  $("question").value = "";
  $("answer").hidden = true;
  $("results").replaceChildren();
  $("log").replaceChildren();
  $("stepper").hidden = true;
  $("progress").className = "progress";
  setSourceType("classmate");
  setTab("timeline");
  renderAll();
  announce("Demo reset. The list is empty.");
});

// ---------- start ----------

function renderAll() {
  if (state.selected && !state.items.some((i) => i.id === state.selected)) state.selected = null;
  if (!state.selected && state.items.length) {
    const first = state.items.find((i) => i.status === "conflict") || [...state.items].sort(byDate)[0];
    state.selected = first.id;
  }
  renderBoard();
  renderEvidence();
  renderDemo();
}

async function loadItems() {
  try {
    const items = await api("/api/items");
    state.items = Array.isArray(items) ? items : [];
  } catch (err) {
    showError(err.message);
  }
  renderAll();
}

for (const holder of document.querySelectorAll("[data-icon]")) holder.prepend(icon(holder.dataset.icon));

(async function start() {
  try {
    const info = await api("/api/info");
    if (info && parseDate(info.demo_date)) DEMO_DATE = info.demo_date;
    if (info && info.model) $("model-name").textContent = info.model;
  } catch (err) { /* keep defaults */ }
  try {
    const steps = await api("/api/demo");
    state.demo = Array.isArray(steps) ? steps : [];
  } catch (err) { state.demo = []; }
  await loadItems();
})();
