// Session Inspector — UI. Virtualized transcript + weight map + benchmark.
// Zero dependencies. Reads session files strictly read-only (File API).

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const state = {
  meta: null,
  offsets: null,
  lengths: null,
  roles: null,
  count: 0,
  scrollTop: 0,
  rowHeight: 28,
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function fmtTime(ts) {
  return ts ? new Date(ts).toISOString().slice(11, 19) : "—";
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── file intake ─────────────────────────────────────────────────────────────
$("drop").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => e.target.files[0] && openFile(e.target.files[0]));
["dragover", "dragenter"].forEach((ev) =>
  $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); })
);
$("drop").addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) openFile(f);
});

function openFile(file) {
  worker.postMessage({ type: "open", file });
  $("status").textContent = "Parsing " + file.name + "…";
}

// ── worker responses ────────────────────────────────────────────────────────
worker.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "ready": {
      state.meta = msg.meta;
      state.offsets = msg.offsets;
      state.lengths = msg.lengths;
      state.roles = msg.roles;
      state.count = msg.meta.entries;
      renderHeader();
      renderTotals();
      renderWeightMap();
      renderList();
      break;
    }
    case "entry-content": {
      const raw = msg.raw;
      const parsed = raw ? formatEntry(raw) : "(unavailable)";
      $("detail").innerHTML =
        `<div class="detail-head"><button onclick="closeDetail()">× close</button>` +
        `<span class="muted">${raw ? fmtBytes(raw.length) : ""}</span></div>` +
        `<pre>${escapeHtml(parsed)}</pre>`;
      break;
    }
    case "search": {
      const hits = msg.hits;
      $("search-results").innerHTML =
        hits.length === 0
          ? `<p class="muted">No matches for “${escapeHtml(msg.needle)}”.</p>`
          : hits
              .map(
                (h) =>
                  `<button class="hit" onclick="jumpTo(${h.index})"><span class="muted">#${h.index}</span> ${escapeHtml(h.snippet)}</button>`
              )
              .join("");
      break;
    }
    case "benchmark": {
      const r = msg.result;
      const rows = [
        ["Parse + index", r.parseMs, "ms"],
        ["Type totals", r.totalsMs, "ms"],
        ["Payload estimate", r.payloadMs, "ms"],
        ["Payload (full)", r.payload.fullKB, "KB"],
        ["Payload (clamped)", r.payload.clampedKB, "KB"],
        ["Clamped messages", r.payload.clampedCount, ""],
        ["Messages", r.messages, ""],
      ];
      $("benchmark-body").innerHTML = rows
        .map(([k, v, u]) => `<tr><td>${k}</td><td class="num">${v}</td><td>${u}</td></tr>`)
        .join("");
      $("heaviest").innerHTML = r.heaviest
        .map(
          (h, i) =>
            `<li><button onclick="jumpTo(${h.index})">${i + 1}. <b>${escapeHtml(h.role ?? "?")}</b> ${fmtBytes(h.bytes)} @ ${fmtTime(h.ts)}</button></li>`
        )
        .join("");
      break;
    }
    case "error":
      $("status").textContent = "Error: " + msg.message;
      break;
  }
};

function formatEntry(raw) {
  try {
    const e = JSON.parse(raw);
    const m = e.message ?? {};
    const content = Array.isArray(m.content)
      ? m.content
          .map((b) => {
            if (b?.type === "text") return b.text;
            if (b?.type === "thinking") return "⏳ " + (b.thinking ?? "");
            if (b?.type === "image") return `[image ${fmtBytes((b.data ?? b.source?.data ?? "").length)}]`;
            return JSON.stringify(b);
          })
          .join("\n")
      : String(m.content ?? "");
    const out = typeof m.output === "string" ? "\n\n── output ──\n" + m.output : "";
    const details = m.details ? "\n\n── details ──\n" + JSON.stringify(m.details).slice(0, 2000) : "";
    return `${e.type} · ${m.role ?? ""} · ${e.timestamp ?? ""}\n\n${content}${out}${details}`;
  } catch {
    return raw;
  }
}

