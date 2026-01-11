'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Drop-in replacement for your generator:
 * - No hard-coded tiles like water/sand/dirt.
 * - LLM (optional) returns a declarative JSON spec (tiles + layers + ops).
 * - Engine interprets a small safe DSL (no eval).
 * - Output is a JSON object: { tiles:{background,foreground}, area:{width,height,cells:[["bg","fg"|null], ...]} }
 *
 * Env:
 * - OPENAI_API_KEY (or OPENAI_KEY)
 * - WORLD_ENGINE_MODEL (default: gpt-5-mini)
 * - WORLD_ENGINE_OUTFILE (optional path; writes JSON and returns a string)
 */

let _openAIClient = null;
function getOpenAIClient() {
  if (_openAIClient) return _openAIClient;
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!key) return null;
  try {
    const OpenAI = require('openai');
    const Client = OpenAI.default || OpenAI;
    _openAIClient = new Client({ apiKey: key });
    return _openAIClient;
  } catch {
    return null;
  }
}

// ------------------------- deterministic RNG + noise -------------------------

function xfnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5;
    return (h >>> 0) / 4294967296;
  };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function makeValueNoise2D(rand) {
  const perm = new Uint16Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function grad(ix, iy) {
    const v = perm[(ix + perm[iy & 255]) & 255];
    return (v / 255) * 2 - 1;
  }

  return function noise2D(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = x0 + 1, y1 = y0 + 1;
    const sx = fade(x - x0), sy = fade(y - y0);

    const n00 = grad(x0, y0), n10 = grad(x1, y0);
    const n01 = grad(x0, y1), n11 = grad(x1, y1);

    const ix0 = lerp(n00, n10, sx);
    const ix1 = lerp(n01, n11, sx);
    const val = lerp(ix0, ix1, sy);
    return (val + 1) / 2;
  };
}

function octaveNoise(noiseFn, x, y, octaves, persistence) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noiseFn(x * freq, y * freq) * amp;
    norm += amp;
    amp *= persistence;
    freq *= 2;
  }
  return sum / (norm || 1);
}

// ------------------------------ validation helpers --------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function uniqIds(list, kind) {
  const s = new Set();
  for (const t of list) {
    assert(t && typeof t === 'object', `${kind} tile must be an object`);
    assert(typeof t.id === 'string' && ID_RE.test(t.id), `${kind} tile.id invalid: "${t.id}"`);
    assert(!s.has(t.id), `${kind} tile.id must be unique: "${t.id}"`);
    s.add(t.id);
  }
  return s;
}

function validateTiles(tiles) {
  assert(tiles && typeof tiles === 'object', 'tiles missing/invalid');
  assert(Array.isArray(tiles.background) && tiles.background.length >= 1, 'tiles.background must be a non-empty array');
  assert(Array.isArray(tiles.foreground), 'tiles.foreground must be an array');

  for (const t of tiles.background) {
    assert(typeof t.name === 'string', `bg(${t.id}).name must be string`);
    assert(typeof t.color === 'string' && HEX_RE.test(t.color), `bg(${t.id}).color must be hex #RRGGBB`);
    assert(typeof t.walkable === 'boolean', `bg(${t.id}).walkable must be boolean`);
  }
  for (const t of tiles.foreground) {
    assert(typeof t.name === 'string', `fg(${t.id}).name must be string`);
    assert(typeof t.symbol === 'string' && t.symbol.length >= 1 && t.symbol.length <= 4, `fg(${t.id}).symbol must be short string`);
    assert(typeof t.color === 'string' && HEX_RE.test(t.color), `fg(${t.id}).color must be hex #RRGGBB`);
    assert(typeof t.walkable === 'boolean', `fg(${t.id}).walkable must be boolean`);
  }

  const bgIds = uniqIds(tiles.background, 'background');
  const fgIds = uniqIds(tiles.foreground, 'foreground');
  return { bgIds, fgIds };
}

function buildIndex(list) {
  const m = new Map();
  for (const t of list) m.set(t.id, t);
  return m;
}

