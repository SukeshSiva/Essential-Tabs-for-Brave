<h1 align="center">Essential Tabs for Brave 🦁</h1>
<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.0-blue.svg?cacheSeconds=2592000" />
  <img alt="Manifest" src="https://img.shields.io/badge/manifest-v3-green.svg" />
  <a href="http://www.wtfpl.net/about/" target="_blank">
    <img alt="License: WTFPL" src="https://img.shields.io/badge/License-WTFPL-yellow.svg" />
  </a>
</p>

> Smart pinned tab management for Brave — offloading, URL locking, and intelligent tab lifecycle so your essential tabs stay exactly where they belong.

## ✨ Features

### 🔒 Pinned Tab Protection
Click the extension icon to close tabs — **pinned tabs are protected** and won't close. Instead, they get **offloaded** (discarded from memory but stay in your tab bar).

### 🔗 URL Lock for Pinned Tabs
Clicking a bookmark or link while on a pinned tab? It **opens in a new tab** instead of overwriting your pinned tab. Your pinned apps stay untouched.

### 🔄 Smart Offload Cascade
Have multiple pinned tabs? The extension cascades through them:
1. Click extension icon on **pinned tab 1** → offloads it → moves to **pinned tab 2**
2. Click again on **pinned tab 2** → offloads it → moves to **pinned tab 3**
3. Once **all pinned tabs are offloaded** → moves to a new tab

### 📑 Intelligent New Tab Behavior
- **Last normal tab closed + active pinned tabs** → a new tab is created in the background, you stay on your pinned tab
- **Last normal tab closed + all pinned tabs offloaded** → a new active tab is created, you stay on the new tab
- **All pinned tabs offloaded + last tab has content** → resets to a fresh new tab page instead of waking offloaded pinned tabs

## 🚀 Installation

1. Clone this repo:
   ```bash
   git clone https://github.com/SukeshSiva/Essential-Tabs-for-Brave.git
   ```

2. Open `brave://extensions/` in Brave

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the cloned folder

## ⚙️ Setup

1. Open `brave://extensions/shortcuts` in Brave

2. Find **"Essential Tabs for Brave"**

3. Set the shortcut for **"Activate the extension"** to `Ctrl+W` (or `Cmd+W` on Mac)

4. Now the extension icon shortcut replaces the default close behavior, giving you all the smart tab management features

## 🔧 Permissions

| Permission | Why |
|---|---|
| `tabs` | Monitor tab state (pinned, discarded) and manage tab lifecycle |
| `webNavigation` | Intercept navigations on pinned tabs to redirect to new tabs |

## 📁 Project Structure

```
├── manifest.json          # Extension configuration (Manifest V3)
├── src/
│   └── background.js      # Core logic — tab management service worker
├── images/
│   ├── icon.png            # Extension icon
│   └── icon_128.png        # Extension icon (128x128)
└── README.md
```

---

<p align="center">
  Originally inspired by <a href="https://github.com/gustavotrott/brave-lock-pinned-tabs">brave-lock-pinned-tabs</a> and <a href="https://github.com/gabrielmaldi/chrome-lock-tab">chrome-lock-tab</a>
</p>
