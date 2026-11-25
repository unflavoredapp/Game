/** Shared stylesheet for the DELvEKBot control panel. */
module.exports = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Syne:wght@600;700;800&display=swap');

:root {
  --bg: #f3efe6;
  --ink: #14120f;
  --muted: #5c574e;
  --line: #d9d2c5;
  --card: #fffdf8;
  --accent: #0b6e4f;
  --accent-2: #c45c26;
  --good: #0b6e4f;
  --bad: #9b1d20;
  --warn: #a67c00;
  --shadow: 0 12px 40px rgba(20, 18, 15, 0.08);
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(1200px 500px at 10% -10%, #ffe7c7 0%, transparent 55%),
    radial-gradient(900px 400px at 100% 0%, #d7efe4 0%, transparent 50%),
    var(--bg);
  color: var(--ink);
  font-family: "IBM Plex Mono", ui-monospace, monospace;
}

body {
  padding: 28px 20px 60px;
}

.shell {
  max-width: 1100px;
  margin: 0 auto;
}

.brand {
  font-family: Syne, sans-serif;
  font-weight: 800;
  font-size: clamp(2rem, 5vw, 3.4rem);
  letter-spacing: -0.04em;
  line-height: 0.95;
  margin: 0 0 8px;
}

.tagline {
  color: var(--muted);
  margin: 0 0 28px;
  max-width: 40rem;
  line-height: 1.5;
}

.grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(12, 1fr);
}

.panel {
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  padding: 18px;
}

.panel h2 {
  font-family: Syne, sans-serif;
  font-size: 1.05rem;
  margin: 0 0 12px;
  letter-spacing: -0.02em;
}

.span-4 { grid-column: span 4; }
.span-6 { grid-column: span 6; }
.span-8 { grid-column: span 8; }
.span-12 { grid-column: span 12; }

@media (max-width: 800px) {
  .span-4, .span-6, .span-8, .span-12 { grid-column: span 12; }
}

.stat {
  font-family: Syne, sans-serif;
  font-size: 1.8rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.stat small {
  display: block;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  color: var(--muted);
  font-weight: 400;
  margin-top: 4px;
}

label {
  display: block;
  font-size: 0.75rem;
  color: var(--muted);
  margin-bottom: 6px;
}

input, textarea, button, select {
  font: inherit;
}

input, textarea, select {
  width: 100%;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  padding: 10px 12px;
  margin-bottom: 12px;
}

button, .btn {
  border: 0;
  background: var(--ink);
  color: #fff;
  padding: 10px 14px;
  cursor: pointer;
  font-weight: 600;
}

button.secondary {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--line);
}

button.danger { background: var(--bad); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

th, td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}

th { color: var(--muted); font-weight: 600; }

.pill {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid var(--line);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pill.queued { border-color: var(--warn); color: var(--warn); }
.pill.leased { border-color: #1d4e89; color: #1d4e89; }
.pill.done { border-color: var(--good); color: var(--good); }
.pill.failed { border-color: var(--bad); color: var(--bad); }
.pill.online { border-color: var(--good); color: var(--good); }
.pill.offline { color: var(--muted); }

.mono { font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.err { color: var(--bad); font-size: 0.8rem; margin-top: 8px; }
.ok { color: var(--good); font-size: 0.8rem; margin-top: 8px; }

.speed {
  font-family: Syne, sans-serif;
  font-weight: 700;
  color: var(--accent);
}

footer {
  margin-top: 28px;
  color: var(--muted);
  font-size: 0.75rem;
}
`;
