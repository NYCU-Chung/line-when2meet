/**
 * 統計頁邏輯
 * - 載入群組統計資料 → 渲染熱力圖 Day Carousel → 點擊格子顯示詳細
 */

const STATUS_LABELS = ["有空", "上課", "忙碌", "其他"];
const STATUS_CSS = ["status-free", "status-class", "status-busy", "status-other"];

let statsData = null;
let groupId = null;
let currentDayIndex = 0;

// DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES 由 HTML 注入

// ── 初始化 ────────────────────────────────────────────────────────────────────

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

  renderCarousel();
  initDayIndicator();
  initDetailPanel();
});

// ── 載入統計 ──────────────────────────────────────────────────────────────────

async function loadStats() {
  const resp = await fetch(`/api/stats?group_id=${groupId}`);
  if (!resp.ok) { showError("載入失敗，請重新整理"); return; }
  statsData = await resp.json();

  document.getElementById("stat-summary").textContent =
    `共 ${statsData.total_users} 人填寫`;
}

// ── 渲染 Carousel ─────────────────────────────────────────────────────────────

function renderCarousel() {
  const carousel = document.getElementById("day-carousel");
  carousel.innerHTML = "";
  const total = statsData.total_users;

  DAY_CODES.forEach((day, dayIdx) => {
    const card = document.createElement("div");
    card.className = `day-card${dayIdx === 0 ? " active" : ""}`;
    card.dataset.dayIdx = dayIdx;

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
      const freeCount = slotInfo.free_count;
      const row = createSlotRow(day, slot, freeCount, total, slotInfo.details);
      slotList.appendChild(row);
    });

    carousel.appendChild(card);
  });

  // 滾動監聽
  const scrollHandler = debounce(() => {
    const cards = carousel.querySelectorAll(".day-card");
    const carouselRect = carousel.getBoundingClientRect();
    let closestIdx = 0, closestDist = Infinity;
    cards.forEach((card, idx) => {
      const rect = card.getBoundingClientRect();
      const dist = Math.abs((rect.left + rect.width / 2) - (carouselRect.left + carouselRect.width / 2));
      if (dist < closestDist) { closestDist = dist; closestIdx = idx; }
    });
    if (closestIdx !== currentDayIndex) {
      currentDayIndex = closestIdx;
      updateActiveCard();
      updateDayIndicator();
    }
  }, 50);

  carousel.addEventListener("scroll", scrollHandler);
}

function createSlotRow(day, slot, freeCount, total, details) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const timeLabel = document.createElement("div");
  timeLabel.className = "slot-time-label";
  timeLabel.innerHTML = `<strong>${slot}</strong>${SLOT_TIMES[slot].replace("~", "<br>")}`;

  const cell = document.createElement("div");
  cell.className = "slot-cell";

  // 熱力圖：依有空比例調色（白 → 深綠）
  const ratio = total > 0 ? freeCount / total : 0;
  const bg = heatColor(ratio);
  cell.style.background = bg;

  const countEl = document.createElement("div");
  countEl.className = `slot-count${ratio >= 0.85 ? " all-free" : ""}`;
  countEl.textContent = total > 0 ? `${freeCount}/${total}` : "-";

  cell.appendChild(countEl);

  // 點擊 → 顯示詳細
  cell.addEventListener("click", () => showDetail(day, slot, freeCount, total, details));

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

/** 依比例（0~1）回傳熱力圖背景色（白→淺綠→深綠）*/
function heatColor(ratio) {
  if (ratio <= 0) return "#FAFAFA";
  // HSL: hue=120(綠), saturation 固定, lightness 100%→45%
  const l = Math.round(100 - ratio * 55);
  const s = ratio < 0.05 ? 0 : 60;
  return `hsl(120, ${s}%, ${l}%)`;
}

// ── 星期指示列 ────────────────────────────────────────────────────────────────

function initDayIndicator() {
  const indicator = document.getElementById("day-indicator");
  indicator.innerHTML = "";
  DAY_CODES.forEach((day, idx) => {
    const dot = document.createElement("div");
    dot.className = `day-dot${idx === 0 ? " active" : ""}`;
    dot.textContent = day;
    dot.addEventListener("click", () => scrollToDay(idx));
    indicator.appendChild(dot);
  });
}

function updateDayIndicator() {
  document.querySelectorAll(".day-dot").forEach((d, i) =>
    d.classList.toggle("active", i === currentDayIndex)
  );
}

function updateActiveCard() {
  document.querySelectorAll(".day-card").forEach((card, idx) =>
    card.classList.toggle("active", idx === currentDayIndex)
  );
}

function scrollToDay(idx) {
  const carousel = document.getElementById("day-carousel");
  const cards = carousel.querySelectorAll(".day-card");
  if (cards[idx]) cards[idx].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

// ── 詳細面板 ─────────────────────────────────────────────────────────────────

function initDetailPanel() {
  document.getElementById("panel-close").addEventListener("click", hideDetail);
  document.getElementById("panel-overlay").addEventListener("click", hideDetail);
}

function showDetail(day, slot, freeCount, total, busyDetails) {
  const panel = document.getElementById("detail-panel");
  const overlay = document.getElementById("panel-overlay");

  document.getElementById("panel-title").textContent =
    `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  document.getElementById("panel-free-count").textContent =
    `有空 ${freeCount} / ${total} 人`;

  const list = document.getElementById("detail-list");
  list.innerHTML = "";

  // 先顯示有空的人（不在 busyDetails 裡的使用者）
  // 只能顯示有填寫過的人，有空的人是 total - busyDetails
  const busyUserIds = new Set(busyDetails.map((d) => d.user_id));

  // 非忙碌的人（有空）
  // 取得所有有填寫的使用者（透過 statsData.slots 所有 detail 找）
  const allUsersMap = {};
  Object.values(statsData.slots).forEach((slotInfo) => {
    (slotInfo.details || []).forEach((d) => {
      allUsersMap[d.user_id] = d.display_name;
    });
  });

  const freeUsers = Object.entries(allUsersMap)
    .filter(([uid]) => !busyUserIds.has(uid))
    .map(([uid, name]) => ({ user_id: uid, display_name: name, status: 0, note: "" }));

  const allDetails = [...freeUsers, ...busyDetails];

  if (allDetails.length === 0) {
    list.innerHTML = `<div style="color:#aaa;text-align:center;padding:20px">尚無人填寫</div>`;
  } else {
    allDetails.forEach((item) => {
      const div = document.createElement("div");
      div.className = "detail-item";
      div.innerHTML = `
        <div class="detail-avatar">${item.display_name.charAt(0)}</div>
        <div class="detail-info">
          <div class="detail-name">${escHtml(item.display_name)}</div>
          ${item.note ? `<div class="detail-note">${escHtml(item.note)}</div>` : ""}
        </div>
        <div class="detail-status ${STATUS_CSS[item.status]}">
          ${STATUS_LABELS[item.status]}
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

// ── 工具函式 ─────────────────────────────────────────────────────────────────

function showError(msg) {
  document.getElementById("loading").innerHTML = `
    <div style="text-align:center;padding:40px 20px;color:#e53935">
      <div style="font-size:36px;margin-bottom:12px">⚠️</div>
      <div>${msg}</div>
    </div>`;
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
