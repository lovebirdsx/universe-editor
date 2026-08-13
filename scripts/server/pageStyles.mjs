/*---------------------------------------------------------------------------------------------
 *  内嵌网页（registerPage / adminPage）共享的基础样式：与下载页
 *  （download-page/index.html）同一套深色设计令牌——下载页是静态 HTML 无法 import，
 *  所以令牌在两处各存一份，改主题时两边要同步。
 *--------------------------------------------------------------------------------------------*/

export const PAGE_BASE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --card: #171a21;
  --fg: #e7e9ee;
  --muted: #9aa3b2;
  --accent: #4c8dff;
  --accent-hover: #3b7af0;
  --border: #262b36;
  --danger: #cf222e;
  --danger-hover: #a40e26;
  --ok: #3fb950;
  --warn: #d29922;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
  background: radial-gradient(1200px 600px at 50% -10%, #1b2130, var(--bg));
  color: var(--fg);
}
.card {
  width: 100%;
  height: fit-content;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
.back { display: inline-block; margin-bottom: 18px; font-size: 13px; color: var(--muted); text-decoration: none; }
.back:hover { color: var(--fg); }
input {
  display: block; width: 100%; margin-top: 6px; padding: 8px 10px;
  font-size: 14px; font-family: ui-monospace, Consolas, monospace;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: inherit;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
code { background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
button {
  padding: 6px 14px; font-size: 13px; font-weight: 600;
  border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer;
}
button:hover { background: var(--accent-hover); }
button.ghost { background: var(--border); color: var(--fg); }
button.ghost:hover { background: #303642; }
button.danger { background: var(--danger); }
button.danger:hover { background: var(--danger-hover); }
button:disabled { opacity: 0.5; cursor: default; }
`
