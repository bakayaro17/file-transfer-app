const myIdElement = document.getElementById('my-id');
const copyBtn = document.getElementById('copy-btn');
const shareBtn = document.getElementById('share-btn');
const targetIdInput = document.getElementById('target-id');
const connectBtn = document.getElementById('connect-btn');
const statusElement = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const dropzone = document.getElementById('dropzone');
const browseBtn = document.getElementById('browse-btn');
const fileInput = document.getElementById('file-input');
const connectedIdElement = document.getElementById('connected-id');
const filesSection = document.getElementById('files-section');
const fileList = document.getElementById('file-list');
const sendLinkSection = document.getElementById('send-link-section');
const linkInput = document.getElementById('link-input');
const sendLinkBtn = document.getElementById('send-link-btn');
const linksSection = document.getElementById('links-section');
const linkList = document.getElementById('link-list');
const sendTextSection = document.getElementById('send-text-section');
const textInput = document.getElementById('text-input');
const sendTextBtn = document.getElementById('send-text-btn');
const textsSection = document.getElementById('texts-section');
const textList = document.getElementById('text-list');
const clipSection = document.getElementById('clip-section');
const clipToggle = document.getElementById('clip-toggle');
const clipStatus = document.getElementById('clip-status');
const clipSendNowBtn = document.getElementById('clip-send-now');
const versionEl = document.getElementById('app-version');
const minimizeBtn = document.getElementById('btn-minimize');
const closeBtn = document.getElementById('btn-close');
const toast = document.getElementById('toast');
const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateInstallBtn = document.getElementById('update-install-btn');

const api = window.electronAPI;
const isMac = api.platform === 'darwin';
const PASTE_KEY = isMac ? '⌘V' : 'Ctrl+V';

let peer = null;
let conn = null;
let pendingDeepLinkCode = null;

function showToast(msg, ms = 1500) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
}

function setStatus(text, kind = 'ready') {
    statusElement.textContent = text;
    statusPill.classList.remove('ready', 'connected', 'error');
    statusPill.classList.add(kind);
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fmtSize(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function isConnected() {
    return !!(conn && conn.open);
}

function generateCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// ===========================================================================
// Peer connection
// ===========================================================================

function initPeer() {
    if (peer) {
        try { peer.destroy(); } catch (_) {}
    }
    myIdElement.textContent = '......';
    const code = generateCode();
    peer = new Peer(code);

    peer.on('open', (id) => {
        myIdElement.textContent = id;
        setStatus('Ready to connect', 'ready');
        if (pendingDeepLinkCode) {
            const code = pendingDeepLinkCode;
            pendingDeepLinkCode = null;
            connectToCode(code);
        }
    });

    peer.on('connection', (incoming) => {
        const accept = confirm(`Accept incoming connection from ${incoming.peer}?`);
        if (!accept) {
            incoming.close();
            return;
        }
        if (conn && conn.open) conn.close();
        conn = incoming;
        setupConnection();
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
            setTimeout(initPeer, 200);
            return;
        }
        setStatus(`Error: ${err.type}`, 'error');
        connectBtn.disabled = false;
    });
}

function setupConnection() {
    conn.on('open', () => {
        setStatus('Connected', 'connected');
        dropzone.style.display = 'block';
        sendLinkSection.style.display = 'block';
        sendTextSection.style.display = 'block';
        clipSection.style.display = 'block';
        connectedIdElement.textContent = conn.peer;
        connectBtn.disabled = true;
        applyClipboardSyncState();
    });

    conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        switch (data.type) {
            case 'file': handleLegacyFile(data.file); break; // pre-1.0.12 single-message format
            case 'batch-start': handleBatchStart(data); break;
            case 'batch-end': handleBatchEnd(data); break;
            case 'file-start': handleFileStart(data); break;
            case 'file-chunk': handleFileChunk(data); break;
            case 'file-end': handleFileEnd(data); break;
            case 'file-ack': handleFileAck(data); break;
            case 'link': handleIncomingLink(data.url); break;
            case 'text': handleIncomingText(data.text); break;
            default: break;
        }
    });

    conn.on('close', () => {
        setStatus('Connection closed', 'ready');
        dropzone.style.display = 'none';
        sendLinkSection.style.display = 'none';
        sendTextSection.style.display = 'none';
        clipSection.style.display = 'none';
        connectBtn.disabled = false;
        conn = null;
        api.setClipboardSync(false);
        abortAllIncoming();
        pendingSends.clear();
        batchAcks.clear();
    });
}

