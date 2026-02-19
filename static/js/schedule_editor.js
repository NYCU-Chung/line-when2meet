/**
 * 課表填寫頁邏輯
 * - LIFF 登入 → 載入個人排程 → 支援筆刷拖曳（一次性）→ 儲存
 *
 * 狀態說明：
 * - 空白格 = 預設有空（不儲存）
 * - 1~5 = 非空閒狀態（會儲存）
 */

// 所有狀態都顯示 icon（包括 status=0 有空）
const STATUS_CONFIG = {
  0: { label: "有空", icon: "✅", cls: "status-0" },
  1: { label: "上課", icon: "📚", cls: "status-1" },
  2: { label: "忙碌", icon: "🔴", cls: "status-2" },
  3: { label: "其他", icon: "⚪", cls: "status-3" },
  4: { label: "睡覺", icon: "😴", cls: "status-4" },
  5: { label: "回家", icon: "🏠", cls: "status-5" },
};

// 伺服器回傳的 {day-slot: {status, note}}（只包含已選取的格子）
let serverData = {};
// 本地端編輯中的 {day-slot: {status, note}}（只包含已選取的格子）
let localData = {};

let groupId = null;
let currentDayIndex = 0;

let dirty = false;
let saving = false;

// 筆刷狀態：0 代表清除（回到預設有空）
let brushStatus = null;
let brushArmed = false;
let floatingScrollbarInited = false;
let floatingScrollbarDragging = false;
let floatingScrollbarDragStartX = 0;
let floatingScrollbarDragStartLeft = 0;

function normalizeGroupId(v) {
  return (v || "").toString().trim();
}

function resolveGroupId() {
  const fromParam = normalizeGroupId(LiffHelper.getParam("group") || LiffHelper.getParam("group_id"));
  if (fromParam) return fromParam;
  const fromTemplate = normalizeGroupId(typeof INITIAL_GROUP_ID === "string" ? INITIAL_GROUP_ID : "");
  if (fromTemplate) return fromTemplate;
  return "";
}

function keyOf(day, slot) {
  return `${day}-${slot}`;
}

function getEntry(day, slot) {
  return localData[keyOf(day, slot)] || null;
}

function setEntry(day, slot, statusOrNull, note) {
  const key = keyOf(day, slot);
  const status = (statusOrNull === null || statusOrNull === undefined) ? 0 : Number(statusOrNull);

  // 如果是 status=0 且沒有註解，則刪除（節省儲存空間）
  if (status === 0 && !note) {
    delete localData[key];
    return;
  }

  // 儲存資料（包括有註解的 status=0）
  localData[key] = { status: status, note: note || "" };
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

function setBrushMode(statusOrNull) {
  const bar = document.getElementById("brushbar");
  const state = document.getElementById("brush-state");

  const parsed = Number(statusOrNull);
  if (statusOrNull === null || statusOrNull === undefined || Number.isNaN(parsed)) {
    brushArmed = false;
    brushStatus = null;
  } else {
    brushArmed = true;
    brushStatus = parsed;
  }

  if (bar) {
    bar.querySelectorAll(".brush-btn").forEach((btn) => {
      const st = Number(btn.dataset.status);
      btn.classList.toggle("is-active", brushArmed && st === brushStatus);
    });
  }

  if (state) {
    if (!brushArmed) {
      state.textContent = "已關閉";
      state.classList.remove("is-armed");
    } else {
      const modeName = STATUS_CONFIG[brushStatus]?.label || "筆刷";
      state.textContent = `${modeName}模式`;
      state.classList.add("is-armed");
    }
  }

  document.body.classList.toggle("paint-armed", brushArmed);
  if (!brushArmed) stopAutoScrollLoop();
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  groupId = resolveGroupId();
  setLoadingText("登入中...");

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

  // /api/schedule 會自動 upsert user/group，因此不需額外打一支 /api/auth。
  setLoadingText("載入課表中...");
  const loaded = await loadSchedule();
  if (!loaded) return;

  setLoadingText("生成畫面中...");
  renderCarousel();
  initFloatingScrollbar();
  // Let browser paint the generated DOM before switching screens.
  await nextFrame();

  document.getElementById("loading").style.display = "none";
  document.getElementById("main-content").style.display = "block";

  initDayIndicator();
  initModal();
  initBrushBar();
  setBrushMode(null);
  initPaintHandlers();
  initSaveButton();

  dirty = false;
  refreshSaveButton();
});

