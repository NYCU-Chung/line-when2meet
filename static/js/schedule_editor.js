/**
 * 課表填寫頁邏輯
 * - LIFF 登入 → 載入個人排程 → 支援拖曳一次塗多格 → 儲存
 *
 * 狀態說明：
 * - 未選取：不儲存（前端顯示白/灰）
 * - 0~3：明確選取，全部都會儲存（包含 0=有空）
 */

const STATUS_CONFIG = {
  0: { label: "有空", icon: "✅", cls: "status-0" },
  1: { label: "上課", icon: "📚", cls: "status-1" },
  2: { label: "忙碌", icon: "🔴", cls: "status-2" },
  3: { label: "其他", icon: "⚪", cls: "status-3" },
};

// 伺服器回傳的 {day-slot: {status, note}}（只包含已選取的格子）
let serverData = {};
// 本地端編輯中的 {day-slot: {status, note}}（只包含已選取的格子）
let localData = {};

let groupId = null;
let currentDayIndex = 0;

let dirty = false;
let saving = false;

// 筆刷狀態：null 代表清除/未選取
let brushStatus = 0;

function keyOf(day, slot) {
  return `${day}-${slot}`;
}

function getEntry(day, slot) {
  return localData[keyOf(day, slot)] || null;
}

function setEntry(day, slot, statusOrNull, note) {
  const key = keyOf(day, slot);
  if (statusOrNull === null || statusOrNull === undefined) {
    delete localData[key];
    return;
  }
  localData[key] = { status: statusOrNull, note: note || "" };
}

function markDirty() {
  if (!dirty) dirty = true;
  refreshSaveButton();
}

function refreshSaveButton() {
  const btn = document.getElementById("save-btn");
  if (!btn) return;

  btn.disabled = saving || !dirty;
  if (saving) btn.textContent = "儲存中...";
  else if (dirty) btn.textContent = "儲存";
  else btn.textContent = "已儲存";
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  groupId = LiffHelper.getParam("group");

  if (!groupId) {
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
    body: JSON.stringify({ id_token: LiffHelper.getIdToken(), group_id: parseInt(groupId, 10) }),
  });

  await loadSchedule();

  renderCarousel();
  initDayIndicator();
  initModal();
  initBrushBar();
  initPaintHandlers();
  initSaveButton();

  dirty = false;
  refreshSaveButton();
});

// ── 載入排程 ─────────────────────────────────────────────────────────────────

async function loadSchedule() {
  const resp = await fetch(`/api/schedule?group_id=${encodeURIComponent(groupId)}`, {
    headers: { Authorization: `Bearer ${LiffHelper.getIdToken()}` },
  });
  if (!resp.ok) {
    showToast("⚠️ 載入失敗，請稍後重試");
    return;
  }
  const data = await resp.json();
  serverData = data.schedules || {};
  localData = JSON.parse(JSON.stringify(serverData)); // deep copy
}

// ── 渲染 Carousel ──────────────────────────────────────────────────────────