function safeInt(n, def, min, max) {
  const x = Number.isFinite(n) ? Math.floor(n) : def;
  return Math.max(min, Math.min(max, x));
}

function safeNum(n, def, min, max) {
  const x = Number.isFinite(n) ? n : def;
  return Math.max(min, Math.min(max, x));
}

// ------------------------------ shapes & predicates --------------------------

function pointInPoly(poly, x, y) {
  // ray casting
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function shapeContains(shape, x, y) {
  if (!shape || typeof shape !== 'object') return false;
  const k = shape.kind;

  if (k === 'rect' || k === 'roundRect') {
    const rx = safeInt(shape.x, 0, -1e9, 1e9);
    const ry = safeInt(shape.y, 0, -1e9, 1e9);
    const rw = safeInt(shape.w, 0, 0, 1e9);
    const rh = safeInt(shape.h, 0, 0, 1e9);
    if (rw <= 0 || rh <= 0) return false;

    const round = safeNum(shape.round ?? 0, 0, 0, 1e6);
    if (round <= 0 || k === 'rect') {
      return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
    }

    // rounded rect: rect minus corner squares + corner circles
    if (!(x >= rx && x < rx + rw && y >= ry && y < ry + rh)) return false;
    const r = Math.min(round, rw / 2, rh / 2);
    const left = rx + r, right = rx + rw - r;
    const top = ry + r, bottom = ry + rh - r;
    if (x >= left && x < right) return true;
    if (y >= top && y < bottom) return true;

    const cx = x < left ? left : right;
    const cy = y < top ? top : bottom;
    return Math.hypot(x - cx, y - cy) <= r;
  }

  if (k === 'circle') {
    const cx = safeNum(shape.cx, 0, -1e9, 1e9);
    const cy = safeNum(shape.cy, 0, -1e9, 1e9);
    const r = safeNum(shape.r, 0, 0, 1e9);
    return Math.hypot(x - cx, y - cy) <= r;
  }

  if (k === 'polygon') {
    const pts = Array.isArray(shape.points) ? shape.points : [];
    if (pts.length < 3) return false;
    return pointInPoly(pts, x, y);
  }

  if (k === 'line') {
    const a = shape.a, b = shape.b;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const thickness = safeNum(shape.thickness ?? 1, 1, 0.1, 1e6);
    const d = distPointToSegment(x, y, a[0], a[1], b[0], b[1]);
    return d <= thickness / 2;
  }

  return false;
}

function predTrue(pred, x, y, ctx) {
  if (!pred) return true;
  if (pred.all) return Array.isArray(pred.all) && pred.all.every(p => predTrue(p, x, y, ctx));
  if (pred.any) return Array.isArray(pred.any) && pred.any.some(p => predTrue(p, x, y, ctx));
  if (pred.not) return !predTrue(pred.not, x, y, ctx);

  if (pred.layerGt) {
    const [name, t] = pred.layerGt;
    return ctx.sampleLayer(name, x, y) > t;
  }
  if (pred.layerLt) {
    const [name, t] = pred.layerLt;
    return ctx.sampleLayer(name, x, y) < t;
  }
  if (pred.layerBetween) {
    const [name, a, b] = pred.layerBetween;
    const v = ctx.sampleLayer(name, x, y);
    return v >= a && v <= b;
  }
  if (pred.shape) return shapeContains(pred.shape, x, y);

  if (pred.chance != null) {
    const p = clamp01(Number(pred.chance) || 0);
    const rr = xfnv1a(ctx.seed + '|chance|' + (pred.seed || '') + '|' + x + ',' + y)();
    return rr < p;
  }

  return false;
}

// ------------------------------ layer evaluator ------------------------------

function combine(op, a, b, t) {
  switch (op) {
    case 'add': return clamp01(a + b);
    case 'sub': return clamp01(a - b);
    case 'mul': return clamp01(a * b);
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'lerp': {
      const tt = clamp01(Number(t) || 0.5);
      return a + (b - a) * tt;
    }
    case 'threshold': return a >= (Number(t) || 0.5) ? 1 : 0;
    case 'smoothstep': {
      const e0 = Array.isArray(t) ? Number(t[0]) : 0.4;
      const e1 = Array.isArray(t) ? Number(t[1]) : 0.6;
      const x = clamp01((a - e0) / ((e1 - e0) || 1e-9));
      return x * x * (3 - 2 * x);
    }
    default: return a;
  }
}

function makeLayerSampler({ seed, width, height, layers, baseNoise }) {
  // memoize per-layer seed offsets so different layers don't look identical
  const seedOffsets = new Map();
  function layerOffset(seedKey) {
    if (seedOffsets.has(seedKey)) return seedOffsets.get(seedKey);
    const r = xfnv1a(seed + '|layer|' + String(seedKey || ''))();
    // large stable offset in noise-space
    const ox = Math.floor(r * 20000);
    const oy = Math.floor(xfnv1a(seed + '|layer2|' + String(seedKey || ''))() * 20000);
    const v = { ox, oy };
    seedOffsets.set(seedKey, v);
    return v;
  }

  const visiting = new Set(); // cycle detection
  const cacheConst = new Map(); // cache for constant-only layers (rare)

  function sampleLayer(name, x, y) {
    const def = layers?.[name];
    if (!def) throw new Error(`Unknown layer "${name}"`);
    if (def.type === 'const') {
      if (!cacheConst.has(name)) cacheConst.set(name, clamp01(Number(def.value) || 0));
      return cacheConst.get(name);
    }

    // cycle detection (for combine refs)
    const key = name + '@' + x + ',' + y;
    if (visiting.has(key)) throw new Error(`Layer cycle detected at "${name}"`);
    visiting.add(key);

    let out = 0;

    if (def.type === 'fbm') {
      const scale = safeNum(def.scale, 0.01, 1e-6, 1);
      const octaves = safeInt(def.octaves, 3, 1, 8);
      const persistence = safeNum(def.persistence, 0.5, 0.05, 0.95);
      const off = layerOffset(def.seed || name);
      out = octaveNoise(
        baseNoise,
        (x + off.ox) * scale,
        (y + off.oy) * scale,
        octaves,
        persistence
      );
    } else if (def.type === 'valueNoise') {
      const scale = safeNum(def.scale, 0.01, 1e-6, 1);
      const off = layerOffset(def.seed || name);
      out = baseNoise((x + off.ox) * scale, (y + off.oy) * scale);
    } else if (def.type === 'radialGradient') {
      const cx = safeNum(def.cx, width / 2, -1e9, 1e9);
      const cy = safeNum(def.cy, height / 2, -1e9, 1e9);
      const r = safeNum(def.r, Math.min(width, height) / 2, 1, 1e9);
      const invert = !!def.invert;
      let v = 1 - Math.min(1, Math.hypot(x - cx, y - cy) / r);
      if (invert) v = 1 - v;
      out = v;
    } else if (def.type === 'shape') {
      out = shapeContains(def.shape, x, y) ? 1 : 0;
    } else if (def.type === 'combine') {
      const op = String(def.op || 'mul');
      const a = def.a?.ref ? sampleLayer(def.a.ref, x, y) : clamp01(Number(def.a?.const) || 0);
      const b = def.b?.ref ? sampleLayer(def.b.ref, x, y) : clamp01(Number(def.b?.const) || 0);
      out = combine(op, a, b, def.t);
    } else {
      visiting.delete(key);
      throw new Error(`Unsupported layer.type "${def.type}" (layer "${name}")`);
    }

    visiting.delete(key);
    return clamp01(out);
  }

  return { sampleLayer };
}

// ------------------------------ fallback spec -------------------------------

function rgbToHex(r, g, b) {
  const h = (v) => v.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function fallbackSpec(reference) {
  const r = xfnv1a('tiles|' + reference);
  const bgCount = 6;
  const fgCount = 4;

  const background = [];
  for (let i = 0; i < bgCount; i++) {
    const rr = Math.floor(r() * 200) + 30;
    const gg = Math.floor(r() * 200) + 30;
    const bb = Math.floor(r() * 200) + 30;
    background.push({
      id: `bg${i}`,
      name: `BG ${i}`,
      color: rgbToHex(rr, gg, bb),
      walkable: i !== 0 // arbitrary but not semantically "water"
    });
  }

  const symbols = ['■', '▲', '◆', '●', '▣', '▦', '▥'];
  const foreground = [];
  for (let i = 0; i < fgCount; i++) {
    const rr = Math.floor(r() * 200) + 30;
    const gg = Math.floor(r() * 200) + 30;
    const bb = Math.floor(r() * 200) + 30;
    foreground.push({
      id: `fg${i}`,
      name: `FG ${i}`,
      symbol: symbols[i % symbols.length],
      color: rgbToHex(rr, gg, bb),
      walkable: true
    });
  }

  return {
    world: { width: 200, height: 200, metersPerCell: 1 },
    tiles: { background, foreground },
    layers: {
      n0: { type: 'fbm', seed: 'n0', scale: 0.006, octaves: 4, persistence: 0.5 },
      n1: { type: 'fbm', seed: 'n1', scale: 0.012, octaves: 2, persistence: 0.6 },
      mask: { type: 'radialGradient', cx: 500, cy: 500, r: 540, invert: false }
    },
    ops: [
      { type: 'paint', where: { layerLt: ['mask', 0.05] }, bg: 'bg0', fg: null },
      { type: 'paint', where: { all: [{ layerGt: ['mask', 0.05] }, { layerLt: ['n0', 0.20] }] }, bg: 'bg1' },
      { type: 'paint', where: { all: [{ layerGt: ['mask', 0.05] }, { layerBetween: ['n0', 0.20, 0.45] }] }, bg: 'bg2' },
      { type: 'paint', where: { all: [{ layerGt: ['mask', 0.05] }, { layerBetween: ['n0', 0.45, 0.70] }] }, bg: 'bg3' },
      { type: 'paint', where: { all: [{ layerGt: ['mask', 0.05] }, { layerGt: ['n0', 0.70] }] }, bg: 'bg4' },
      { type: 'paint', where: { all: [{ layerGt: ['mask', 0.05] }, { layerGt: ['n1', 0.75] }] }, bg: 'bg5' },

      {
        type: 'stamp.scatter',
        seed: 'scatter',
        where: { layerGt: ['mask', 0.15] },
        count: 16000,
        maxAttempts: 120000,
        prefabs: [
          { w: 1, h: 1, fg: 'fg0', p: 0.40 },
          { w: 1, h: 1, fg: 'fg1', p: 0.30 },
          { w: 2, h: 1, fg: 'fg2', p: 0.20 },
          { w: 2, h: 2, fg: 'fg3', p: 0.10 }
        ]
      }
    ]
  };
}

// ------------------------------ LLM spec fetch ------------------------------

function readWhitelistChars() {
  // Always include ASCII printable
  const ascii = [];
  for (let cp = 0x20; cp <= 0x7e; cp++) ascii.push(String.fromCodePoint(cp));
  let extra = '';
  const fp = process.env.WORLD_ENGINE_WHITELIST || path.join(process.cwd(), 'unicode-whitelist.txt');
  try {
    if (fs.existsSync(fp)) {
      extra = fs.readFileSync(fp, 'utf8');
    }
  } catch {}
  // Merge and dedupe
  const set = new Set([...ascii.join(''), ...String(extra || '')]);
  // Remove obvious whitespace other than space
  set.delete('\n'); set.delete('\r'); set.delete('\t');
  return Array.from(set).join('');
}

async function fetchSpecFromOpenAI(reference) {
  const client = getOpenAIClient();
  if (!client) return fallbackSpec(reference);

  const model = process.env.WORLD_ENGINE_MODEL || 'gpt-5-mini';
  const allowedChars = readWhitelistChars();

const promptsPath = path.join(process.cwd(), 'prompts.json');
let system = '';
let user = '';
try {
    if (fs.existsSync(promptsPath)) {
        const raw = fs.readFileSync(promptsPath, 'utf8');
        const p = JSON.parse(raw);
        // Expected format only: { "system": "...", "user": "..." }
        if (p && typeof p === 'object') {
          if (typeof p.system === 'string') system = p.system;
          if (typeof p.user === 'string') user = p.user;
        }
    }
} catch (e) {
    try { console.error('Error reading prompts.json:', e); } catch {}
    process.exit(1);
}
system = String(system || '');
user = String(user || '');

 // Ensure compliance with JSON-only response_format requirement
 // The OpenAI API requires that at least one message mention "json" when using response_format: json_object
 const defaultSystem = 'You are a generator. Return a JSON object only. Output strictly valid JSON with no extra commentary.';
 if (!/json/i.test(system) && !/json/i.test(user)) {
   system = (defaultSystem + (system ? '\n' + system : ''));
 }
 // Provide a minimal user prompt if none is supplied
 const userMsg = (user && user.trim().length)
   ? user
   : `Generate a world specification for the reference "${reference}". Respond with a JSON object only.`;

 const messages = [
   { role: 'system', content: system.trim() },
   { role: 'user', content: userMsg }
 ];
try {
    const resp = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages
    });

    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    // Debug log raw LLM output
    try {
      const logFile = process.env.WORLD_ENGINE_LLM_LOG || path.join(process.cwd(), 'llm-spec.log');
      const stamp = new Date().toISOString();
      fs.appendFileSync(logFile, `\n[${stamp}] model=${model} raw\n${text}\n`);
    } catch {}

    // Parse JSON; if invalid, log+print raw and exit without fallback
    try {
      const json = JSON.parse(text);
      return json;
    } catch (parseErr) {
      try {
        const logFile = process.env.WORLD_ENGINE_LLM_LOG || path.join(process.cwd(), 'llm-spec.log');
        const stamp = new Date().toISOString();
        fs.appendFileSync(logFile, `\n[${stamp}] model=${model} parse-error\n${(parseErr && parseErr.message) || String(parseErr)}\n`);
      } catch {}
      try { console.log(text); } catch {}
      process.exit(1);
    }
  } catch (err) {
    // Log error for debugging
    try {
      const logFile = process.env.WORLD_ENGINE_LLM_LOG || path.join(process.cwd(), 'llm-spec.log');
      const stamp = new Date().toISOString();
      fs.appendFileSync(logFile, `\n[${stamp}] model=${model} error\n${(err && err.message) || String(err)}\n`);
    } catch {}
    // fall back to deterministic local generator
    return fallbackSpec(reference);
  }
}

