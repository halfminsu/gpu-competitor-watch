const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const BRIEFINGS = path.join(DOCS, "briefings");
const PUBLIC = path.join(__dirname, "public");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = process.env.PORT || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const RANK = { high: 3, medium: 2, low: 1 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function computeTopImportance(items) {
  let top = "low";
  for (const it of items) {
    if ((RANK[it.importance] || 0) > (RANK[top] || 0)) top = it.importance;
  }
  return top;
}

function listBriefingDates() {
  if (!fs.existsSync(BRIEFINGS)) return [];
  return fs
    .readdirSync(BRIEFINGS)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort((a, b) => (a < b ? 1 : -1));
}

function rebuildIndex() {
  const dates = listBriefingDates();
  const list = dates.map((date) => {
    const b = JSON.parse(fs.readFileSync(path.join(BRIEFINGS, `${date}.json`), "utf8"));
    return {
      date: b.date,
      title: b.title,
      summary: b.summary,
      top_importance: b.top_importance,
      competitors: b.competitors || [],
    };
  });
  fs.mkdirSync(BRIEFINGS, { recursive: true });
  fs.writeFileSync(path.join(BRIEFINGS, "index.json"), JSON.stringify(list, null, 2) + "\n");
  return list;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(baseDir, urlPath, res) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const normalizedBase = path.normalize(baseDir);
  const filePath = path.normalize(path.join(baseDir, rel));
  if (filePath !== normalizedBase && !filePath.startsWith(normalizedBase + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found: " + rel);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function runGit(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

const MS_PER_UNIT = {
  minute: 60000, 분: 60000,
  hour: 3600000, 시간: 3600000,
  day: 86400000, 일: 86400000,
  week: 604800000, 주: 604800000,
  month: 2629800000, 개월: 2629800000,
  year: 31557600000, 년: 31557600000,
};

function parseSerperDate(dateStr, now) {
  if (!dateStr) return "";
  const rel =
    dateStr.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago$/i) ||
    dateStr.match(/^(\d+)\s*(분|시간|일|주|개월|년)\s*전$/);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = MS_PER_UNIT[rel[2].toLowerCase()] || MS_PER_UNIT[rel[2]];
    if (unitMs) return new Date(now.getTime() - n * unitMs).toISOString();
  }
  const parsed = Date.parse(dateStr);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return dateStr; // 파싱 실패 시 원문 그대로 보존
}

function formatGoogleDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function buildFreshnessTbs(now) {
  const yesterday = new Date(now.getTime() - 86400000);
  return `cdr:1,cd_min:${formatGoogleDate(yesterday)},cd_max:${formatGoogleDate(now)}`;
}

async function callSerperNews(query, tbs) {
  const res = await fetch("https://google.serper.dev/news", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, gl: "kr", hl: "ko", tbs }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 150)}`);
  }
  const data = await res.json();
  return Array.isArray(data.news) ? data.news : [];
}

function buildQueries(competitors, keywords) {
  const kws = keywords.length ? keywords : [""];
  const combos = [];
  for (const c of competitors) {
    for (const k of kws) combos.push({ competitor: c, keyword: k, query: k ? `${c} ${k}` : c });
  }
  return combos;
}

// ---- 정적 아카이브(대시보드 스냅샷 + 카드 인덱스) 생성 ----

const IMPORTANCE_LABEL = { high: "상", medium: "중", low: "하" };

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url || "") ? url : "";
}

function badgeHtml(level) {
  const safe = IMPORTANCE_LABEL[level] ? level : "low";
  return `<span class="badge badge-${safe}">${IMPORTANCE_LABEL[safe]}</span>`;
}

function computeMetrics(b) {
  const items = b.items || [];
  const byImportance = { high: 0, medium: 0, low: 0 };
  const byCompetitor = {};
  const byKeyword = {};
  let newCount = 0;
  for (const it of items) {
    if (byImportance[it.importance] !== undefined) byImportance[it.importance]++;
    const comp = it.competitor || "(경쟁사 미지정)";
    byCompetitor[comp] = (byCompetitor[comp] || 0) + 1;
    if (it.keyword) byKeyword[it.keyword] = (byKeyword[it.keyword] || 0) + 1;
    if (it.is_new) newCount++;
  }
  return {
    totalItems: items.length,
    competitorCount: Object.keys(byCompetitor).length,
    newCount,
    byImportance,
    byCompetitor,
    byKeyword,
    highlights: items.filter((it) => it.importance === "high"),
  };
}

function groupByCompetitorServer(b) {
  const order = (b.competitors || []).slice();
  const seen = new Set(order);
  for (const it of b.items || []) {
    const name = it.competitor || "(경쟁사 미지정)";
    if (!seen.has(name)) { seen.add(name); order.push(name); }
  }
  return order.map((name) => ({
    competitor: name,
    items: (b.items || [])
      .filter((it) => (it.competitor || "(경쟁사 미지정)") === name)
      .sort((x, y) => (RANK[y.importance] || 0) - (RANK[x.importance] || 0)),
  }));
}

function barListHtml(entries, colorClassFn) {
  if (!entries.length) return "";
  const max = Math.max(1, ...entries.map((e) => e.value));
  return entries.map(({ label, value }) => {
    const pct = Math.round((value / max) * 100);
    const colorClass = colorClassFn ? colorClassFn(label) : "";
    return `
      <div class="bar-row">
        <div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="bar-track"><div class="bar-fill ${colorClass}" style="width:${pct}%"></div></div>
        <div class="bar-value">${value}</div>
      </div>
    `;
  }).join("");
}

function itemCardHtmlServer(it) {
  const dateStr = it.published_at ? String(it.published_at).slice(0, 10) : "";
  const url = safeUrl(it.url);
  const headline = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(it.headline || "(헤드라인 없음)")}</a>`
    : escapeHtml(it.headline || "(헤드라인 없음)");
  return `
    <div class="item-card">
      <p class="item-headline">${headline} ${badgeHtml(it.importance)}</p>
      <p class="item-byline">
        ${escapeHtml(it.source || "출처 미기재")}${dateStr ? ` · ${escapeHtml(dateStr)}` : ""} · ${escapeHtml(it.keyword)}
        ${it.is_new ? ' · <span class="new-badge">NEW</span>' : ""}
      </p>
      ${it.note ? `<p class="item-note">${escapeHtml(it.note)}</p>` : ""}
    </div>
  `;
}

