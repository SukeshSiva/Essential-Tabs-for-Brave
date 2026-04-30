// =============================================================================
// Base URL Lock for Pinned Tabs
// =============================================================================
//
// CRITICAL DESIGN NOTE (MV3):
// In Manifest V3, the service worker is killed after ~30s of inactivity.
// When it restarts, ALL in-memory state (Maps, variables) is wiped.
// We MUST persist pinned tab URLs to chrome.storage.local so the lock
// survives across service worker restarts.
// =============================================================================

// In-memory cache (fast synchronous access for event listeners)
let pinnedTabUrls = {}; // { tabId: origin }

// Flag for startup offloading
let isStartupOffloadActive = false;
const queuedForDiscard = new Set();

/**
 * Get the origin (base URL) from a full URL.
 */
function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Save the current pinned tab URLs to persistent storage.
 */
function persistPinnedUrls() {
  chrome.storage.local.set({ pinnedTabUrls });
}

/**
 * Load pinned tab URLs from persistent storage into memory.
 * This is the FIRST thing that runs when the service worker wakes up.
 */
async function loadPinnedUrls() {
  const data = await chrome.storage.local.get("pinnedTabUrls");
  if (data.pinnedTabUrls) {
    pinnedTabUrls = data.pinnedTabUrls;
  }
}

/**
 * Scan all current pinned tabs and register any that are missing from our map.
 * Also cleans up entries for tabs that no longer exist or aren't pinned.
 */
async function syncPinnedTabs() {
  const tabs = await chrome.tabs.query({ pinned: true });
  const currentPinnedIds = new Set();

  for (const tab of tabs) {
    const url = tab.pendingUrl || tab.url;
    if (url && url !== "about:blank" && tab.id != null) {
      currentPinnedIds.add(String(tab.id));
      // Only set if we don't already have a lock for this tab
      if (!pinnedTabUrls[tab.id]) {
        const origin = getOrigin(url);
        if (origin && !origin.startsWith("chrome://")) {
          pinnedTabUrls[tab.id] = origin;
        }
      }
    }
  }

  // Clean up entries for tabs that no longer exist or are no longer pinned
  for (const tabId of Object.keys(pinnedTabUrls)) {
    if (!currentPinnedIds.has(tabId)) {
      delete pinnedTabUrls[tabId];
    }
  }

  persistPinnedUrls();
}

// --- Boot sequence: load from storage FIRST, then sync with real tabs ---
loadPinnedUrls().then(() => syncPinnedTabs());

// =============================================================================
// Extension icon click: offload/cascade
// =============================================================================
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.pinned) {
    const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
    if (unpinnedTabs.length <= 1) {
      const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
      const allPinnedOffloaded = pinnedTabs.length > 0 && pinnedTabs.every((t) => t.discarded);
      if (allPinnedOffloaded) {
        chrome.tabs.update(tab.id, { url: "chrome://newtab" });
        return;
      }
    }
    chrome.tabs.remove(tab.id);
  } else {
    const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
    const nextActivePinned = pinnedTabs.find((t) => t.id !== tab.id && !t.discarded);

    if (nextActivePinned) {
      await chrome.tabs.update(nextActivePinned.id, { active: true });
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
// Track pinned/unpinned state changes + startup offloading
// =============================================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // --- Handle unpinning: remove the lock ---
  if (changeInfo.pinned === false) {
    delete pinnedTabUrls[tabId];
    persistPinnedUrls();
    return;
  }

  // --- Handle pinning or loading of a pinned tab ---
  if (tab.pinned) {
    const url = tab.pendingUrl || tab.url;
    const isValidUrl = url && url !== "about:blank" && !url.startsWith("chrome://");

    // Lock the base URL if we don't have one yet for this tab
    if (!pinnedTabUrls[tabId] && isValidUrl) {
      pinnedTabUrls[tabId] = getOrigin(url);
      persistPinnedUrls();
    }

    // Startup offloading: discard background pinned tabs with a favicon grace period
    if (isStartupOffloadActive && !tab.active && !tab.discarded && isValidUrl) {
      if (!queuedForDiscard.has(tabId)) {
        queuedForDiscard.add(tabId);
        setTimeout(() => {
          chrome.tabs.get(tabId, (t) => {
            if (chrome.runtime.lastError) return;
            if (t && !t.active && !t.discarded) {
              chrome.tabs.discard(tabId).catch(() => {});
            }
          });
        }, 1500);
      }
    }
  }
});

