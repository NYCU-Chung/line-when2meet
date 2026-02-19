/**
 * 統計頁邏輯
 * - 載入群組統計資料
 * - 以「日期標籤」切換單日視圖（比橫向卡片滑動更快）
 * - 點擊格子顯示詳細
 */

const STATUS_LABELS = {
  0: "有空",
  1: "上課",
  2: "忙碌",
  3: "其他",
  4: "睡覺",
  5: "回家",
};
const STATUS_CSS = {
  0: "status-free",
  1: "status-class",
  2: "status-busy",
  3: "status-other",
  4: "status-sleep",
  5: "status-home",
};
const STATS_HELP_SEEN_KEY = "w2m_stats_help_seen_v1";

let statsData = null;
let groupId = null;
let currentDayIndex = 0;
let busyDelayTimer = null;
let avatarResizeBound = false;
let avatarResizeTimer = null;
let selectedUserId = "";
let userSlotMap = new Map();
let selectedUserIds = new Set();
let isFilterActive = false;
let lastAppliedFilterUserIds = new Set();
let pageXScrollBound = false;
let syncingFromCarousel = false;
let syncingFromPageXScroll = false;
let detailCursor = null;

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

function initStatsHelpPanel() {
  const panel = document.getElementById("stats-help-panel");
  const toggle = document.getElementById("stats-help-toggle");
  const closeBtn = document.getElementById("stats-help-close");
  if (!panel || !toggle || !closeBtn) return;

  const setOpen = (open) => {
    panel.classList.toggle("show", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    toggle.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "收起操作教學" : "查看操作教學";
  };

  toggle.addEventListener("click", () => {
    const open = !panel.classList.contains("show");
    setOpen(open);
    markHelpSeen(STATS_HELP_SEEN_KEY);
  });

  closeBtn.addEventListener("click", () => {
    setOpen(false);
    markHelpSeen(STATS_HELP_SEEN_KEY);
  });

  const seen = isHelpSeen(STATS_HELP_SEEN_KEY);
  setOpen(!seen);
  if (!seen) {
    markHelpSeen(STATS_HELP_SEEN_KEY);
  }
}

function isHelpSeen(key) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}

function markHelpSeen(key) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // ignore storage errors
  }
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

  buildUserSlotMap();
  initUserFilter();
  initFilterPanel();
  initQuickFilter();
  initDayTabs();
  initPageXScroll();
  renderAllDays();
  initCarouselDrag();
  initDetailPanel();
  updateLegendHint();
  initStatsHelpPanel();
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
        renderAllDays();
      });
    });
    wrap.appendChild(btn);
  });
}

function initUserFilter() {
  const select = document.getElementById("user-filter");
  if (!select) return;

  const users = getAllUsers().slice().sort((a, b) => {
    return (a.display_name || "").localeCompare((b.display_name || ""), "zh-Hant");
  });

  select.innerHTML = '<option value="">全部人（統計）</option>';
  users.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.user_id;
    opt.textContent = u.display_name || u.user_id;
    select.appendChild(opt);
  });

  select.value = "";
  select.addEventListener("change", async () => {
    selectedUserId = normalizeGroupId(select.value);

    if (selectedUserId) {
      selectedUserIds.clear();
      isFilterActive = false;
      const btn = document.getElementById('filter-btn');
      if (btn) btn.classList.remove('active');
    }

    updateLegendHint();
    renderQuickFilter();
    await runWithBusy("切換檢視中...", async () => {
      await nextFrame();
      renderAllDays();
    });
  });
}

function buildUserSlotMap() {
  userSlotMap = new Map();
  getAllUsers().forEach((u) => {
    userSlotMap.set(u.user_id, {});
  });

  const slots = (statsData && statsData.slots) || {};
  Object.entries(slots).forEach(([slotKey, slotInfo]) => {
    const details = Array.isArray(slotInfo && slotInfo.details) ? slotInfo.details : [];
    details.forEach((item) => {
      if (!item || !item.user_id) return;
      if (!userSlotMap.has(item.user_id)) {
        userSlotMap.set(item.user_id, {});
      }
      userSlotMap.get(item.user_id)[slotKey] = {
        status: Number(item.status),
        note: (item.note || "").toString(),
      };
    });
  });
}

function getSelectedUser() {
  if (!selectedUserId) return null;
  return getAllUsers().find((u) => u.user_id === selectedUserId) || null;
}

