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
let avatarResizeBound = false;
let avatarResizeTimer = null;

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
  bindAvatarAutoLayout();
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
  requestAnimationFrame(() => refreshAvatarStrips(container));
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
  const allUsers = getAllUsers();
  const freeUsers = getFreeUsers(allUsers, slotInfo);
  const avatarsWrap = document.createElement("div");
  avatarsWrap.className = "slot-avatars";
  cell.appendChild(avatarsWrap);
  cell.__avatarData = { freeUsers, totalUsers: allUsers.length, freeCount };

  const countEl = document.createElement("div");
  countEl.className = `slot-count${allUsers.length > 0 && freeCount === allUsers.length ? " all-free" : ""}`;
  countEl.textContent = total > 0 ? `${freeCount}/${total}` : "-";
  countEl.title = `有空 ${freeCount} / ${total}`;
  cell.appendChild(countEl);
  renderAvatarStripForCell(cell);

  cell.addEventListener("click", () => showDetail(day, slot, slotInfo, total));

  row.appendChild(timeLabel);
  row.appendChild(cell);
  return row;
}

function getAllUsers() {
  const users = Array.isArray(statsData && statsData.users) ? statsData.users : [];
  return users.filter((u) => u && typeof u.user_id === "string" && u.user_id);
}

function getFreeUsers(allUsers, slotInfo) {
  const busyDetails = Array.isArray(slotInfo && slotInfo.details) ? slotInfo.details : [];
  const busySet = new Set(busyDetails.map((x) => x && x.user_id).filter(Boolean));
  return allUsers.filter((u) => !busySet.has(u.user_id));
}

function renderAvatarStripForCell(cell) {
  if (!cell || !cell.__avatarData) return;
  const data = cell.__avatarData;
  const wrap = cell.querySelector(".slot-avatars");
  if (!wrap) return;

  const maxVisible = calcAvatarVisibleCount(cell, data.freeUsers.length);
  renderAvatarStrip(wrap, data.freeUsers, data.totalUsers, data.freeCount, maxVisible);
}

function renderAvatarStrip(wrap, freeUsers, totalUsers, freeCount, maxVisible) {
  wrap.innerHTML = "";

  if (totalUsers <= 0) {
    const empty = document.createElement("span");
    empty.className = "slot-avatar-empty";
    empty.textContent = "尚無資料";
    wrap.appendChild(empty);
    return;
  }

  const visibleCount = Math.max(1, Math.min(freeUsers.length, maxVisible));
  const displayUsers = freeUsers.slice(0, visibleCount);
  displayUsers.forEach((u) => wrap.appendChild(createAvatarEl(u)));

  const hidden = freeUsers.length - displayUsers.length;
  if (hidden > 0) {
    const more = document.createElement("span");
    more.className = "slot-avatar slot-avatar-more";
    more.textContent = `+${hidden}`;
    more.title = `還有 ${hidden} 位有空`;
    wrap.appendChild(more);
  }

  if (freeCount <= 0) {
    const none = document.createElement("span");
    none.className = "slot-avatar-empty";
    none.textContent = "無人有空";
    wrap.appendChild(none);
  }
}

function calcAvatarVisibleCount(cell, freeUserCount) {
  if (freeUserCount <= 0) return 0;
  const countEl = cell.querySelector(".slot-count");
  const rect = cell.getBoundingClientRect();
  const cellWidth = rect.width || cell.clientWidth || 0;
  if (!cellWidth) return freeUserCount;

  const styles = window.getComputedStyle(cell);
  const padLeft = parseFloat(styles.paddingLeft) || 0;
  const padRight = parseFloat(styles.paddingRight) || 0;
  const gap = parseFloat(styles.columnGap || styles.gap) || 8;
  const countWidth = countEl ? (countEl.getBoundingClientRect().width || 44) : 44;
  const available = cellWidth - padLeft - padRight - countWidth - gap;
  if (available <= 0) return 1;

  const avatarSize = getAvatarSize();
  const overlap = getAvatarOverlap();
  const step = Math.max(1, avatarSize - overlap);

  const footprint = (n) => (n <= 0 ? 0 : (avatarSize + (n - 1) * step));
  const moreWidth = getAvatarMoreWidth();

  let visible = 1 + Math.floor(Math.max(0, available - avatarSize) / step);
  visible = Math.max(1, Math.min(freeUserCount, visible));

  if (visible < freeUserCount) {
    while (visible > 1 && footprint(visible) + moreWidth > available) {
      visible -= 1;
    }
  }
  return visible;
}

function getAvatarSize() {
  if (window.matchMedia("(max-width: 640px)").matches) return 20;
  if (window.matchMedia("(min-width: 960px)").matches) return 24;
  return 22;
}

function getAvatarOverlap() {
  if (window.matchMedia("(max-width: 640px)").matches) return 5;
  if (window.matchMedia("(min-width: 960px)").matches) return 7;
  return 6;
}

function getAvatarMoreWidth() {
  if (window.matchMedia("(max-width: 640px)").matches) return 30;
  if (window.matchMedia("(min-width: 960px)").matches) return 36;
  return 34;
}

function refreshAvatarStrips(root = document) {
  root.querySelectorAll(".slot-cell").forEach((cell) => renderAvatarStripForCell(cell));
}

function bindAvatarAutoLayout() {
  if (avatarResizeBound) return;
  avatarResizeBound = true;
  window.addEventListener("resize", () => {
    clearTimeout(avatarResizeTimer);
    avatarResizeTimer = setTimeout(() => refreshAvatarStrips(), 100);
  });
}

function createAvatarEl(user) {
  const el = document.createElement("span");
  el.className = "slot-avatar";
  const name = (user.display_name || "").trim();
  el.title = `${name || "未知使用者"} 有空`;

  const picture = (user.picture_url || "").trim();
  if (picture) {
    const img = document.createElement("img");
    img.src = picture;
    img.alt = name || "avatar";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      el.innerHTML = "";
      const fallback = document.createElement("span");
      fallback.className = "slot-avatar-fallback";
      fallback.textContent = initialOf(name);
      el.appendChild(fallback);
    };
    el.appendChild(img);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "slot-avatar-fallback";
    fallback.textContent = initialOf(name);
    el.appendChild(fallback);
  }
  return el;
}

function initialOf(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0];
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
