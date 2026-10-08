"use strict";
// LifeOS front end.
// Safety: all text that comes from files or from the AI is shown with textContent / text nodes, never innerHTML.

const $ = (id) => document.getElementById(id);
let DEMO_DATE = "2026-10-12"; // replaced by the backend setting from /api/info

const state = {
  files: [],
  items: [],
  queue: [],            // files waiting / being read
  running: false,
  open: new Set(),      // plan items the user expanded
  closed: new Set(),    // conflict items the user collapsed
  flash: new Set(),     // plan items changed by the latest file
  flashFile: null,
};

// ---------- helpers ----------

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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
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

function scrollToFile(fileId) {
  const card = document.querySelector(`.file[data-id="${CSS.escape(str(fileId))}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

function scrollToItem(itemId) {
  const row = document.querySelector(`.item[data-id="${CSS.escape(str(itemId))}"]`);
  if (!row) return;
  row.open = true;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

// ---------- plan ----------

const RESULT_TEXT = { new: "new", same: "merged", update: "updated", conflict: "conflict", related: "linked" };

function historyLine(line) {
  // "Thu 15 Oct 23:59 -> Mon 19 Oct 23:59 (prof_notice.png)"
  const m = /^(.+?) -> (.+?)(?: \(([^()]*)\))?((?: \([^()]*\))*)$/.exec(str(line));
  if (!m) return el("li", { text: line });
  return el("li", {}, el("s", { text: m[1] }), " → ", el("span", { class: "now", text: m[2] }),
    m[3] ? ` (${m[3]})` : "", m[4] || "");
}

function conflictEl(it) {
  const c = it.conflict;
  const msg = el("p", { text: "Your files disagree on the date. Which one is right?" });
  const choices = el("div", { class: "choices" });
  c.options.forEach((o, i) => {
    const suggested = i === c.suggested;
    choices.append(el("button", {
      type: "button", class: `choice${suggested ? " suggested" : ""}`,
      onclick: () => resolveConflict(it.id, i, choices, msg),
    }, el("b", { text: when(o.date, o.time) }),
    el("span", { text: `${str(o.source_type)} · ${str(o.file)}${suggested ? " · suggested" : ""}` })));
  });
  return el("div", { class: "conflict-box" }, msg, choices);
}

async function resolveConflict(id, choice, box, msg) {
  for (const b of box.querySelectorAll("button")) b.disabled = true;
  try {
    applyState(await postJSON("/api/resolve", { item_id: id, choice }));
    state.flash = new Set([id]);
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
  if (srcs.some((s) => !s.verified)) tags.append(el("span", { class: "tag unverified", text: "Check quote" }));

  const meta = conflict
    ? [`${it.conflict.options.map((o) => fmtDate(o.date)).join(" or ")}, not confirmed`]
    : [timeRange(it.time, it.end_time), it.location, it.type === "event" ? "Event" : "Task"];

  const summary = el("summary", {},
    el("span", { class: "item-title", text: it.title }), tags,
    parent ? el("span", { class: "item-for", text: `For: ${parent.title}` }) : null,
    el("span", { class: "item-meta", text: meta.filter(Boolean).join(" · ") }));

  const href = safeHref(it.link);
  const body = el("div", { class: "item-body" },
    href ? el("p", {}, "Link: ", el("a", { href, target: "_blank", rel: "noopener", text: it.link })) : null,
    el("h4", { text: "Found in" }),
    el("ul", {}, srcs.map((s) => el("li", {},
      el("button", { type: "button", class: "cite", text: str(s.file), onclick: () => scrollToFile(s.file_id) }), " ",
      str(s.source_type), s.quote ? ": " : "", s.quote ? el("q", { text: str(s.quote).replace(/\s+/g, " ") }) : null,
      s.verified ? "" : " (this quote was not found word for word in the file; please check it)"))),
    el("h4", { text: "History" }),
    el("ol", {}, (Array.isArray(it.history) ? it.history : []).map(historyLine)));

  const d = el("details", { class: `item${depth ? " child" : ""}${state.flash.has(it.id) ? " flash" : ""}`, "data-id": it.id },
    summary, conflict ? conflictEl(it) : null, body);
  d.open = state.open.has(it.id) || (conflict && !state.closed.has(it.id));
  d.addEventListener("toggle", () => {
    if (d.open) { state.open.add(it.id); state.closed.delete(it.id); }
    else { state.open.delete(it.id); if (conflict) state.closed.add(it.id); }
  });
  return d;
}

function renderPlan() {
  const box = $("plan");
  box.replaceChildren();
  const items = state.items;
  $("plan-count").textContent = items.length ? String(items.length) : "";
  if (!items.length) {
    box.append(el("p", { class: "empty-note", text: "Tasks and events from your files will show up here, in date order." }));
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
  for (const key of keys) {
    const n = key === "none" ? null : daysFromDemo(key);
    const day = el("div", { class: "day" }, el("div", { class: "day-head" },
      el("span", { class: "day-date", text: key === "none" ? "No date yet" : fmtDate(key) }),
      el("span", { class: `day-rel${n !== null && n >= 0 && n <= 3 ? " soon" : ""}`, text: relLabel(n) })));
    const seen = new Set();
    const addTree = (it, depth) => { // an item, then its helper tasks right below it
      if (seen.has(it.id) || depth > 3) return;
      seen.add(it.id);
      day.append(itemEl(it, depth));
      items.filter((c) => c.parent_id === it.id).sort(byDate).forEach((c) => addTree(c, depth + 1));
    };
    groups.get(key).forEach((it) => addTree(it, 0));
    box.append(day);
  }
}

// ---------- files ----------

function resultText(fact) {
  const it = state.items.find((i) => i.id === fact.item_id);
  const title = it ? `“${it.title}”` : "your plan";
  switch (fact.result) {
    case "same": return { text: `Matches ${title} in your plan`, cls: "" };
    case "update": return { text: `Changed the date of ${title}`, cls: "res-update" };
    case "conflict":
      return it && it.status === "conflict"
        ? { text: `Disagrees with ${title}: choose a date in your plan`, cls: "res-conflict" }
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

function fileEl(f) {
  const kind = str(f.kind);
  const url = str(f.url).startsWith("/") ? f.url : null; // only links to our own server
  const thumb = el("a", { class: "thumb", href: url, target: "_blank", rel: "noopener", "aria-label": `Open ${str(f.name)}` },
    kind === "image" && url ? el("img", { src: url, alt: "", loading: "lazy" }) : (kind === "pdf" ? "PDF" : "TXT"));
  const kindText = kind === "pdf" ? (f.pages > 1 ? `PDF, ${f.pages} pages` : "PDF") : kind === "image" ? "Image" : "Text";
  const head = el("div", { class: "file-head" }, thumb, el("div", {},
    el("p", { class: "file-name" }, url ? el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }) : str(f.name)),
    el("p", { class: "file-meta", text: [str(f.source_label), kindText, f.seconds ? `read in ${f.seconds}s` : ""].filter(Boolean).join(" · ") })));

  const facts = Array.isArray(f.facts) ? f.facts : [];
  const factList = facts.length
    ? el("ul", { class: "facts" }, facts.map((x) => {
      const res = resultText(x);
      const href = safeHref(x.link);
      const more = el("p", { class: "fact-more" });
      const parts = [x.location ? str(x.location) : null,
        href ? el("a", { href, target: "_blank", rel: "noopener", text: x.link }) : null,
        el("button", { type: "button", class: `link ${res.cls}`, text: res.text, onclick: () => scrollToItem(x.item_id) }),
        x.verified ? null : "quote not found word for word, please check"].filter(Boolean);
      parts.forEach((p, k) => { if (k) more.append(" · "); more.append(p); });
      return el("li", {},
        el("div", { class: "fact-main" }, el("mark", { class: "fact-when", text: when(x.date, x.time, x.end_time) }),
          el("span", { class: "fact-title", text: x.title })),
        more);
    }))
    : el("p", { class: "no-facts", text: "No dates or tasks were found in this file." });

  const text = str(f.text);
  const full = el("details", { class: "fulltext" }, el("summary", { text: "Show the text we read" }));
  full.addEventListener("toggle", () => { // build the (possibly long) text only when opened
    if (full.open && full.children.length === 1) full.append(highlightedText(text, facts.map((x) => x.quote_span)));
  }, { passive: true });

  return el("article", { class: `file${state.flashFile === f.id ? " flash" : ""}`, "data-id": f.id },
    head, factList, f.summary ? el("p", { class: "summary", text: f.summary }) : null, text ? full : null);
}

function renderFiles() {
  const box = $("files");
  box.replaceChildren();
  $("files-count").textContent = state.files.length ? String(state.files.length) : "";
  if (!state.files.length) {
    box.append(el("p", { class: "empty-note", text: "Nothing here yet. Add a file above: the key dates and a short summary of each file show up here." }));
    return;
  }
  [...state.files].sort((a, b) => (b.order || 0) - (a.order || 0)).forEach((f) => box.append(fileEl(f)));
}

function applyState(s) {
  if (!s) return;
  state.files = Array.isArray(s.files) ? s.files : [];
  state.items = Array.isArray(s.items) ? s.items : [];
}

function render() {
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
  if (job.status === "busy") return `Reading… ${((performance.now() - job.started) / 1000).toFixed(0)}s`;
  return job.message || "";
}

function renderQueue() {
  $("queue").replaceChildren(...state.queue.map((job) => el("li", { class: job.status },
    el("span", { class: "q-name", text: job.name }), el("span", { class: "q-status", text: statusText(job) }))));
}

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
  timer = setInterval(renderQueue, 500);
  try {
    let job;
    while ((job = state.queue.find((j) => j.status === "waiting"))) {
      job.status = "busy";
      job.started = performance.now();
      renderQueue();
      try {
        let out;
        if (job.sample) {
          out = await api(`/api/samples/${encodeURIComponent(job.sample)}`, { method: "POST" });
        } else {
          const form = new FormData();
          if (job.file) form.append("file", job.file, job.file.name);
          else form.append("text", job.text);
          out = await api("/api/process", { method: "POST", body: form });
        }
        applyState(out.state);
        if (out.duplicate) {
          job.status = "done";
          job.message = "Already added";
        } else {
          job.status = "done";
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

// ---------- adding files: button, drag and drop anywhere, Ctrl+V ----------

$("browse").addEventListener("click", () => $("file-input").click());
$("drop").addEventListener("click", (e) => { if (e.target === $("drop") || e.target.classList.contains("drop-title")) $("file-input").click(); });
$("file-input").addEventListener("change", (e) => {
  if (e.target.files && e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").classList.add("over"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop").classList.remove("over"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").classList.remove("over");
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

$("paste-toggle").addEventListener("click", () => {
  $("paste").hidden = false;
  $("paste-toggle").setAttribute("aria-expanded", "true");
  $("paste-text").focus();
});
$("paste-cancel").addEventListener("click", () => {
  $("paste").hidden = true;
  $("paste-toggle").setAttribute("aria-expanded", "false");
});
$("paste").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("paste-text").value.trim();
  if (!text) { $("paste-text").focus(); return; }
  enqueue([{ name: "Pasted text", text }]);
  $("paste-text").value = "";
  $("paste").hidden = true;
  $("paste-toggle").setAttribute("aria-expanded", "false");
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
  state.open.clear();
  state.closed.clear();
  $("answer").hidden = true;
  $("question").value = "";
  renderQueue();
  render();
  announce("Everything was cleared.");
});

// ---------- start ----------

(async function start() {
  try {
    const info = await api("/api/info");
    if (info && parseDate(info.demo_date)) DEMO_DATE = info.demo_date;
    if (info && info.model) $("model-name").textContent = `Gemma 4 (${info.model})`;
  } catch (err) { /* keep defaults */ }
  const demo = parseDate(DEMO_DATE);
  $("demo-date").textContent = demo.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  try {
    applyState(await api("/api/state"));
  } catch (err) {
    $("files").replaceChildren(el("p", { class: "empty-note", text: err.message }));
  }
  render();
  try {
    const names = await api("/api/samples");
    if (Array.isArray(names) && names.length) {
      $("sample-list").replaceChildren(...names.map((name, i) => el("button", {
        type: "button", class: "link", text: `${i + 1}. ${name}`, onclick: () => enqueue([{ name, sample: name }]),
      })));
      $("samples").hidden = false;
    }
  } catch (err) { /* samples are optional */ }
})();
