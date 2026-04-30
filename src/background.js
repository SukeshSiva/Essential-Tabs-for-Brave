// =============================================================================
// Essential Tabs for Brave - Background Service Worker
// =============================================================================
//
// MV3 DESIGN NOTES:
// 1. Service workers restart frequently. ALL state must be in chrome.storage.
// 2. Events can fire before async init completes. Handlers must await init.
// 3. There is NO synchronous way to cancel a navigation in MV3.
//    We use declarativeNetRequest to block cross-origin requests on pinned
//    tabs at the network level (synchronous, zero-flash).
// =============================================================================

// In-memory cache — loaded from storage on every service worker wake
let pinnedTabUrls = {}; // { "tabId": "https://example.com" (origin) }
let isStartupOffloadActive = false;
const queuedForDiscard = new Set();

// Promise that resolves when our data is ready
const initDone = init();

// --- Core Utilities ---

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function persistPinnedUrls() {
  chrome.storage.local.set({ pinnedTabUrls });
}

// --- Initialization ---

async function init() {
  // Step 1: Load persisted data (very fast, < 5ms)
  const data = await chrome.storage.local.get("pinnedTabUrls");
  if (data.pinnedTabUrls) {
    pinnedTabUrls = data.pinnedTabUrls;
  }

  // Step 2: Reconcile with actual browser state
  const tabs = await chrome.tabs.query({ pinned: true });
  const currentPinnedIds = new Set();

  for (const tab of tabs) {
    const url = tab.pendingUrl || tab.url;
    if (url && url !== "about:blank" && tab.id != null) {
      currentPinnedIds.add(String(tab.id));
      if (!pinnedTabUrls[tab.id]) {
        const origin = getOrigin(url);
        if (origin && !origin.startsWith("chrome://")) {
          pinnedTabUrls[tab.id] = origin;
        }
      }
    }
  }

  // Remove stale entries for tabs that no longer exist/aren't pinned
  for (const tabId of Object.keys(pinnedTabUrls)) {
    if (!currentPinnedIds.has(tabId)) {
      delete pinnedTabUrls[tabId];
    }
  }

  persistPinnedUrls();

  // Step 3: Set up DNR blocking rules for all pinned tabs
  await updateAllDnrRules();
}

// =============================================================================
// declarativeNetRequest — the REAL base URL lock
// =============================================================================
//
// DNR rules are evaluated SYNCHRONOUSLY by the browser at the network level,
// BEFORE the request is made. This means:
//   - Zero flash (the page never even starts loading)
//   - Zero reload (the current page is completely untouched)
//   - Works even if the service worker is asleep (rules persist in session)
//
// We create one rule per pinned tab that blocks all main_frame requests
// EXCEPT those going to the tab's locked domain.
// =============================================================================

function makeRuleId(tabId) {
  // DNR rule IDs must be positive integers. Tab IDs are already integers.
  return Number(tabId);
}

async function addDnrRuleForTab(tabId, origin) {
  const domain = getDomain(origin + "/");
  if (!domain) return;

  const ruleId = makeRuleId(tabId);

  // Remove existing rule for this tab first (in case domain changed)
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      condition: {
        tabIds: [Number(tabId)],
        resourceTypes: ["main_frame"],
        excludedRequestDomains: [domain]
      },
      action: {
        type: "block"
      }
    }]
  }).catch(() => {});
}

async function removeDnrRuleForTab(tabId) {
  const ruleId = makeRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId]
  }).catch(() => {});
}

async function updateAllDnrRules() {
  // Clear all existing session rules
  const existingRules = await chrome.declarativeNetRequest.getSessionRules();
  const existingIds = existingRules.map(r => r.id);
  if (existingIds.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingIds
    });
  }

  // Add a rule for each pinned tab
  for (const [tabId, origin] of Object.entries(pinnedTabUrls)) {
    await addDnrRuleForTab(tabId, origin);
  }
}

// =============================================================================
// onBeforeNavigate — opens the blocked URL in a new tab
// =============================================================================
// DNR blocks the network request (so the pinned tab stays put), but the user
// still needs the URL to open somewhere. This handler opens it in a new tab.

const recentNavigations = new Set();

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await initDone;

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

  // Prevent duplicate tab creations
  const navKey = `${tabId}:${details.url}`;
  if (recentNavigations.has(navKey)) return;
  recentNavigations.add(navKey);
  setTimeout(() => recentNavigations.delete(navKey), 2000);

  // Open the blocked URL in a new tab
  chrome.tabs.create({ url: details.url, active: true });
});

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
// Track pinned/unpinned state + startup offloading
// =============================================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await initDone;

  // --- Tab was unpinned: remove the lock ---
  if (changeInfo.pinned === false) {
    delete pinnedTabUrls[tabId];
    persistPinnedUrls();
    await removeDnrRuleForTab(tabId);
    return;
  }

  // --- Tab is pinned: ensure we have a lock ---
  if (tab.pinned) {
    const url = tab.pendingUrl || tab.url;
    const isValidUrl = url && url !== "about:blank" && !url.startsWith("chrome://");

    if (!pinnedTabUrls[tabId] && isValidUrl) {
      pinnedTabUrls[tabId] = getOrigin(url);
      persistPinnedUrls();
      await addDnrRuleForTab(tabId, pinnedTabUrls[tabId]);
    }

    // Startup offloading with favicon grace period
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
  delete pinnedTabUrls[tabId];
  persistPinnedUrls();
  await removeDnrRuleForTab(tabId);

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
