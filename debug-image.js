'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const engine = require('./engine');
const generate = typeof engine === 'function' ? engine : engine.Generate;

function isWorldObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && v.tiles && v.area && Array.isArray(v.area?.cells);
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

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

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToInt(r, g, b) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function blend(a, b, t) {
  // t=0 -> a, t=1 -> b
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}

async function getWorld(input) {
  // If input is a JSON file path, prefer loading it
  if (input && typeof input === 'string') {
    const candidate = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
    if (fs.existsSync(candidate) && candidate.toLowerCase().endsWith('.json')) {
      const content = fs.readFileSync(candidate, 'utf8');
      const obj = tryParseJSON(content);
      if (isWorldObject(obj)) return obj;
    }
  }

  const res = await Promise.resolve(generate(input));
  if (isWorldObject(res)) return res;

  const raw = Buffer.isBuffer(res) ? res.toString('utf8') : String(res);
  let world = tryLoadWorldFromWriteMessage(raw) || tryParseJSON(raw);
  if (isWorldObject(world)) return world;

  throw new Error('Generate did not return a valid world JSON');
}

function buildDicts(world) {
  const tiles = world.tiles || {};
  const bg = new Map();
  const fg = new Map();
  (tiles.background || []).forEach(t => bg.set(t.id, t));
  (tiles.foreground || []).forEach(t => fg.set(t.id, t));
  return { bg, fg };
}

async function main() {
  const input = process.argv[2] || 'example string';
  const outFile = process.argv[3] || process.env.WORLD_ENGINE_PNG || path.join(process.cwd(), 'debug.png');

  const world = await getWorld(input);
  const width = world.area?.width | 0;
  const height = world.area?.height | 0;
  const cells = world.area?.cells;
  if (!width || !height || !Array.isArray(cells)) {
    throw new Error('World missing area.width/height/cells');
  }

  const { bg: bgDict, fg: fgDict } = buildDicts(world);

  const png = new PNG({ width, height });
  const data = png.data; // Buffer length = width*height*4

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
        // Blend: 70% foreground, 30% background to make FG noticeable
        rgb = blend(bgRGB, fgRGB, 0.7);
      }

      const idx = (y * width + x) << 2;
      data[idx] = rgb.r;
      data[idx + 1] = rgb.g;
      data[idx + 2] = rgb.b;
      data[idx + 3] = 255; // opaque
    }
  }

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile);
    ws.on('finish', resolve);
    ws.on('error', reject);
    png.pack().pipe(ws);
  });

  console.log(`Wrote PNG: ${outFile}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
  });
}
