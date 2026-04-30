// =============================================================================
// Essential Tabs for Brave
// =============================================================================
// Simple, reliable pinned tab management.
// - Base URL lock (pinned tabs can't navigate away from their origin)
// - Offload cascade (extension icon click offloads pinned tabs)
// - Smart tab close (last tab resets instead of closing)
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

/** Check if a URL is a "new tab" page (blank or chrome://newtab variants) */
function isNewTabPage(url) {
  if (!url) return true;
  return (
    url === "chrome://newtab/" ||
    url === "chrome://newtab" ||
    url === "brave://newtab/" ||
    url === "brave://newtab" ||
    url === "about:blank" ||
    url === ""
  );
}

// =============================================================================
// Extension icon click — close / offload / reset
// =============================================================================
//
// FLOW (the user's exact desired behavior):
//
// Normal tabs exist → close normally
// Last normal tab closed → focus moves to pinned tab, new tab created in bg
//   (this is handled by onRemoved below)
// On a pinned tab → offload it, cascade to next active pinned tab
// Last pinned tab → offload it, move to the new tab
// On the new tab with a URL loaded, all pinned offloaded → RESET to fresh
//   new tab (clear history) instead of closing
// On a fresh new tab, all pinned offloaded → do nothing (already fresh)
//
// =============================================================================
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.pinned) {
    // --- Normal (unpinned) tab ---
    const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });

    if (unpinnedTabs.length <= 1) {
      // This is the LAST unpinned tab
      const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
      const allPinnedOffloaded = pinnedTabs.length > 0 && pinnedTabs.every(t => t.discarded);
      const noPinnedTabs = pinnedTabs.length === 0;

      if (allPinnedOffloaded || noPinnedTabs) {
        // All pinned tabs are sleeping (or none exist).
        // Can't close — would wake a pinned tab or close the window.
        if (isNewTabPage(tab.url)) {
          // Already a fresh new tab — do nothing
          return;
        }
        // Has a real URL loaded — reset it to a fresh new tab
        chrome.tabs.update(tab.id, { url: "chrome://newtab" });
        return;
      }
      // There are active pinned tabs — close normally.
      // onRemoved will handle creating a background new tab.
    }
    chrome.tabs.remove(tab.id);
  } else {
    // --- Pinned tab: offload it, cascade to next ---
    const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
    const nextActive = pinnedTabs.find(t => t.id !== tab.id && !t.discarded);

    if (nextActive) {
      // There's another active pinned tab — move there first, then offload
      await chrome.tabs.update(nextActive.id, { active: true });
      chrome.tabs.discard(tab.id).catch(() => {});
    } else {
      // No more active pinned tabs — move to an unpinned tab (or create one)
      const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
      if (unpinnedTabs.length > 0) {
        await chrome.tabs.update(unpinnedTabs[0].id, { active: true });
      } else {
        // No unpinned tabs either — create a new tab
        await chrome.tabs.create({ active: true, windowId: tab.windowId });
      }
      chrome.tabs.discard(tab.id).catch(() => {});
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
// When the last normal tab is closed:
//   - If there are active pinned tabs → create a background new tab (user stays
//     on pinned tab)
//   - If all pinned tabs are offloaded → create an ACTIVE new tab (user lands
//     there)
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
// When enabled, all tabs from secondary normal windows are merged into the
// primary window. Detaching tabs (dragging them out) triggers an immediate
// re-merge. Private/Tor/incognito windows are excluded.
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

/**
 * Move all tabs from other normal (non-incognito) windows into the primary
 * window. If a move fails (e.g. user is mid-drag), retry with increasing
 * delay up to a max number of attempts.
 */
let consolidateRetries = 0;
const MAX_RETRIES = 15; // ~4.5 seconds total (100ms * 15 with backoff)

async function consolidateWindows() {
  if (!primaryWindowId) await initPrimaryWindow();
  if (!primaryWindowId) return;

  // Verify primary window still exists
  try {
    await chrome.windows.get(primaryWindowId);
  } catch {
    primaryWindowId = null;
    await initPrimaryWindow();
    if (!primaryWindowId) return;
  }

  const wins = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
  let needsRetry = false;
  let movedTabs = false;

  for (const win of wins) {
    if (win.id === primaryWindowId || win.incognito) continue;
    const tabIds = win.tabs.map(t => t.id);
    if (tabIds.length === 0) continue;

    try {
      await chrome.tabs.move(tabIds, { windowId: primaryWindowId, index: -1 });
      movedTabs = true;
    } catch {
      needsRetry = true;
    }
  }

  // Close any empty leftover windows
  if (movedTabs) {
    const updatedWins = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    for (const win of updatedWins) {
      if (win.id === primaryWindowId || win.incognito) continue;
      if (win.tabs.length === 0) {
        chrome.windows.remove(win.id).catch(() => {});
      }
    }
  }

  if (needsRetry && consolidateRetries < MAX_RETRIES) {
    consolidateRetries++;
    const delay = Math.min(100 + consolidateRetries * 50, 500);
    setTimeout(consolidateWindows, delay);
  } else {
    consolidateRetries = 0;
    // Only do post-merge cleanup when we actually moved tabs
    if (movedTabs && !needsRetry) {
      chrome.windows.update(primaryWindowId, { focused: true }).catch(() => {});

      // Re-offload any pinned tabs that Chrome accidentally woke up during
      // the drag (Chrome activates an offloaded tab when all other tabs leave)
      setTimeout(async () => {
        const pinnedTabs = await chrome.tabs.query({
          windowId: primaryWindowId,
          pinned: true,
        });
        for (const pt of pinnedTabs) {
          if (!pt.active && !pt.discarded) {
            chrome.tabs.discard(pt.id).catch(() => {});
          }
        }
      }, 500); // short delay to let the moved tab settle as active first
    }
  }
}

// --- Debounced handler for window/tab events ---
let consolidateTimeout = null;
async function handleWindowChange() {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  if (!singleWindowMode) return;
  if (consolidateTimeout) clearTimeout(consolidateTimeout);
  consolidateTimeout = setTimeout(() => {
    consolidateRetries = 0; // reset retries for new event
    consolidateWindows();
  }, 100);
}

// Listen to all events that could mean a tab ended up in a new window
chrome.windows.onCreated.addListener(handleWindowChange);
chrome.tabs.onCreated.addListener(handleWindowChange);
chrome.tabs.onAttached.addListener(handleWindowChange);

// --- Catch tab detach specifically (drag-out) ---
// When a tab is detached from the primary window, it's about to land in a
// new window. We aggressively trigger consolidation to pull it back.
chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  if (!singleWindowMode) return;

  // The tab was pulled out of a window. Give it a moment to land in the
  // new window, then aggressively consolidate.
  if (consolidateTimeout) clearTimeout(consolidateTimeout);
  consolidateRetries = 0;
  // Start quickly (50ms) — the new window is being created right now
  consolidateTimeout = setTimeout(consolidateWindows, 50);
});

