// Try to force truecolor to avoid poor downsampling (magenta-ish hues)
if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '3';

// Viewer viewport size (change here)
const VIEW_WIDTH = Number(process.env.WORLD_ENGINE_VIEW_WIDTH) || 65;
const VIEW_HEIGHT = Number(process.env.WORLD_ENGINE_VIEW_HEIGHT) || 21;

const engine = require('./engine');
const generate = typeof engine === 'function' ? engine : engine.Generate;
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

if (!generate) {
    console.error('Generate function not found in ./engine.js');
    process.exit(1);
}

// Load ESM-only chalk inside CommonJS via dynamic import and cache it
let chalkPromise;
function getChalk() {
    if (!chalkPromise) {
        chalkPromise = import('chalk').then(m => {
            // Prefer a Chalk instance with level 3 (truecolor) when possible
            try {
                const ChalkCtor = m.Chalk || (m.default && m.default.Chalk);
                if (ChalkCtor) return new ChalkCtor({ level: 3 });
            } catch {}
            // Fallback to module default (will detect level automatically)
            return m.default || m;
        });
    }
    return chalkPromise;
}

function truncate(str, max = 2000) {
    str = String(str ?? '');
    if (str.length <= max) return str;
    return str.slice(0, max) + `... (truncated ${str.length - max} chars)`;
}

function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

function isHexRed(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return r >= 200 && g <= 80 && b <= 80;
}

function hexToRgb(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function blendRGB(a, b, t) {
    return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t)
    };
}

function isWorldObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) && v.tiles && v.area;
}

function tryParseJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
}

// If engine returns "Wrote terrain JSON to <path>", load that file.
function tryLoadWorldFromWriteMessage(str) {
    const m = /^Wrote terrain JSON to (.+)$/.exec(String(str || '').trim());
    if (!m) return null;
    const filePath = m[1].trim();
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function firstChar(str) {
    // Better than str[0] for many unicode symbols
    const arr = Array.from(String(str || ''));
    return arr[0] || ' ';
}

// ---- Color profile loading and sanitization ----
function rgbToHex(r,g,b){
    const h=v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0');
    return '#' + h(r)+h(g)+h(b);
}

function loadColorProfile() {
    const fp = process.env.WORLD_ENGINE_COLOR_PROFILE || path.join(process.cwd(), 'color-profile.json');
    try {
        if (fs.existsSync(fp)) {
            const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (obj && (obj.mode === 'truecolor' || obj.mode === 'xterm256' || obj.mode === 'ansi16')) {
                return { mode: obj.mode, palette: Array.isArray(obj.palette) ? obj.palette : null, colorBlindMode: obj.colorBlindMode || 'none' };
            }
        }
    } catch {}
    return { mode: 'truecolor', palette: null, colorBlindMode: 'none' };
}

function applyCB(rgb, mode){
    if(!mode || mode==='none') return rgb;
    const [r,g,b]=rgb;
    let m=null;
    if(mode==='protanopia') m=[
        0.56667,0.43333,0.0,
        0.55833,0.44167,0.0,
        0.0,0.24167,0.75833
    ];
    else if(mode==='deuteranopia') m=[
        0.625,0.375,0.0,
        0.70,0.30,0.0,
        0.0,0.30,0.70
    ];
    else if(mode==='tritanopia') m=[
        0.95,0.05,0.0,
        0.0,0.43333,0.56667,
        0.0,0.475,0.525
    ];
    if(!m) return rgb;
    const rr = r*m[0] + g*m[1] + b*m[2];
    const gg = r*m[3] + g*m[4] + b*m[5];
    const bb = r*m[6] + g*m[7] + b*m[8];
    return [Math.max(0,Math.min(255,rr)),Math.max(0,Math.min(255,gg)),Math.max(0,Math.min(255,bb))];
}

function dist2(a,b){
    const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2];
    return dr*dr+dg*dg+db*db;
}

function makeSanitizer(profile){
    const mode = profile.mode || 'truecolor';
    const palette = Array.isArray(profile.palette) ? profile.palette.slice() : null;
    const cb = profile.colorBlindMode || 'none';

    let paletteRGB = null;
    if (mode !== 'truecolor' && palette) {
        paletteRGB = palette.map(h=>{
            const n=parseInt(h.slice(1),16);
            return [ (n>>16)&255, (n>>8)&255, n&255 ];
        });
    }

    return function sanitize(hex) {
        // parse input
        const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex||''));
        if (!m) return hex || '#000000';
        const num = parseInt(m[1],16);
        let rgb = [ (num>>16)&255, (num>>8)&255, num&255 ];
        // apply color-blindness simulation for better consistency
        rgb = applyCB(rgb, cb);
        if (mode === 'truecolor' || !paletteRGB) {
            return rgbToHex(rgb[0],rgb[1],rgb[2]);
        }
        // nearest palette color
        let bestIdx=0, bestD=Infinity;
        for (let i=0;i<paletteRGB.length;i++){
            const d=dist2(rgb, paletteRGB[i]);
            if (d<bestD){ bestD=d; bestIdx=i; }
        }
        const p=paletteRGB[bestIdx];
        return rgbToHex(p[0],p[1],p[2]);
    };
}