function connectToCode(targetId) {
    targetId = (targetId || '').trim().toUpperCase();
    if (!targetId) return;
    targetIdInput.value = targetId;

    if (!peer || !peer.open) {
        pendingDeepLinkCode = targetId;
        return;
    }
    connectBtn.disabled = true;
    setStatus('Connecting...', 'ready');

    // reliable: true gives an *ordered* data channel. PeerJS defaults to unordered,
    // which can scramble file chunks on a lossy link.
    conn = peer.connect(targetId, { reliable: true });
    setupConnection();
}

connectBtn.addEventListener('click', () => connectToCode(targetIdInput.value));

targetIdInput.addEventListener('input', () => {
    targetIdInput.value = targetIdInput.value.toUpperCase();
});
targetIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click();
});

copyBtn.addEventListener('click', async () => {
    const code = myIdElement.textContent;
    if (!code || code.startsWith('.')) return;
    await navigator.clipboard.writeText(code);
    showToast('Code copied');
});

shareBtn.addEventListener('click', async () => {
    const code = myIdElement.textContent;
    if (!code || code.startsWith('.')) return;
    const url = `filetransfer://connect/${code}`;
    await navigator.clipboard.writeText(url);
    showToast('Share link copied');
});

myIdElement.addEventListener('click', () => copyBtn.click());

// ===========================================================================
// Picking files to send: drop, browse, paste
// ===========================================================================

// Split File objects into real paths (sent via main, folders supported) and
// path-less blobs such as an image dragged out of a browser (sent directly).
function splitFiles(fileListLike) {
    const paths = [];
    const blobs = [];
    for (const f of fileListLike) {
        const p = api.getPathForFile(f);
        if (p) paths.push(p);
        else blobs.push(f);
    }
    return { paths, blobs };
}

function sendPicked(fileListLike) {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    const { paths, blobs } = splitFiles(fileListLike);
    if (paths.length) sendPaths(paths);
    for (const f of blobs) enqueueSend(() => sendBlob(f));
}

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    sendPicked(e.dataTransfer.files);
});

dropzone.addEventListener('click', () => {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    fileInput.click();
});
browseBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the dropzone click handler open the picker twice
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    fileInput.click();
});
fileInput.addEventListener('change', () => {
    sendPicked(fileInput.files);
    fileInput.value = '';
});

// Paste events carrying files come from two places: the user pressing Ctrl/Cmd+V
// in the window, or the main process probing the clipboard for the sync watcher.
// Main tells us which one it was.
document.addEventListener('paste', async (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return; // plain text paste — leave it alone
    e.preventDefault();
    const { paths, blobs } = splitFiles(files);
    const wasProbe = await api.reportPasteFiles(paths);
    if (wasProbe) return;
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    if (paths.length) sendPaths(paths);
    for (const f of blobs) enqueueSend(() => sendBlob(f));
}, true);

// ===========================================================================
// Sending
// ===========================================================================

// Chunked, backpressured file transfer. Sending one giant message floods the
// WebRTC send buffer; over a high-latency link that collapses throughput.
// Instead we slice the file and keep a bounded amount of data in flight.
const CHUNK_SIZE = 256 * 1024;
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;  // pause sending above 8 MB buffered
const BUFFER_LOW_WATER = 1 * 1024 * 1024;   // resume once drained to 1 MB

// Auto clipboard sync refuses absurd batches; manual sends have no cap.
const MAX_AUTO_FILES = 2000;
const MAX_AUTO_BYTES = 4 * 1024 * 1024 * 1024;

let fileSeq = 0;
const pendingSends = new Map(); // transfer id -> { name, batch }
const batchAcks = new Map();    // batch id -> { expected, got, label }

