/**
 * 統計頁邏輯
 * - 載入群組統計資料
 * - 以「日期標籤」切換單日視圖（比橫向卡片滑動更快）
 * - 點擊格子顯示詳細
 */

const STATUS_LABELS = {
  1: "上課",
  2: "忙碌",
  3: "其他",
  4: "睡覺",
  5: "回家",
};
const STATUS_CSS = {
  1: "status-class",
  2: "status-busy",
  3: "status-other",
  4: "status-sleep",
  5: "status-home",
};

let statsData = null;
let groupId = null;
let currentDayIndex = 0;
let busyDelayTimer = null;

// DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES 由 HTML 注入

function normalizeGroupId(v) {
  return (v || "").toString().trim();
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodeMulti(s, rounds = 2) {
  let out = s;
  for (let i = 0; i < rounds; i += 1) {
    const next = safeDecodeURIComponent(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function readFromQueryBlob(blob, key) {
  if (!blob || typeof blob !== "string") return null;

  const candidates = [blob, decodeMulti(blob, 2)];
  for (const raw of candidates) {
    const text = String(raw || "").trim();
    if (!text) continue;

    try {
      const fullUrl = new URL(text);
      const value = fullUrl.searchParams.get(key);
      if (value) return value;
    } catch {
      // ignore non-URL strings
    }

    const noHash = text.startsWith("#") ? text.slice(1) : text;
    const qIndex = noHash.indexOf("?");
    const queryPart = qIndex >= 0 ? noHash.slice(qIndex + 1) : noHash.replace(/^\?/, "");
    if (!queryPart) continue;
    const sp = new URLSearchParams(queryPart);
    const value = sp.get(key);
    if (value) return value;
  }

  return null;
}

function resolveGroupId() {
  const url = new URL(window.location.href);

  const direct = normalizeGroupId(url.searchParams.get("group") || url.searchParams.get("group_id"));
  if (direct) return direct;

  const fromHash = normalizeGroupId(readFromQueryBlob(url.hash, "group") || readFromQueryBlob(url.hash, "group_id"));
  if (fromHash) return fromHash;

  const stateRaw = url.searchParams.get("liff.state") || url.searchParams.get("liff_state");
  const fromState = normalizeGroupId(readFromQueryBlob(stateRaw, "group") || readFromQueryBlob(stateRaw, "group_id"));
  if (fromState) return fromState;

  return normalizeGroupId(typeof INITIAL_GROUP_ID === "string" ? INITIAL_GROUP_ID : "");
}

window.addEventListener("DOMContentLoaded", async () => {
  groupId = resolveGroupId();

  if (!groupId) {
    showError("缺少群組資訊");
    return;
  }

  const loaded = await loadStats();
  if (!loaded) {
    return;
  }
  document.getElementById("loading").style.display = "none";
  document.getElementById("main-content").style.display = "block";

  initDayTabs();
  renderCurrentDay();
  initDetailPanel();
});

async function loadStats() {
  try {
    const resp = await fetch(`/api/stats?group=${encodeURIComponent(groupId)}`);
    if (!resp.ok) {
      showError("載入失敗，請稍候重試");
      return false;
    }
    statsData = await resp.json();
    document.getElementById("stat-summary").textContent = `共 ${statsData.total_users} 人參與`;
    return true;
  } catch (err) {
    console.error(err);
    showError("載入失敗，請稍候重試");
    return false;
  }
}

function initDayTabs() {
  const wrap = document.getElementById("day-tabs");
  wrap.innerHTML = "";

  DAY_CODES.forEach((day, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `day-tab${idx === currentDayIndex ? " active" : ""}`;
    btn.textContent = DAY_NAMES[day];
    btn.addEventListener("click", async () => {
      if (idx === currentDayIndex) return;
      currentDayIndex = idx;
      updateDayTabs();
      await runWithBusy("切換日期中...", async () => {
        // Let the tab state paint first so switching feels responsive.
        await nextFrame();
        renderCurrentDay();
      });
    });
    wrap.appendChild(btn);
  });
}

function updateDayTabs() {
  document.querySelectorAll(".day-tab").forEach((el, idx) => {
    el.classList.toggle("active", idx === currentDayIndex);
  });
}

function renderCurrentDay() {
  const container = document.getElementById("day-carousel");
  container.innerHTML = "";

  const total = statsData.total_users || 0;
  const day = DAY_CODES[currentDayIndex];

  const card = document.createElement("div");
  card.className = "day-card";
  card.innerHTML = `
    <div class="day-card-header">
      ${DAY_NAMES[day]}
      <span>${day}</span>
    </div>
    <div class="slot-list" id="slots-${day}"></div>
  `;

  const slotList = card.querySelector(`#slots-${day}`);
  SLOT_CODES.forEach((slot) => {
    const key = `${day}-${slot}`;
    const slotInfo = statsData.slots[key] || { free_count: total, details: [] };
    slotList.appendChild(createSlotRow(day, slot, slotInfo, total));
  });

  container.appendChild(card);
}

function createSlotRow(day, slot, slotInfo, total) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const timeLabel = document.createElement("div");
  timeLabel.className = "slot-time-label";
  timeLabel.innerHTML = `<strong>${slot}</strong>${SLOT_TIMES[slot].replace("~", "<br>")}`;

  const cell = document.createElement("div");
  cell.className = "slot-cell";

  const freeCount = slotInfo && typeof slotInfo.free_count === "number" ? slotInfo.free_count : 0;
  const ratio = total > 0 ? freeCount / total : 0;
  cell.classList.toggle("is-full", ratio >= 0.999);
  applyMeterPalette(cell, ratio);

  const meter = document.createElement("div");
  meter.className = "slot-meter";

  const meterTrack = document.createElement("div");
  meterTrack.className = "slot-meter-track";

  const meterFill = document.createElement("div");
  meterFill.className = "slot-meter-fill";
  meterFill.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
  meterTrack.appendChild(meterFill);

  const meterPattern = document.createElement("div");
  meterPattern.className = "slot-meter-pattern";
  meterTrack.appendChild(meterPattern);

  meter.appendChild(meterTrack);
  cell.appendChild(meter);

  const countEl = document.createElement("div");
  countEl.className = `slot-count${ratio >= 0.86 ? " all-free" : ""}`;
  countEl.textContent = total > 0 ? `${freeCount}/${total}` : "-";
  countEl.title = `有空 ${freeCount} / ${total}`;
  cell.appendChild(countEl);

  cell.addEventListener("click", () => showDetail(day, slot, slotInfo, total));

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

function applyMeterPalette(cell, ratio) {
  const r = clamp01(ratio);
  if (r <= 0) {
    cell.style.setProperty("--cell-border", "#cfdad4");
    cell.style.setProperty("--meter-track-border", "#d5dfda");
    cell.style.setProperty("--meter-track-bg-top", "#edf3ef");
    cell.style.setProperty("--meter-track-bg-bottom", "#e3eae5");
    cell.style.setProperty("--meter-start", "#d6dfd9");
    cell.style.setProperty("--meter-end", "#c2cec6");
    cell.style.setProperty("--pattern-accent", "rgba(94, 112, 101, 0.14)");
    cell.style.setProperty("--count-bg", "#ffffff");
    cell.style.setProperty("--count-border", "#d5e3da");
    cell.style.setProperty("--count-color", "#60726a");
    cell.style.setProperty("--count-full-bg", "#4f7d67");
    cell.style.setProperty("--count-full-border", "#4f7d67");
    return;
  }

  // Low ratio: warm orange/red, high ratio: cool green/teal.
  const hue = Math.round(18 + r * 150); // 18 -> 168
  const sat = Math.round(68 - r * 10); // 68 -> 58
  const startLight = Math.round(74 - r * 12); // 74 -> 62
  const endLight = Math.round(60 - r * 16); // 60 -> 44
  const borderLight = Math.round(82 - r * 15); // 82 -> 67

  cell.style.setProperty("--cell-border", `hsl(${hue}, 30%, ${borderLight}%)`);
  cell.style.setProperty("--meter-track-border", `hsl(${hue}, 24%, ${Math.min(88, borderLight + 7)}%)`);
  cell.style.setProperty("--meter-track-bg-top", `hsl(${hue}, 28%, 94%)`);
  cell.style.setProperty("--meter-track-bg-bottom", `hsl(${hue}, 22%, 89%)`);
  cell.style.setProperty("--meter-start", `hsl(${hue}, ${sat}%, ${startLight}%)`);
  cell.style.setProperty("--meter-end", `hsl(${hue}, ${Math.max(42, sat - 8)}%, ${endLight}%)`);
  cell.style.setProperty("--pattern-accent", `hsla(${hue}, 30%, 28%, 0.17)`);

  cell.style.setProperty("--count-bg", `hsl(${hue}, ${Math.round(48 + r * 10)}%, ${Math.round(97 - r * 12)}%)`);
  cell.style.setProperty("--count-border", `hsl(${hue}, ${Math.round(34 + r * 14)}%, ${Math.round(83 - r * 14)}%)`);
  cell.style.setProperty("--count-color", `hsl(${hue}, ${Math.round(46 + r * 8)}%, ${Math.round(26 - r * 6)}%)`);
  cell.style.setProperty("--count-full-bg", `hsl(${hue}, ${Math.round(58 + r * 8)}%, ${Math.round(44 - r * 8)}%)`);
  cell.style.setProperty("--count-full-border", `hsl(${hue}, ${Math.round(58 + r * 8)}%, ${Math.round(44 - r * 8)}%)`);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function initDetailPanel() {
  document.getElementById("panel-close").addEventListener("click", hideDetail);
  document.getElementById("panel-overlay").addEventListener("click", hideDetail);
}

function showDetail(day, slot, slotInfo, total) {
  const panel = document.getElementById("detail-panel");
  const overlay = document.getElementById("panel-overlay");

  const details = (slotInfo && slotInfo.details) ? slotInfo.details : [];
  const freeCount = (slotInfo && typeof slotInfo.free_count === "number") ? slotInfo.free_count : 0;
  const busyCount = details.length;

  document.getElementById("panel-title").textContent = `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  document.getElementById("panel-free-count").textContent = (
    total > 0
      ? `有空 ${freeCount} / ${total} 人（非空閒 ${busyCount} 人）`
      : "尚無人參與"
  );

  const list = document.getElementById("detail-list");
  list.innerHTML = "";

  if (total === 0) {
    list.innerHTML = `<div class="detail-empty-msg">尚無人參與</div>`;
  } else if (details.length === 0) {
    list.innerHTML = `<div class="detail-allfree-msg">✅ 此時段所有人都有空</div>`;
  } else {
    const sorted = [...details].sort((a, b) => Number(a.status) - Number(b.status));
    sorted.forEach((item) => {
      const div = document.createElement("div");
      div.className = "detail-item";
      div.innerHTML = `
        <div class="detail-avatar">${item.display_name.charAt(0)}</div>
        <div class="detail-info">
          <div class="detail-name">${escHtml(item.display_name)}</div>
          ${item.note ? `<div class="detail-note">${escHtml(item.note)}</div>` : ""}
        </div>
        <div class="detail-status ${STATUS_CSS[item.status] || "status-other"}">
          ${STATUS_LABELS[item.status] || "其他"}
        </div>
      `;
      list.appendChild(div);
    });
  }

  overlay.classList.add("show");
  panel.classList.add("show");
}

function hideDetail() {
  document.getElementById("detail-panel").classList.remove("show");
  document.getElementById("panel-overlay").classList.remove("show");
}

function showError(msg) {
  setPageBusy(false);
  document.getElementById("loading").innerHTML = `
    <div class="loading-error">
      <div class="loading-error-icon">⚠️</div>
      <div>${msg}</div>
    </div>`;
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setPageBusy(show, text = "載入中...") {
  const layer = document.getElementById("page-busy");
  if (!layer) return;
  const label = layer.querySelector(".page-busy-text");
  if (label) {
    label.textContent = text;
  }
  if (show) {
    layer.classList.add("show");
  } else {
    layer.classList.remove("show");
  }
}

async function runWithBusy(label, task) {
  if (busyDelayTimer) {
    clearTimeout(busyDelayTimer);
  }
  busyDelayTimer = setTimeout(() => {
    setPageBusy(true, label);
  }, 140);
  try {
    await task();
  } finally {
    clearTimeout(busyDelayTimer);
    busyDelayTimer = null;
    setPageBusy(false);
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