// ── rendering ───────────────────────────────────────────────────────────────
function renderHeader() {
  const m = state.meta;
  $("status").textContent =
    `${m.name} · ${fmtBytes(m.size)} · ${m.entries} lines · ${m.messages} messages · parse ${m.parseMs} ms · payload ${fmtBytes(m.payload.fullKB * 1024)} → clamped ${fmtBytes(m.payload.clampedKB * 1024)}`;
}
function renderTotals() {
  const t = state.meta.totals;
  $("totals").innerHTML = ["text", "thinking", "image", "toolResult", "other"]
    .map((k) => `<div class="tcard"><b>${fmtBytes(t[k] ?? 0)}</b><span>${k}</span></div>`)
    .join("");
}
function renderWeightMap() {
  const canvas = $("weightmap");
  const n = state.count;
  if (!n) return;
  const W = (canvas.width = canvas.clientWidth);
  const H = (canvas.height = 44);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const colors = { toolResult: "#c5433e", image: "#a96d18", text: "#2563c7", thinking: "#6f6f6b", other: "#9a9a95" };
  const step = Math.max(1, Math.ceil(n / W));
  let maxBytes = 0;
  for (let i = 0; i < n; i += step) {
    const b = state.lengths[i] ?? 0;
    if (b > maxBytes) maxBytes = b;
  }
  if (!maxBytes) return;
  for (let x = 0; x < W; x++) {
    let peak = 0, type = "other";
    for (let i = x * step; i < Math.min(n, (x + 1) * step); i++) {
      const b = state.lengths[i] ?? 0;
      if (b > peak) { peak = b; type = roleType(state.roles[i]); }
    }
    if (peak > 0) {
      const h = Math.max(2, (Math.log2(peak) / Math.log2(maxBytes)) * H);
      ctx.fillStyle = colors[type] ?? colors.other;
      ctx.fillRect(x, H - h, 1, h);
    }
  }
}
function roleType(role) {
  if (role === "toolResult") return "toolResult";
  if (role === "user" || role === "assistant") return "text";
  if (role === "thinking") return "thinking";
  if (role === "image") return "image";
  return role ?? "other";
}

// ── virtualized list ────────────────────────────────────────────────────────
const listEl = $("list");
const scrollEl = $("scroll");
scrollEl.addEventListener("scroll", () => {
  state.scrollTop = scrollEl.scrollTop;
  scheduleRender();
});
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderList(); });
}
function renderList() {
  const n = state.count;
  if (!n) return;
  const vh = scrollEl.clientHeight;
  const total = n * state.rowHeight;
  const first = Math.max(0, Math.floor(state.scrollTop / state.rowHeight) - 20);
  const last = Math.min(n, Math.ceil((state.scrollTop + vh) / state.rowHeight) + 20);
  listEl.style.height = total + "px";
  listEl.innerHTML = "";
  for (let i = first; i < last; i++) {
    const row = document.createElement("button");
    row.className = "row";
    row.style.transform = `translateY(${i * state.rowHeight}px)`;
    const bytes = state.lengths[i] ?? 0;
    row.textContent = `#${i} · ${fmtBytes(bytes)} · ${escapeHtml(String(state.roles[i] ?? ""))}`;
    row.onclick = () => worker.postMessage({ type: "entry-content", index: i });
    listEl.appendChild(row);
  }
}

// search + benchmark
let searchTimer = 0;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (q) worker.postMessage({ type: "search", needle: q });
    else $("search-results").innerHTML = "";
  }, 250);
});
$("bench-btn").addEventListener("click", () => worker.postMessage({ type: "benchmark" }));

window.jumpTo = (index) => {
  scrollEl.scrollTop = index * state.rowHeight;
  renderList();
};
window.closeDetail = () => { $("detail").innerHTML = ""; };