// All sends go through one queue so transfers don't fight for the channel and
// the status line tells one coherent story.
let sendChain = Promise.resolve();
function enqueueSend(task) {
    const p = sendChain.then(task).catch((err) => console.error('Send failed:', err));
    sendChain = p;
    return p;
}

function waitForDrain(lowWater) {
    const dc = conn && conn.dataChannel;
    if (!dc || dc.bufferedAmount <= lowWater) return Promise.resolve();
    return new Promise((resolve) => {
        try { dc.bufferedAmountLowThreshold = lowWater; } catch (_) {}
        const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
        dc.addEventListener('bufferedamountlow', onLow);
    });
}

async function throttle() {
    if (conn && conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_HIGH_WATER) {
        await waitForDrain(BUFFER_LOW_WATER);
    }
}

function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) return chunk;
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) return chunk.buffer;
    return chunk.slice().buffer;
}

function newBatchId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newTransferId() {
    return `${Date.now()}-${fileSeq++}`;
}

function pct(done, total) {
    return total ? Math.floor((done / total) * 100) : 100;
}

// Send files and folders by path. opts.clipboard marks the batch as a clipboard
// sync so the receiver puts it on its clipboard; opts.manual skips the size cap.
async function sendPaths(paths, opts = {}) {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    let info;
    try {
        info = await api.expandPaths(paths);
    } catch (err) {
        console.error('expandPaths failed:', err);
        showToast('Could not read those files');
        return;
    }
    if (!info.items.length) {
        showToast('Nothing to send');
        return;
    }
    if (opts.clipboard && !opts.manual && (info.count > MAX_AUTO_FILES || info.total > MAX_AUTO_BYTES)) {
        showToast(`Clipboard has ${plural(info.count, 'file')} (${fmtSize(info.total)}) — too big to auto-sync. Use "Send clipboard now" to force it.`, 5000);
        return;
    }
    if (info.truncated) showToast(`Only the first ${info.count} files will be sent`, 3000);
    if (opts.clipboard) showToast(`Clipboard: sending ${plural(info.count, 'item')}...`, 2000);
    enqueueSend(() => sendBatch(info, !!opts.clipboard));
}

async function sendBatch(info, clipboard) {
    if (!isConnected()) return;
    const batch = newBatchId();
    const many = info.items.length > 1;
    const verb = clipboard ? 'Syncing clipboard' : 'Sending';
    batchAcks.set(batch, { expected: info.items.length, got: 0, clipboard });
    conn.send({ type: 'batch-start', batch, count: info.items.length, total: info.total, clipboard });
    try {
        for (let i = 0; i < info.items.length; i++) {
            if (!isConnected()) throw new Error('disconnected');
            const item = info.items[i];
            const prefix = many ? `${verb} ${i + 1}/${info.items.length} · ` : `${verb} `;
            await sendOneFromPath(item, batch, prefix);
        }
        if (!isConnected()) throw new Error('disconnected');
        conn.send({ type: 'batch-end', batch });
        setStatus(many ? `Finishing ${plural(info.items.length, 'item')}...` : `Finishing ${info.items[0].rel}...`, 'connected');
    } catch (err) {
        console.error('Batch send error:', err);
        batchAcks.delete(batch);
        setStatus('Error while sending', 'error');
    }
}

async function sendOneFromPath(item, batch, prefix) {
    const id = newTransferId();
    const name = item.rel.split('/').pop();
    pendingSends.set(id, { name, batch });
    setStatus(`${prefix}${name}... 0%`, 'connected');
    conn.send({ type: 'file-start', id, name, size: item.size, batch, rel: item.rel });
    const handle = await api.readOpen(item.abs);
    try {
        let offset = 0;
        while (offset < item.size) {
            const chunk = await api.readChunk(handle, offset, Math.min(CHUNK_SIZE, item.size - offset));
            if (!chunk || !chunk.byteLength) break; // file shrank underneath us
            if (!isConnected()) throw new Error('disconnected');
            conn.send({ type: 'file-chunk', id, data: toArrayBuffer(chunk) });
            offset += chunk.byteLength;
            await throttle();
            setStatus(`${prefix}${name}... ${pct(offset, item.size)}%`, 'connected');
        }
    } finally {
        api.readClose(handle).catch(() => {});
    }
    if (!isConnected()) throw new Error('disconnected');
    conn.send({ type: 'file-end', id });
}

