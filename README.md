<h1 align="center">Essential Tabs for Brave 🦁</h1>
<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-1.0.0-blue.svg?cacheSeconds=2592000" />
  <img alt="Manifest" src="https://img.shields.io/badge/manifest-v3-green.svg" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Brave%20%7C%20Chrome%20%7C%20Edge-orange.svg" />
  <a href="http://www.wtfpl.net/about/" target="_blank">
    <img alt="License: WTFPL" src="https://img.shields.io/badge/License-WTFPL-yellow.svg" />
  </a>
</p>

<p align="center">
  <strong>Smart pinned tab management for Brave</strong> — offloading, URL locking, single window mode, and an intelligent tab lifecycle that keeps your essential tabs exactly where they belong.
</p>

---

## ✨ Features

### 🔒 Pinned Tab Protection
Your pinned tabs are **indestructible**. Map `Ctrl+W` / `Cmd+W` to the extension and pinned tabs can never be closed — they get **offloaded** (removed from memory but stay visible in the tab bar) instead.

### 🔗 Base URL Lock
Pinned tabs are **origin-locked**. Clicking a bookmark, typing a URL, or following a link that leaves the pinned tab's domain will:
- **Open the URL in a new tab** automatically
- **Snap the pinned tab back** to its original page (via `goBack()`)
- Navigation within the same domain still works normally

The lock persists across browser restarts and service worker restarts (stored in `chrome.storage.local`).

### ⚡ Smart Offload Cascade
Have multiple pinned tabs? The extension cascades through them intelligently:

| Step | Action | Result |
|:----:|--------|--------|
| 1 | Close normal tabs | Tabs close normally |
| 2 | Close last normal tab | Focus moves to pinned tab. A new tab is created in the background |
| 3 | Close pinned tab 1 | **Offloads** it → moves to **pinned tab 2** |
| 4 | Close pinned tab 2 | **Offloads** it → moves to **pinned tab 3** |
| … | *(repeat for all pinned tabs)* | |
| N | Close last pinned tab | **Offloads** it → moves to the **new tab** |
| N+1 | Open a URL in the new tab, then close | **Resets** the tab to a fresh `chrome://newtab` (clears history) |
| N+2 | Close the fresh new tab | **Does nothing** — you're already on a clean slate |

### 📑 Intelligent New Tab Behavior
The extension ensures you **never get stranded**:

- **Last normal tab closed + active pinned tabs exist** → new tab created in the **background** (you stay on pinned tab)
- **Last normal tab closed + all pinned tabs offloaded** → new **active** tab created (you land on it)
- **On the last tab with a URL + all pinned offloaded** → tab **resets** to `chrome://newtab` instead of closing (prevents waking offloaded tabs)
- **On a fresh new tab + all pinned offloaded** → does **nothing** (already fresh)

### 🪟 Single Window Mode
Toggle via **right-click on the extension icon** → **"Single Window Mode"**.

When enabled:
- **New windows** are detected and all their tabs are **merged back** into your main window
- **Dragged-out tabs** are caught and **pulled back** into the primary window
- Uses aggressive retry logic (up to 15 attempts with increasing delay) to handle Chrome's drag-lock
- **Accidentally woken pinned tabs** are automatically re-offloaded after a merge
- **Private / Incognito / Tor windows** are excluded — they stay separate
- The primary window is auto-selected (focused or first normal window)

### 😴 Startup Offloading
When Brave launches, all **non-active pinned tabs** are automatically **offloaded** after a 1.5-second grace period (to let favicons cache). This saves memory on startup without losing any tab state.

---

## 🚀 Installation

1. **Clone** this repo:
   ```bash
   git clone https://github.com/SukeshSiva/Essential-Tabs-for-Brave.git
   ```

2. Open **`brave://extensions/`** in Brave

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the cloned folder

5. ✅ The extension icon should appear in your toolbar

## ⚙️ Setup — Map Ctrl+W

This is **essential** for the full experience:

1. Open **`brave://extensions/shortcuts`** in Brave

2. Find **"Essential Tabs for Brave"**

3. Set the shortcut for **"Activate the extension"** to:
   - **`Ctrl+W`** on Windows/Linux
   - **`Cmd+W`** on Mac

4. Now every `Ctrl+W` / `Cmd+W` goes through the extension instead of the browser's default close. Normal tabs close normally, pinned tabs get the smart offload cascade.

> **Note**: Without this shortcut mapping, you can still click the extension icon in the toolbar to trigger the same behavior.

---

## 🔧 Permissions

| Permission | Why |
|---|---|
| `tabs` | Monitor tab state (pinned, active, discarded) and manage tab lifecycle |
| `webNavigation` | Intercept navigations on pinned tabs to enforce the base URL lock |
| `contextMenus` | Right-click menu on extension icon to toggle Single Window Mode |
| `storage` | Persist pinned tab URL locks and Single Window Mode setting across restarts |

## 🏗️ Architecture

```
Essential-Tabs-for-Brave/
├── manifest.json            # Extension config (Manifest V3)
├── src/
│   └── background.js        # Service worker — all logic lives here
├── images/
│   ├── icon.png              # Extension icon (full size)
│   ├── icon_128.png          # Extension icon (128×128)
│   └── Logo.png              # Logo asset
└── README.md
```

### How it works under the hood

The extension is a single **MV3 service worker** (`background.js`) with no content scripts, popups, or UI — just pure background logic.

**MV3 Service Worker Challenge**: Manifest V3 kills service workers after ~30 seconds of inactivity, wiping all in-memory state. The extension solves this by persisting all pinned tab URL locks to `chrome.storage.local` and rehydrating on every wake-up via a top-level `ready` promise.

```
Service Worker Wakes Up
  └→ Load pinnedTabBaseUrls from chrome.storage.local
  └→ Reconcile with actual browser tabs (remove stale, add new)
  └→ Ready — all event listeners now have valid lock data
```

---

## 🔄 The Complete Tab Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                    Normal Tabs                          │
│                                                         │
│  Close tab ────→ Tab removed                            │
│  Close LAST tab ──┬→ Active pinned tabs? ──→ Create     │
│                   │   background new tab                │
│                   └→ All pinned offloaded? ──→ Create   │
│                       active new tab                    │
├─────────────────────────────────────────────────────────┤
│                    Pinned Tabs                          │
│                                                         │
│  Close pinned ──┬→ Next active pinned? ──→ Offload +    │
│                 │   switch to it                        │
│                 └→ No active pinned? ──→ Offload +      │
│                     switch to unpinned (or create new)  │
├─────────────────────────────────────────────────────────┤
│                    Last Tab Standing                    │
│                                                         │
│  Close last tab ──┬→ Has URL loaded? ──→ Reset to       │
│                   │   chrome://newtab                   │
│                   └→ Already new tab? ──→ Do nothing    │
└─────────────────────────────────────────────────────────┘
```

---

## 📝 Changelog

### v1.0.0 (2026-04-30)
- 🔒 Pinned tab protection with smart offload cascade
- 🔗 Persistent base URL lock (survives service worker restarts)
- ⚡ Intelligent tab lifecycle — last tab resets instead of closing
- 🪟 Single window mode with drag detection and re-offload
- 😴 Startup offloading with favicon grace period
- 🛡️ Drag protection — re-offloads accidentally woken pinned tabs

---

<p align="center">
  Originally inspired by <a href="https://github.com/gustavotrott/brave-lock-pinned-tabs">brave-lock-pinned-tabs</a> and <a href="https://github.com/gabrielmaldi/chrome-lock-tab">chrome-lock-tab</a>
</p>
