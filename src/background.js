// =============================================================================
// Essential Tabs for Brave
// =============================================================================
// Simple, reliable pinned tab management.
// - Base URL lock (pinned tabs can't navigate away from their origin)
// - Offload cascade (extension icon click offloads pinned tabs)
// - Single window mode (optional, toggle via right-click)
// - Startup offloading (pinned tabs auto-offload on browser launch)
// =============================================================================

// --- Persistent storage for pinned tab base URLs ---
// MV3 service workers restart often — we persist to chrome.storage.local
// so the lock survives restarts.
let pinnedTabBaseUrls = {}; // { tabId: origin }

// Load from storage immediately on every service worker wake
const ready = (async () => {
  const data = await chrome.storage.local.get("pinnedTabBaseUrls");
  if (data.pinnedTabBaseUrls) {
    pinnedTabBaseUrls = data.pinnedTabBaseUrls;
  }
  // Reconcile with actual tabs
  const tabs = await chrome.tabs.query({ pinned: true });
  const validIds = new Set();
  for (const tab of tabs) {
    validIds.add(String(tab.id));
    if (!pinnedTabBaseUrls[tab.id]) {
      const url = tab.pendingUrl || tab.url;
      if (url && url !== "about:blank" && !url.startsWith("chrome://")) {
        pinnedTabBaseUrls[tab.id] = getOrigin(url);
      }
    }
  }
  // Remove stale entries
  for (const id of Object.keys(pinnedTabBaseUrls)) {
    if (!validIds.has(id)) delete pinnedTabBaseUrls[id];
  }
  save();
})();

function save() {
  chrome.storage.local.set({ pinnedTabBaseUrls });
}

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// =============================================================================
// Extension icon click — offload/cascade
// =============================================================================
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.pinned) {
    // Normal tab: close it (unless it's the last one with all pinned offloaded)
    const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
    if (unpinnedTabs.length <= 1) {
      const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
      const allPinnedOffloaded = pinnedTabs.length > 0 && pinnedTabs.every(t => t.discarded);
      if (allPinnedOffloaded) {
        chrome.tabs.update(tab.id, { url: "chrome://newtab" });
        return;
      }
    }
    chrome.tabs.remove(tab.id);
  } else {
    // Pinned tab: offload it, cascade to next
    const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
    const nextActive = pinnedTabs.find(t => t.id !== tab.id && !t.discarded);

    if (nextActive) {
      await chrome.tabs.update(nextActive.id, { active: true });
      chrome.tabs.discard(tab.id).catch(() => {});
    } else {
      const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
      if (unpinnedTabs.length > 0) {
        await chrome.tabs.update(unpinnedTabs[0].id, { active: true });
        chrome.tabs.discard(tab.id).catch(() => {});
      }
    }
  }
});

// =============================================================================
// Track when tabs are pinned/unpinned
// =============================================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;

  if (tab.pinned) {
    // Capture base URL if we don't have it yet
    const url = tab.pendingUrl || tab.url;
    if (!pinnedTabBaseUrls[tabId] && url && url !== "about:blank" && !url.startsWith("chrome://")) {
      pinnedTabBaseUrls[tabId] = getOrigin(url);
      save();
    }
  }

  if (changeInfo.pinned === false) {
    delete pinnedTabBaseUrls[tabId];
    save();
  }
});

// =============================================================================
// Handle tab removal — keep a normal tab alive
// =============================================================================
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  delete pinnedTabBaseUrls[tabId];
  save();

  if (removeInfo.isWindowClosing) return;

  const windowId = removeInfo.windowId;
  const remaining = await chrome.tabs.query({ windowId });
  const hasUnpinned = remaining.some(t => !t.pinned);

  if (!hasUnpinned && remaining.length > 0) {
    const hasActive = remaining.some(t => t.pinned && !t.discarded);
    chrome.tabs.create({ active: !hasActive, windowId });
  }
});

// =============================================================================
// BASE URL LOCK — the core feature
// =============================================================================
// When a pinned tab tries to navigate to a different origin:
// 1. Open the URL in a new tab
// 2. Send the pinned tab back with goBack()
//
// This is the simplest approach that works reliably in MV3.
// goBack() preserves the page state in most cases.
// =============================================================================