// Path-less File/Blob (e.g. an image dragged from a browser): read it here.
async function sendBlob(file) {
    if (!isConnected()) return;
    const id = newTransferId();
    const total = file.size;
    const name = file.name || 'file';
    pendingSends.set(id, { name, batch: null });
    setStatus(`Sending ${name}... 0%`, 'connected');
    try {
        conn.send({ type: 'file-start', id, name, size: total });
        let offset = 0;
        while (offset < total) {
            const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            if (!isConnected()) throw new Error('disconnected');
            conn.send({ type: 'file-chunk', id, data: buf });
            offset += buf.byteLength;
            await throttle();
            setStatus(`Sending ${name}... ${pct(offset, total)}%`, 'connected');
        }
        conn.send({ type: 'file-end', id });
        setStatus(`Finishing ${name}...`, 'connected');
    } catch (err) {
        console.error('Send error', err);
        pendingSends.delete(id);
        setStatus(`Error sending ${name}`, 'error');
    }
}

function handleFileAck(msg) {
    const p = pendingSends.get(msg.id);
    if (!p) return;
    pendingSends.delete(msg.id);
    const b = p.batch && batchAcks.get(p.batch);
    if (!b || b.expected <= 1) {
        if (b) batchAcks.delete(p.batch);
        setStatus(`Sent ${p.name}`, 'connected');
        showToast(`${p.name} delivered`, 2500);
        return;
    }
    b.got++;
    if (b.got < b.expected) {
        setStatus(`Delivered ${b.got}/${b.expected}...`, 'connected');
        return;
    }
    batchAcks.delete(p.batch);
    setStatus(`Sent ${plural(b.expected, 'item')}`, 'connected');
    showToast(`${plural(b.expected, 'item')} delivered`, 2500);
}

// ===========================================================================
// Links and text
// ===========================================================================

function normalizeUrl(input) {
    const url = (input || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (/^[\w.-]+\.\w{2,}/.test(url)) return `https://${url}`;
    return null;
}

function sendLink() {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    const url = normalizeUrl(linkInput.value);
    if (!url) {
        showToast('Enter a valid URL');
        return;
    }
    conn.send({ type: 'link', url });
    setStatus('Sent link', 'connected');
    showToast('Link sent');
    linkInput.value = '';
}

sendLinkBtn.addEventListener('click', sendLink);
linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
});

function sendText() {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    const text = textInput.value.trim();
    if (!text) {
        showToast('Enter some text');
        return;
    }
    conn.send({ type: 'text', text });
    setStatus('Sent text', 'connected');
    showToast('Text sent');
    textInput.value = '';
}

sendTextBtn.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter inserts a newline
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText();
    }
});

// Long messages show a short preview with a Show all / Show less toggle so the
// received list stays scannable.
const TEXT_PREVIEW_CHARS = 280;
const TEXT_PREVIEW_LINES = 5;

function makePreview(text) {
    let preview = text.split('\n').slice(0, TEXT_PREVIEW_LINES).join('\n');
    if (preview.length > TEXT_PREVIEW_CHARS) preview = preview.slice(0, TEXT_PREVIEW_CHARS);
    if (preview.length >= text.length) return null; // nothing was cut
    return preview.trimEnd() + '…';
}

function handleIncomingText(text) {
    if (typeof text !== 'string' || !text) return;
    textsSection.style.display = 'block';

    const item = document.createElement('div');
    item.className = 'text-item';

    const body = document.createElement('div');
    body.className = 'text-body';

    const span = document.createElement('span');
    span.className = 'text';

    const preview = makePreview(text);
    span.textContent = preview || text;
    body.appendChild(span);

    if (preview) {
        let expanded = false;
        const toggle = document.createElement('button');
        toggle.className = 'toggle-text';
        toggle.textContent = 'Show all';
        toggle.addEventListener('click', () => {
            expanded = !expanded;
            span.textContent = expanded ? text : preview;
            toggle.textContent = expanded ? 'Show less' : 'Show all';
        });
        body.appendChild(toggle);
    }

    const copy = document.createElement('button');
    copy.className = 'copy-text';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(text);
        showToast('Text copied');
    });

    item.appendChild(body);
    item.appendChild(copy);
    textList.appendChild(item);
    setStatus('Received text', 'connected');
}

