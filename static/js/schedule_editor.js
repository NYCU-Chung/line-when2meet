/**
 * 課表填寫頁邏輯
 * - LIFF 登入 → 載入個人排程 → 渲染 Day Carousel → 儲存
 */

const STATUS_CONFIG = [
  { label: "有空",   icon: "✅", cls: "status-0" },
  { label: "上課",   icon: "📚", cls: "status-1" },
  { label: "忙碌",   icon: "🔴", cls: "status-2" },
  { label: "其他",   icon: "⚪", cls: "status-3" },
];

// 伺服器回傳的 {day-slot: {status, note}}，用來追蹤變更
let serverData = {};
// 本地端編輯中的狀態 {day-slot: {status, note}}
let localData = {};
let groupId = null;
let currentDayIndex = 0;

// 從 Flask 模板注入
// DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES 透過 HTML 的 <script> 注入

// ── 初始化 ──────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  groupId = LiffHelper.getParam("group");

  if (!groupId) {
    // LIFF may rewrite query into `liff.state`; LiffHelper.getParam() handles that.
    showError("缺少群組資訊，請從 LINE 群組內點擊卡片連結進入。");
    return;
  }

  try {
    const ok = await LiffHelper.init(LIFF_ID);
    if (!ok) return; // 等待 LIFF 登入跳轉
  } catch (e) {
    showError("LIFF 初始化失敗，請關閉並重新開啟。");
    return;
  }

  const profile = LiffHelper.getProfile();
  document.getElementById("user-name").textContent = profile.displayName;
  document.getElementById("loading").style.display = "none";
  document.getElementById("main-content").style.display = "block";

  // 向後端 auth（建立/更新 user 記錄）
  await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: LiffHelper.getIdToken(), group_id: parseInt(groupId) }),
  });

  // 載入個人排程
  await loadSchedule();
  renderCarousel();
  initDayIndicator();
  initModal();
  initSaveButton();
});

// ── 載入排程 ─────────────────────────────────────────────────────────────────

async function loadSchedule() {
  const resp = await fetch(`/api/schedule?group_id=${groupId}`, {
    headers: { Authorization: `Bearer ${LiffHelper.getIdToken()}` },
  });
  if (resp.ok) {
    const data = await resp.json();
    serverData = data.schedules || {};
    localData = JSON.parse(JSON.stringify(serverData)); // deep copy
  }
}

// ── 渲染 Carousel ──────────────────────────────────────────────────────────

function renderCarousel() {
  const carousel = document.getElementById("day-carousel");
  carousel.innerHTML = "";

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
      const entry = localData[key] || { status: 0, note: "" };
      const row = createSlotRow(day, slot, entry.status, entry.note);
      slotList.appendChild(row);
    });

    carousel.appendChild(card);
  });

  // Scroll Snap 監聽（切換 active card）
  const scrollHandler = debounce(() => {
    const cards = carousel.querySelectorAll(".day-card");
    const carouselRect = carousel.getBoundingClientRect();
    let closestIdx = 0;
    let closestDist = Infinity;

    cards.forEach((card, idx) => {
      const rect = card.getBoundingClientRect();
      const cardCenter = rect.left + rect.width / 2;
      const viewCenter = carouselRect.left + carouselRect.width / 2;
      const dist = Math.abs(cardCenter - viewCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = idx;
      }
    });

    if (closestIdx !== currentDayIndex) {
      currentDayIndex = closestIdx;
      updateActiveCard();
      updateDayIndicator();
    }
  }, 50);

  carousel.addEventListener("scroll", scrollHandler);
}