const recentNavs = new Set();

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await ready;

  const tabId = details.tabId;
  const baseOrigin = pinnedTabBaseUrls[tabId];
  if (!baseOrigin) return;

  const newOrigin = getOrigin(details.url);
  if (newOrigin === baseOrigin) return;

  // Allow browser internal pages
  if (
    details.url.startsWith("chrome://") ||
    details.url.startsWith("chrome-extension://") ||
    details.url.startsWith("brave://")
  ) return;

  // Dedup rapid navigations (redirects, double-clicks)
  const key = `${tabId}:${details.url}`;
  if (recentNavs.has(key)) return;
  recentNavs.add(key);
  setTimeout(() => recentNavs.delete(key), 2000);

  // Open blocked URL in a new tab
  chrome.tabs.create({ url: details.url, active: true });

  // Send the pinned tab back to where it was
  chrome.tabs.goBack(tabId).catch(() => {
    // If there's no history, reload the base URL (only happens on fresh pins)
    chrome.tabs.update(tabId, { url: baseOrigin + "/" });
  });
});

// =============================================================================
// Single Window Mode
// =============================================================================
let primaryWindowId = null;

async function initPrimaryWindow() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normal = windows.filter(w => !w.incognito);
  if (normal.length > 0) {
    const focused = normal.find(w => w.focused);
    primaryWindowId = focused ? focused.id : normal[0].id;
  }
}

initPrimaryWindow();

const MENU_ID = "toggle-single-window";

chrome.runtime.onInstalled.addListener(async () => {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  chrome.contextMenus.create({
    id: MENU_ID,
    title: (singleWindowMode ?? false) ? "✅ Single Window Mode" : "⬜ Single Window Mode",
    contexts: ["action"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  const newVal = !singleWindowMode;
  await chrome.storage.local.set({ singleWindowMode: newVal });
  chrome.contextMenus.update(MENU_ID, {
    title: newVal ? "✅ Single Window Mode" : "⬜ Single Window Mode",
  });
  if (newVal) consolidateWindows();
});

async function consolidateWindows() {
  if (!primaryWindowId) await initPrimaryWindow();
  if (!primaryWindowId) return;

  const wins = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
  let retry = false;

  for (const win of wins) {
    if (win.id === primaryWindowId || win.incognito) continue;
    const ids = win.tabs.map(t => t.id);
    if (ids.length > 0) {
      try {
        await chrome.tabs.move(ids, { windowId: primaryWindowId, index: -1 });
      } catch { retry = true; }
    }
  }

  if (retry) setTimeout(consolidateWindows, 300);
  else if (wins.length > 1) chrome.windows.update(primaryWindowId, { focused: true }).catch(() => {});
}

let consolidateTimeout = null;
async function handleWindowChange() {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  if (!singleWindowMode) return;
  if (consolidateTimeout) clearTimeout(consolidateTimeout);
  consolidateTimeout = setTimeout(consolidateWindows, 100);
}

chrome.windows.onCreated.addListener(handleWindowChange);
chrome.tabs.onCreated.addListener(handleWindowChange);
chrome.tabs.onAttached.addListener(handleWindowChange);

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === primaryWindowId) {
    primaryWindowId = null;
    initPrimaryWindow();
  }
});

// =============================================================================
// Startup Offloading
// =============================================================================
let isStartupOffloadActive = false;
const queuedForDiscard = new Set();

chrome.runtime.onStartup.addListener(() => {
  isStartupOffloadActive = true;
  setTimeout(() => { isStartupOffloadActive = false; }, 10000);
});

// Hook into the existing onUpdated listener to offload during startup
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isStartupOffloadActive) return;
  if (!tab.pinned || tab.active || tab.discarded) return;

  const url = tab.pendingUrl || tab.url;
  if (!url || url === "about:blank") return;

  if (!queuedForDiscard.has(tabId)) {
    queuedForDiscard.add(tabId);
    setTimeout(() => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) return;
        if (t && !t.active && !t.discarded) {
          chrome.tabs.discard(tabId).catch(() => {});
        }
      });
    }, 1500); // Grace period for favicon caching
  }
});
