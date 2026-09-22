<!DOCTYPE HTML>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solar system</title>
<!--
    WebGPU fly-through solar system viewer. All data comes from
    gpusystem-data.php; rendering and controls are in gpusystem.js and
    gpusystem-render.js. system.php remains the classic Three.js view.
    Parameters: ?system=<solarSystemID>&focus=<itemID>
-->
<style>
:root {
    --bg: #010103;
    --panel: rgba(8, 12, 20, 0.82);
    --panel-border: rgba(120, 160, 200, 0.18);
    --text: #d6e2ee;
    --muted: #7d8fa3;
    --accent: #6cc4ff;
    --hover: rgba(108, 196, 255, 0.12);
    --sel: rgba(108, 196, 255, 0.24);
    --font: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.35 var(--font);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button {
    font: inherit;
    color: var(--text);
    background: rgba(108, 196, 255, 0.12);
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
}
button:hover { background: rgba(108, 196, 255, 0.25); }
input[type=text] {
    font: inherit;
    color: var(--text);
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    padding: 5px 8px;
    width: 100%;
    outline: none;
}
input[type=text]:focus { border-color: var(--accent); }

#viewport {
    position: fixed;
    inset: 0;
    touch-action: none;
}
#gpu { width: 100%; height: 100%; display: block; }

#labels {
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
}
.lbl {
    position: absolute;
    left: 0;
    top: 0;
    white-space: nowrap;
    font-size: 11px;
    line-height: 13px;
    text-shadow: 0 0 3px #000, 0 0 2px #000;
    will-change: transform;
}
.lbl .s { display: block; color: var(--muted); font-size: 10px; }
.lbl.hi { font-size: 12px; font-weight: 600; }
.lbl.k-moon, .lbl.k-belt { opacity: 0.8; font-size: 10px; }
.lbl.sky { opacity: 0.55; font-size: 10px; font-style: italic; }

.panel {
    position: fixed;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}

#header { top: 10px; left: 10px; width: 300px; padding: 10px 12px; }
#header h1 { margin: 0; font-size: 20px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
#systemSec { font-size: 15px; }
#systemLinks { margin: 2px 0 8px; font-size: 12px; color: var(--muted); }
#searchResults {
    display: none;
    margin-top: 4px;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.8);
}
.res { padding: 4px 8px; cursor: pointer; }
.res:hover { background: var(--hover); }
.res .tag { display: inline-block; width: 92px; color: var(--muted); font-size: 10px; text-transform: uppercase; }

#sidebar {
    top: 10px;
    right: 10px;
    bottom: 44px;
    width: 280px;
    display: flex;
    flex-direction: column;
    transition: transform 0.2s;
}
#sidebar.collapsed { transform: translateX(calc(100% + 10px)); }
#sidebar .top { padding: 10px 12px 6px; }
#sidebar .top h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
#tree { overflow-y: auto; flex: 1; padding: 0 6px 10px; }
#tree .hd { margin: 10px 6px 2px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
#tree .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
}
#tree .row:hover { background: var(--hover); }
#tree .row.sel { background: var(--sel); }
#tree .row.d1 { padding-left: 20px; }
#tree .row.d2 { padding-left: 34px; }
#tree .row.k-planet { margin-top: 4px; font-weight: 600; }
#tree .row.k-moon, #tree .row.k-belt { color: #aab4be; }
#tree .row.k-station { color: #7fe9d0; }
#tree .nm { overflow: hidden; text-overflow: ellipsis; flex: 1; }
#tree .sec { font-size: 11px; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
#sidebarToggle {
    position: fixed;
    top: 10px;
    right: 300px;
    z-index: 2;
    padding: 3px 8px;
    transition: right 0.2s;
}
#sidebar.collapsed + #sidebarToggle { right: 10px; }

#info { left: 10px; bottom: 44px; width: 320px; padding: 10px 12px; display: none; }
#info .ihd { display: flex; align-items: center; gap: 8px; }
#info .iname { font-size: 15px; font-weight: 600; flex: 1; }
#info .x { padding: 0 7px; font-size: 16px; line-height: 20px; }
#info .itype { color: var(--muted); margin: 2px 0 6px 16px; }
#info table { border-collapse: collapse; width: 100%; font-size: 12px; }
#info th { text-align: left; color: var(--muted); font-weight: normal; padding: 1px 8px 1px 0; white-space: nowrap; vertical-align: top; }
#info td { padding: 1px 0; }
#info .btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
#info .jump { border-color: rgba(255, 190, 90, 0.5); background: rgba(255, 170, 51, 0.18); }
#info .jump:hover { background: rgba(255, 170, 51, 0.32); }

