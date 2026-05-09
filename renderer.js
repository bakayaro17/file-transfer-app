const myIdElement = document.getElementById('my-id');
const copyBtn = document.getElementById('copy-btn');
const shareBtn = document.getElementById('share-btn');
const targetIdInput = document.getElementById('target-id');
const connectBtn = document.getElementById('connect-btn');
const statusElement = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const dropzone = document.getElementById('dropzone');
const connectedIdElement = document.getElementById('connected-id');
const filesSection = document.getElementById('files-section');
const fileList = document.getElementById('file-list');
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
        connectedIdElement.textContent = conn.peer;
        connectBtn.disabled = true;
    });

    conn.on('data', async (data) => {
        if (data.type === 'file') handleIncomingFile(data.file);
    });

    conn.on('close', () => {
        setStatus('Connection closed', 'ready');
        dropzone.style.display = 'none';
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

async function sendFile(file) {
    setStatus(`Sending ${file.name}...`, 'connected');
    try {
        const arrayBuffer = await file.arrayBuffer();
        conn.send({
            type: 'file',
            file: { name: file.name, data: arrayBuffer }
        });
        setStatus(`Sent ${file.name}`, 'connected');
    } catch (err) {
        console.error('Send error', err);
        setStatus(`Error sending ${file.name}`, 'error');
    }
}

async function handleIncomingFile(file) {
    try {
        const tempPath = await window.electronAPI.saveTempFile(file.name, file.data);

        filesSection.style.display = 'block';

        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-item';
        fileDiv.draggable = true;
        fileDiv.innerHTML = `
            <span class="name">📄 ${file.name}</span>
            <span class="hint">drag out</span>
        `;
        fileDiv.addEventListener('dragstart', (e) => {
            e.preventDefault();
            window.electronAPI.startDrag(tempPath);
        });
        fileList.appendChild(fileDiv);
        setStatus(`Received ${file.name}`, 'connected');
    } catch (err) {
        console.error('Receive error', err);
        setStatus(`Error saving ${file.name}`, 'error');
    }
}

// Window controls
minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

// Version display
window.electronAPI.getVersion().then((v) => {
    versionEl.textContent = `v${v}`;
}).catch(() => {});

// Deep link handling
if (window.electronAPI?.onDeepLink) {
    window.electronAPI.onDeepLink((code) => {
        connectToCode(code);
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
                break;
            }
            case 'ready':
                updateText.textContent = `Update v${status.version} ready.`;
                updateInstallBtn.style.display = 'inline-block';
                updateBanner.classList.add('visible', 'ready');
                break;
            case 'error':
                updateText.textContent = `Update error: ${status.message}`;
                updateBanner.classList.add('visible', 'error');
                setTimeout(() => updateBanner.classList.remove('visible'), 6000);
                break;
            case 'none':
            default:
                break;
        }
    });
}

updateInstallBtn?.addEventListener('click', () => {
    window.electronAPI.installUpdate();
});

initPeer();