function handleIncomingLink(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    linksSection.style.display = 'block';

    const item = document.createElement('div');
    item.className = 'link-item';

    const a = document.createElement('span');
    a.className = 'url';
    a.textContent = url;
    a.title = url;
    a.addEventListener('click', () => api.openExternal(url));

    const copy = document.createElement('button');
    copy.className = 'copy-link';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(url);
        showToast('Link copied');
    });

    item.appendChild(a);
    item.appendChild(copy);
    linkList.appendChild(item);
    setStatus('Received link', 'connected');
}

// ===========================================================================
// Receiving
// ===========================================================================

let recvSeq = 0;
const incoming = new Map(); // transfer id -> record
const batches = new Map();  // batch id -> { id, clipboard, count, total, tops: Map, done: [], solo }

function parentFolderName(p) {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : p;
}

// One row in "Received files": a file or a top-level folder from a batch.
function createEntry(info) {
    filesSection.style.display = 'block';

    const el = document.createElement('div');
    el.className = 'file-item';
    el.draggable = true;
    el.title = 'Drag out to a folder, or click Save';
    el.dataset.path = info.path;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    const nameText = document.createElement('span');
    nameText.className = 'name-text';
    nameEl.appendChild(nameText);
    if (info.clipboard) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'clipboard';
        nameEl.appendChild(badge);
    }

    const metaEl = document.createElement('span');
    metaEl.className = 'meta';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save…';
    saveBtn.draggable = false;
    saveBtn.title = 'Choose where to save';

    el.addEventListener('dragstart', (e) => {
        e.preventDefault();
        api.startDrag(info.path);
    });

    saveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        const r = await api.saveReceived(info.path, info.name, info.isDir);
        saveBtn.disabled = false;
        if (r && r.ok) {
            saveBtn.textContent = 'Saved ✓';
            showToast(`Saved to ${parentFolderName(r.path)}`, 2500);
            setTimeout(() => { saveBtn.textContent = 'Save…'; }, 2500);
        } else {
            saveBtn.textContent = 'Save…';
            if (r && !r.canceled) showToast(`Save failed: ${r.error || 'unknown error'}`, 3500);
        }
    });

    el.appendChild(nameEl);
    el.appendChild(metaEl);
    el.appendChild(saveBtn);
    fileList.appendChild(el);

    const entry = {
        el,
        info,
        refresh() {
            nameText.textContent = `${info.isDir ? '📁' : '📄'} ${info.name}`;
            metaEl.textContent = info.isDir
                ? `${plural(info.count, 'file')} · ${fmtSize(info.size)}`
                : fmtSize(info.size);
        }
    };
    entry.refresh();
    return entry;
}

function batchFor(msg) {
    const id = msg.batch ? String(msg.batch) : `solo-${msg.id}`;
    let b = batches.get(id);
    if (!b) {
        b = { id, clipboard: false, count: 1, total: Number(msg.size) || 0, tops: new Map(), done: [], solo: !msg.batch };
        batches.set(id, b);
    }
    return b;
}

function handleBatchStart(msg) {
    if (msg.batch == null) return;
    const id = String(msg.batch);
    batches.set(id, {
        id,
        clipboard: !!msg.clipboard,
        count: Number(msg.count) || 0,
        total: Number(msg.total) || 0,
        tops: new Map(),
        done: [],
        solo: false
    });
    setStatus(msg.clipboard
        ? `Receiving ${plural(msg.count, 'clipboard item')}...`
        : `Receiving ${plural(msg.count, 'file')}...`, 'connected');
}