function updateLegendHint() {
  const hint = document.getElementById("legend-hint");
  const title = document.getElementById("legend-title");
  const scale = document.getElementById("legend-scale");
  if (!hint) return;
  const selectedUser = getSelectedUser();
  if (selectedUser) {
    if (title) title.textContent = "個人狀態：";
    if (scale) scale.style.display = "none";
    hint.textContent = `（單人模式：${selectedUser.display_name || selectedUser.user_id}）`;
  } else if (isFilterActive) {
    if (title) title.textContent = "有空人數：";
    if (scale) scale.style.display = "";
    hint.textContent = `（已選 ${selectedUserIds.size} 人）`;
  } else {
    if (title) title.textContent = "有空頭像：";
    if (scale) scale.style.display = "";
    hint.textContent = "（點格子看詳情）";
  }
}

function updateDayTabs() {
  document.querySelectorAll(".day-tab").forEach((el, idx) => {
    el.classList.toggle("active", idx === currentDayIndex);
  });
}

function renderAllDays() {
  const container = document.getElementById("day-carousel");
  container.innerHTML = "";

  const total = statsData.total_users || 0;
  const selectedUser = getSelectedUser();

  DAY_CODES.forEach((day, idx) => {
    const card = document.createElement("div");
    card.className = "day-card";
    if (idx === currentDayIndex) {
      card.classList.add("active");
    }
    card.dataset.dayIndex = idx;
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
      slotList.appendChild(createSlotRow(day, slot, slotInfo, total, selectedUser));
    });

    container.appendChild(card);
  });

  if (!selectedUser) {
    requestAnimationFrame(() => refreshAvatarStrips(container));
  }

  refreshPageXScroll();
  scrollToCurrentDay();
}

function createSlotRow(day, slot, slotInfo, total, selectedUser) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const timeLabel = document.createElement("div");
  timeLabel.className = "slot-time-label";
  timeLabel.innerHTML = `<strong>${slot}</strong>${SLOT_TIMES[slot].replace("~", "<br>")}`;

  const cell = document.createElement("div");
  cell.className = "slot-cell";

  if (selectedUser) {
    const entry = getUserSlotEntry(selectedUser.user_id, day, slot);
    renderPersonalSlotCell(cell, entry);
  } else {
    let freeCount, filteredTotal, allUsers;

    if (isFilterActive && selectedUserIds.size > 0) {
      filteredTotal = selectedUserIds.size;
      freeCount = getFilteredFreeCount(slotInfo);
      allUsers = getFilteredUsers();
    } else {
      filteredTotal = total;
      freeCount = slotInfo && typeof slotInfo.free_count === "number" ? slotInfo.free_count : 0;
      allUsers = getAllUsers();
    }

    const freeUsers = getFreeUsers(allUsers, slotInfo);
    const avatarsWrap = document.createElement("div");
    avatarsWrap.className = "slot-avatars";
    cell.appendChild(avatarsWrap);
    cell.__avatarData = { freeUsers, totalUsers: allUsers.length, freeCount };

    const countEl = document.createElement("div");
    countEl.className = `slot-count${allUsers.length > 0 && freeCount === allUsers.length ? " all-free" : ""}`;
    countEl.textContent = filteredTotal > 0 ? `${freeCount}/${filteredTotal}` : "-";
    countEl.title = `有空 ${freeCount} / ${filteredTotal}`;
    cell.appendChild(countEl);
    renderAvatarStripForCell(cell);
  }

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

function getUserSlotEntry(userId, day, slot) {
  const slotKey = `${day}-${slot}`;
  const entries = userSlotMap.get(userId) || {};
  const raw = entries[slotKey];
  if (!raw) {
    return { status: 0, note: "" };
  }

  const n = Number(raw.status);
  return {
    status: Number.isFinite(n) ? n : 0,
    note: (raw.note || "").toString(),
  };
}