// ── 載入排程 ─────────────────────────────────────────────────────────────────

async function loadSchedule() {
  try {
    const resp = await fetchWithAuthRetry(`/api/schedule?group=${encodeURIComponent(groupId)}`);
    if (!resp.ok) {
      let msg = `載入失敗（${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) msg = String(data.error);
        if (resp.status === 401) msg = "登入狀態失效，請重新整理；若仍失敗請回到 LINE 重新開啟";
        if (resp.status === 503) msg = "LINE 驗證服務暫時忙碌，請稍候重試";
        if (resp.status === 410) msg = "連結已過期，請回到群組輸入 when2meet 取得新連結";
        if (data && data.detail) msg = `${msg}：${String(data.detail).slice(0, 80)}`;
      } catch { /* ignore */ }
      showError(msg);
      return false;
    }
    const data = await resp.json();
    serverData = data.schedules || {};
    localData = JSON.parse(JSON.stringify(serverData)); // deep copy
    return true;
  } catch (e) {
    console.error(e);
    showError("網路錯誤，請稍候重試");
    return false;
  }
}

// ── 渲染 Carousel ──────────────────────────────────────────────────────────

function renderCarousel() {
  const carousel = document.getElementById("day-carousel");
  carousel.innerHTML = "";
  const fragment = document.createDocumentFragment();

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

    fragment.appendChild(card);
  });
  carousel.appendChild(fragment);

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
  refreshFloatingScrollbar();
}

function initFloatingScrollbar() {
  if (floatingScrollbarInited) {
    refreshFloatingScrollbar();
    return;
  }

  const carousel = document.getElementById("day-carousel");
  const overlay = document.getElementById("carousel-scrollbar-overlay");
  const thumb = document.getElementById("carousel-scrollbar-thumb");
  if (!carousel || !overlay || !thumb) return;

  floatingScrollbarInited = true;

  const endDrag = () => {
    floatingScrollbarDragging = false;
  };

  thumb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!overlay.classList.contains("show")) return;
    e.preventDefault();
    floatingScrollbarDragging = true;
    floatingScrollbarDragStartX = e.clientX;
    floatingScrollbarDragStartLeft = carousel.scrollLeft;
    try { thumb.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target === thumb) return;
    if (!overlay.classList.contains("show")) return;
    e.preventDefault();

    const metrics = getFloatingScrollbarMetrics(carousel, overlay, thumb);
    if (!metrics) return;

    const targetThumbX = clamp(
      e.clientX - metrics.trackLeft - (metrics.thumbWidth / 2),
      0,
      metrics.maxThumbX
    );
    carousel.scrollLeft = metrics.maxThumbX > 0
      ? (targetThumbX / metrics.maxThumbX) * metrics.maxScroll
      : 0;
  });

  window.addEventListener("pointermove", (e) => {
    if (!floatingScrollbarDragging) return;

    const metrics = getFloatingScrollbarMetrics(carousel, overlay, thumb);
    if (!metrics) return;

    const deltaX = e.clientX - floatingScrollbarDragStartX;
    const ratio = metrics.maxThumbX > 0 ? (metrics.maxScroll / metrics.maxThumbX) : 0;
    const nextLeft = floatingScrollbarDragStartLeft + (deltaX * ratio);
    carousel.scrollLeft = clamp(nextLeft, 0, metrics.maxScroll);
  }, { passive: true });

  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  carousel.addEventListener("scroll", refreshFloatingScrollbar, { passive: true });
  window.addEventListener("resize", refreshFloatingScrollbar);

  refreshFloatingScrollbar();
}

function refreshFloatingScrollbar() {
  const carousel = document.getElementById("day-carousel");
  const overlay = document.getElementById("carousel-scrollbar-overlay");
  const thumb = document.getElementById("carousel-scrollbar-thumb");
  if (!carousel || !overlay || !thumb) return;

  const metrics = getFloatingScrollbarMetrics(carousel, overlay, thumb);
  if (!metrics) {
    overlay.classList.remove("show");
    return;
  }

  overlay.classList.add("show");
  thumb.style.width = `${metrics.thumbWidth}px`;
  const thumbX = metrics.maxScroll > 0
    ? (carousel.scrollLeft / metrics.maxScroll) * metrics.maxThumbX
    : 0;
  thumb.style.transform = `translateX(${thumbX}px)`;
}

function getFloatingScrollbarMetrics(carousel, overlay) {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return null;
  }

  const maxScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  if (maxScroll <= 0) return null;

  const trackWidth = overlay.clientWidth;
  if (!trackWidth) return null;

  const rawThumb = trackWidth * (carousel.clientWidth / carousel.scrollWidth);
  const thumbWidth = Math.max(56, Math.round(rawThumb));
  const maxThumbX = Math.max(1, trackWidth - thumbWidth);
  const trackLeft = overlay.getBoundingClientRect().left;
  return { maxScroll, trackWidth, thumbWidth, maxThumbX, trackLeft };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

  // Tap to edit note/status. Drag painting will set suppressClickUntil.
  cell.addEventListener("click", () => {
    if (Date.now() < suppressClickUntil) return;
    openModal(day, slot);
  });

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

function applyCellVisual(cell, statusOrNull, note) {
  const status = (statusOrNull === null || statusOrNull === undefined) ? 0 : Number(statusOrNull);
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG[0];  // fallback 到有空

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

  const stNum = (statusOrNull === null || statusOrNull === undefined) ? 0 : Number(statusOrNull);

  if (stNum === 0 || Number.isNaN(stNum)) {
    if (existing) {
      delete localData[key];
      markDirty();
    }
  } else {
    const status = stNum;
    if (!STATUS_CONFIG[status]) return;
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
  if (!indicator) return;
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
  const dots = document.querySelectorAll(".day-dot");
  if (!dots.length) return;
  dots.forEach((dot, idx) => {
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
    const selectedStatus = Number(raw);
    if (Number.isNaN(selectedStatus)) return;

    if (brushArmed && brushStatus === selectedStatus) {
      setBrushMode(null);
      return;
    }
    setBrushMode(selectedStatus);
  });
}

// ── 拖曳塗色（一次選多格）────────────────────────────────────────────────────

let pointerState = null;
let suppressClickUntil = 0;
const AUTO_SCROLL_EDGE_PX = 88;
const AUTO_SCROLL_MAX_STEP_PX = 5;
let autoScrollRaf = null;

function stopAutoScrollLoop() {
  if (!autoScrollRaf) return;
  cancelAnimationFrame(autoScrollRaf);
  autoScrollRaf = null;
}

function startAutoScrollLoop() {
  if (autoScrollRaf) return;
  autoScrollRaf = requestAnimationFrame(autoScrollTick);
}

function autoScrollTick() {
  autoScrollRaf = null;
  if (!brushArmed || !pointerState || !pointerState.isPainting) return;

  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const y = pointerState.lastY;
  const x = pointerState.lastX;

  let delta = 0;
  if (y > viewportH - AUTO_SCROLL_EDGE_PX) {
    const ratio = (y - (viewportH - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX;
    delta = Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
  } else if (y < AUTO_SCROLL_EDGE_PX) {
    const ratio = (AUTO_SCROLL_EDGE_PX - y) / AUTO_SCROLL_EDGE_PX;
    delta = -Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
  }

  if (delta !== 0) {
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - viewportH);
    const prevY = window.scrollY;
    const nextY = Math.min(maxScrollY, Math.max(0, prevY + delta));
    if (nextY !== prevY) {
      window.scrollTo({ top: nextY, behavior: "auto" });
      // Sample around finger point so cells passing during auto-scroll are painted.
      const offsets = delta > 0 ? [0, -18, -36] : [0, 18, 36];
      offsets.forEach((off) => paintFromPoint(x, y + off));
    }
  }

  autoScrollRaf = requestAnimationFrame(autoScrollTick);
}

function initPaintHandlers() {
  const carousel = document.getElementById("day-carousel");
  if (!carousel) return;

  carousel.addEventListener("pointerdown", (e) => {
    if (!brushArmed) return;
    const cell = e.target.closest(".slot-cell");
    if (!cell) return;

    pointerState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startCell: cell,
      isPainting: true,
      visited: new Set(),
    };

    paintCell(cell);
    startAutoScrollLoop();
    e.preventDefault();
    try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, { passive: false });

  carousel.addEventListener("pointermove", (e) => {
    if (!brushArmed || !pointerState || pointerState.pointerId !== e.pointerId) return;
    pointerState.lastX = e.clientX;
    pointerState.lastY = e.clientY;
    e.preventDefault();
    paintFromPoint(e.clientX, e.clientY);
  }, { passive: false });

  const end = (e) => {
    if (!pointerState || pointerState.pointerId !== e.pointerId) return;
    stopAutoScrollLoop();

    const usedBrush = pointerState.visited.size > 0;

    pointerState = null;
    if (usedBrush) {
      suppressClickUntil = Date.now() + 450;
      // One-shot brush: after one drag/tap paint, return to normal scroll mode.
      setBrushMode(null);
    }
  };

  carousel.addEventListener("pointerup", end);
  carousel.addEventListener("pointercancel", end);
}

function paintFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const cell = el && el.closest ? el.closest(".slot-cell") : null;
  if (cell) paintCell(cell);
}

function paintCell(cell) {
  if (!pointerState || !brushArmed) return;
  const day = cell.dataset.day;
  const slot = cell.dataset.slot;
  if (!day || !slot) return;

  const key = keyOf(day, slot);
  if (pointerState.visited.has(key)) return;
  pointerState.visited.add(key);

  if (brushStatus === 0) {
    updateSlotCell(day, slot, 0, "");
    return;
  }

  const existing = localData[key] || null;
  const nextStatus = Number(brushStatus);
  if (!STATUS_CONFIG[nextStatus]) return;
  // 避免不小心把已寫備註的格子刷過就清掉備註：狀態沒變就保留 note。
  const nextNote = (existing && existing.status === nextStatus) ? (existing.note || "") : "";
  updateSlotCell(day, slot, nextStatus, nextNote);
}

// ── Modal（單格編輯）────────────────────────────────────────────────────────

let modalDay = null;
let modalSlot = null;
let modalStatus = 0; // 0=有空（預設）

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
      modalStatus = Number(raw);
      document.querySelectorAll(".status-option").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
      updateModalNoteState();
    });
  });
}

function updateModalNoteState() {
  // 移除禁用邏輯，所有狀態都可以加註解
  const noteEl = document.getElementById("modal-note");
  if (!noteEl) return;
  // 備註框永遠啟用
  noteEl.disabled = false;
}

function openModal(day, slot) {
  modalDay = day;
  modalSlot = slot;

  const entry = getEntry(day, slot);
  modalStatus = entry ? Number(entry.status) : 0;

  document.getElementById("modal-title").textContent =
    `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  document.getElementById("modal-note").value = entry ? (entry.note || "") : "";
  updateModalNoteState();

  document.querySelectorAll(".status-option").forEach((opt) => {
    const raw = opt.dataset.status;
    const st = Number(raw);
    opt.classList.toggle("selected", st === modalStatus);
  });

  document.getElementById("modal-overlay").classList.add("show");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("show");
}

function confirmModal() {
  const note = document.getElementById("modal-note").value.trim();
  if (Number(modalStatus) === 0) {
    updateSlotCell(modalDay, modalSlot, 0, "");
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

  // 只送差異，避免 sqlite 寫入過多造成 lock
  const schedules = [];
  const allKeys = new Set([...Object.keys(serverData), ...Object.keys(localData)]);
  for (const key of allKeys) {
    const [day, slot] = key.split("-");
    if (!day || !slot) continue;

    const s = serverData[key] || null;
    const l = localData[key] || null;

    const sStatus = s ? Number(s.status) : 0;
    const lStatus = l ? Number(l.status) : 0;
    const sNote = s ? (s.note || "") : "";
    const lNote = l ? (l.note || "") : "";

    if (sStatus === lStatus && sNote === lNote) continue;

    if (!l) schedules.push({ day, slot, status: 0, note: "" });
    else schedules.push({ day, slot, status: lStatus, note: lNote });
  }

  if (schedules.length === 0) {
    dirty = false;
    saving = false;
    refreshSaveButton();
    return;
  }

  try {
    const resp = await fetchWithAuthRetry("/api/schedule", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ group: groupId, schedules }),
    });

    if (resp.ok) {
      serverData = JSON.parse(JSON.stringify(localData));
      dirty = false;
      showToast("✅ 已儲存成功！");
    } else {
      let msg = `❌ 儲存失敗（${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) msg = `❌ ${data.error}`;
        if (resp.status === 401) msg = "❌ 登入狀態失效，請重新整理；若仍失敗請回到 LINE 重新開啟";
        if (resp.status === 503) msg = "❌ LINE 驗證服務暫時忙碌，請稍候重試";
        if (data && data.detail) msg = `${msg}：${String(data.detail).slice(0, 80)}`;
      } catch { /* ignore */ }
      showToast(msg);
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
    <div class="loading-error">
      <div class="loading-error-icon">⚠️</div>
      <div>${msg}</div>
    </div>`;
}

async function fetchWithAuthRetry(url, options = {}, retried = false, preferAccessToken = false) {
  const cred = getAuthCredential(preferAccessToken);
  if (!cred && !retried) {
    const recovered = await LiffHelper.recoverAuth(LIFF_ID);
    if (recovered) {
      return fetchWithAuthRetry(url, options, true, true);
    }
  }

  const headers = {
    ...(options.headers || {}),
    ...(cred ? {
      Authorization: `Bearer ${cred.token}`,
      "X-Line-Token-Type": cred.type,
    } : {}),
  };
  const resp = await fetch(url, { ...options, headers });
  if (resp.status !== 401 || retried) {
    return resp;
  }

  const recovered = await LiffHelper.recoverAuth(LIFF_ID);
  if (!recovered) {
    return resp;
  }

  // Retry once and prefer access_token on the second attempt.
  return fetchWithAuthRetry(url, options, true, true);
}

function getAuthCredential(preferAccessToken = false) {
  const accessToken = (LiffHelper.getAccessToken() || "").trim();
  const idToken = (LiffHelper.getIdToken() || "").trim();

  if (preferAccessToken && accessToken) {
    return { token: accessToken, type: "access_token" };
  }

  if (idToken && !isLikelyExpiredIdToken(idToken)) {
    return { token: idToken, type: "id_token" };
  }

  if (accessToken) {
    return { token: accessToken, type: "access_token" };
  }

  // Last fallback: still try id_token if access_token is unavailable.
  if (idToken) {
    return { token: idToken, type: "id_token" };
  }

  return null;
}

function isLikelyExpiredIdToken(token, skewSec = 20) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return false;
  try {
    const data = JSON.parse(payload);
    const exp = Number(data && data.exp);
    if (!Number.isFinite(exp)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return exp <= (nowSec + skewSec);
  } catch {
    return false;
  }
}

function decodeBase64Url(input) {
  if (!input) return "";
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  try {
    return atob(padded);
  } catch {
    return "";
  }
}

function setLoadingText(msg) {
  const el = document.getElementById("loading-text");
  if (el) el.textContent = msg;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