function handleFileStart(msg) {
    if (msg.id == null) return;
    const b = batchFor(msg);
    const key = `r${++recvSeq}`;
    const rec = {
        id: msg.id,
        key,
        name: String(msg.name || 'file'),
        size: Number(msg.size) || 0,
        rel: typeof msg.rel === 'string' ? msg.rel : '',
        received: 0,
        batch: b,
        start: null,
        failed: false,
        finish: null,
        queue: null
    };
    b.done.push(new Promise((resolve) => { rec.finish = resolve; }));
    rec.queue = api.recvStart(key, { name: rec.name, batch: b.solo ? key : b.id, rel: rec.rel })
        .then((start) => { rec.start = start; })
        .catch((err) => { rec.failed = true; console.error('recvStart failed:', err); });
    incoming.set(msg.id, rec);
    setStatus(`Receiving ${rec.name}... 0%`, 'connected');
}

function handleFileChunk(msg) {
    const rec = incoming.get(msg.id);
    if (!rec || rec.failed) return;
    const data = msg.data;
    const len = (data && data.byteLength) || 0;
    if (!len) return;
    rec.received += len;
    rec.queue = rec.queue
        .then(() => (rec.failed ? null : api.recvChunk(rec.key, data)))
        .catch((err) => { rec.failed = true; console.error('recvChunk failed:', err); });
    if (rec.size) {
        setStatus(`Receiving ${rec.name}... ${pct(rec.received, rec.size)}%`, 'connected');
    }
}

async function handleFileEnd(msg) {
    const rec = incoming.get(msg.id);
    if (!rec) return;
    incoming.delete(msg.id);
    const b = rec.batch;
    try {
        await rec.queue;
        if (rec.failed || !rec.start) throw new Error('write failed');
        const finalPath = await api.recvEnd(rec.key);
        const start = rec.start;
        if (start.isDir) {
            let entry = b.tops.get(start.topName);
            if (!entry) {
                entry = createEntry({ path: start.topPath, name: start.topName, isDir: true, size: 0, count: 0, clipboard: b.clipboard });
                b.tops.set(start.topName, entry);
            }
            entry.info.size += rec.received;
            entry.info.count++;
            entry.refresh();
        } else {
            const entry = createEntry({ path: finalPath, name: start.topName, isDir: false, size: rec.received, clipboard: b.clipboard });
            b.tops.set(finalPath, entry);
        }
        setStatus(`Received ${rec.name}`, 'connected');
        if (isConnected()) conn.send({ type: 'file-ack', id: msg.id });
    } catch (err) {
        console.error('Receive error', err);
        api.recvAbort(rec.key).catch(() => {});
        setStatus(`Error saving ${rec.name}`, 'error');
    } finally {
        rec.finish();
        if (b.solo) batches.delete(b.id);
    }
}

async function handleBatchEnd(msg) {
    if (msg.batch == null) return;
    const b = batches.get(String(msg.batch));
    if (!b) return;
    await Promise.all(b.done);
    batches.delete(b.id);
    const entries = [...b.tops.values()];
    const n = entries.length;
    if (!n) return;
    if (!b.clipboard) {
        if (n > 1) setStatus(`Received ${plural(n, 'item')}`, 'connected');
        return;
    }
    if (!clipToggle.checked) {
        showToast(`Received ${plural(n, 'item')} from the other device's clipboard`, 3000);
        return;
    }
    const r = await api.writeClipboardFiles(entries.map((e) => e.info.path));
    if (r && r.ok) {
        setStatus(`Clipboard ready · ${plural(n, 'item')}`, 'connected');
        showToast(`Ready to paste: ${plural(n, 'item')} (${PASTE_KEY})`, 4000);
    } else {
        showToast(`Received ${plural(n, 'item')}, but couldn't update the clipboard${r && r.error ? `: ${r.error}` : ''}`, 5000);
    }
}

// Pre-1.0.12 senders deliver the whole file in one message.
async function handleLegacyFile(file) {
    if (!file || typeof file.name !== 'string' || !file.data) return;
    const id = `legacy-${++recvSeq}`;
    handleFileStart({ id, name: file.name, size: file.data.byteLength || 0 });
    handleFileChunk({ id, data: file.data });
    await handleFileEnd({ id });
}