function createSlotRow(day, slot, status, note) {
  const row = document.createElement("div");
  row.className = "slot-row";
  row.dataset.day = day;
  row.dataset.slot = slot;

  const timeLabel = document.createElement("div");
  timeLabel.className = "slot-time-label";
  timeLabel.innerHTML = `<strong>${slot}</strong>${SLOT_TIMES[slot].replace("~", "<br>")}`;

  const cell = document.createElement("div");
  cell.className = `slot-cell status-${status}`;
  cell.dataset.day = day;
  cell.dataset.slot = slot;
  cell.dataset.status = status;
  cell.dataset.note = note;

  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG[0];
  cell.innerHTML = `
    <span class="slot-icon">${status === 0 ? "" : cfg.icon}</span>
    <span class="slot-label">${status === 0 ? "" : cfg.label}</span>
    ${note ? `<span class="slot-note-indicator">✏️</span>` : ""}
  `;

  cell.addEventListener("click", () => openModal(day, slot));

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

function updateSlotCell(day, slot, status, note) {
  const key = `${day}-${slot}`;
  localData[key] = { status, note };

  const cell = document.querySelector(`.slot-cell[data-day="${day}"][data-slot="${slot}"]`);
  if (!cell) return;

  cell.className = `slot-cell status-${status}`;
  cell.dataset.status = status;
  cell.dataset.note = note;

  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG[0];
  cell.innerHTML = `
    <span class="slot-icon">${status === 0 ? "" : cfg.icon}</span>
    <span class="slot-label">${status === 0 ? "" : cfg.label}</span>
    ${note ? `<span class="slot-note-indicator">✏️</span>` : ""}
  `;
  cell.addEventListener("click", () => openModal(day, slot));
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
  document.querySelectorAll(".day-dot").forEach((dot, idx) => {
    dot.classList.toggle("active", idx === currentDayIndex);
  });

  // 更新卡片 header 顏色
  const activeCard = document.querySelector(".day-card.active");
  if (activeCard) {
    const header = activeCard.querySelector(".day-card-header");
    if (header) header.style.background = "#4CAF50";
  }
}

function updateActiveCard() {
  document.querySelectorAll(".day-card").forEach((card, idx) => {
    card.classList.toggle("active", idx === currentDayIndex);
  });
}

function scrollToDay(idx) {
  const carousel = document.getElementById("day-carousel");
  const cards = carousel.querySelectorAll(".day-card");
  if (cards[idx]) {
    cards[idx].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

// ── Modal（格子編輯）────────────────────────────────────────────────────────

let modalDay = null;
let modalSlot = null;
let modalStatus = 0;

function initModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-confirm").addEventListener("click", confirmModal);

  document.querySelectorAll(".status-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      modalStatus = parseInt(opt.dataset.status);
      document.querySelectorAll(".status-option").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
    });
  });
}

function openModal(day, slot) {
  modalDay = day;
  modalSlot = slot;

  const key = `${day}-${slot}`;
  const entry = localData[key] || { status: 0, note: "" };
  modalStatus = entry.status;

  document.getElementById("modal-title").textContent =
    `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  document.getElementById("modal-note").value = entry.note || "";

  document.querySelectorAll(".status-option").forEach((opt) => {
    opt.classList.toggle("selected", parseInt(opt.dataset.status) === modalStatus);
  });

  document.getElementById("modal-overlay").classList.add("show");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("show");
}

function confirmModal() {
  const note = document.getElementById("modal-note").value.trim();
  updateSlotCell(modalDay, modalSlot, modalStatus, note);
  closeModal();
}

// ── 儲存 ─────────────────────────────────────────────────────────────────────

function initSaveButton() {
  document.getElementById("save-btn").addEventListener("click", saveSchedule);
}

async function saveSchedule() {
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "儲存中...";

  const schedules = [];
  DAY_CODES.forEach((day) => {
    SLOT_CODES.forEach((slot) => {
      const key = `${day}-${slot}`;
      const entry = localData[key] || { status: 0, note: "" };
      schedules.push({ day, slot, status: entry.status, note: entry.note || "" });
    });
  });

  try {
    const resp = await fetch("/api/schedule", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LiffHelper.getIdToken()}`,
      },
      body: JSON.stringify({ group_id: parseInt(groupId), schedules }),
    });

    if (resp.ok) {
      serverData = JSON.parse(JSON.stringify(localData));
      showToast("✅ 已儲存成功！");
    } else {
      showToast("❌ 儲存失敗，請重試");
    }
  } catch (e) {
    showToast("❌ 網路錯誤，請重試");
  } finally {
    btn.disabled = false;
    btn.textContent = "儲存";
  }
}

// ── 工具函式 ─────────────────────────────────────────────────────────────────

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function showError(msg) {
  document.getElementById("loading").innerHTML = `
    <div style="text-align:center;padding:40px 20px;color:#e53935">
      <div style="font-size:36px;margin-bottom:12px">⚠️</div>
      <div>${msg}</div>
    </div>`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
