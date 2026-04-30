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