// --- If primary window is closed, pick a new one ---
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === primaryWindowId) {
    primaryWindowId = null;
    initPrimaryWindow();
  }
});

// =============================================================================
// Startup Offloading
// =============================================================================
// On browser launch:
//   1. Create a new active tab so the user lands there
//   2. Offload ALL pinned tabs after a grace period (favicon caching)
// =============================================================================

chrome.runtime.onStartup.addListener(async () => {
  // Wait a moment for Brave to finish restoring the session
  setTimeout(async () => {
    const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    const mainWindow = allWindows.find(w => !w.incognito);
    if (!mainWindow) return;

    const pinnedTabs = mainWindow.tabs.filter(t => t.pinned);
    if (pinnedTabs.length === 0) return;

    // Create a new tab so the user has somewhere to land
    const unpinnedTabs = mainWindow.tabs.filter(t => !t.pinned);
    if (unpinnedTabs.length === 0) {
      await chrome.tabs.create({ active: true, windowId: mainWindow.id });
    } else {
      // Make sure the user is on an unpinned tab, not a pinned one
      const activeTab = mainWindow.tabs.find(t => t.active);
      if (activeTab && activeTab.pinned) {
        await chrome.tabs.update(unpinnedTabs[0].id, { active: true });
      }
    }

    // Now offload all pinned tabs after a grace period for favicon caching
    setTimeout(async () => {
      const freshPinned = await chrome.tabs.query({
        windowId: mainWindow.id,
        pinned: true,
      });
      for (const pt of freshPinned) {
        if (!pt.active && !pt.discarded) {
          chrome.tabs.discard(pt.id).catch(() => {});
        }
      }
    }, 1500);
  }, 500); // wait for session restore
});