function pageShell(title, baseCss, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${baseCss}</style>
</head>
<body>
<div class="page">
${bodyHtml}
</div>
</body>
</html>
`;
}

function tickerChipsHtml(entries) {
  if (!entries.length) return '<span class="wl-empty">키워드 데이터가 없습니다.</span>';
  const max = Math.max(...entries.map((e) => e.value));
  const tierOf = (v) => {
    const ratio = v / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  return entries.map(({ label, value }) => `
    <span class="ticker-chip tk-${tierOf(value)}"><span class="tk-word">${escapeHtml(label)}</span><span class="tk-count">×${value}</span></span>
  `).join("");
}

function tickerPanelHtml(label, entries) {
  return `
    <div class="ticker-panel">
      <span class="ticker-label">${escapeHtml(label)}</span>
      <div class="ticker-chips">${tickerChipsHtml(entries)}</div>
    </div>
  `;
}

function watchlistTableHtml(groups) {
  const rows = groups.map((g) => {
    const dist = { high: 0, medium: 0, low: 0 };
    let newCount = 0;
    for (const it of g.items) {
      if (dist[it.importance] !== undefined) dist[it.importance]++;
      if (it.is_new) newCount++;
    }
    const top = g.items[0];
    const topDate = top?.published_at ? String(top.published_at).slice(0, 10) : "";
    const topUrl = top ? safeUrl(top.url) : "";
    const topHeadlineHtml = top
      ? (topUrl
          ? `<a href="${escapeHtml(topUrl)}" target="_blank" rel="noopener">${escapeHtml(top.headline || "(헤드라인 없음)")}</a>`
          : escapeHtml(top.headline || "(헤드라인 없음)")) + (topDate ? `<span class="wl-date">${escapeHtml(topDate)}</span>` : "")
      : '<span class="wl-empty">데이터 없음</span>';
    return `
      <tr>
        <td class="wl-name">${escapeHtml(g.competitor)}</td>
        <td class="wl-count">${g.items.length}</td>
        <td>
          <div class="wl-dist">
            <span class="d-high">상 ${dist.high}</span>
            <span class="d-medium">중 ${dist.medium}</span>
            <span class="d-low">하 ${dist.low}</span>
          </div>
        </td>
        <td class="wl-count">${newCount}</td>
        <td class="wl-headline">${topHeadlineHtml}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="watchlist-table">
      <thead>
        <tr><th>경쟁사</th><th>항목</th><th>중요도 분포</th><th>NEW</th><th>대표 헤드라인</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSnapshotHtml(b, metrics, baseCss) {
  const groups = groupByCompetitorServer(b);

  const keywordTicker = tickerPanelHtml(
    "오늘의 키워드",
    Object.entries(metrics.byKeyword).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }))
  );

  const columnsHtml = groups.map((g) => `
    <div class="competitor-column">
      <div class="competitor-column-header">
        ${escapeHtml(g.competitor)}
        <span class="competitor-count">${g.items.length}건</span>
      </div>
      ${g.items.length ? g.items.map(itemCardHtmlServer).join("") : '<p class="empty-state" style="padding:20px 0;">아직 수집된 항목이 없습니다.</p>'}
    </div>
  `).join("");

  const competitorBars = barListHtml(
    Object.entries(metrics.byCompetitor).map(([label, value]) => ({ label, value }))
  );

  const importanceBars = barListHtml(
    [
      { label: "상", value: metrics.byImportance.high },
      { label: "중", value: metrics.byImportance.medium },
      { label: "하", value: metrics.byImportance.low },
    ],
    (label) => (label === "상" ? "bar-fill-high" : label === "중" ? "bar-fill-medium" : "bar-fill-low")
  );

  const topKeywords = Object.entries(metrics.byKeyword)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));
  const keywordBars = barListHtml(topKeywords);

  const highlightsHtml = metrics.highlights.length
    ? metrics.highlights.map((it) => {
        const dateStr = it.published_at ? String(it.published_at).slice(0, 10) : "";
        const url = safeUrl(it.url);
        const headline = url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(it.headline || "(헤드라인 없음)")}</a>`
          : escapeHtml(it.headline || "(헤드라인 없음)");
        return `
          <div class="highlight-item">
            <p class="highlight-headline">${headline}</p>
            <p class="highlight-byline">
              ${escapeHtml(it.competitor)} · ${escapeHtml(it.source || "출처 미기재")}${dateStr ? ` · ${escapeHtml(dateStr)}` : ""}
            </p>
            ${it.note ? `<p class="highlight-note">${escapeHtml(it.note)}</p>` : ""}
          </div>
        `;
      }).join("")
    : '<p class="empty-state" style="padding:10px 0;">오늘은 "상" 중요도 항목이 없습니다.</p>';

  const body = `
    <a class="back-link" href="../index.html">← 아카이브로</a>
    <div class="detail-header">
      <div class="card-date">${escapeHtml(b.date)} ${badgeHtml(b.top_importance)}</div>
      <h2>${escapeHtml(b.title)}</h2>
      <p class="card-summary">${escapeHtml(b.summary)}</p>
    </div>

    ${keywordTicker}

    <div class="dashboard-section">
      <h3 class="section-title">1. 경쟁사 워치리스트</h3>
      ${groups.length ? watchlistTableHtml(groups) : '<p class="empty-state">등록된 경쟁사가 없습니다.</p>'}
    </div>

    <div class="dashboard-section">
      <h3 class="section-title">2. 정량 분석</h3>
      <div class="stat-tiles">
        <div class="stat-tile"><div class="stat-value">${metrics.totalItems}</div><div class="stat-label">총 항목</div></div>
        <div class="stat-tile"><div class="stat-value">${metrics.competitorCount}</div><div class="stat-label">경쟁사</div></div>
        <div class="stat-tile stat-tile-positive"><div class="stat-value">${metrics.newCount}</div><div class="stat-label">NEW 항목</div></div>
        <div class="stat-tile stat-tile-alert"><div class="stat-value">${metrics.byImportance.high}</div><div class="stat-label">상 중요도</div></div>
      </div>
      <div class="dashboard-grid">
        <div class="dashboard-card">
          <h4 class="subsection-title">경쟁사별 항목 수</h4>
          <div class="bar-list">${competitorBars || '<p class="empty-state" style="padding:10px 0;">데이터 없음</p>'}</div>
        </div>
        <div class="dashboard-card">
          <h4 class="subsection-title">중요도 분포</h4>
          <div class="bar-list">${importanceBars}</div>
        </div>
        <div class="dashboard-card">
          <h4 class="subsection-title">키워드 TOP ${topKeywords.length}</h4>
          <div class="bar-list">${keywordBars || '<p class="empty-state" style="padding:10px 0;">키워드 데이터가 없습니다.</p>'}</div>
        </div>
      </div>
    </div>

    <div class="dashboard-section">
      <h3 class="section-title">3. 정성 분석 — 핵심 헤드라인 (상 중요도)</h3>
      <div class="highlight-list">${highlightsHtml}</div>
    </div>

    <div class="dashboard-section">
      <h3 class="section-title">4. 경쟁사별 상세</h3>
      <div class="competitor-columns">${columnsHtml || '<p class="empty-state">항목이 없습니다.</p>'}</div>
    </div>
  `;

  return pageShell(`${b.title} — 브리핑`, baseCss, body);
}

function aggregateKeywords(cards) {
  const agg = {};
  for (const c of cards) {
    for (const [k, v] of Object.entries(c.metrics.byKeyword || {})) {
      agg[k] = (agg[k] || 0) + v;
    }
  }
  return Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([label, value]) => ({ label, value }));
}

function renderIndexHtml(cards, baseCss) {
  const rowsHtml = cards.map((c) => `
    <a class="watch-row" href="briefings/${c.date}.html" data-rank="${RANK[c.top_importance] || 0}">
      <div class="watch-date">${escapeHtml(c.date)}</div>
      <div class="watch-main">
        <div class="card-title">${escapeHtml(c.title)}</div>
        <div class="card-summary">${escapeHtml(c.summary)}</div>
        <div class="card-metrics">총 ${c.metrics.totalItems}건 · 경쟁사 ${c.metrics.competitorCount} · NEW ${c.metrics.newCount}</div>
        <div class="card-tags">
          ${(c.competitors || []).map((comp) => `<span class="tag">${escapeHtml(comp)}</span>`).join("")}
        </div>
      </div>
      <div class="watch-side">${badgeHtml(c.top_importance)}</div>
    </a>
  `).join("");

  const body = `
    <header class="site-header">
      <h1>GPU 경쟁사 워치 · 아카이브</h1>
      <p>LAST UPDATED: ${escapeHtml(cards[0]?.date || "-")}</p>
    </header>

    ${tickerPanelHtml("최근 화두 키워드", aggregateKeywords(cards))}

    <div class="toolbar">
      <label for="importance-filter">중요도 필터</label>
      <select id="importance-filter">
        <option value="0">전체</option>
        <option value="2">중 이상</option>
        <option value="3">상만</option>
      </select>
    </div>

    <div id="watch-list" class="watch-list">${rowsHtml}</div>
    <div id="empty-state" class="empty-state" style="display:${cards.length ? "none" : "block"};">아직 브리핑이 없습니다.</div>

    <script>
      document.getElementById("importance-filter").addEventListener("change", function (e) {
        var min = Number(e.target.value);
        document.querySelectorAll("#watch-list .watch-row").forEach(function (row) {
          var rank = Number(row.dataset.rank || 0);
          row.style.display = rank >= min ? "" : "none";
        });
      });
    </script>
  `;

  return pageShell("GPU 경쟁사 워치 · 아카이브", baseCss, body);
}

function buildArchive() {
  const baseCss = fs.readFileSync(path.join(DOCS, "assets", "style.css"), "utf8");
  const dates = listBriefingDates();
  const cards = [];
  for (const date of dates) {
    const b = JSON.parse(fs.readFileSync(path.join(BRIEFINGS, `${date}.json`), "utf8"));
    const metrics = computeMetrics(b);
    fs.writeFileSync(path.join(BRIEFINGS, `${date}.html`), renderSnapshotHtml(b, metrics, baseCss));
    cards.push({
      date: b.date,
      title: b.title,
      summary: b.summary,
      top_importance: b.top_importance,
      competitors: b.competitors || [],
      metrics,
    });
  }
  cards.sort((a, b) => (a.date < b.date ? 1 : -1));
  fs.mkdirSync(BRIEFINGS, { recursive: true });
  fs.writeFileSync(path.join(BRIEFINGS, "index.json"), JSON.stringify(cards, null, 2) + "\n");
  fs.writeFileSync(path.join(DOCS, "index.html"), renderIndexHtml(cards, baseCss));
  return cards;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/briefings") {
    const dates = listBriefingDates();
    const list = dates.map((date) => {
      const b = JSON.parse(fs.readFileSync(path.join(BRIEFINGS, `${date}.json`), "utf8"));
      return { date: b.date, title: b.title };
    });
    return sendJson(res, 200, list);
  }

  const detailMatch = url.pathname.match(/^\/api\/briefings\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === "GET" && detailMatch) {
    const file = path.join(BRIEFINGS, `${detailMatch[1]}.json`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
  }

  if (req.method === "POST" && url.pathname === "/api/briefings") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "잘못된 JSON" });
    }
    if (!body.date || !DATE_RE.test(body.date)) {
      return sendJson(res, 400, { error: "date는 YYYY-MM-DD 형식이어야 합니다." });
    }
    if (!body.title) return sendJson(res, 400, { error: "title이 필요합니다." });

    const items = Array.isArray(body.items) ? body.items : [];
    const briefing = {
      date: body.date,
      title: body.title,
      summary: body.summary || "",
      top_importance: computeTopImportance(items),
      competitors: Array.isArray(body.competitors) ? body.competitors : [],
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
      items,
      generated_at: new Date().toISOString(),
    };

    fs.mkdirSync(BRIEFINGS, { recursive: true });
    fs.writeFileSync(
      path.join(BRIEFINGS, `${briefing.date}.json`),
      JSON.stringify(briefing, null, 2) + "\n"
    );
    rebuildIndex();
    return sendJson(res, 200, briefing);
  }

  if (req.method === "POST" && url.pathname === "/api/collect") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "잘못된 JSON" });
    }
    const competitors = Array.isArray(body.competitors) ? body.competitors.filter(Boolean) : [];
    const keywords = Array.isArray(body.keywords) ? body.keywords.filter(Boolean) : [];
    if (!competitors.length) return sendJson(res, 400, { error: "경쟁사를 1개 이상 입력해주세요." });
    if (!process.env.SERPER_API_KEY) {
      return sendJson(res, 500, { error: "SERPER_API_KEY가 설정되어 있지 않습니다 (.env 확인)." });
    }

    const MAX_QUERIES = 12;
    const RESULTS_PER_QUERY = 6;
    let combos = buildQueries(competitors, keywords);
    let notice = null;
    if (combos.length > MAX_QUERIES) {
      notice = `쿼리가 ${combos.length}개라 상위 ${MAX_QUERIES}개만 수집했습니다.`;
      combos = combos.slice(0, MAX_QUERIES);
    }

    const now = new Date();
    const tbs = buildFreshnessTbs(now);
    const items = [];
    const errors = [];
    for (const combo of combos) {
      try {
        const news = await callSerperNews(combo.query, tbs);
        for (const n of news.slice(0, RESULTS_PER_QUERY)) {
          items.push({
            competitor: combo.competitor,
            keyword: combo.keyword,
            headline: n.title || "",
            note: n.snippet || "",
            importance: "medium",
            url: n.link || "",
            source: n.source || "",
            published_at: parseSerperDate(n.date, now),
            is_new: true,
          });
        }
      } catch (e) {
        errors.push(`"${combo.query}" 검색 실패: ${e.message}`);
      }
    }
    return sendJson(res, 200, { items, errors, notice });
  }

  if (req.method === "POST" && url.pathname === "/api/deploy") {
    let cards;
    try {
      cards = buildArchive();
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: "정적 페이지 생성 중 오류: " + e.message });
    }

    if (!fs.existsSync(path.join(ROOT, ".git"))) {
      return sendJson(res, 200, {
        ok: true,
        pushed: false,
        message: `정적 스냅샷과 아카이브 index.html을 생성했습니다 (${cards.length}건). 다만 이 폴더가 아직 git 저장소가 아니라 GitHub에는 올라가지 않았습니다. 'git init' 후 원격 저장소를 연결하면 push까지 됩니다.`,
      });
    }

    try {
      runGit(["add", "docs"]);
      const status = runGit(["status", "--porcelain"]);
      if (!status.trim()) {
        return sendJson(res, 200, { ok: true, pushed: false, message: "변경사항이 없습니다. 이미 최신 상태입니다." });
      }
      runGit(["commit", "-m", `브리핑 배포: ${cards[0]?.date || "업데이트"}`]);

      let pushed = false;
      let pushMessage = "로컬 커밋까지 완료했습니다. 원격 저장소(upstream)가 연결되어 있지 않아 push는 하지 않았습니다.";
      try {
        runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        runGit(["push"]);
        pushed = true;
        pushMessage = "커밋 후 원격 저장소로 push까지 완료했습니다.";
      } catch {
        // no upstream configured — leave as local commit only
      }
      return sendJson(res, 200, { ok: true, pushed, message: `정적 스냅샷 ${cards.length}건 생성 후 ${pushMessage}` });
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: "배포 중 오류: " + e.message });
    }
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  if (url.pathname === "/archive" || url.pathname.startsWith("/archive/")) {
    const sub = url.pathname.replace(/^\/archive/, "") || "/";
    return serveStatic(DOCS, sub, res);
  }
  return serveStatic(PUBLIC, url.pathname, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`브리핑 생성 도구: http://localhost:${PORT}`);
  console.log(`아카이브 미리보기: http://localhost:${PORT}/archive/`);
});
