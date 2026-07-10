# Cinematic Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing admin dashboard presentation with the approved minimal cinematic console while preserving every authentication, metrics, logs, cache, background, and logout behavior.

**Architecture:** Keep the zero-dependency single-file dashboard architecture. Restructure `admin-dashboard.html` into a cinematic overview plus an accessible details drawer, reuse the existing fetch and DOM-safe rendering functions, and add static contract tests in `test.js` for the new controls and accessibility behavior.

**Tech Stack:** HTML5, CSS, browser JavaScript, Node.js built-in test assertions, Playwright for visual verification only.

## Global Constraints

- Do not add runtime dependencies or change server endpoints.
- Keep all interface copy in Chinese.
- Keep remote log data rendered through `textContent`, never `innerHTML`.
- Keep `POST /admin/clear-cache?type=all` and Cookie-based admin authentication unchanged.
- Support desktop 1440×900 and mobile 390×844 without horizontal page overflow.
- Respect `prefers-reduced-motion` and retain visible keyboard focus styles.
- Do not add playback, poster walls, rankings, or fictional media browsing behavior.

---

### Task 1: Add cinematic dashboard contract tests

**Files:**
- Modify: `test.js`
- Test: `test.js`

**Interfaces:**
- Consumes: the static contents of `admin-dashboard.html`
- Produces: assertions for `details_drawer`, `btn_details`, `btn_changebg`, drawer accessibility state, reduced-motion CSS, and existing clear-cache POST semantics

- [ ] **Step 1: Write the failing static assertions**

Add after the existing `dashboardHtml` clear-cache assertions:

```js
assert.match(dashboardHtml, /id=["']details_drawer["']/);
assert.match(dashboardHtml, /id=["']btn_details["'][^>]*aria-expanded=["']false["']/);
assert.match(dashboardHtml, /id=["']btn_changebg["']/);
assert.match(dashboardHtml, /aria-controls=["']details_drawer["']/);
assert.match(dashboardHtml, /prefers-reduced-motion:\s*reduce/);
assert.match(dashboardHtml, /event\.key\s*===\s*["']Escape["']/);
assert.doesNotMatch(dashboardHtml, /播放预告|热门 TOP|海报墙/);
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test`

Expected: FAIL at the first `details_drawer` assertion because the cinematic drawer has not been added.

- [ ] **Step 3: Commit the failing test**

```bash
git add test.js
git commit -m "test: define cinematic dashboard contracts"
```

### Task 2: Implement the cinematic overview and details drawer

**Files:**
- Modify: `admin-dashboard.html`
- Test: `test.js`

**Interfaces:**
- Consumes: existing endpoints `/admin/status`, `/admin/auth`, `/admin/metrics`, `/admin/logs?limit=200`, `/health`, `/admin/random-bg`, `/admin/logout`, and `POST /admin/clear-cache?type=all`
- Produces: DOM IDs `v_total`, `v_hit_rate`, `v_rps`, `v_error_rate`, `details_drawer`, `btn_details`, `btn_changebg`, `btn_clear_cache`, and existing detailed metric/log IDs used by the current update logic

- [ ] **Step 1: Replace the visual shell while preserving login behavior**

Implement this structure inside the authenticated content container:

```html
<div class="cinematic-shell">
  <nav class="topbar" aria-label="管理页顶部栏">...</nav>
  <main class="overview">
    <section class="hero-copy">...</section>
    <section class="status-panel" aria-label="实时状态">...</section>
  </main>
  <nav class="action-dock" aria-label="快捷操作">
    <button id="btn_refresh" type="button">服务概览</button>
    <button id="btn_changebg" type="button">更换背景</button>
    <button id="btn_details" type="button" aria-controls="details_drawer" aria-expanded="false">查看日志</button>
    <button id="btn_clear_cache" type="button">清理缓存</button>
  </nav>
</div>
<aside id="details_drawer" class="details-drawer" aria-hidden="true" aria-label="详细监控信息">...</aside>
<button id="drawer_backdrop" class="drawer-backdrop" type="button" aria-label="关闭详细信息"></button>
```