function renderPersonalSlotCell(cell, entry) {
  const status = Number(entry.status);
  cell.classList.add("user-mode", `user-status-${Number.isFinite(status) ? status : 0}`);

  const wrap = document.createElement("div");
  wrap.className = "slot-personal";

  const state = document.createElement("span");
  state.className = "slot-personal-state";
  state.textContent = STATUS_LABELS[status] || STATUS_LABELS[3];

  const note = document.createElement("span");
  note.className = "slot-personal-note";
  if (entry.note) {
    note.textContent = entry.note;
  } else {
    note.classList.add("empty");
    note.textContent = status === 0 ? "預設有空" : "未填備註";
  }

  wrap.appendChild(state);
  wrap.appendChild(note);
  cell.appendChild(wrap);
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

function createDetailAvatarEl(user) {
  const el = document.createElement("div");
  el.className = "detail-avatar";
  const name = (user.display_name || "").trim();
  const picture = (user.picture_url || "").trim();

  if (picture) {
    const img = document.createElement("img");
    img.src = picture;
    img.alt = name || "avatar";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      // 圖片載入失敗，顯示首字母
      el.innerHTML = "";
      el.textContent = initialOf(name);
    };
    el.appendChild(img);
  } else {
    // 沒有圖片，直接顯示首字母
    el.textContent = initialOf(name);
  }

  return el;
}

function initQuickFilter() {
  renderQuickFilter();
}

function renderQuickFilter() {
  const wrap = document.getElementById("filter-quick");
  if (!wrap) return;
  wrap.innerHTML = "";

  const totalUsers = getAllUsers().length;
  const allActive = !selectedUserId && !isFilterActive;

  const defs = [
    { key: "all", label: "全部", active: allActive, disabled: totalUsers <= 0 },
    { key: "last", label: "最近篩選", active: false, disabled: lastAppliedFilterUserIds.size <= 0 },
    { key: "invert", label: "反向", active: false, disabled: totalUsers <= 0 || !isFilterActive },
  ];

  defs.forEach((def) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `quick-chip${def.active ? " active" : ""}`;
    btn.textContent = def.label;
    btn.disabled = !!def.disabled;
    btn.addEventListener("click", async () => {
      await applyQuickFilter(def.key);
    });
    wrap.appendChild(btn);
  });
}

async function applyQuickFilter(type) {
  const allUsers = getAllUsers();
  const allIds = new Set(allUsers.map((u) => u.user_id));
  if (allIds.size === 0) return;

  const select = document.getElementById("user-filter");
  selectedUserId = "";
  if (select) select.value = "";

  if (type === "all") {
    selectedUserIds = new Set();
    isFilterActive = false;
  } else if (type === "last") {
    selectedUserIds = new Set(lastAppliedFilterUserIds);
    const total = allIds.size;
    isFilterActive = selectedUserIds.size > 0 && selectedUserIds.size < total;
  } else if (type === "invert") {
    if (!isFilterActive) return;
    const base = isFilterActive ? selectedUserIds : allIds;
    const inverted = new Set();
    allIds.forEach((id) => {
      if (!base.has(id)) inverted.add(id);
    });
    selectedUserIds = inverted;
    const total = allIds.size;
    isFilterActive = selectedUserIds.size > 0 && selectedUserIds.size < total;
  } else {
    return;
  }

  const btn = document.getElementById("filter-btn");
  if (btn) btn.classList.toggle("active", isFilterActive);

  updateLegendHint();
  renderQuickFilter();
  await runWithBusy("更新統計中...", async () => {
    await nextFrame();
    renderAllDays();
  });
}

function initialOf(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0];
}

