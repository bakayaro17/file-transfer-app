// clipboard-sync.js — main-process side of clipboard file sync.
//
// Watches the system clipboard for copied files (Explorer / Finder) while a
// peer is connected, and can put received files back on the clipboard so the
// user can paste them on the other machine.
//
// Reading: Electron's clipboard module can't list file paths directly, but
// Chromium can. A programmatic webContents.paste() dispatches a DOM `paste`
// event whose clipboardData.files carries every copied file and folder; the
// renderer reports those paths back over IPC (see handlePasteReport). Native
// single-file reads are the fallback if that ever fails.
//
// Writing: no Electron API either, so we shell out once per received batch:
// PowerShell (Clipboard.SetFileDropList) on Windows, osascript/JXA
// (NSPasteboard writeObjects) on macOS.

const { clipboard } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const POLL_MS = 600;
const SETTLE_MS = 700;              // same file list must sit on the clipboard this long before we act
const PROBE_TIMEOUT_MS = 1500;
const STICKY_MS = 3 * 60 * 1000;    // after we write files, defend them against KVM clipboard wipes
const MAX_REASSERTS = 4;

let win = null;
let ignoreRoot = null;   // paths under here are our own received files — never re-send them
let onFiles = null;      // callback(paths) when the user copies new files
let enabled = false;
let timer = null;
let ticking = false;
let lastKey = null;      // file list we last acted on (or recognised as our own)
let candidate = null;    // { key, paths, since } — a new list waiting to settle
let probe = null;        // { tag, resolve, timer } — an outstanding synthetic paste
let sticky = null;       // { paths, names, until, rewrites } — what we last wrote

function configure(opts) {
  win = opts.window || win;
  ignoreRoot = opts.ignoreRoot || ignoreRoot;
  onFiles = opts.onFiles || onFiles;
}

function setEnabled(on) {
  enabled = !!on;
  if (enabled && !timer) timer = setInterval(tick, POLL_MS);
  if (!enabled && timer) {
    clearInterval(timer);
    timer = null;
    candidate = null;
  }
}

function isEnabled() {
  return enabled;
}

function formats() {
  try { return clipboard.availableFormats(); } catch (_) { return []; }
}

function readText() {
  try { return clipboard.readText(); } catch (_) { return ''; }
}

// Chromium reports CF_HDROP / NSFilenamesPboardType / file URLs as text/uri-list.
function hasFiles(fmts) {
  return fmts.some((f) => f === 'text/uri-list' || f === 'Files' || f === 'public.file-url' || f === 'NSFilenamesPboardType');
}

function isUnder(p, root) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function keyOf(paths) {
  return paths.join('\n');
}

async function tick() {
  if (!enabled || ticking) return;
  ticking = true;
  try {
    const fmts = formats();
    if (!hasFiles(fmts)) {
      candidate = null;
      lastKey = null;
      await maybeReassert(fmts);
      return;
    }
    const paths = await readFilePaths();
    if (!paths.length) return;
    const key = keyOf(paths);
    if (key === lastKey) return;
    if (ignoreRoot && paths.every((p) => isUnder(p, ignoreRoot))) {
      lastKey = key; // our own clipboard write
      return;
    }
    if (!candidate || candidate.key !== key) {
      candidate = { key, paths, since: Date.now() };
      return;
    }
    if (Date.now() - candidate.since < SETTLE_MS) return;
    lastKey = key;
    candidate = null;
    sticky = null; // the user copied something new — stop defending the old paste
    if (onFiles) onFiles(paths);
  } catch (err) {
    console.error('[clipboard-sync] tick failed:', err);
  } finally {
    ticking = false;
  }
}

async function readFilePaths() {
  const viaPaste = await probeViaPaste();
  if (viaPaste && viaPaste.length) return viaPaste;
  return nativeFallback();
}

function probeViaPaste() {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || probe) return resolve(null);
    const tag = {};
    const t = setTimeout(() => {
      if (probe && probe.tag === tag) {
        probe = null;
        resolve(null);
      }
    }, PROBE_TIMEOUT_MS);
    probe = { tag, resolve, timer: t };
    try {
      win.webContents.paste();
    } catch (err) {
      clearTimeout(t);
      probe = null;
      resolve(null);
    }
  });
}

