const IMPORTANCE_LABEL = { high: "상", medium: "중", low: "하" };
const IMPORTANCE_RANK = { high: 3, medium: 2, low: 1 };

let items = [];
let competitors = [];
let keywords = [];
let expandedIdx = new Set();

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseCsv(str) {
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function badgeHtml(level) {
  const safe = IMPORTANCE_LABEL[level] ? level : "low";
  return `<span class="badge badge-${safe}">${IMPORTANCE_LABEL[safe]}</span>`;
}

function newItem() {
  return { competitor: "", keyword: "", headline: "", note: "", importance: "medium", url: "", source: "", published_at: "", is_new: true };
}

function orderedCompetitorNames() {
  const order = competitors.slice();
  const seen = new Set(order);
  for (const it of items) {
    const name = it.competitor || "(경쟁사 미지정)";
    if (!seen.has(name)) { seen.add(name); order.push(name); }
  }
  return order;
}

function renderTagList(containerId, list) {
  const el = document.getElementById(containerId);
  el.innerHTML = list.length
    ? list.map((tag, idx) => `
        <label class="tag-chip">
          <input type="checkbox" data-tag-idx="${idx}" />
          ${escapeHtml(tag)}
        </label>
      `).join("")
    : '<span style="color:#999;font-size:13px;">등록된 항목이 없습니다.</span>';
}

function renderCompetitorTags() {
  renderTagList("competitor-tags", competitors);
}

function renderKeywordTags() {
  renderTagList("keyword-tags", keywords);
}

function addTagsFromInput(inputEl, arr, rerender) {
  const parsed = parseCsv(inputEl.value);
  for (const tag of parsed) {
    if (!arr.includes(tag)) arr.push(tag);
  }
  inputEl.value = "";
  rerender();
  renderItems();
}

function deleteSelectedTags(containerId, arr, rerender) {
  const container = document.getElementById(containerId);
  const checkedIdx = new Set(
    [...container.querySelectorAll("input[type=checkbox]:checked")].map((cb) => Number(cb.dataset.tagIdx))
  );
  if (!checkedIdx.size) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (checkedIdx.has(i)) arr.splice(i, 1);
  }
  rerender();
  renderItems();
}

function groupItemsByCompetitor() {
  return orderedCompetitorNames().map((name) => ({
    name,
    entries: items
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => (it.competitor || "(경쟁사 미지정)") === name)
      .sort((a, b) => (IMPORTANCE_RANK[b.it.importance] || 0) - (IMPORTANCE_RANK[a.it.importance] || 0)),
  }));
}

function renderItemRow(it, idx) {
  const isOpen = expandedIdx.has(idx) || !it.headline;
  return `
    <div class="item-row" data-idx="${idx}">
      <div class="item-toolbar">
        <input type="checkbox" class="item-select" data-idx="${idx}" title="선택" />
        <select class="item-importance-quick" data-field="importance" data-idx="${idx}" title="중요도">
          <option value="high" ${it.importance === "high" ? "selected" : ""}>상</option>
          <option value="medium" ${it.importance === "medium" ? "selected" : ""}>중</option>
          <option value="low" ${it.importance === "low" ? "selected" : ""}>하</option>
        </select>
        <input type="text" class="item-headline-quick" data-field="headline" data-idx="${idx}" value="${escapeHtml(it.headline)}" placeholder="헤드라인" />
        <input type="text" class="item-keyword-quick" data-field="keyword" data-idx="${idx}" value="${escapeHtml(it.keyword)}" placeholder="키워드" />
        <label class="new-toggle"><input type="checkbox" data-field="is_new" data-idx="${idx}" ${it.is_new ? "checked" : ""} /> NEW</label>
        <button type="button" class="btn-toggle-detail" data-action="toggle-detail" data-idx="${idx}">${isOpen ? "▴ 접기" : "▾ 상세"}</button>
        <button type="button" class="btn-remove-x" data-action="remove" data-idx="${idx}" title="삭제">✕</button>
      </div>
      ${it.note ? `<div class="item-preview-note">${escapeHtml(it.note)}</div>` : ""}
      <div class="item-body" style="display:${isOpen ? "block" : "none"}">
        <label>경쟁사</label>
        <input type="text" data-field="competitor" data-idx="${idx}" value="${escapeHtml(it.competitor)}" />
        <label>요약 / 노트</label>
        <textarea data-field="note" data-idx="${idx}">${escapeHtml(it.note)}</textarea>
        <div class="row">
          <div>
            <label>출처 URL</label>
            <input type="url" data-field="url" data-idx="${idx}" value="${escapeHtml(it.url)}" />
          </div>
          <div>
            <label>출처명</label>
            <input type="text" data-field="source" data-idx="${idx}" value="${escapeHtml(it.source)}" />
          </div>
        </div>
        <label>발표 날짜</label>
        <input type="text" data-field="published_at" data-idx="${idx}" value="${escapeHtml(it.published_at || "")}" placeholder="자동 수집 시 채워집니다" />
      </div>
    </div>
  `;
}