function initDetailPanel() {
  document.getElementById("panel-close").addEventListener("click", hideDetail);
  document.getElementById("panel-overlay").addEventListener("click", hideDetail);
  document.getElementById("panel-prev").addEventListener("click", () => moveDetail(-1));
  document.getElementById("panel-next").addEventListener("click", () => moveDetail(1));
  document.addEventListener("keydown", (e) => {
    const panel = document.getElementById("detail-panel");
    if (!panel || !panel.classList.contains("show")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveDetail(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveDetail(1);
    }
  });
  refreshDetailNav();
}

function refreshDetailNav() {
  const prev = document.getElementById("panel-prev");
  const next = document.getElementById("panel-next");
  if (!prev || !next) return;
  if (!detailCursor) {
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const totalSlots = DAY_CODES.length * SLOT_CODES.length;
  const absolute = detailCursor.dayIndex * SLOT_CODES.length + detailCursor.slotIndex;
  prev.disabled = absolute <= 0;
  next.disabled = absolute >= (totalSlots - 1);
}

function moveDetail(step) {
  if (!detailCursor) return;
  const totalSlots = DAY_CODES.length * SLOT_CODES.length;
  const absolute = detailCursor.dayIndex * SLOT_CODES.length + detailCursor.slotIndex;
  const nextAbs = Math.max(0, Math.min(totalSlots - 1, absolute + step));
  if (nextAbs === absolute) return;

  const dayIndex = Math.floor(nextAbs / SLOT_CODES.length);
  const slotIndex = nextAbs % SLOT_CODES.length;
  const day = DAY_CODES[dayIndex];
  const slot = SLOT_CODES[slotIndex];
  const total = statsData.total_users || 0;
  const key = `${day}-${slot}`;
  const slotInfo = statsData.slots[key] || { free_count: total, details: [] };
  showDetail(day, slot, slotInfo, total);
}

function initFilterPanel() {
  const btn = document.getElementById('filter-btn');
  const panel = document.getElementById('filter-panel');
  const overlay = document.getElementById('filter-overlay');
  const close = document.getElementById('filter-close');
  const apply = document.getElementById('filter-apply');
  const selectAll = document.getElementById('filter-select-all');
  const selectNone = document.getElementById('filter-select-none');

  btn.addEventListener('click', () => {
    renderFilterList();
    overlay.classList.add('show');
    panel.classList.add('show');
  });

  const closePanel = () => {
    overlay.classList.remove('show');
    panel.classList.remove('show');
  };
  close.addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);

  selectAll.addEventListener('click', () => {
    document.querySelectorAll('.filter-item input[type="checkbox"]').forEach(cb => cb.checked = true);
  });
  selectNone.addEventListener('click', () => {
    document.querySelectorAll('.filter-item input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  apply.addEventListener('click', async () => {
    applyFilter();
    closePanel();
    await runWithBusy('更新統計中...', async () => {
      await nextFrame();
      renderAllDays();
    });
  });
}

function renderFilterList() {
  const list = document.getElementById('filter-list');
  list.innerHTML = '';

  const users = getAllUsers().slice().sort((a, b) =>
    (a.display_name || '').localeCompare(b.display_name || '', 'zh-Hant')
  );

  users.forEach(u => {
    const item = document.createElement('div');
    item.className = 'filter-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = u.user_id;
    checkbox.id = `filter-user-${u.user_id}`;
    checkbox.checked = selectedUserIds.has(u.user_id) || !isFilterActive;

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = u.display_name || u.user_id;
    label.style.flex = '1';
    label.style.cursor = 'pointer';

    item.appendChild(checkbox);
    item.appendChild(label);
    list.appendChild(item);
  });
}

function applyFilter() {
  const checkedBoxes = document.querySelectorAll('.filter-item input[type="checkbox"]:checked');
  selectedUserIds = new Set(Array.from(checkedBoxes).map(cb => cb.value));

  const totalUsers = getAllUsers().length;
  isFilterActive = selectedUserIds.size > 0 && selectedUserIds.size < totalUsers;
  if (isFilterActive) {
    lastAppliedFilterUserIds = new Set(selectedUserIds);
  }

  const btn = document.getElementById('filter-btn');
  btn.classList.toggle('active', isFilterActive);

  const userFilter = document.getElementById('user-filter');
  if (userFilter) userFilter.value = '';
  selectedUserId = '';

  updateLegendHint();
  renderQuickFilter();
}

function getFilteredFreeCount(slotInfo) {
  const busyDetails = slotInfo.details || [];
  const busySet = new Set(busyDetails.map(d => d.user_id));

  let freeCount = 0;
  for (const uid of selectedUserIds) {
    if (!busySet.has(uid)) freeCount++;
  }
  return freeCount;
}

function getFilteredUsers() {
  return getAllUsers().filter(u => selectedUserIds.has(u.user_id));
}

function showDetail(day, slot, slotInfo, total) {
  const panel = document.getElementById("detail-panel");
  const overlay = document.getElementById("panel-overlay");
  detailCursor = {
    dayIndex: Math.max(0, DAY_CODES.indexOf(day)),
    slotIndex: Math.max(0, SLOT_CODES.indexOf(slot)),
  };

  const details = (slotInfo && slotInfo.details) ? slotInfo.details : [];

  const allUsers = (isFilterActive && selectedUserIds.size > 0)
    ? getFilteredUsers()
    : getAllUsers();

  let filteredTotal = (isFilterActive && selectedUserIds.size > 0)
    ? selectedUserIds.size
    : total;

  let freeCount, busyCount;

  if (isFilterActive && selectedUserIds.size > 0) {
    freeCount = getFilteredFreeCount(slotInfo);
    const filteredBusyDetails = details.filter(d => selectedUserIds.has(d.user_id));
    busyCount = filteredBusyDetails.length;
  } else {
    freeCount = (slotInfo && typeof slotInfo.free_count === "number") ? slotInfo.free_count : 0;
    busyCount = details.length;
  }

  const freeUsers = getFreeUsers(allUsers, slotInfo);

  let rawBusyDetails = details;
  if (isFilterActive && selectedUserIds.size > 0) {
    rawBusyDetails = details.filter(d => selectedUserIds.has(d.user_id));
  }
  const busyUsers = [...rawBusyDetails].sort((a, b) => Number(a.status) - Number(b.status));

  document.getElementById("panel-title").textContent = `${DAY_NAMES[day]} ${slot} 節（${SLOT_TIMES[slot]}）`;
  let subline = (
    filteredTotal > 0
      ? `有空 ${freeCount} / ${filteredTotal} 人（非空閒 ${busyCount} 人）`
      : "尚無人參與"
  );
  if (isFilterActive && selectedUserIds.size > 0) {
    subline += ` [已篩選 ${selectedUserIds.size} 人]`;
  }
  const selectedUser = getSelectedUser();
  if (selectedUser) {
    const entry = getUserSlotEntry(selectedUser.user_id, day, slot);
    const label = STATUS_LABELS[entry.status] || STATUS_LABELS[3];
    subline += `｜${selectedUser.display_name || selectedUser.user_id}：${label}`;
  }
  document.getElementById("panel-free-count").textContent = subline;

  const list = document.getElementById("detail-list");
  list.innerHTML = "";

  if (filteredTotal === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "detail-empty-msg";
    emptyMsg.textContent = "尚無人參與";
    list.appendChild(emptyMsg);
  } else {
    appendSectionTitle(list, `有空（${freeUsers.length}）`);
    if (freeUsers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "detail-empty-msg";
      empty.textContent = "此時段目前無人有空";
      list.appendChild(empty);
    } else {
      freeUsers.forEach((item) => {
        const div = document.createElement("div");
        div.className = "detail-item";

        const avatarEl = createDetailAvatarEl(item);
        div.appendChild(avatarEl);

        const infoDiv = document.createElement("div");
        infoDiv.className = "detail-info";
        const nameDiv = document.createElement("div");
        nameDiv.className = "detail-name";
        nameDiv.textContent = item.display_name || "";
        infoDiv.appendChild(nameDiv);
        div.appendChild(infoDiv);

        const statusDiv = document.createElement("div");
        statusDiv.className = `detail-status ${STATUS_CSS[0]}`;
        statusDiv.textContent = STATUS_LABELS[0];
        div.appendChild(statusDiv);

        list.appendChild(div);
      });
    }

    appendSectionTitle(list, `非空閒（${busyUsers.length}）`);
    if (busyUsers.length === 0) {
      const ok = document.createElement("div");
      ok.className = "detail-allfree-msg";
      ok.textContent = "✅ 此時段所有人都有空";
      list.appendChild(ok);
    } else {
      busyUsers.forEach((item) => {
        const div = document.createElement("div");
        div.className = "detail-item";

        const avatarEl = createDetailAvatarEl(item);
        div.appendChild(avatarEl);

        const infoDiv = document.createElement("div");
        infoDiv.className = "detail-info";
        const nameDiv = document.createElement("div");
        nameDiv.className = "detail-name";
        nameDiv.textContent = item.display_name || "";
        infoDiv.appendChild(nameDiv);

        if (item.note) {
          const noteDiv = document.createElement("div");
          noteDiv.className = "detail-note";
          noteDiv.textContent = item.note;
          infoDiv.appendChild(noteDiv);
        }

        div.appendChild(infoDiv);

        const statusDiv = document.createElement("div");
        statusDiv.className = `detail-status ${STATUS_CSS[item.status] || "status-other"}`;
        statusDiv.textContent = STATUS_LABELS[item.status] || "其他";
        div.appendChild(statusDiv);

        list.appendChild(div);
      });
    }
  }

  overlay.classList.add("show");
  panel.classList.add("show");
  refreshDetailNav();
}

function appendSectionTitle(list, text) {
  const title = document.createElement("div");
  title.className = "detail-section-title";
  title.textContent = text;
  list.appendChild(title);
}

function hideDetail() {
  detailCursor = null;
  refreshDetailNav();
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
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function initPageXScroll() {
  if (pageXScrollBound) {
    refreshPageXScroll();
    return;
  }

  const carousel = document.getElementById("day-carousel");
  const pageXScroll = document.getElementById("stats-page-xscroll");
  const spacer = document.getElementById("stats-page-xscroll-spacer");
  if (!carousel || !pageXScroll || !spacer) return;

  pageXScrollBound = true;

  pageXScroll.addEventListener("scroll", () => {
    if (syncingFromCarousel) return;
    const metrics = getPageXScrollMetrics(carousel, pageXScroll);
    if (!metrics) return;

    syncingFromPageXScroll = true;
    const ratio = metrics.maxPageScroll > 0 ? (pageXScroll.scrollLeft / metrics.maxPageScroll) : 0;
    carousel.scrollLeft = ratio * metrics.maxCarouselScroll;
    syncingFromPageXScroll = false;
  }, { passive: true });

  carousel.addEventListener("scroll", () => {
    if (syncingFromPageXScroll) return;
    syncPageXScrollFromCarousel();
  }, { passive: true });

  window.addEventListener("resize", refreshPageXScroll);
  refreshPageXScroll();
}

function refreshPageXScroll() {
  const carousel = document.getElementById("day-carousel");
  const pageXScroll = document.getElementById("stats-page-xscroll");
  const spacer = document.getElementById("stats-page-xscroll-spacer");
  if (!carousel || !pageXScroll || !spacer) return;

  const desktop = (window.innerWidth || document.documentElement.clientWidth || 0) >= 960;
  const maxCarouselScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  if (!desktop || maxCarouselScroll <= 0) {
    pageXScroll.classList.remove("show");
    pageXScroll.scrollLeft = 0;
    spacer.style.width = "0px";
    return;
  }

  pageXScroll.classList.add("show");
  spacer.style.width = `${Math.ceil(carousel.scrollWidth)}px`;
  syncPageXScrollFromCarousel();
}

function syncPageXScrollFromCarousel() {
  const carousel = document.getElementById("day-carousel");
  const pageXScroll = document.getElementById("stats-page-xscroll");
  if (!carousel || !pageXScroll || !pageXScroll.classList.contains("show")) return;

  const metrics = getPageXScrollMetrics(carousel, pageXScroll);
  if (!metrics) return;

  syncingFromCarousel = true;
  const ratio = metrics.maxCarouselScroll > 0 ? (carousel.scrollLeft / metrics.maxCarouselScroll) : 0;
  pageXScroll.scrollLeft = ratio * metrics.maxPageScroll;
  syncingFromCarousel = false;
}

function getPageXScrollMetrics(carousel, pageXScroll) {
  const maxCarouselScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  const maxPageScroll = Math.max(0, pageXScroll.scrollWidth - pageXScroll.clientWidth);
  if (maxCarouselScroll <= 0 || maxPageScroll <= 0) return null;
  return { maxCarouselScroll, maxPageScroll };
}

function scrollToCurrentDay() {
  const container = document.getElementById("day-carousel");
  if (!container) return;

  const cards = container.querySelectorAll(".day-card");
  const targetCard = cards[currentDayIndex];
  if (!targetCard) return;

  // Update active class
  cards.forEach((card, idx) => {
    card.classList.toggle("active", idx === currentDayIndex);
  });

  // Scroll to the target card
  targetCard.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

function initCarouselDrag() {
  const container = document.getElementById("day-carousel");
  if (!container) return;

  let isDown = false;
  let startX;
  let scrollLeft;

  container.addEventListener("mousedown", (e) => {
    // Only enable drag on desktop (width >= 960px)
    if (window.innerWidth < 960) return;

    isDown = true;
    container.style.cursor = "grabbing";
    container.style.userSelect = "none";
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  });

  container.addEventListener("mouseleave", () => {
    isDown = false;
    container.style.cursor = "grab";
    container.style.userSelect = "";
  });

  container.addEventListener("mouseup", () => {
    isDown = false;
    container.style.cursor = "grab";
    container.style.userSelect = "";
  });

  container.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - container.offsetLeft;
    const walk = (x - startX) * 2; // Scroll speed multiplier
    container.scrollLeft = scrollLeft - walk;
  });

  // Set initial cursor on desktop
  if (window.innerWidth >= 960) {
    container.style.cursor = "grab";
  }
}