// The renderer calls this (via IPC) for every DOM paste event that carried files.
// Returns true when the paste was one of ours, so the renderer knows not to treat
// it as the user pasting files into the app.
function handlePasteReport(paths) {
  if (!probe) return false;
  const p = probe;
  probe = null;
  clearTimeout(p.timer);
  p.resolve(Array.isArray(paths) ? paths.filter((x) => typeof x === 'string' && x) : []);
  return true;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function nativeFallback() {
  try {
    if (process.platform === 'win32') {
      const first = clipboard.readBuffer('FileNameW').toString('utf16le').replace(/\0+$/, '');
      return first ? [first] : [];
    }
    if (process.platform === 'darwin') {
      const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
      const found = [];
      const re = /<string>([\s\S]*?)<\/string>/g;
      let m;
      while ((m = re.exec(plist))) found.push(unescapeXml(m[1]));
      if (found.length) return found;
      const url = clipboard.read('public.file-url');
      if (url && url.startsWith('file://')) return [decodeURIComponent(new URL(url).pathname)];
    }
  } catch (err) {
    console.error('[clipboard-sync] native read failed:', err);
  }
  return [];
}

// One-shot read for the "Send clipboard now" button.
async function readNow() {
  if (!hasFiles(formats())) return [];
  const paths = await readFilePaths();
  if (paths.length) lastKey = keyOf(paths); // don't auto-send the same list again right after
  return paths;
}

// ---- writing ----

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: e.message });
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function psQuote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

async function writeWindows(list) {
  const script = [
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  $c = New-Object System.Collections.Specialized.StringCollection',
    '  $c.AddRange([string[]]@(' + list.map(psQuote).join(',') + '))',
    '  [System.Windows.Forms.Clipboard]::SetFileDropList($c)',
    '  exit 0',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-EncodedCommand', encoded
  ]);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.err || r.out || `powershell exit ${r.code}`).trim().slice(0, 300) };
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistFor(list) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><array>' + list.map((p) => `<string>${escapeXml(p)}</string>`).join('') + '</array></plist>';
}

async function writeMac(list) {
  const jxa = [
    "ObjC.import('AppKit');",
    `var paths = ${JSON.stringify(list)};`,
    'var pb = $.NSPasteboard.generalPasteboard;',
    'pb.clearContents;',
    'var arr = $.NSMutableArray.alloc.init;',
    'paths.forEach(function (p) { arr.addObject($.NSURL.fileURLWithPath(p)); });',
    'var ok = pb.writeObjects(arr);',
    "ok ? 'ok' : 'fail';"
  ].join('\n');
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa]);
  if (r.code === 0 && r.out.trim() === 'ok') return { ok: true };
  console.error('[clipboard-sync] osascript write failed, falling back:', r.err || r.out);
  try {
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plistFor(list), 'utf8'));
    return { ok: true, fallback: true };
  } catch (err) {
    return { ok: false, error: (r.err || r.out || err.message).trim().slice(0, 300) };
  }
}

async function writeFiles(paths, { reassert = false } = {}) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return { ok: false, error: 'nothing to put on the clipboard' };
  let result;
  if (process.platform === 'win32') result = await writeWindows(list);
  else if (process.platform === 'darwin') result = await writeMac(list);
  else result = { ok: false, error: 'unsupported platform' };
  if (result.ok) {
    lastKey = keyOf(list);
    candidate = null;
    if (!reassert) {
      sticky = { paths: list, names: list.map((p) => path.basename(p)), until: Date.now() + STICKY_MS, rewrites: 0 };
    }
  }
  return result;
}

// KVM clipboard sharers (Deskflow / Synergy / Barrier) push the *other* machine's
// clipboard onto this one when the cursor crosses screens. A file-only clipboard
// marshals as empty (Windows) or as a list of file names (Finder), which would
// silently wipe the files we just made pasteable. Put them back, a few times at most.
async function maybeReassert(fmts) {
  if (!sticky) return;
  if (Date.now() > sticky.until) { sticky = null; return; }
  const text = readText();
  const empty = fmts.length === 0 && !text;
  const namesOnly = !!text && sameNames(text, sticky.names);
  if (!empty && !namesOnly) { sticky = null; return; } // the user copied something else on purpose
  if (sticky.rewrites >= MAX_REASSERTS) return;
  sticky.rewrites++;
  await writeFiles(sticky.paths, { reassert: true });
}

function sameNames(text, names) {
  const got = text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean).sort();
  const want = names.slice().sort();
  return got.length === want.length && got.every((v, i) => v === want[i]);
}

module.exports = { configure, setEnabled, isEnabled, handlePasteReport, readNow, writeFiles };