#statusbar {
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 28px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
}
#status { color: var(--text); }
#lodStats { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#statusbar label { cursor: pointer; display: flex; align-items: center; gap: 3px; }
#helpToggle { padding: 1px 8px; }

#helpPanel {
    display: none;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 460px;
    max-width: calc(100vw - 32px);
    padding: 14px 18px;
    z-index: 5;
}
#helpPanel.open { display: block; }
#helpPanel h2 { margin: 0 0 8px; font-size: 15px; }
#helpPanel table { border-collapse: collapse; width: 100%; }
#helpPanel td { padding: 2px 0; vertical-align: top; }
#helpPanel td:first-child { color: var(--accent); white-space: nowrap; padding-right: 14px; }
#helpPanel p { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
kbd { font: 11px monospace; border: 1px solid var(--panel-border); border-radius: 3px; padding: 0 4px; }

#fade {
    position: fixed;
    inset: 0;
    background: #000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s;
}
#fade.on { opacity: 1; }
#loading {
    position: fixed;
    left: 50%;
    top: 45%;
    transform: translate(-50%, -50%);
    text-align: center;
    color: var(--text);
    font-size: 15px;
    max-width: 480px;
    padding: 0 16px;
}
#loading small { display: block; margin-top: 8px; color: var(--muted); }

@media (max-width: 760px) {
    #header { width: calc(100vw - 20px); }
    #sidebar { top: auto; height: 45vh; width: calc(100vw - 20px); }
    #sidebarToggle { display: none; }
    #info { width: calc(100vw - 20px); bottom: calc(45vh + 54px); }
    #lodStats { display: none; }
}
</style>
</head>
<body>
<div id="viewport"><canvas id="gpu"></canvas></div>
<div id="labels"></div>

<div id="header" class="panel ui">
    <h1><span id="systemName">…</span> <span id="systemSec"></span></h1>
    <div id="systemLinks"></div>
    <input type="text" id="search" placeholder="Jump to system, constellation, region…" autocomplete="off">
    <div id="searchResults"></div>
</div>

<div id="sidebar" class="panel ui">
    <div class="top">
        <h2>Jump to</h2>
        <input type="text" id="treeFilter" placeholder="Filter this system  ( / )" autocomplete="off">
    </div>
    <div id="tree"></div>
</div>
<button id="sidebarToggle" class="ui" title="Show/hide list">☰</button>

<div id="info" class="panel ui"></div>

<div id="statusbar" class="panel ui">
    <span id="status"></span>
    <span id="lodStats"></span>
    <label><input type="checkbox" id="toggleOrbits" checked> Orbits</label>
    <label><input type="checkbox" id="toggleLabels" checked> Labels</label>
    <label><input type="checkbox" id="toggleSky" checked> Sky</label>
    <span id="fps"></span>
    <button id="helpToggle" title="Controls (?)">?</button>
</div>

<div id="helpPanel" class="panel ui">
    <h2>Controls</h2>
    <table>
        <tr><td>Click / double-click</td><td>Select an object / warp to it</td></tr>
        <tr><td>Drag (left)</td><td>Orbit the current target, or look around in free flight</td></tr>
        <tr><td>Drag (right)</td><td>Look around</td></tr>
        <tr><td>Wheel</td><td>Zoom while orbiting; throttle in free flight</td></tr>
        <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Fly (leaves orbit); <kbd>Space</kbd>/<kbd>C</kbd> up/down, <kbd>Shift</kbd> boost</td></tr>
        <tr><td><kbd>Q</kbd><kbd>E</kbd> · arrows</td><td>Roll · turn</td></tr>
        <tr><td><kbd>G</kbd> / <kbd>Enter</kbd></td><td>Warp to selection</td></tr>
        <tr><td><kbd>O</kbd></td><td>Orbit selection</td></tr>
        <tr><td><kbd>J</kbd></td><td>Jump through selected stargate</td></tr>
        <tr><td><kbd>H</kbd></td><td>System overview</td></tr>
        <tr><td><kbd>/</kbd> · <kbd>L</kbd> · <kbd>B</kbd></td><td>Filter list · labels · orbits</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Stop warp / deselect</td></tr>
    </table>
    <p>Everything is drawn at true SDE scale. Objects too small to see are dropped; moons, stations and belts only get a marker once they separate from their parent on screen. Flight speed scales with distance to the nearest surface. Station and stargate sizes are nominal - the SDE has no radius for them. Orbit rings are circles through each body's current position; the SDE has no orbital planes, so they are tilted to the planets' best-fit plane.</p>
</div>

<div id="fade" class="on"></div>
<div id="loading">Starting WebGPU…</div>

<script type="module" src="gpusystem.js"></script>
</body>
</html>