function renderItems() {
  const container = document.getElementById("items-container");
  const groups = groupItemsByCompetitor();

  container.innerHTML = groups.length
    ? groups.map((g) => `
        <div class="competitor-group">
          <div class="competitor-group-header">
            ${escapeHtml(g.name)} <span class="competitor-count">${g.entries.length}건</span>
          </div>
          ${g.entries.length
            ? g.entries.map(({ it, idx }) => renderItemRow(it, idx)).join("")
            : '<p style="color:#666;font-size:13px;margin:0;">이 경쟁사에 대한 항목이 아직 없습니다. 자동 수집 또는 "+ 항목 직접 추가"로 채워주세요.</p>'}
        </div>
      `).join("")
    : '<p style="color:#666;font-size:13px;">아직 항목이 없습니다. "+ 항목 추가"를 눌러주세요.</p>';

  renderPreview();
}

function computeTopImportance() {
  let top = "low";
  for (const it of items) {
    if ((IMPORTANCE_RANK[it.importance] || 0) > (IMPORTANCE_RANK[top] || 0)) top = it.importance;
  }
  return top;
}

function groupTopImportance(entries) {
  let top = "low";
  for (const { it } of entries) {
    if ((IMPORTANCE_RANK[it.importance] || 0) > (IMPORTANCE_RANK[top] || 0)) top = it.importance;
  }
  return top;
}

function renderPreview() {
  const date = document.getElementById("f-date").value || todayStr();
  const title = document.getElementById("f-title").value || "(제목 없음)";
  const summary = document.getElementById("f-summary").value || "(요약 없음)";
  const top = computeTopImportance();
  const groups = groupItemsByCompetitor();

  const compareBarHtml = groups.length > 1 ? `
    <div class="compare-bar">
      ${groups.map((g) => `
        <div class="compare-chip">
          <strong>${escapeHtml(g.name)}</strong> ${g.entries.length}건
          ${g.entries.length ? badgeHtml(groupTopImportance(g.entries)) : '<span class="badge badge-low">데이터 없음</span>'}
        </div>
      `).join("")}
    </div>
  ` : "";

  const columnsHtml = groups.map((g) => `
    <div class="preview-group">
      <div class="preview-group-header">${escapeHtml(g.name)}</div>
      ${g.entries.length
        ? g.entries.map(({ it }) => `
            <div class="preview-item">
              <div class="headline">${escapeHtml(it.headline || "(헤드라인 없음)")} ${badgeHtml(it.importance)}</div>
              <div>${escapeHtml(it.keyword)} ${it.is_new ? "· NEW" : ""}</div>
            </div>
          `).join("")
        : '<div class="preview-item" style="color:#999;">데이터 없음</div>'}
    </div>
  `).join("");

  document.getElementById("preview").innerHTML = `
    <div class="preview-date">${escapeHtml(date)} ${badgeHtml(top)}</div>
    <div class="preview-title">${escapeHtml(title)}</div>
    <div class="preview-summary">${escapeHtml(summary)}</div>
    ${compareBarHtml}
    <div class="preview-columns">${columnsHtml}</div>
  `;
}

function collectBriefing() {
  return {
    date: document.getElementById("f-date").value || todayStr(),
    title: document.getElementById("f-title").value.trim(),
    summary: document.getElementById("f-summary").value.trim(),
    competitors,
    keywords,
    items,
  };
}

function bindItemEvents() {
  const container = document.getElementById("items-container");
  container.addEventListener("input", (e) => {
    const idx = e.target.dataset.idx;
    const field = e.target.dataset.field;
    if (idx === undefined || !field) return;
    if (field === "is_new") items[idx][field] = e.target.checked;
    else items[idx][field] = e.target.value;
    if (field === "note") {
      const preview = e.target.closest(".item-row")?.querySelector(".item-preview-note");
      if (preview) preview.textContent = e.target.value;
    }
    renderPreview();
  });
  container.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action === "remove") {
      items.splice(Number(e.target.dataset.idx), 1);
      expandedIdx.clear();
      renderItems();
      return;
    }
    if (action === "toggle-detail") {
      const idx = Number(e.target.dataset.idx);
      const body = e.target.closest(".item-row").querySelector(".item-body");
      const willOpen = body.style.display === "none";
      body.style.display = willOpen ? "block" : "none";
      e.target.textContent = willOpen ? "▴ 접기" : "▾ 상세";
      if (willOpen) expandedIdx.add(idx);
      else expandedIdx.delete(idx);
    }
  });
}

function deleteSelectedItems() {
  const container = document.getElementById("items-container");
  const checkedIdx = new Set(
    [...container.querySelectorAll(".item-select:checked")].map((cb) => Number(cb.dataset.idx))
  );
  if (!checkedIdx.size) return;
  items = items.filter((_, idx) => !checkedIdx.has(idx));
  expandedIdx.clear();
  document.getElementById("select-all-items").checked = false;
  renderItems();
}