function renderCarousel() {
  const carousel = document.getElementById("day-carousel");
  carousel.innerHTML = "";

  DAY_CODES.forEach((day, dayIdx) => {
    const card = document.createElement("div");
    card.className = `day-card${dayIdx === 0 ? " active" : ""}`;
    card.dataset.dayIdx = String(dayIdx);

    card.innerHTML = `
      <div class="day-card-header">
        ${DAY_NAMES[day]}
        <span>${day}</span>
      </div>
      <div class="slot-list" id="slots-${day}"></div>
    `;

    const slotList = card.querySelector(`#slots-${day}`);
    SLOT_CODES.forEach((slot) => {
      const entry = getEntry(day, slot);
      const row = createSlotRow(day, slot, entry);
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

  carousel.addEventListener("scroll", scrollHandler, { passive: true });
}

function createSlotRow(day, slot, entryOrNull) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const timeLabel = document.createElement("div");
  timeLabel.className = "slot-time-label";
  timeLabel.innerHTML = `<strong>${slot}</strong>${SLOT_TIMES[slot].replace("~", "<br>")}`;

  const cell = document.createElement("div");
  cell.className = "slot-cell";
  cell.dataset.day = day;
  cell.dataset.slot = slot;

  if (!entryOrNull) {
    applyCellVisual(cell, null, "");
  } else {
    applyCellVisual(cell, entryOrNull.status, entryOrNull.note || "");
  }

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

function applyCellVisual(cell, statusOrNull, note) {
  if (statusOrNull === null || statusOrNull === undefined) {
    cell.className = "slot-cell status-empty";
    cell.dataset.status = "";
    cell.dataset.note = "";
    cell.innerHTML = "";
    return;
  }

  const status = Number(statusOrNull);
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG[0];

  cell.className = `slot-cell ${cfg.cls}`;
  cell.dataset.status = String(status);
  cell.dataset.note = note || "";

  const showNote = (note || "").trim().length > 0;
  cell.innerHTML = `
    <span class="slot-icon">${cfg.icon}</span>
    <span class="slot-label">${cfg.label}</span>
    ${showNote ? `<span class="slot-note-indicator">✏️</span>` : ""}
  `;
}

function updateSlotCell(day, slot, statusOrNull, note) {
  const key = keyOf(day, slot);
  const existing = localData[key] || null;

  if (statusOrNull === null || statusOrNull === undefined) {
    if (existing) {
      delete localData[key];
      markDirty();
    }
  } else {
    const status = Number(statusOrNull);
    const next = { status, note: note || "" };
    const changed = !existing || existing.status !== next.status || (existing.note || "") !== next.note;
    if (changed) {
      localData[key] = next;
      markDirty();
    }
  }

  const cell = document.querySelector(`.slot-cell[data-day="${day}"][data-slot="${slot}"]`);
  if (!cell) return;
  applyCellVisual(cell, statusOrNull, note);
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

// ── 筆刷 ─────────────────────────────────────────────────────────────────────

function initBrushBar() {
  const bar = document.getElementById("brushbar");
  if (!bar) return;

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".brush-btn");
    if (!btn) return;

    const raw = btn.dataset.status;
    brushStatus = (raw === "empty") ? null : Number(raw);

    bar.querySelectorAll(".brush-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
  });
}

// ── 拖曳塗色（一次選多格）────────────────────────────────────────────────────

let pointerState = null;
const PAINT_START_DISTANCE_PX = 10;

function initPaintHandlers() {
  const carousel = document.getElementById("day-carousel");
  if (!carousel) return;

  carousel.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".slot-cell");
    if (!cell) return;

    pointerState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startCell: cell,
      isPainting: false,
      visited: new Set(),
    };

    try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  carousel.addEventListener("pointermove", (e) => {
    if (!pointerState || pointerState.pointerId !== e.pointerId) return;

    const dx = e.clientX - pointerState.startX;
    const dy = e.clientY - pointerState.startY;
    const dist2 = dx * dx + dy * dy;

    if (!pointerState.isPainting && dist2 > (PAINT_START_DISTANCE_PX * PAINT_START_DISTANCE_PX)) {
      pointerState.isPainting = true;
      paintCell(pointerState.startCell);
    }

    if (!pointerState.isPainting) return;

    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest ? el.closest(".slot-cell") : null;
    if (cell) paintCell(cell);
  }, { passive: false });

  const end = (e) => {
    if (!pointerState || pointerState.pointerId !== e.pointerId) return;

    const wasPainting = pointerState.isPainting;
    const cell = pointerState.startCell;
    pointerState = null;

    if (!wasPainting && cell) {
      openModal(cell.dataset.day, cell.dataset.slot);
    }
  };

  carousel.addEventListener("pointerup", end);
  carousel.addEventListener("pointercancel", end);
}

function paintCell(cell) {
  if (!pointerState) return;
  const day = cell.dataset.day;
  const slot = cell.dataset.slot;
  if (!day || !slot) return;

  const key = keyOf(day, slot);
  if (pointerState.visited.has(key)) return;
  pointerState.visited.add(key);

  if (brushStatus === null) {
    updateSlotCell(day, slot, null, "");
    return;
  }

  const existing = localData[key] || null;
  const nextStatus = Number(brushStatus);
  // 避免不小心把已寫備註的格子刷過就清掉備註：狀態沒變就保留 note。
  const nextNote = (existing && existing.status === nextStatus) ? (existing.note || "") : "";
  updateSlotCell(day, slot, nextStatus, nextNote);
}

// ── Modal（單格編輯）────────────────────────────────────────────────────────

let modalDay = null;
let modalSlot = null;
let modalStatus = null; // null=未選取

function initModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-confirm").addEventListener("click", confirmModal);

  document.querySelectorAll(".status-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const raw = opt.dataset.status;
      modalStatus = (raw === "empty") ? null : Number(raw);
      document.querySelectorAll(".status-option").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
    });
  });
}

function openModal(day, slot) {
  modalDay = day;
  modalSlot = slot;

  const entry = getEntry(day, slot);
  modalStatus = entry ? Number(entry.status) : null;

  document.getElementById("modal-title").textContent =
    `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  document.getElementById("modal-note").value = entry ? (entry.note || "") : "";

  document.querySelectorAll(".status-option").forEach((opt) => {
    const raw = opt.dataset.status;
    const st = (raw === "empty") ? null : Number(raw);
    const selected = (st === null && modalStatus === null) || (st !== null && modalStatus === st);
    opt.classList.toggle("selected", selected);
  });

  document.getElementById("modal-overlay").classList.add("show");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("show");
}

function confirmModal() {
  const note = document.getElementById("modal-note").value.trim();
  if (modalStatus === null) {
    updateSlotCell(modalDay, modalSlot, null, "");
  } else {
    updateSlotCell(modalDay, modalSlot, modalStatus, note);
  }
  closeModal();
}

// ── 儲存 ─────────────────────────────────────────────────────────────────────

function initSaveButton() {
  document.getElementById("save-btn").addEventListener("click", saveSchedule);
}

async function saveSchedule() {
  if (saving || !dirty) return;

  saving = true;
  refreshSaveButton();

  // 送全量（105格）：未選取用 status=-1，後端會 delete
  const schedules = [];
  DAY_CODES.forEach((day) => {
    SLOT_CODES.forEach((slot) => {
      const key = keyOf(day, slot);
      const entry = localData[key] || null;
      if (!entry) {
        schedules.push({ day, slot, status: -1, note: "" });
      } else {
        schedules.push({ day, slot, status: Number(entry.status), note: entry.note || "" });
      }
    });
  });

  try {
    const resp = await fetch("/api/schedule", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LiffHelper.getIdToken()}`,
      },
      body: JSON.stringify({ group_id: parseInt(groupId, 10), schedules }),
    });

    if (resp.ok) {
      serverData = JSON.parse(JSON.stringify(localData));
      dirty = false;
      showToast("✅ 已儲存成功！");
    } else {
      showToast("❌ 儲存失敗，請重試");
    }
  } catch (e) {
    showToast("❌ 網路錯誤，請重試");
  } finally {
    saving = false;
    refreshSaveButton();
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