function abortAllIncoming() {
    for (const rec of incoming.values()) {
        rec.failed = true;
        const key = rec.key;
        rec.queue.then(() => api.recvAbort(key)).catch(() => {});
        if (rec.finish) rec.finish();
    }
    incoming.clear();
    batches.clear();
}

// ===========================================================================
// Clipboard sync
// ===========================================================================

const CLIP_PREF_KEY = 'clipboardSync';

function clipboardSyncWanted() {
    try { return localStorage.getItem(CLIP_PREF_KEY) === '1'; } catch (_) { return false; }
}

function applyClipboardSyncState() {
    const on = clipToggle.checked;
    try { localStorage.setItem(CLIP_PREF_KEY, on ? '1' : '0'); } catch (_) {}
    const active = on && isConnected();
    api.setClipboardSync(active);
    clipStatus.textContent = active
        ? `Watching clipboard · copied files land on the other device, ready for ${PASTE_KEY}`
        : on ? 'On · starts when connected' : 'Off';
    clipStatus.classList.toggle('active', active);
}

clipToggle.checked = clipboardSyncWanted();
clipToggle.addEventListener('change', applyClipboardSyncState);
applyClipboardSyncState();

clipSendNowBtn.addEventListener('click', async () => {
    if (!isConnected()) {
        showToast('Not connected');
        return;
    }
    const paths = await api.readClipboardFiles();
    if (!paths || !paths.length) {
        showToast('No files on the clipboard — copy some in Explorer or Finder first', 3000);
        return;
    }
    sendPaths(paths, { clipboard: true, manual: true });
});

// The main-process watcher saw the user copy new files.
api.onClipboardFiles((paths) => {
    if (!isConnected() || !clipToggle.checked) return;
    sendPaths(paths, { clipboard: true });
});

// ===========================================================================
// Window chrome, updates, deep links
// ===========================================================================

minimizeBtn.addEventListener('click', () => api.minimizeWindow());
closeBtn.addEventListener('click', () => api.closeWindow());

api.getVersion().then((v) => {
    versionEl.textContent = `v${v}`;
}).catch(() => {});

let manualUpdateCheck = false;
versionEl.addEventListener('click', async () => {
    const result = await api.checkForUpdates();
    if (!result?.ok) {
        if (result?.reason === 'dev') showToast('Updates only check in installed builds');
        else if (result?.reason === 'portable') showToast('Auto-update is disabled for the portable build');
        else showToast(`Update check failed${result?.message ? `: ${result.message}` : ''}`);
        return;
    }
    manualUpdateCheck = true;
});

api.onDeepLink((code) => {
    connectToCode(code);
});

api.onDragError((msg) => {
    console.error('[drag] main reported:', msg);
    showToast(`Drag failed: ${msg}`, 3000);
});

api.onUpdateStatus((status) => {
    updateBanner.classList.remove('visible', 'ready', 'error');
    updateInstallBtn.style.display = 'none';

    switch (status.state) {
        case 'checking':
            updateText.textContent = 'Checking for updates...';
            updateBanner.classList.add('visible');
            break;
        case 'downloading': {
            const pctText = typeof status.percent === 'number' ? ` (${status.percent}%)` : '';
            const ver = status.version ? ` v${status.version}` : '';
            updateText.textContent = `Downloading update${ver}${pctText}...`;
            updateBanner.classList.add('visible');
            manualUpdateCheck = false;
            break;
        }
        case 'ready':
            updateText.textContent = `Update v${status.version} ready.`;
            updateInstallBtn.style.display = 'inline-block';
            updateBanner.classList.add('visible', 'ready');
            manualUpdateCheck = false;
            break;
        case 'error':
            updateText.textContent = `Update error: ${status.message}`;
            updateBanner.classList.add('visible', 'error');
            setTimeout(() => updateBanner.classList.remove('visible'), 6000);
            manualUpdateCheck = false;
            break;
        case 'none':
            if (manualUpdateCheck) {
                showToast("You're on the latest version");
                manualUpdateCheck = false;
            }
            break;
        default:
            break;
    }
});

updateInstallBtn.addEventListener('click', () => {
    api.installUpdate();
});

initPeer();
