#!/usr/bin/env node
'use strict';
//
//  gamesir-battery.js — mini CLI that reads charge level from connected
//  GameSir controllers, by reverse-engineering the same input-report path
//  that GameSir Connect's main.js uses internally.
//
//  Works for models whose battery is reported in HID input report 0x12:
//    • CYCLONE 2  (class Va / proxyC2)
//    • CYCLONE 3  (proxyC3)
//    • Tarantula CE (proxyT3CE)
//    • G7 Pro 8K  (proxyG7ProCE)
//
//  Other GameSir models (Nova 2 Lite, NovaPro, Tarantula Pro, N2S…) read
//  battery via a vendor SAPJoy DLL we don't have here, so they're skipped.
//
//  Usage:
//    node gamesir-battery.js          # one-shot poll, print and exit
//    node gamesir-battery.js --watch  # keep updating until Ctrl+C

const HID = require('node-hid');

const VID = 0x3537; // GameSir vendor id

// Per-model decoding. Byte offsets are into the raw HID input report buffer
// (byte 0 is the report id). Verified against the parseGamepadState methods
// in dist/electron/main.js.
const DEVICES = [
  { model: 'C2',      name: 'Cyclone 2',     chargeOffset: 35, batteryOffset: 36,
    pids: [0x101D, 0x102A, 0x1053, 0x100B] },
  { model: 'C3',      name: 'Cyclone 3',     chargeOffset: 35, batteryOffset: 36,
    pids: [0x108E, 0x109F] },
  { model: 'T3CE',    name: 'Tarantula CE',  chargeOffset: 27, batteryOffset: 28,
    pids: [0x103D] },
  { model: 'G7ProCE', name: 'G7 Pro 8K',     chargeOffset: 35, batteryOffset: 36,
    pids: [0x10B7, 0x10B9, 0x10C5, 0x10C6, 0x10CD, 0x10CE, 0x10FD, 0x10FE] },
];

const REPORT_ID = 0x12;        // GamepadKeyStateReportId = 18
const HEARTBEAT = [0x0F, 0xF2, 0x00]; // wakes the controller — taken from getHeartBeatCommand()

function defForPid(pid) {
  return DEVICES.find(d => d.pids.includes(pid)) || null;
}

// One physical controller may expose multiple HID interfaces; group them so
// we open all of them in parallel and just keep the first one that talks.
function groupByPhysicalDevice(devs) {
  const m = new Map();
  for (const d of devs) {
    const key = `${d.vendorId}:${d.productId}:${d.serialNumber || d.product || d.path.split('#')[1] || ''}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(d);
  }
  return [...m.values()];
}

function readOnce(interfaces, def, timeoutMs = 2500) {
  return new Promise(resolve => {
    let done = false;
    const opened = [];
    const finish = result => {
      if (done) return;
      done = true;
      for (const h of opened) { try { h.close(); } catch {} }
      resolve(result);
    };

    for (const iface of interfaces) {
      let h;
      try { h = new HID.HID(iface.path); }
      catch { continue; } // probably opened by GameSir Connect already
      opened.push(h);

      h.on('data', buf => {
        if (buf[0] !== REPORT_ID) return;
        if (buf.length <= def.batteryOffset) return;
        finish({
          chargeState: buf[def.chargeOffset],
          battery:     buf[def.batteryOffset],
        });
      });
      h.on('error', () => {});
      // poke the controller — vendor reports sometimes only come on activity
      try { h.write(HEARTBEAT); } catch {}
    }

    if (opened.length === 0) {
      finish({ error: 'could not open any HID interface (is GameSir Connect running?)' });
      return;
    }
    setTimeout(() => finish({ error: 'no response (try pressing a button on the controller)' }), timeoutMs);
  });
}

function fmt(result, def, productId) {
  const pidHex = '0x' + productId.toString(16).padStart(4, '0').toUpperCase();
  const head = `${def.name.padEnd(14)} ${pidHex}`;
  if (result.error) return `${head}  —  ${result.error}`;
  const bar = ''.repeat(Math.round(result.battery / 5)).padEnd(20, '');
  const charging = result.chargeState === 1 ? ' ' : '  ';
  return `${head}  ${String(result.battery).padStart(3)}% ${bar}${charging}`;
}

async function pollOnce() {
  const all = HID.devices();
  const matches = all.filter(d => d.vendorId === VID && defForPid(d.productId));
  const groups = groupByPhysicalDevice(matches);

  if (groups.length === 0) {
    console.log('No supported GameSir controllers detected.');
    console.log('(Models read by this tool: ' + DEVICES.map(d => d.name).join(', ') + ')');
    return false;
  }

  const lines = [];
  for (const interfaces of groups) {
    const first = interfaces[0];
    const def = defForPid(first.productId);
    const result = await readOnce(interfaces, def);
    lines.push(fmt(result, def, first.productId));
  }
  // redraw cleanly when in --watch mode
  if (process.argv.includes('--watch')) {
    process.stdout.write('\x1b[H\x1b[2J'); // clear screen
    console.log(`GameSir charge — ${new Date().toLocaleTimeString()}\n`);
  }
  console.log(lines.join('\n'));
  return true;
}

(async () => {
  if (process.argv.includes('--watch')) {
    // refresh every 3s. press Ctrl+C to stop.
    while (true) {
      await pollOnce();
      await new Promise(r => setTimeout(r, 3000));
    }
  } else {
    await pollOnce();
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
