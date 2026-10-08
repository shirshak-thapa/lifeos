// LifeOS front end: talks to the FastAPI backend and draws the board.
const $ = (id) => document.getElementById(id);
let DEMO_DATE = "2026-10-12";
let chosenFile = null;

// Safe text for HTML
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function niceDate(d) {
  if (!d) return "No date";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// red = within 3 days of the demo date, yellow = within 7, green = later, grey = no date
function dotColor(d) {
  if (!d) return "grey";
  const days = (new Date(d) - new Date(DEMO_DATE)) / 86400000;
  return days <= 3 ? "red" : days <= 7 ? "yellow" : "green";
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ---------- board ----------
function card(item, all) {
  const parent = all.find((i) => i.id === item.parent_id);
  const meta = [niceDate(item.date), item.time, item.location].filter(Boolean).join(" · ");
  let conflict = "";
  if (item.status === "conflict" && item.conflict) {
    const c = item.conflict;
    conflict = `<div class="conflict"><strong>⚠ Conflict:</strong> sources disagree on the date. Which one is right?
      <div class="choices">${c.options.map((o, i) => `
        <button class="${i === c.suggested ? "suggested" : ""}" onclick="resolve('${item.id}', ${i})">
          ${esc(niceDate(o.date))}${o.time ? " " + esc(o.time) : ""} — ${esc(o.source_type)} (${esc(o.file)})${i === c.suggested ? " ✓ suggested" : ""}
        </button>`).join("")}</div></div>`;
  }
  const sources = item.sources.map((s) => `<li>
      <b>${esc(s.source_type)}</b> · <a href="${esc(s.url)}" target="_blank">${esc(s.file)}</a>
      <span class="tag ${s.verified ? "ok" : "check"}">${s.verified ? "verified" : "check this"}</span>
      <span class="quote">“${esc(s.quote)}”</span></li>`).join("");
  const history = item.history.map((h) => `<li>${esc(h)}</li>`).join("");
  return `<div class="card ${parent ? "child" : ""}">
    <h3><span class="dot ${dotColor(item.date)}"></span>${esc(item.title)} <span class="type">${esc(item.type)}</span></h3>
    ${parent ? `<p class="for">For: ${esc(parent.title)}</p>` : ""}
    <p class="meta">${esc(meta)}</p>
    ${conflict}
    <details><summary>Sources (${item.sources.length})</summary><ul>${sources}</ul></details>
    <details><summary>History (${item.history.length})</summary><ul>${history}</ul></details>
  </div>`;
}

async function loadBoard() {
  const items = await api("/api/items");
  const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");
  const top = items.filter((i) => !i.parent_id).sort(byDate);
  // each helper task is shown right below its parent
  const ordered = top.flatMap((p) => [p, ...items.filter((c) => c.parent_id === p.id).sort(byDate)]);
  $("board").innerHTML = ordered.length
    ? ordered.map((i) => card(i, items)).join("")
    : `<p class="empty">Nothing here yet. Drop a screenshot, PDF or text on the left.</p>`;
}

async function resolve(id, choice) {
  await api("/api/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item_id: id, choice }) });
  loadBoard();
}

// ---------- drop zone ----------
function pickFile(f) {
  chosenFile = f;
  $("drop-text").innerHTML = f ? `📄 ${esc(f.name)}<br><small>click to change</small>` : "Drop an image or PDF here<br><small>or click to choose</small>";
}
$("file").onchange = (e) => pickFile(e.target.files[0]);
$("drop").ondragover = (e) => { e.preventDefault(); $("drop").classList.add("over"); };
$("drop").ondragleave = () => $("drop").classList.remove("over");
$("drop").ondrop = (e) => { e.preventDefault(); $("drop").classList.remove("over"); pickFile(e.dataTransfer.files[0]); };

$("process").onclick = async () => {
  const form = new FormData();
  form.append("source_type", $("source").value);
  if (chosenFile) form.append("file", chosenFile);
  else form.append("text", $("text").value);

  const start = Date.now();
  const timer = setInterval(() => ($("status").textContent = `Gemma is reading and organizing… ${((Date.now() - start) / 1000).toFixed(0)}s`), 250);
  $("process").disabled = true;
  $("status").className = "status";
  try {
    const out = await api("/api/process", { method: "POST", body: form });
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    $("status").textContent = `Done in ${secs}s` + (out.backup_used ? ` (main model failed, used backup ${out.model})` : "");
    $("log").innerHTML = out.log.map((l) => `<li>${esc(l)}</li>`).join("");
    pickFile(null);
    $("file").value = "";
    $("text").value = "";
    loadBoard();
  } catch (err) {
    $("status").textContent = err.message;
    $("status").className = "status error";
  } finally {
    clearInterval(timer);
    $("process").disabled = false;
  }
};

// ---------- ask box ----------
$("ask-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("question").value.trim();
  if (!q) return;
  $("answer").hidden = false;
  $("answer").textContent = "Thinking…";
  try {
    const out = await api("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
    $("answer").textContent = out.answer;
  } catch (err) {
    $("answer").textContent = err.message;
  }
};

$("reset").onclick = async () => {
  if (!confirm("Clear all items?")) return;
  await api("/api/reset", { method: "POST" });
  $("answer").hidden = true;
  $("log").innerHTML = "";
  loadBoard();
};

// ---------- start ----------
api("/api/info").then((info) => {
  DEMO_DATE = info.demo_date;
  $("badge").textContent = `Powered by ${info.model} · open-weight model via Gemini API`;
});
loadBoard();
