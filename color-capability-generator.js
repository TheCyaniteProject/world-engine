'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function promptYesNo(rl, question) {
  return new Promise(resolve => {
    rl.question(question + ' (y/N) ', answer => {
      const c = (answer || '').trim().toLowerCase();
      resolve(c === 'y' || c === 'yes');
    });
  });
}

function rgbToHex(r,g,b){
  const h=v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0');
  return '#' + h(r)+h(g)+h(b);
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

function buildAnsi16Palette(){
  // Standard ANSI 16 palette (approx RGB)
  const colors = [
    '#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0',
    '#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'
  ];
  return colors;
}

function buildXterm256Palette(){
  const out=[];
  // 16 basic
  out.push(...buildAnsi16Palette());
  // 6x6x6 cube (16..231)
  const levels=[0,95,135,175,215,255];
  for(let r=0;r<6;r++){
    for(let g=0;g<6;g++){
      for(let b=0;b<6;b++){
        out.push(rgbToHex(levels[r],levels[g],levels[b]));
      }
    }
  }
  // grayscale (232..255)
  for(let i=0;i<24;i++){
    const v=8+i*10;
    out.push(rgbToHex(v,v,v));
  }
  return out;
}

async function main(){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Terminal color capability setup');
  console.log('This will create a color profile JSON for the viewer.');
  console.log('');

  // Truecolor test
  console.log('24-bit truecolor test (should look like a smooth gradient):');
  let line='';
  for(let i=0;i<60;i++){
    const r=Math.floor(255*i/59);
    const g=Math.floor(255*(59-i)/59);
    const b=180;
    line += `\x1b[48;2;${r};${g};${b}m `;
  }
  line += '\x1b[0m';
  console.log(line);
  const truecolorOk = await promptYesNo(rl,'Does the above gradient look smooth (no banding with few steps)?');

  let mode='truecolor';
  let palette=null;
  if(!truecolorOk){
    // 256-color test
    console.log('\n256-color test (should show many distinct colors):');
    let out='';
    for(let i=16;i<232;i++){
      out += `\x1b[48;5;${i}m `;
      if(((i-16)+1)%36===0){ out+='\x1b[0m\n'; }
    }
    out+='\x1b[0m\n';
    console.log(out);
    const x256ok = await promptYesNo(rl,'Do you see a broad range of distinct colors (not just a few)?');
    if(x256ok){
      mode='xterm256';
      palette=buildXterm256Palette();
    } else {
      // 16-color test
      console.log('\nANSI 16-color test:');
      let out16='';
      for(let i=0;i<16;i++){
        out16 += `\x1b[48;5;${i}m ${i.toString().padStart(2,' ')} `;
      }
      out16+='\x1b[0m\n';
      console.log(out16);
      const ansiOk = await promptYesNo(rl,'Do these 16 swatches render with distinct colors?');
      mode='ansi16';
      palette=buildAnsi16Palette();
      if(!ansiOk){
        console.log('Warning: Even 16-color not confirmed. Proceeding with ANSI 16 fallback palette.');
      }
    }
  }

  // Color blindness option
  console.log('\nColor blindness options:');
  console.log('  1) none');
  console.log('  2) protanopia');
  console.log('  3) deuteranopia');
  console.log('  4) tritanopia');
  const cbMode = await new Promise(resolve => {
    rl.question('Select (1-4) [1]: ', ans => {
      const v=(ans||'').trim();
      if(v==='2') return resolve('protanopia');
      if(v==='3') return resolve('deuteranopia');
      if(v==='4') return resolve('tritanopia');
      return resolve('none');
    });
  });

  // If palette exists, optionally adjust preview through CB simulation for awareness
  if(palette){
    const adjusted = palette.slice(0,16).map(hex=>{
      const n=parseInt(hex.slice(1),16);
      const r=(n>>16)&255,g=(n>>8)&255,b=n&255;
      const [rr,gg,bb]=applyCB([r,g,b],cbMode);
      return rgbToHex(rr,gg,bb);
    });
    console.log('\nExample after color-blindness simulation (first 16 palette colors):');
    let line2='';
    for(const h of adjusted){
      const n=parseInt(h.slice(1),16);
      const r=(n>>16)&255,g=(n>>8)&255,b=n&255;
      line2 += `\x1b[48;2;${r};${g};${b}m  `;
    }
    line2+='\x1b[0m\n';
    console.log(line2);
  }

  rl.close();

  const profile = { mode, palette, colorBlindMode: cbMode };
  const outFile = process.env.WORLD_ENGINE_COLOR_PROFILE || path.join(process.cwd(),'color-profile.json');
  fs.writeFileSync(outFile, JSON.stringify(profile, null, 2));
  console.log(`Saved color profile to ${outFile}`);
}

if(require.main===module){
  main().catch(err=>{ console.error('Error:', err?.message||err); process.exit(1); });
}
