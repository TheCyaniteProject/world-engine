'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function range(start, end) {
  const out = [];
  for (let cp = start; cp <= end; cp++) out.push(String.fromCodePoint(cp));
  return out.join('');
}

function asciiPrintable() {
  const out = [];
  for (let cp = 0x20; cp <= 0x7e; cp++) out.push(String.fromCodePoint(cp));
  return out.join('');
}

const GROUPS = [
  {
    id: 'arrows',
    name: 'Arrows',
    sample: '← ↑ → ↓ ↔ ↕',
    chars: range(0x2190, 0x21ff),
    ask: ['←','↑','→','↓','↔','↕']
  },
  {
    id: 'box-drawing',
    name: 'Box Drawing',
    sample: '┌┐└┘ ─ │ ┼ ┣┳┫┻',
    chars: range(0x2500, 0x257f),
    ask: ['┌','┐','└','┘','─','│','┼','┣','┳','┫','┻']
  },
  {
    id: 'block-elements',
    name: 'Block Elements',
    sample: '░ ▒ ▓ █ ▁ ▂ ▃ ▄ ▅ ▆ ▇',
    chars: range(0x2580, 0x259f),
    ask: ['░','▒','▓','█','▁','▂','▃','▄','▅','▆','▇']
  },
  {
    id: 'geometric-shapes',
    name: 'Geometric Shapes',
    sample: '■ □ ● ○ ▲ △ ▼ ▽ ◆ ◇',
    chars: range(0x25a0, 0x25ff),
    ask: ['■','□','●','○','▲','△','▼','▽','◆','◇']
  },
  {
    id: 'misc-symbols',
    name: 'Misc Symbols',
    sample: '★ ☆ ☼ ☂ ♣ ♠ ♥ ♦',
    chars: range(0x2600, 0x26ff),
    ask: ['★','☆','☼','☂','♣','♠','♥','♦']
  },
  {
    id: 'misc-technical',
    name: 'Misc Technical',
    sample: '⌂ ⌘ ⌶ ⌧',
    chars: range(0x2300, 0x23ff),
    ask: ['⌂','⌘','⌶','⌧']
  },
  {
    id: 'dingbats',
    name: 'Dingbats',
    sample: '✓ ✗ ✚ ✖ ✿ ✦ ✧ ✪',
    chars: range(0x2700, 0x27bf),
    ask: ['✓','✗','✚','✖','✿','✦','✧','✪']
  },
  {
    id: 'braille',
    name: 'Braille Patterns',
    sample: '⣿ ⠿ ⠛ ⠋',
    chars: range(0x2800, 0x28ff),
    ask: ['⣿','⠿','⠛','⠋']
  },
  {
    id: 'emoji-basic',
    name: 'Emoji (basic test)',
    sample: '🌴 🔥 🌊 🏠',
    chars: ['🌴','🔥','🌊','🏠'].join(''),
    ask: ['🌴','🔥','🌊','🏠']
  }
];

function promptYesNo(rl, question) {
  return new Promise(resolve => {
    rl.question(question + ' (y/N) ', answer => {
      const c = (answer || '').trim().toLowerCase();
      resolve(c === 'y' || c === 'yes');
    });
  });
}

async function main() {
  const outPath = process.env.WORLD_ENGINE_WHITELIST || path.join(process.cwd(), 'unicode-whitelist.txt');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Unicode whitelist generator');
  console.log('This will build a whitelist of characters supported in your terminal/font.');
  console.log('ASCII will always be included.');
  console.log('');

  const included = new Set();
  // Always include ASCII printable + newline
  asciiPrintable().split('').forEach(ch => included.add(ch));

  for (const g of GROUPS) {
    console.log(`Group: ${g.name}`);
    console.log(`Preview: ${g.sample}`);
    const allOk = await promptYesNo(rl, 'Do these look correct in your terminal?');
    if (allOk) {
      // Include entire group
      for (const ch of Array.from(g.chars)) included.add(ch);
      console.log(`Included ${g.name}.`);
      console.log('');
      continue;
    }

    const anyOk = await promptYesNo(rl, 'Do any of them look correct?');
    if (!anyOk) {
      console.log(`Skipping ${g.name}.`);
      console.log('');
      continue;
    }

    // Ask about representative/common glyphs individually
    const toAsk = Array.isArray(g.ask) && g.ask.length ? g.ask : Array.from(new Set(Array.from(g.sample).filter(ch => ch.trim() !== '')));
    let added = 0;
    for (const r of toAsk) {
      const ok = await promptYesNo(rl, `Does '${r}' render as expected?`);
      if (ok) { included.add(r); added++; }
    }
    console.log(`Added ${added} characters from ${g.name}.`);
    console.log('');
  }

  rl.close();

  // Build final whitelist string
  const whitelist = Array.from(included).join('');
  fs.writeFileSync(outPath, whitelist, 'utf8');
  console.log(`Wrote whitelist: ${outPath}`);
  console.log('To use this whitelist during generation, the engine will auto-load unicode-whitelist.txt');
  console.log('or set WORLD_ENGINE_WHITELIST to the file path.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err?.message || err);
    process.exit(1);
  });
}
