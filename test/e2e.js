// End-to-end smoke test: launches two dev instances of the app with separate
// profiles, connects them over PeerJS, and drives both windows through the
// Chrome DevTools Protocol. Windows-only (uses PowerShell for the clipboard).
//
//   npm run test:e2e
//
// It needs internet access for the PeerJS broker, opens two app windows, and
// replaces the system clipboard while it runs.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(os.tmpdir(), 'file-transfer-e2e');
const FIXTURES = path.join(WORK, 'fixtures');
const RECEIVED_ROOT = path.join(os.tmpdir(), 'FileTransferApp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function pass(name, detail = '') { results.push(['PASS', name, detail]); console.log('PASS', name, detail); }
function fail(name, detail = '') { results.push(['FAIL', name, detail]); console.log('FAIL', name, detail); }
function check(cond, name, detail = '') { (cond ? pass : fail)(name, detail); return cond; }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function makeFixtures() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURES, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'a.txt'), 'hello a\n');
  fs.writeFileSync(path.join(FIXTURES, 'b ünïcode.txt'), 'hello b\n');
  fs.writeFileSync(path.join(FIXTURES, 'sub', 'n.txt'), 'nested\n');
  fs.mkdirSync(path.join(WORK, 'dup1'));
  fs.mkdirSync(path.join(WORK, 'dup2'));
  fs.writeFileSync(path.join(WORK, 'dup1', 'same.txt'), 'one');
  fs.writeFileSync(path.join(WORK, 'dup2', 'same.txt'), 'two');
  fs.writeFileSync(path.join(WORK, 'big.bin'), crypto.randomBytes(40 * 1024 * 1024));
}

function launch(tag, port) {
  const udd = path.join(WORK, `profile-${tag}`);
  fs.mkdirSync(udd, { recursive: true });
  const log = fs.openSync(path.join(WORK, `${tag}.log`), 'w');
  return spawn(ELECTRON, [APP, `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    stdio: ['ignore', log, log]
  });
}

class CDP {
  constructor(ws, tag) {
    this.ws = ws; this.tag = tag; this.id = 0; this.pending = new Map(); this.handlers = []; this.errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`[${this.tag}] eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }
  async waitFor(expression, timeoutMs = 15000, every = 250) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await this.eval(expression); } catch (_) { v = undefined; }
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`[${this.tag}] timeout waiting for: ${expression}`);
      await sleep(every);
    }
  }
}

async function connect(port, tag) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const cdp = new CDP(ws, tag);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        cdp.on((m) => {
          if (m.method === 'Page.javascriptDialogOpening') {
            console.log(`[${tag}] dialog: ${m.params.message} -> accept`);
            cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
          } else if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            cdp.errors.push(`${d.text} ${d.exception?.description || ''}`);
          } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            cdp.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
          }
        });
        return cdp;
      }
    } catch (_) {}
    await sleep(250);
  }
  throw new Error(`no CDP on ${port}`);
}