async function loadHistory() {
  const res = await fetch("/api/briefings");
  const list = await res.json();
  const el = document.getElementById("history-list");
  if (!list.length) {
    el.innerHTML = '<span style="color:#666;font-size:13px;">저장된 브리핑이 없습니다.</span>';
    return;
  }
  el.innerHTML = list.map((b) => `<button type="button" data-date="${b.date}">${b.date}</button>`).join("");
  el.addEventListener("click", async (e) => {
    const date = e.target.dataset.date;
    if (!date) return;
    const res = await fetch(`/api/briefings/${date}`);
    const b = await res.json();
    document.getElementById("f-date").value = b.date;
    document.getElementById("f-title").value = b.title;
    document.getElementById("f-summary").value = b.summary;
    competitors = (b.competitors || []).slice();
    keywords = (b.keywords || []).slice();
    renderCompetitorTags();
    renderKeywordTags();
    items = (b.items || []).map((it) => ({ ...newItem(), ...it }));
    expandedIdx = new Set();
    renderItems();
  });
}

function setStatus(elId, ok, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.className = ok ? "status-ok" : "status-fail";
}

document.getElementById("f-date").value = todayStr();
document.getElementById("add-item").addEventListener("click", () => {
  items.push(newItem());
  renderItems();
});

document.getElementById("collect-btn").addEventListener("click", async () => {
  if (!competitors.length) return setStatus("collect-status", false, "경쟁사를 먼저 입력해주세요.");

  const btn = document.getElementById("collect-btn");
  btn.disabled = true;
  setStatus("collect-status", true, "수집 중...");
  try {
    const res = await fetch("/api/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitors, keywords }),
    });
    const data = await res.json();
    if (!res.ok) return setStatus("collect-status", false, "수집 실패: " + (data.error || res.status));

    const existingUrls = new Set(items.map((i) => i.url).filter(Boolean));
    let added = 0;
    for (const it of data.items) {
      if (it.url && existingUrls.has(it.url)) continue;
      items.push({ ...newItem(), ...it });
      if (it.url) existingUrls.add(it.url);
      added++;
    }
    renderItems();

    let msg = `${added}건 수집 완료 (중복 제외)`;
    if (data.errors?.length) msg += ` — 일부 검색 실패 ${data.errors.length}건: ${data.errors[0]}`;
    if (data.notice) msg += ` — ${data.notice}`;
    setStatus("collect-status", !data.errors?.length, msg);
  } catch (e) {
    setStatus("collect-status", false, "수집 중 오류: " + e.message);
  } finally {
    btn.disabled = false;
  }
});
["f-title", "f-summary", "f-date"].forEach((id) =>
  document.getElementById(id).addEventListener("input", renderPreview)
);

document.getElementById("save-btn").addEventListener("click", async () => {
  const briefing = collectBriefing();
  if (!briefing.title) return setStatus("save-status", false, "제목을 입력해주세요.");
  try {
    const res = await fetch("/api/briefings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(briefing),
    });
    const data = await res.json();
    if (!res.ok) return setStatus("save-status", false, "저장 실패: " + (data.error || res.status));
    setStatus("save-status", true, `저장 완료 — docs/briefings/${data.date}.json`);
    loadHistory();
  } catch (e) {
    setStatus("save-status", false, "저장 중 오류: " + e.message);
  }
});

document.getElementById("deploy-btn").addEventListener("click", async () => {
  setStatus("deploy-status", true, "배포 중...");
  try {
    const res = await fetch("/api/deploy", { method: "POST" });
    const data = await res.json();
    setStatus("deploy-status", data.ok, data.message);
  } catch (e) {
    setStatus("deploy-status", false, "배포 중 오류: " + e.message);
  }
});

document.getElementById("add-competitor-btn").addEventListener("click", () => {
  addTagsFromInput(document.getElementById("f-competitor-add"), competitors, renderCompetitorTags);
});
document.getElementById("f-competitor-add").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTagsFromInput(document.getElementById("f-competitor-add"), competitors, renderCompetitorTags);
  }
});
document.getElementById("delete-competitors-btn").addEventListener("click", () => {
  deleteSelectedTags("competitor-tags", competitors, renderCompetitorTags);
});

document.getElementById("add-keyword-btn").addEventListener("click", () => {
  addTagsFromInput(document.getElementById("f-keyword-add"), keywords, renderKeywordTags);
});
document.getElementById("f-keyword-add").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTagsFromInput(document.getElementById("f-keyword-add"), keywords, renderKeywordTags);
  }
});
document.getElementById("delete-keywords-btn").addEventListener("click", () => {
  deleteSelectedTags("keyword-tags", keywords, renderKeywordTags);
});

document.getElementById("select-all-items").addEventListener("change", (e) => {
  document.querySelectorAll("#items-container .item-select").forEach((cb) => {
    cb.checked = e.target.checked;
  });
});
document.getElementById("delete-selected-items-btn").addEventListener("click", deleteSelectedItems);

bindItemEvents();
items.push(newItem());
renderCompetitorTags();
renderKeywordTags();
renderItems();
loadHistory();