async function runWithInput(input) {
    try {
        const res = await Promise.resolve(generate(input));
        const chalk = await getChalk();

        // Load color profile and build sanitizer
        const colorProfile = loadColorProfile();
        const sanitizeColor = makeSanitizer(colorProfile);

        // Clear viewer log on first run this process
        const logPath = process.env.WORLD_ENGINE_LOG || path.join(process.cwd(), 'generate-output.log');
        if (!runWithInput._logCleared) {
            try { fs.writeFileSync(logPath, ''); } catch {}
            runWithInput._logCleared = true;
        }

        // --- NEW: support Generate() returning an object directly ---
        let world = null;

        if (isWorldObject(res)) {
            world = res;
        } else if (typeof res === 'string' || Buffer.isBuffer(res)) {
            const raw = Buffer.isBuffer(res) ? res.toString('utf8') : res;

            // special case: outfile message
            world = tryLoadWorldFromWriteMessage(raw);

            if (!world) {
                world = tryParseJSON(raw);
            }

            if (!world) {
                // write raw output for debugging
                const logFile = logPath;
                try {
                    const stamp = new Date().toISOString();
                    fs.appendFileSync(logFile, `\n[${stamp}] (raw, parse failed)\n${truncate(raw, 5000)}\n`);
                } catch (e) {
                    console.error('Failed writing log file:', e.message);
                }
                console.error('Generate did not return a world object or JSON; viewer cannot render a map. See log file.');
                return;
            }
        } else {
            console.error('Generate returned an unsupported type:', typeof res);
            return;
        }

        // Build a compact, readable summary without repeating values like full cells
        const logFile = logPath;
        try {
            const tiles = world.tiles || {};
            const area = world.area || {};
            const width = area.width | 0, height = area.height | 0;
            const cells = Array.isArray(area.cells) ? area.cells : null;

            const sampleSize = 7;
            const sy = Math.min(sampleSize, height || 0);
            const sx = Math.min(sampleSize, width || 0);

            let sample = undefined;
            if (cells && sx && sy) {
                sample = [];
                for (let y = 0; y < sy; y++) {
                    const row = [];
                    for (let x = 0; x < sx; x++) {
                        const pair = cells?.[y]?.[x];
                        if (Array.isArray(pair) && pair.length >= 1) {
                            row.push(`${pair[0]}:${pair[1] ?? ''}`);
                        } else {
                            row.push('?:?');
                        }
                    }
                    sample.push(row);
                }
            }

            const summary = {
                tiles: {
                    background: (tiles.background || []).map(t => ({ id: t.id, color: t.color, walkable: t.walkable })),
                    foreground: (tiles.foreground || []).map(t => ({ id: t.id, symbol: t.symbol, color: t.color, walkable: t.walkable }))
                },
                area: {
                    width,
                    height,
                    cells: cells ? `omitted (${width}x${height})` : undefined,
                    sampleTopLeft: sample ? { size: [sx, sy], data: sample } : undefined
                }
            };

            const stamp = new Date().toISOString();
            fs.appendFileSync(logFile, `\n[${stamp}] summary\n${JSON.stringify(summary, null, 2)}\n`);
        } catch (e) {
            console.error('Failed writing summary log:', e.message);
        }

        const tiles = world.tiles || {};
        const area = world.area || {};
        const cells = area.cells;
        const width = area.width | 0, height = area.height | 0;

        if (!Array.isArray(cells) || !width || !height) {
            console.error('Invalid world object: missing area.cells/width/height');
            return;
        }

        // Build tile dictionaries by id for quick lookup
        const bgDict = new Map();
        const fgDict = new Map();
        (tiles.background || []).forEach(t => bgDict.set(t.id, t));
        (tiles.foreground || []).forEach(t => fgDict.set(t.id, t));

        const VIEW_W = Math.max(3, Math.min(79, Number(VIEW_WIDTH) || 21));
        const VIEW_H = Math.max(3, Math.min(43, Number(VIEW_HEIGHT) || 21));
        const HALF_W = Math.floor(VIEW_W / 2);
        const HALF_H = Math.floor(VIEW_H / 2);
        let playerX = Math.floor(width / 2);
        let playerY = Math.floor(height / 2);

        let statusMsg = '';
        const setStatus = (m) => { statusMsg = m || ''; };

        function draw() {
            const startX = clamp(playerX - HALF_W, 0, Math.max(0, width - VIEW_W));
            const startY = clamp(playerY - HALF_H, 0, Math.max(0, height - VIEW_H));

            // Clear screen and hide cursor
            process.stdout.write('\u001b[2J\u001b[0;0H');
            process.stdout.write('\u001b[?25l');

            for (let y = 0; y < VIEW_H; y++) {
                const worldY = startY + y;
                if (worldY >= height) { console.log(''); continue; }

                let line = '';
                for (let x = 0; x < VIEW_W; x++) {
                    const worldX = startX + x;
                    if (worldX >= width) { line += ' '; continue; }

                    const pair = cells?.[worldY]?.[worldX];
                    const bgId = Array.isArray(pair) ? pair[0] : null;
                    const fgId = Array.isArray(pair) ? pair[1] : null;

                    const bgRaw = bgDict.get(bgId) || { color: '#000000' };
                    const fgRaw = fgId ? fgDict.get(fgId) : null;
                    const bg = { ...bgRaw, color: sanitizeColor(bgRaw.color) };
                    const fg = fgRaw ? { ...fgRaw, color: sanitizeColor(fgRaw.color) } : null;

                    const isPlayer = (worldX === playerX && worldY === playerY);
                    if (isPlayer) {
                        const playerChar = '@';
                        const playerColor = isHexRed(bg.color) ? '#0000ff' : '#ff0000';
                        line += chalk.bgHex(bg.color || '#000000').hex(playerColor)(playerChar);
                    } else if (fg && fg.symbol) {
                        line += chalk.bgHex(bg.color || '#000000').hex(fg.color || '#ffffff')(firstChar(fg.symbol));
                    } else {
                        // background only - use space with background color
                        line += chalk.bgHex(bg.color || '#000000')(' ');
                    }
                }
                console.log(line);
            }
            console.log('WASD to move, Q to quit, P to export PNG');
            if (statusMsg) console.log(statusMsg);
        }

        let keyHandler = null;
        function cleanup() {
            try {
                if (process.stdin.isTTY) {
                    try { process.stdin.setRawMode(false); } catch {}
                }
                if (keyHandler) {
                    try { process.stdin.off('keypress', keyHandler); } catch {}
                }
                try { process.stdin.pause(); } catch {}
                process.stdout.write('\u001b[?25h');
            } catch {}
        }

        // Initial draw
        draw();

        const readline = require('readline');
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch {}
            try { process.stdin.resume(); } catch {}
        }

        async function exportPng(outFile) {
            const png = new PNG({ width, height });
            const data = png.data;
            for (let y = 0; y < height; y++) {
                const row = cells[y];
                for (let x = 0; x < width; x++) {
                    const pair = row[x];
                    const bgId = Array.isArray(pair) ? pair[0] : null;
                    const fgId = Array.isArray(pair) ? pair[1] : null;
                    const bgTile = bgDict.get(bgId) || { color: '#000000' };
                    const fgTile = fgId ? fgDict.get(fgId) : null;

                    const bgRGB = hexToRgb(bgTile.color);
                    let rgb = bgRGB;
                    if (fgTile && fgTile.color) {
                        const fgRGB = hexToRgb(fgTile.color);
                        rgb = blendRGB(bgRGB, fgRGB, 0.7);
                    }

                    const idx = (y * width + x) << 2;
                    data[idx] = rgb.r;
                    data[idx + 1] = rgb.g;
                    data[idx + 2] = rgb.b;
                    data[idx + 3] = 255;
                }
            }

            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(outFile);
                ws.on('finish', resolve);
                ws.on('error', reject);
                png.pack().pipe(ws);
            });
        }

        function onKey(_str, key) {
            if (!key) return;
            if (key.sequence) {
                const c = key.sequence.toLowerCase();
                if (c === 'q' || (key.name === 'c' && key.ctrl)) {
                    cleanup();
                    process.exit(0);
                }
                if (c === 'w') playerY = Math.max(0, playerY - 1);
                else if (c === 's') playerY = Math.min(height - 1, playerY + 1);
                else if (c === 'a') playerX = Math.max(0, playerX - 1);
                else if (c === 'd') playerX = Math.min(width - 1, playerX + 1);
                else if (c === 'p') {
                    const outFile = process.env.WORLD_ENGINE_PNG || path.join(process.cwd(), `world-${Date.now()}.png`);
                    setStatus(`Exporting PNG to ${outFile} ...`);
                    draw();
                    exportPng(outFile)
                        .then(() => { setStatus(`Wrote PNG: ${outFile}`); draw(); })
                        .catch(err => { setStatus(`Export failed: ${err?.message || err}`); draw(); });
                    return; // draw already called
                }
                draw();
            }
        }

        keyHandler = onKey;
        process.stdin.on('keypress', keyHandler);
        process.on('exit', cleanup);
        process.on('SIGINT', () => { cleanup(); process.exit(0); });
        process.on('uncaughtException', () => { cleanup(); });
    } catch (err) {
        console.error('Error:', err);
        process.exitCode = 1;
    }
}

// If data is piped in, read all stdin. Otherwise prompt (or use argv/default).
if (!process.stdin.isTTY) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
        runWithInput(data.replace(/\r?\n$/, ''));
    });
} else {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const defaultInput = process.argv[2] || 'example string';
    rl.question(`Zone description: `, answer => {
        rl.close();
        const input = answer.trim() === '' ? defaultInput : answer;
        runWithInput(input);
    });
}