// =============================================================================
// Handle tab removal
// =============================================================================
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // Clean up our tracking
  delete pinnedTabUrls[tabId];
  persistPinnedUrls();

  if (removeInfo.isWindowClosing) return;

  const windowId = removeInfo.windowId;
  const remainingTabs = await chrome.tabs.query({ windowId });
  const hasUnpinned = remainingTabs.some((t) => !t.pinned);

  if (!hasUnpinned && remainingTabs.length > 0) {
    const hasActivePinned = remainingTabs.some((t) => t.pinned && !t.discarded);
    if (hasActivePinned) {
      chrome.tabs.create({ active: false, windowId });
    } else {
      chrome.tabs.create({ active: true, windowId });
    }
  }
});

// =============================================================================
// BASE URL LOCK — the core feature
// =============================================================================
const recentNavigations = new Set();

// Track the last known good full URL for each pinned tab (for fallback)
const lastGoodUrl = {};

// Keep track of what page each pinned tab is actually showing
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.pinned && changeInfo.status === "complete" && tab.url) {
    const origin = getOrigin(tab.url);
    if (origin && origin === pinnedTabUrls[tabId]) {
      lastGoodUrl[tabId] = tab.url;
    }
  }
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  const tabId = details.tabId;
  const baseOrigin = pinnedTabUrls[tabId];
  if (!baseOrigin) return;

  const newOrigin = getOrigin(details.url);
  if (newOrigin === baseOrigin) return;

  // Allow internal browser pages
  if (
    details.url.startsWith("chrome://") ||
    details.url.startsWith("chrome-extension://") ||
    details.url.startsWith("brave://")
  )
    return;

  // Prevent duplicate tab creations for rapid-fire navigations
  const navKey = `${tabId}:${details.url}`;
  if (recentNavigations.has(navKey)) return;
  recentNavigations.add(navKey);
  setTimeout(() => recentNavigations.delete(navKey), 2000);

  // Open the blocked URL in a new tab
  chrome.tabs.create({ url: details.url, active: true });

  // Cancel the navigation on the pinned tab.
  // window.stop() freezes the page in place without any visible reload.
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => window.stop()
  }).catch(() => {
    // Fallback: navigate back to the exact page they were on (not just the root)
    const fallbackUrl = lastGoodUrl[tabId] || baseOrigin + "/";
    chrome.tabs.update(tabId, { url: fallbackUrl });
  });
});

// =============================================================================
// Single Window Mode
// =============================================================================
let primaryWindowId = null;

async function initPrimaryWindow() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normalWindows = windows.filter((w) => !w.incognito);
  if (normalWindows.length > 0) {
    const focused = normalWindows.find((w) => w.focused);
    primaryWindowId = focused ? focused.id : normalWindows[0].id;
  }
}

initPrimaryWindow();

const MENU_ID = "toggle-single-window";

chrome.runtime.onInstalled.addListener(async () => {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  const enabled = singleWindowMode ?? false;
  chrome.contextMenus.create({
    id: MENU_ID,
    title: enabled ? "✅ Single Window Mode" : "⬜ Single Window Mode",
    contexts: ["action"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  const newValue = !singleWindowMode;
  await chrome.storage.local.set({ singleWindowMode: newValue });
  chrome.contextMenus.update(MENU_ID, {
    title: newValue ? "✅ Single Window Mode" : "⬜ Single Window Mode",
  });
  if (newValue) {
    await consolidateWindows();
  }
});

async function consolidateWindows() {
  if (!primaryWindowId) await initPrimaryWindow();
  if (!primaryWindowId) return;

  const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
  let needsRetry = false;

  for (const win of windows) {
    if (win.id === primaryWindowId || win.incognito) continue;
    const tabIds = win.tabs.map((t) => t.id);
    if (tabIds.length > 0) {
      try {
        await chrome.tabs.move(tabIds, { windowId: primaryWindowId, index: -1 });
      } catch (err) {
        needsRetry = true;
      }
    }
  }

  if (needsRetry) {
    setTimeout(consolidateWindows, 300);
  } else if (windows.length > 1) {
    chrome.windows.update(primaryWindowId, { focused: true }).catch(() => {});
  }
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
chrome.runtime.onStartup.addListener(async () => {
  isStartupOffloadActive = true;
  setTimeout(() => {
    isStartupOffloadActive = false;
  }, 10000);
});