function ps(script) {
  const file = path.join(WORK, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, '﻿' + script, 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true });
  fs.unlinkSync(file);
  if (r.status !== 0) console.log('[ps] stderr:', r.stderr);
  return r.stdout.trim();
}
function psQuote(s) { return "'" + s.replace(/'/g, "''") + "'"; }
function setClipFiles(paths) {
  return ps([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$c = New-Object System.Collections.Specialized.StringCollection',
    '$c.AddRange([string[]]@(' + paths.map(psQuote).join(',') + '))',
    '[System.Windows.Forms.Clipboard]::SetFileDropList($c)',
    "'ok'"
  ].join('\r\n'));
}
function getClipFiles() {
  const out = ps([
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ } }'
  ].join('\r\n'));
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}
function getClipText() {
  return ps(['[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)', 'Add-Type -AssemblyName System.Windows.Forms', '[System.Windows.Forms.Clipboard]::GetText()'].join('\r\n'));
}
function clearClip() { ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear(); "ok"'); }
function setClipText(t) { ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText(${psQuote(t)}); "ok"`); }

const ENTRIES = `Array.from(document.querySelectorAll('#file-list .file-item')).map(el => ({ path: el.dataset.path, name: el.querySelector('.name-text').textContent, meta: el.querySelector('.meta').textContent, badge: !!el.querySelector('.badge'), save: el.querySelector('.save-btn') && el.querySelector('.save-btn').textContent }))`;
const STATUS = `document.getElementById('status').textContent`;

(async () => {
  const procs = [];
  try {
    if (process.platform !== 'win32') throw new Error('this harness is Windows-only');
    makeFixtures();
    procs.push(launch('A', 9333));
    await sleep(1500);
    procs.push(launch('B', 9334));
    const A = await connect(9333, 'A');
    const B = await connect(9334, 'B');
    pass('both instances expose CDP');

    const code = await A.waitFor(`(() => { const c = document.getElementById('my-id').textContent; return /^[A-Z0-9]{6}$/.test(c) ? c : null; })()`, 30000);
    await B.waitFor(`/^[A-Z0-9]{6}$/.test(document.getElementById('my-id').textContent)`, 30000);
    await B.eval(`document.getElementById('target-id').value = ${JSON.stringify(code)}; document.getElementById('connect-btn').click(); true`);
    await A.waitFor(`${STATUS} === 'Connected'`, 30000);
    await B.waitFor(`${STATUS} === 'Connected'`, 30000);
    pass('peer connection established');
    check(await B.eval(`getComputedStyle(document.getElementById('clip-section')).display !== 'none'`), 'clipboard section shows when connected');

    // Long text preview
    const longText = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ` + 'lorem ipsum dolor sit amet '.repeat(3).trim()).join('\n');
    await A.eval(`document.getElementById('text-input').value = ${JSON.stringify(longText)}; document.getElementById('send-text-btn').click(); true`);
    await B.waitFor(`document.querySelectorAll('#text-list .text-item').length === 1`);
    const preview = await B.eval(`document.querySelector('#text-list .text-item .text').textContent`);
    check(preview.length < longText.length && preview.endsWith('…'), 'long text is truncated to a preview', `${preview.length} chars`);
    check((await B.eval(`document.querySelector('#text-list .toggle-text').textContent`)) === 'Show all', 'preview shows "Show all"');
    await B.eval(`document.querySelector('#text-list .toggle-text').click(); true`);
    check((await B.eval(`document.querySelector('#text-list .text-item .text').textContent`)) === longText, 'Show all expands to the full text');
    check((await B.eval(`document.querySelector('#text-list .toggle-text').textContent`)) === 'Show less', 'button becomes "Show less"');
    await B.eval(`document.querySelector('#text-list .toggle-text').click(); true`);
    check((await B.eval(`document.querySelector('#text-list .text-item .text').textContent`)) === preview, 'Show less collapses again');
    await A.eval(`document.getElementById('text-input').value = 'short one'; document.getElementById('send-text-btn').click(); true`);
    await B.waitFor(`document.querySelectorAll('#text-list .text-item').length === 2`);
    check(!(await B.eval(`document.querySelectorAll('#text-list .text-item')[1].querySelector('.toggle-text')`)), 'short text has no toggle');

    // Folder by path
    await A.eval(`sendPaths([${JSON.stringify(FIXTURES)}]); true`);
    await B.waitFor(`${ENTRIES}.length === 1 && ${ENTRIES}[0].meta.startsWith('3 files')`, 20000);
    let entries = await B.eval(ENTRIES);
    check(entries[0].name.endsWith('fixtures') && entries[0].save === 'Save…', 'folder appears as one entry with a Save button');
    const recvDir = entries[0].path;
    for (const rel of ['a.txt', 'b ünïcode.txt', 'sub/n.txt']) {
      check(fs.existsSync(path.join(recvDir, rel)) && sha256(path.join(FIXTURES, rel)) === sha256(path.join(recvDir, rel)), `received ${rel} matches source`);
    }
    check(recvDir.startsWith(RECEIVED_ROOT), 'received folder lives under temp/FileTransferApp');
    await A.waitFor(`${STATUS}.startsWith('Sent 3 items')`, 15000);
    pass('sender got acks for all 3 files');

    // Big file
    const big = path.join(WORK, 'big.bin');
    const t0 = Date.now();
    await A.eval(`sendPaths([${JSON.stringify(big)}]); true`);
    await B.waitFor(`${ENTRIES}.length === 2`, 120000);
    entries = await B.eval(ENTRIES);
    check(sha256(big) === sha256(entries[1].path), `40 MB file received intact in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await A.waitFor(`${STATUS}.startsWith('Sent big.bin')`, 15000);

    // Duplicate names in one batch
    await A.eval(`sendPaths([${JSON.stringify(path.join(WORK, 'dup1', 'same.txt'))}, ${JSON.stringify(path.join(WORK, 'dup2', 'same.txt'))}]); true`);
    await B.waitFor(`${ENTRIES}.length === 4`, 20000);
    const names = (await B.eval(ENTRIES)).slice(2).map((e) => e.name);
    check(names.some((n) => n.endsWith('same.txt')) && names.some((n) => n.endsWith('same (2).txt')), 'same-named files in one batch do not overwrite each other', names.join(' | '));

    // Clipboard sync (both instances share this machine's clipboard, so each sends to the other)
    await A.eval(`document.getElementById('clip-toggle').click(); true`);
    await B.eval(`document.getElementById('clip-toggle').click(); true`);
    check(await A.eval(`document.getElementById('clip-toggle').checked && localStorage.getItem('clipboardSync') === '1'`), 'toggle persists');
    await sleep(800);
    const beforeA = (await A.eval(ENTRIES)).length;
    const beforeB = (await B.eval(ENTRIES)).length;
    setClipFiles([path.join(FIXTURES, 'a.txt'), path.join(FIXTURES, 'b ünïcode.txt'), path.join(FIXTURES, 'sub')]);
    await B.waitFor(`${ENTRIES}.length >= ${beforeB + 3}`, 30000);
    await A.waitFor(`${ENTRIES}.length >= ${beforeA + 3}`, 30000);
    const clipEntries = (await B.eval(ENTRIES)).slice(beforeB);
    check(clipEntries.length === 3 && clipEntries.every((e) => e.badge), 'clipboard batch arrives as 3 badged entries');
    await sleep(6000);
    let clip = getClipFiles();
    check(clip.length === 3 && clip.every((p) => p.startsWith(RECEIVED_ROOT)), 'receiver put its 3 received items on the clipboard', clip.join(' | '));
    const subEntry = clip.find((p) => p.endsWith('sub'));
    check(subEntry && fs.existsSync(path.join(subEntry, 'n.txt')), 'nested folder is pasteable with contents');
    const a2 = (await A.eval(ENTRIES)).length; const b2 = (await B.eval(ENTRIES)).length;
    await sleep(4000);
    check((await A.eval(ENTRIES)).length === a2 && (await B.eval(ENTRIES)).length === b2, 'no ping-pong loop');

    // Sticky re-assert against KVM-style wipes
    clearClip();
    await sleep(4500);
    check(getClipFiles().length === 3, 'files re-asserted after the clipboard was wiped');
    setClipText(clip.map((p) => path.basename(p)).join('\r\n'));
    await sleep(4500);
    check(getClipFiles().length === 3, 'files re-asserted after Finder-style names text replaced them');
    setClipText('totally unrelated text');
    await sleep(4500);
    check(getClipFiles().length === 0 && getClipText() === 'totally unrelated text', 'unrelated text is left alone');

    // Send clipboard now
    setClipFiles([path.join(FIXTURES, 'a.txt')]);
    await sleep(3500);
    const afterAuto = (await B.eval(ENTRIES)).length;
    await A.eval(`document.getElementById('clip-send-now').click(); true`);
    await B.waitFor(`${ENTRIES}.length >= ${afterAuto + 1}`, 20000);
    pass('"Send clipboard now" sends the current clipboard files');

    // Toggle off
    await A.eval(`document.getElementById('clip-toggle').click(); true`);
    await B.eval(`document.getElementById('clip-toggle').click(); true`);
    await sleep(800);
    const bBefore = (await B.eval(ENTRIES)).length; const aBefore = (await A.eval(ENTRIES)).length;
    setClipFiles([path.join(FIXTURES, 'sub', 'n.txt')]);
    await sleep(4000);
    check((await B.eval(ENTRIES)).length === bBefore && (await A.eval(ENTRIES)).length === aBefore, 'with the toggle off, copying files sends nothing');

    check(A.errors.length === 0, 'no renderer errors on A', A.errors.join(' || '));
    check(B.errors.length === 0, 'no renderer errors on B', B.errors.join(' || '));
  } catch (err) {
    fail('harness error', err.stack || String(err));
  } finally {
    for (const p of procs) {
      try { spawnSync('taskkill', ['/F', '/PID', String(p.pid), '/T'], { windowsHide: true }); } catch (_) {}
    }
    try { clearClip(); } catch (_) {}
    console.log('\n==== SUMMARY ====');
    for (const [s, n, d] of results) console.log(s, '-', n, d ? `(${d})` : '');
    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(`${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
