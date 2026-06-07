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
const versionEl = document.getElementById('app-version');
const minimizeBtn = document.getElementById('btn-minimize');
const closeBtn = document.getElementById('btn-close');
const toast = document.getElementById('toast');
const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateInstallBtn = document.getElementById('update-install-btn');

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

function generateCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

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
        connectedIdElement.textContent = conn.peer;
        connectBtn.disabled = true;
    });

    conn.on('data', async (data) => {
        if (data.type === 'file') handleIncomingFile(data.file); // legacy single-message format
        else if (data.type === 'file-start') handleFileStart(data);
        else if (data.type === 'file-chunk') handleFileChunk(data);
        else if (data.type === 'file-end') handleFileEnd(data);
        else if (data.type === 'file-ack') handleFileAck(data);
        else if (data.type === 'link') handleIncomingLink(data.url);
        else if (data.type === 'text') handleIncomingText(data.text);
    });

    conn.on('close', () => {
        setStatus('Connection closed', 'ready');
        dropzone.style.display = 'none';
        sendLinkSection.style.display = 'none';
        sendTextSection.style.display = 'none';
        connectBtn.disabled = false;
        conn = null;
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

    conn = peer.connect(targetId);
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
dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    if (!conn || !conn.open) {
        showToast('Not connected');
        return;
    }
    for (const f of e.dataTransfer.files) sendFile(f);
});

// Click the dropzone (or Browse button) to pick files
dropzone.addEventListener('click', () => {
    if (!conn || !conn.open) {
        showToast('Not connected');
        return;
    }
    fileInput.click();
});
browseBtn.addEventListener('click', (e) => {
    // Avoid the dropzone click handler firing a second time
    e.stopPropagation();
    if (!conn || !conn.open) {
        showToast('Not connected');
        return;
    }
    fileInput.click();
});
fileInput.addEventListener('change', () => {
    for (const f of fileInput.files) sendFile(f);
    fileInput.value = '';
});

// Chunked, backpressured file transfer.
// Sending one giant message floods the WebRTC send buffer; over a high-latency
// link (e.g. to a remote VPS) that collapses throughput. Instead we slice the
// file and only keep a bounded amount of data in flight at once.
const CHUNK_SIZE = 256 * 1024;        // bytes read+sent per chunk
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;  // pause sending above 8 MB buffered
const BUFFER_LOW_WATER = 1 * 1024 * 1024;   // resume once drained to 1 MB

let fileSeq = 0;
const pendingSends = new Map(); // transfer id -> file name (awaiting receiver ack)

// Resolve once the data channel's send buffer has drained below lowWater.
function waitForDrain(lowWater) {
    const dc = conn && conn.dataChannel;
    if (!dc || dc.bufferedAmount <= lowWater) return Promise.resolve();
    return new Promise((resolve) => {
        try { dc.bufferedAmountLowThreshold = lowWater; } catch (_) {}
        const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
        dc.addEventListener('bufferedamountlow', onLow);
    });
}

async function sendFile(file) {
    if (!conn || !conn.open) { showToast('Not connected'); return; }
    const id = `${Date.now()}-${fileSeq++}`;
    const total = file.size;
    pendingSends.set(id, file.name);
    setStatus(`Sending ${file.name}... 0%`, 'connected');
    try {
        conn.send({ type: 'file-start', id, name: file.name, size: total });
        let offset = 0;
        while (offset < total) {
            const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            conn.send({ type: 'file-chunk', id, data: buf });
            offset += buf.byteLength;
            if (conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_HIGH_WATER) {
                await waitForDrain(BUFFER_LOW_WATER);
            }
            setStatus(`Sending ${file.name}... ${total ? Math.floor((offset / total) * 100) : 100}%`, 'connected');
        }
        conn.send({ type: 'file-end', id });
        // Don't claim "Sent" yet — wait for the receiver to actually save it (file-ack).
        setStatus(`Finishing ${file.name}...`, 'connected');
    } catch (err) {
        console.error('Send error', err);
        pendingSends.delete(id);
        setStatus(`Error sending ${file.name}`, 'error');
    }
}

function handleFileAck(msg) {
    const name = pendingSends.get(msg.id);
    if (!name) return;
    pendingSends.delete(msg.id);
    setStatus(`Sent ${name}`, 'connected');
    showToast(`${name} delivered`);
}

function normalizeUrl(input) {
    const url = (input || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (/^[\w.-]+\.\w{2,}/.test(url)) return `https://${url}`;
    return null;
}

function sendLink() {
    if (!conn || !conn.open) {
        showToast('Not connected');
        return;
    }
    const url = normalizeUrl(linkInput.value);
    if (!url) {
        showToast('Enter a valid URL');
        return;
    }
    conn.send({ type: 'link', url });
    setStatus(`Sent link`, 'connected');
    showToast('Link sent');
    linkInput.value = '';
}

sendLinkBtn.addEventListener('click', sendLink);
linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
});