// ------------------------------ ops execution -------------------------------

function pickWeighted(rng, items) {
  let sum = 0;
  for (const it of items) sum += Math.max(0, Number(it.p ?? 1) || 0);
  if (sum <= 0) return items[0];
  let t = rng() * sum;
  for (const it of items) {
    t -= Math.max(0, Number(it.p ?? 1) || 0);
    if (t <= 0) return it;
  }
  return items[items.length - 1];
}

async function Generate(reference) {
  if (typeof reference !== 'string') {
    throw new TypeError('Generate(reference): "reference" must be a string.');
  }

  const specRaw = await fetchSpecFromOpenAI(reference);

  // Hard safety clamps: world size fixed
  const width = 200, height = 200;

  // Basic structural validation + tile validation
  const spec = (specRaw && typeof specRaw === 'object') ? specRaw : fallbackSpec(reference);
  spec.world = { width, height, metersPerCell: 1 };

  if (!spec.tiles) spec.tiles = fallbackSpec(reference).tiles;
  const { bgIds, fgIds } = validateTiles(spec.tiles);
  const bgIndex = buildIndex(spec.tiles.background);
  const fgIndex = buildIndex(spec.tiles.foreground);

  // Enforce whitelist on foreground symbols post-parse
  const allowed = new Set(readWhitelistChars().split(''));
  for (const t of spec.tiles.foreground) {
    if (!t || typeof t.symbol !== 'string' || t.symbol.length === 0) continue;
    const ch = Array.from(t.symbol)[0];
    if (!allowed.has(ch)) {
      // replace with a safe ASCII fallback
      const fallbacks = ['^','*','o','@','#','~','+','x'];
      t.symbol = fallbacks[(Math.abs(t.id?.length || 0) + ch.codePointAt(0)) % fallbacks.length];
    } else if (t.symbol.length > 1) {
      // shrink to single character as required
      t.symbol = ch;
    }
  }

  // Validate layers/ops shape lightly (unsupported types will throw during eval)
  const layers = (spec.layers && typeof spec.layers === 'object') ? spec.layers : {};
  const ops = Array.isArray(spec.ops) ? spec.ops : [];

  // Limits (prevents pathological specs)
  assert(Object.keys(layers).length <= 128, 'Too many layers (max 128)');
  assert(ops.length <= 256, 'Too many ops (max 256)');

  // Deterministic noise base for all layers
  const baseRand = xfnv1a(reference);
  const baseNoise = makeValueNoise2D(baseRand);
  const sampler = makeLayerSampler({ seed: reference, width, height, layers, baseNoise });

  // Allocate grids
  const defaultBg = spec.tiles.background[0].id;
  const bgGrid = new Array(height);
  const fgGrid = new Array(height);
  for (let y = 0; y < height; y++) {
    const rb = new Array(width);
    const rf = new Array(width);
    rb.fill(defaultBg);
    rf.fill(null);
    bgGrid[y] = rb;
    fgGrid[y] = rf;
  }

  function requireBg(id, ctx) {
    assert(typeof id === 'string' && bgIds.has(id), `${ctx}: unknown background tile id "${id}"`);
  }
  function requireFgOrNull(id, ctx) {
    if (id === null) return;
    assert(typeof id === 'string' && fgIds.has(id), `${ctx}: unknown foreground tile id "${id}"`);
  }

  // Execute ops in order
  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];
    if (!op || typeof op !== 'object') continue;

    const type = String(op.type || '');
    if (type === 'paint') {
      if (op.bg != null) requireBg(op.bg, `ops[${opIndex}].paint.bg`);
      if (op.fg !== undefined) requireFgOrNull(op.fg, `ops[${opIndex}].paint.fg`);

      for (let y = 0; y < height; y++) {
        const rowBg = bgGrid[y];
        const rowFg = fgGrid[y];
        for (let x = 0; x < width; x++) {
          if (!predTrue(op.where, x, y, { sampleLayer: sampler.sampleLayer, seed: reference })) continue;
          if (op.bg != null) rowBg[x] = op.bg;
          if (op.fg !== undefined) rowFg[x] = op.fg;
        }
      }
      continue;
    }

    if (type === 'roads.grid') {
      requireBg(op.bg, `ops[${opIndex}].roads.grid.bg`);
      const origin = Array.isArray(op.origin) ? op.origin : [0, 0];
      const ox = safeInt(origin[0], 0, -1e9, 1e9);
      const oy = safeInt(origin[1], 0, -1e9, 1e9);
      const spacing = safeInt(op.spacing, 20, 2, 200);
      const thickness = safeInt(op.thickness, 2, 1, 20);

      const inter = op.fgAtIntersections;
      let interId = null, interP = 0, interSeed = '';
      if (inter && typeof inter === 'object') {
        interId = inter.id ?? null;
        requireFgOrNull(interId, `ops[${opIndex}].roads.grid.fgAtIntersections.id`);
        interP = clamp01(Number(inter.p) || 0);
        interSeed = String(inter.seed || '');
      }

      for (let y = 0; y < height; y++) {
        const rowBg = bgGrid[y];
        const rowFg = fgGrid[y];
        const gy = ((y - oy) % spacing + spacing) % spacing;
        for (let x = 0; x < width; x++) {
          if (!predTrue(op.where, x, y, { sampleLayer: sampler.sampleLayer, seed: reference })) continue;
          const gx = ((x - ox) % spacing + spacing) % spacing;

          const onV = gx < thickness;
          const onH = gy < thickness;
          if (!(onV || onH)) continue;

          rowBg[x] = op.bg;

          if (interId && interP > 0 && onV && onH) {
            const rr = xfnv1a(reference + '|roads|' + interSeed + '|' + x + ',' + y)();
            if (rr < interP) rowFg[x] = interId;
          }
        }
      }
      continue;
    }

    if (type === 'stamp.scatter') {
      const seed = String(op.seed || 'scatter');
      const where = op.where;
      const count = safeInt(op.count, 200, 1, 200000);
      const maxAttempts = safeInt(op.maxAttempts, count * 10, 1, 400000);

      const prefabs = Array.isArray(op.prefabs) ? op.prefabs : [];
      assert(prefabs.length >= 1 && prefabs.length <= 128, `ops[${opIndex}].stamp.scatter.prefabs must be 1..128`);

      // validate prefab tile ids
      for (let i = 0; i < prefabs.length; i++) {
        const pf = prefabs[i];
        assert(pf && typeof pf === 'object', `prefab[${i}] must be object`);
        const w = safeInt(pf.w, 1, 1, 200);
        const h = safeInt(pf.h, 1, 1, 200);
        pf.w = w; pf.h = h;
        if (pf.bg != null) requireBg(pf.bg, `ops[${opIndex}].prefabs[${i}].bg`);
        if (pf.fg != null) requireFgOrNull(pf.fg, `ops[${opIndex}].prefabs[${i}].fg`);
        pf.p = clamp01(Number(pf.p ?? 1) || 0);
      }

      // occupancy to reduce overlaps (1 byte per cell)
      const occ = new Uint8Array(width * height);
      const rng = xfnv1a(reference + '|scatter|' + seed);

      function canPlace(x0, y0, w, h) {
        if (x0 < 0 || y0 < 0 || x0 + w > width || y0 + h > height) return false;
        for (let y = y0; y < y0 + h; y++) {
          const row = y * width;
          for (let x = x0; x < x0 + w; x++) {
            if (occ[row + x]) return false;
          }
        }
        return true;
      }

      function markPlace(x0, y0, w, h) {
        for (let y = y0; y < y0 + h; y++) {
          const row = y * width;
          for (let x = x0; x < x0 + w; x++) occ[row + x] = 1;
        }
      }

      let placed = 0;
      for (let attempt = 0; attempt < maxAttempts && placed < count; attempt++) {
        const pf = pickWeighted(rng, prefabs);
        const w = pf.w, h = pf.h;

        const x0 = Math.floor(rng() * (width - w + 1));
        const y0 = Math.floor(rng() * (height - h + 1));

        // predicate check: test center of stamp (fast & usually good enough)
        const cx = x0 + Math.floor(w / 2);
        const cy = y0 + Math.floor(h / 2);
        if (!predTrue(where, cx, cy, { sampleLayer: sampler.sampleLayer, seed: reference })) continue;

        if (!canPlace(x0, y0, w, h)) continue;

        // stamp bg
        if (pf.bg != null) {
          for (let y = y0; y < y0 + h; y++) {
            const rowBg = bgGrid[y];
            for (let x = x0; x < x0 + w; x++) rowBg[x] = pf.bg;
          }
        }

        // stamp fg at center
        if (pf.fg != null) {
          fgGrid[cy][cx] = pf.fg;
        }

        markPlace(x0, y0, w, h);
        placed++;
      }
      continue;
    }

    // Unknown op -> fail safe (reject)
    throw new Error(`Unsupported op.type "${type}" at ops[${opIndex}]`);
  }

  // Compose cells: [["bgId","fgId"|null], ...]
  const cells = new Array(height);
  for (let y = 0; y < height; y++) {
    const row = new Array(width);
    const rowBg = bgGrid[y];
    const rowFg = fgGrid[y];
    for (let x = 0; x < width; x++) {
      row[x] = [rowBg[x], rowFg[x] === undefined ? null : rowFg[x]];
    }
    cells[y] = row;
  }

  const output = {
    tiles: spec.tiles,
    area: {
      width,
      height,
      cells
    }
  };

  const outFile = process.env.WORLD_ENGINE_OUTFILE;
  if (outFile) {
    const abs = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
    fs.writeFileSync(abs, JSON.stringify(output));
    return `Wrote terrain JSON to ${abs}`;
  }

  return output;
}

module.exports = { Generate };