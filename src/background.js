// Map of pinned tab IDs to their base URLs (origin)
const pinnedTabBaseUrls = new Map();

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
 * Initialize tracking for all pinned tabs on startup.
 */
async function initPinnedTabs() {
  const tabs = await chrome.tabs.query({ pinned: true });
  for (const tab of tabs) {
    if (tab.url && tab.id != null) {
      pinnedTabBaseUrls.set(tab.id, getOrigin(tab.url));
      // Discard the tab to save memory right at startup
      if (!tab.discarded && !tab.active) {
        chrome.tabs.discard(tab.id).catch(() => {});
      }
    }
  }
}

initPinnedTabs();

// --- Extension icon click ---
// Normal tab: close it
// Pinned tab: offload it, then cascade to next active pinned tab.
//             Only go to unpinned new tab once ALL pinned tabs are offloaded.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.pinned) {
    // If this is the last unpinned tab and all pinned tabs are offloaded,
    // don't close — there's nowhere to go without waking a pinned tab
    const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
    if (unpinnedTabs.length <= 1) {
      const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
      const allPinnedOffloaded = pinnedTabs.length > 0 && pinnedTabs.every((t) => t.discarded);
      if (allPinnedOffloaded) {
        // Can't close (would wake pinned tabs), so reset to a fresh new tab instead
        chrome.tabs.update(tab.id, { url: "chrome://newtab" });
        return;
      }
    }
    chrome.tabs.remove(tab.id);
  } else {
    // Find the next non-offloaded pinned tab (excluding the current one)
    const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
    const nextActivePinned = pinnedTabs.find((t) => t.id !== tab.id && !t.discarded);

    if (nextActivePinned) {
      // Move to the next active pinned tab, then offload this one
      await chrome.tabs.update(nextActivePinned.id, { active: true });
      chrome.tabs.discard(tab.id).catch(() => {});
    } else {
      // All other pinned tabs are already offloaded — go to an unpinned tab
      const unpinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
      if (unpinnedTabs.length > 0) {
        await chrome.tabs.update(unpinnedTabs[0].id, { active: true });
        chrome.tabs.discard(tab.id).catch(() => {});
      }
    }
  }
});

// --- Track when a tab becomes pinned or unpinned ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned === true && tab.url) {
    pinnedTabBaseUrls.set(tabId, getOrigin(tab.url));
  }
  if (changeInfo.pinned === false) {
    pinnedTabBaseUrls.delete(tabId);
  }
});

// --- Handle tab removal ---
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) {
    pinnedTabBaseUrls.delete(tabId);
    return;
  }

  const windowId = removeInfo.windowId;
  pinnedTabBaseUrls.delete(tabId);

  // When the last unpinned tab is closed, check the state of pinned tabs
  const remainingTabs = await chrome.tabs.query({ windowId });
  const hasUnpinned = remainingTabs.some((t) => !t.pinned);

  if (!hasUnpinned && remainingTabs.length > 0) {
    // No unpinned tabs left — are any pinned tabs still active (not offloaded)?
    const hasActivePinned = remainingTabs.some((t) => t.pinned && !t.discarded);

    if (hasActivePinned) {
      // Active pinned tabs exist — create new tab in BACKGROUND (user stays on pinned)
      chrome.tabs.create({ active: false, windowId });
    } else {
      // All pinned tabs are offloaded — create ACTIVE new tab (stay on new tab)
      chrome.tabs.create({ active: true, windowId });
    }
  }
});

// --- Prevent pinned tabs from navigating away from their base URL ---
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  const tabId = details.tabId;
  const baseOrigin = pinnedTabBaseUrls.get(tabId);
  if (!baseOrigin) return;

  const newOrigin = getOrigin(details.url);
  if (newOrigin === baseOrigin) return;

  if (
    details.url.startsWith("chrome://") ||
    details.url.startsWith("chrome-extension://")
  )
    return;

  chrome.tabs.create({ url: details.url, active: true });

  chrome.tabs.goBack(tabId).catch(() => {
    chrome.tabs.update(tabId, { url: baseOrigin + "/" });
  });
});

// =============================================================================
// --- Feature: Single Window Mode ---
// Forces all tabs into one window (excludes private/Tor windows).
// Toggle via right-click on the extension icon.
// =============================================================================

let primaryWindowId = null;

/**
 * Find the primary (first normal, non-incognito) window.
 */
async function initPrimaryWindow() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normalWindows = windows.filter((w) => !w.incognito);
  if (normalWindows.length > 0) {
    // Prefer the focused window, otherwise pick the first one
    const focused = normalWindows.find((w) => w.focused);
    primaryWindowId = focused ? focused.id : normalWindows[0].id;
  }
}

initPrimaryWindow();

// --- Context menu toggle ---
const MENU_ID = "toggle-single-window";

chrome.runtime.onInstalled.addListener(async () => {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  const enabled = singleWindowMode ?? false;

  chrome.contextMenus.create({
    id: MENU_ID,
    title: enabled ? "✅ Single Window Mode" : "⬜ Single Window Mode",
    contexts: ["action"], // right-click on extension icon
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

  // If just enabled, consolidate all existing windows now
  if (newValue) {
    await consolidateWindows();
  }
});

/**
 * Move all tabs from other normal windows into the primary window.
 */
async function consolidateWindows() {
  if (!primaryWindowId) await initPrimaryWindow();
  if (!primaryWindowId) return;

  const windows = await chrome.windows.getAll({
    windowTypes: ["normal"],
    populate: true,
  });

  for (const win of windows) {
    if (win.id === primaryWindowId || win.incognito) continue;

    const tabIds = win.tabs.map((t) => t.id);
    if (tabIds.length > 0) {
      await chrome.tabs.move(tabIds, { windowId: primaryWindowId, index: -1 });
    }
    // Window auto-closes when all tabs are moved out
  }

  chrome.windows.update(primaryWindowId, { focused: true });
}

// --- Ensure all tabs stay in the primary window ---

// When a new window is created, check if it has tabs.
// If it does, and it's a normal window, move them to the primary window.
chrome.windows.onCreated.addListener(async (window) => {
  const { singleWindowMode } = await chrome.storage.local.get("singleWindowMode");
  if (!singleWindowMode) return;

  if (window.incognito || window.type !== "normal") return;

  if (!primaryWindowId) await initPrimaryWindow();
  if (!primaryWindowId || window.id === primaryWindowId) return;

  // Wait a tiny bit for the dragged tab to actually attach to the new window
  setTimeout(async () => {
    try {
      const win = await chrome.windows.get(window.id, { populate: true });
      if (win.tabs && win.tabs.length > 0) {
        const tabIds = win.tabs.map((t) => t.id);
        await chrome.tabs.move(tabIds, { windowId: primaryWindowId, index: -1 });
        await chrome.tabs.update(tabIds[0], { active: true });
        await chrome.windows.update(primaryWindowId, { focused: true });
      }
      // Close the now-empty newly created window
      chrome.windows.remove(window.id).catch(() => {});
    } catch {}
  }, 50); // 50ms is enough for Chrome to attach the tab during a drag
});

// --- If primary window is closed, pick a new one ---
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === primaryWindowId) {
    primaryWindowId = null;
    initPrimaryWindow();
  }
});
