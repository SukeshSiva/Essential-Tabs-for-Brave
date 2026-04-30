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
    // pendingUrl is available during session restore
    const url = tab.pendingUrl || tab.url;
    if (url && url !== "about:blank" && tab.id != null) {
      pinnedTabBaseUrls.set(tab.id, getOrigin(url));
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

// --- Track when a tab becomes pinned or unpinned ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned === true) {
    const url = changeInfo.pendingUrl || changeInfo.url || tab.pendingUrl || tab.url;
    if (url && url !== "about:blank") {
      pinnedTabBaseUrls.set(tabId, getOrigin(url));
    }
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
        needsRetry = true; // Tab is being dragged by user
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
// --- Feature: Safe Startup Offloading ---
// =============================================================================

let isTrueBrowserStartup = false;

// This ONLY fires when the browser physically launches (not just SW waking up)
chrome.runtime.onStartup.addListener(async () => {
  isTrueBrowserStartup = true;
  
  // Give Brave 5 seconds to sort out its session restore, then offload
  setTimeout(async () => {
    const tabs = await chrome.tabs.query({ pinned: true });
    for (const tab of tabs) {
      // Never discard if it's currently focused or if it's still about:blank
      if (!tab.active && !tab.discarded && tab.url && tab.url !== "about:blank") {
        chrome.tabs.discard(tab.id).catch(() => {});
      }
    }
    isTrueBrowserStartup = false;
  }, 5000);
});