function sendText() {
    if (!conn || !conn.open) {
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

function handleIncomingText(text) {
    if (typeof text !== 'string' || !text) return;
    textsSection.style.display = 'block';

    const item = document.createElement('div');
    item.className = 'text-item';

    const span = document.createElement('span');
    span.className = 'text';
    span.textContent = text;

    const copy = document.createElement('button');
    copy.className = 'copy-text';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(text);
        showToast('Text copied');
    });

    item.appendChild(span);
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
    a.addEventListener('click', () => window.electronAPI.openExternal(url));

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

// Save received bytes to a temp file and add a draggable entry to the list.
async function saveAndListFile(name, data) {
    const tempPath = await window.electronAPI.saveTempFile(name, data);

    filesSection.style.display = 'block';

    const fileDiv = document.createElement('div');
    fileDiv.className = 'file-item';
    fileDiv.draggable = true;
    fileDiv.innerHTML = `
        <span class="name">📄 ${name}</span>
        <span class="hint">drag out</span>
    `;
    fileDiv.addEventListener('dragstart', (e) => {
        e.preventDefault();
        window.electronAPI.startDrag(tempPath);
    });
    fileList.appendChild(fileDiv);
}

// Legacy single-message path (kept so an un-updated sender still works).
async function handleIncomingFile(file) {
    try {
        await saveAndListFile(file.name, file.data);
        setStatus(`Received ${file.name}`, 'connected');
    } catch (err) {
        console.error('Receive error', err);
        setStatus(`Error saving ${file.name}`, 'error');
    }
}

// Chunked receive: collect chunks per transfer id, then reassemble on file-end.
const incomingFiles = new Map(); // id -> { name, size, chunks: [], received }

function handleFileStart(meta) {
    incomingFiles.set(meta.id, { name: meta.name, size: meta.size || 0, chunks: [], received: 0 });
    setStatus(`Receiving ${meta.name}... 0%`, 'connected');
}

function handleFileChunk(msg) {
    const f = incomingFiles.get(msg.id);
    if (!f) return;
    f.chunks.push(msg.data);
    f.received += msg.data.byteLength || 0;
    if (f.size) {
        setStatus(`Receiving ${f.name}... ${Math.floor((f.received / f.size) * 100)}%`, 'connected');
    }
}

async function handleFileEnd(msg) {
    const f = incomingFiles.get(msg.id);
    if (!f) return;
    incomingFiles.delete(msg.id);
    try {
        const buffer = await new Blob(f.chunks).arrayBuffer();
        await saveAndListFile(f.name, buffer);
        setStatus(`Received ${f.name}`, 'connected');
        if (conn && conn.open) conn.send({ type: 'file-ack', id: msg.id });
    } catch (err) {
        console.error('Receive error', err);
        setStatus(`Error saving ${f.name}`, 'error');
    }
}

// Window controls
minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

// Version display + click to check for updates
window.electronAPI.getVersion().then((v) => {
    versionEl.textContent = `v${v}`;
}).catch(() => {});

let manualUpdateCheck = false;
versionEl.addEventListener('click', async () => {
    const result = await window.electronAPI.checkForUpdates();
    if (!result?.ok) {
        if (result?.reason === 'dev') showToast('Updates only check in installed builds');
        else if (result?.reason === 'portable') showToast('Auto-update is disabled for the portable build');
        else showToast(`Update check failed${result?.message ? `: ${result.message}` : ''}`);
        return;
    }
    manualUpdateCheck = true;
});

// Deep link handling
if (window.electronAPI?.onDeepLink) {
    window.electronAPI.onDeepLink((code) => {
        connectToCode(code);
    });
}

// Surface main-process drag errors so silent failures become visible
if (window.electronAPI?.onDragError) {
    window.electronAPI.onDragError((msg) => {
        console.error('[drag] main reported:', msg);
        showToast(`Drag failed: ${msg}`, 3000);
    });
}

// Auto-update status banner
if (window.electronAPI?.onUpdateStatus) {
    window.electronAPI.onUpdateStatus((status) => {
        updateBanner.classList.remove('visible', 'ready', 'error');
        updateInstallBtn.style.display = 'none';

        switch (status.state) {
            case 'checking':
                updateText.textContent = 'Checking for updates...';
                updateBanner.classList.add('visible');
                break;
            case 'downloading': {
                const pct = typeof status.percent === 'number' ? ` (${status.percent}%)` : '';
                const ver = status.version ? ` v${status.version}` : '';
                updateText.textContent = `Downloading update${ver}${pct}...`;
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
}

updateInstallBtn?.addEventListener('click', () => {
    window.electronAPI.installUpdate();
});

initPeer();