The drawer must retain the current cache capacity cards, status-code distribution, log filters, log rows, pause/scroll controls, clear-display control, theme/background controls if still applicable, and logout control.

- [ ] **Step 2: Implement the approved cinematic CSS**

Use a full-screen background variable with a fixed readability layer:

```css
body::before{background:linear-gradient(90deg,rgba(3,5,7,.94),rgba(3,5,7,.58) 45%,rgba(3,5,7,.2) 72%,rgba(3,5,7,.48)),linear-gradient(0deg,#050607,transparent 42%)}
.status-panel{background:linear-gradient(145deg,rgba(8,11,13,.88),rgba(18,22,24,.72));backdrop-filter:blur(22px);border:1px solid rgba(255,255,255,.16)}
.details-drawer{position:fixed;inset:0 0 0 auto;width:min(720px,100%);transform:translateX(100%)}
.details-drawer.open{transform:translateX(0)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}
```

At widths below 900px, stack hero and status panel. Below 640px, use a full-width drawer, smaller hero typography, a horizontally scrollable dock, and vertically stacked log entries.

- [ ] **Step 3: Connect the four overview metrics to real data**

In `loadDashboard`, compute combined cache hit rate and the one-minute error rate:

```js
const combinedHits = apiHit + imageHit;
const combinedTotal = combinedHits + apiMiss + imageMiss;
document.getElementById('v_hit_rate').textContent = formatPct(combinedHits, combinedTotal);

const total1m = win.length;
const errors1m = win.filter(row => Number(row.status) >= 400).length;
const errorRate = total1m ? (errors1m / total1m) * 100 : 0;
document.getElementById('v_error_rate').textContent = `${errorRate.toFixed(2)}%`;
```

Keep `v_total` and `v_rps` updated from the same existing metrics/log responses.

- [ ] **Step 4: Add accessible drawer behavior**

Add one state function and three close paths:

```js
function setDrawer(open) {
  detailsDrawer.classList.toggle('open', open);
  drawerBackdrop.classList.toggle('open', open);
  detailsDrawer.setAttribute('aria-hidden', String(!open));
  btnDetails.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('drawer-open', open);
}

btnDetails.addEventListener('click', () => setDrawer(btnDetails.getAttribute('aria-expanded') !== 'true'));
drawerBackdrop.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setDrawer(false); });
```

- [ ] **Step 5: Run the tests and confirm GREEN**

Run: `npm test`

Expected: `All tests passed`.

- [ ] **Step 6: Commit the implementation**

```bash
git add admin-dashboard.html test.js
git commit -m "feat: redesign admin dashboard as cinematic console"
```

### Task 3: Verify desktop/mobile rendering and release safety

**Files:**
- Modify: `admin-dashboard.html` only if visual verification exposes a layout defect
- Test: `test.js`

**Interfaces:**
- Consumes: completed cinematic dashboard
- Produces: verified screenshots and a release-safe commit

- [ ] **Step 1: Run all repository checks**

Run:

```bash
npm run check
npm test
npm run validate:release
git diff --check
```

Expected: all commands exit 0, tests print `All tests passed`, and release validation reports success.

- [ ] **Step 2: Start a local authenticated test server**

Run with non-secret local values:

```bash
TMDB_API_KEY=test-key ADMIN_API_KEY=test-admin PORT=3100 node server.js
```

Expected: server listens on port 3100. Use the test admin key only in the local browser session.

- [ ] **Step 3: Capture desktop and mobile screenshots**

Use Playwright to log in at `/admin/dashboard`, then save:

```text
/tmp/tmdb-cinematic-desktop.png  (1440×900)
/tmp/tmdb-cinematic-mobile.png   (390×844)
```

Verify the overview, drawer, dock, focus visibility, mobile stacking, and lack of horizontal page overflow.

- [ ] **Step 4: Re-run checks after any visual adjustment**

Run the complete command set from Step 1 again. Expected: all exit 0.

- [ ] **Step 5: Commit visual fixes if needed**

```bash
git add admin-dashboard.html test.js
git commit -m "fix: polish cinematic dashboard responsiveness"
```

