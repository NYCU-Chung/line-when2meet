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

// DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES 由 HTML 注入

window.addEventListener("DOMContentLoaded", async () => {
  const url = new URL(window.location.href);
  groupId = url.searchParams.get("group");

  if (!groupId) {
    showError("缺少群組資訊");
    return;
  }

  await loadStats();
  document.getElementById("loading").style.display = "none";
  document.getElementById("main-content").style.display = "block";

  initDayTabs();
  renderCurrentDay();
  initDetailPanel();
});

async function loadStats() {
  const resp = await fetch(`/api/stats?group=${encodeURIComponent(groupId)}`);
  if (!resp.ok) {
    showError("載入失敗，請重新整理");
    return;
  }
  statsData = await resp.json();
  document.getElementById("stat-summary").textContent = `共 ${statsData.total_users} 人參與`;
}

function initDayTabs() {
  const wrap = document.getElementById("day-tabs");
  wrap.innerHTML = "";

  DAY_CODES.forEach((day, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `day-tab${idx === currentDayIndex ? " active" : ""}`;
    btn.textContent = DAY_NAMES[day];
    btn.addEventListener("click", () => {
      if (idx === currentDayIndex) return;
      currentDayIndex = idx;
      updateDayTabs();
      renderCurrentDay();
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
  cell.style.background = heatColor(ratio);

  const countEl = document.createElement("div");
  countEl.className = `slot-count${ratio >= 0.86 ? " all-free" : ""}`;
  countEl.textContent = total > 0 ? `${freeCount}/${total}` : "-";
  cell.appendChild(countEl);

  cell.addEventListener("click", () => showDetail(day, slot, slotInfo, total));

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

/** 回傳較明亮的熱力圖顏色（淡藍灰 → 亮綠） */
function heatColor(ratio) {
  if (ratio <= 0) return "#F4F7F5";
  const r = Math.min(1, Math.max(0, ratio));
  const hue = Math.round(188 - r * 62); // 188 ~ 126
  const sat = Math.round(42 + r * 26);  // 42% ~ 68%
  const light = Math.round(97 - r * 40); // 97% ~ 57%
  return `hsl(${hue}, ${sat}%, ${light}%)`;
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
  document.getElementById("loading").innerHTML = `
    <div class="loading-error">
      <div class="loading-error-icon">⚠️</div>
      <div>${msg}</div>
    </div>`;
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
