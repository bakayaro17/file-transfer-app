const myIdElement = document.getElementById('my-id');
const copyBtn = document.getElementById('copy-btn');
const targetIdInput = document.getElementById('target-id');
const connectBtn = document.getElementById('connect-btn');
const statusElement = document.getElementById('status');
const dropzone = document.getElementById('dropzone');
const connectedIdElement = document.getElementById('connected-id');
const filesSection = document.getElementById('files-section');
const fileList = document.getElementById('file-list');

let peer = null;
let conn = null;

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
    myIdElement.textContent = '...';
    const code = generateCode();
    peer = new Peer(code);

    peer.on('open', (id) => {
        myIdElement.textContent = id;
        statusElement.textContent = 'Share your code, or enter another to connect.';
    });

    peer.on('connection', (incoming) => {
        const accept = confirm(`Accept incoming connection from ${incoming.peer}?`);
        if (!accept) {
            incoming.close();
            return;
        }
        if (conn && conn.open) {
            conn.close();
        }
        conn = incoming;
        setupConnection();
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
            setTimeout(initPeer, 200);
            return;
        }
        statusElement.textContent = `Error: ${err.type}`;
        connectBtn.disabled = false;
    });
}

function setupConnection() {
    conn.on('open', () => {
        statusElement.textContent = 'Connected!';
        dropzone.style.display = 'block';
        connectedIdElement.textContent = conn.peer;
        connectBtn.disabled = true;
    });

    conn.on('data', async (data) => {
        if (data.type === 'file') {
            handleIncomingFile(data.file);
        }
    });

    conn.on('close', () => {
        statusElement.textContent = 'Connection closed.';
        dropzone.style.display = 'none';
        connectBtn.disabled = false;
        conn = null;
    });
}

connectBtn.addEventListener('click', () => {
    const targetId = targetIdInput.value.trim().toUpperCase();
    if (!targetId) return;
    targetIdInput.value = targetId;

    connectBtn.disabled = true;
    statusElement.textContent = 'Connecting...';

    conn = peer.connect(targetId);
    setupConnection();
});

targetIdInput.addEventListener('input', () => {
    targetIdInput.value = targetIdInput.value.toUpperCase();
});

targetIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click();
});

copyBtn.addEventListener('click', async () => {
    const code = myIdElement.textContent;
    if (!code || code === '...') return;
    await navigator.clipboard.writeText(code);
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
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
        alert('Not connected to anyone!');
        return;
    }

    const files = e.dataTransfer.files;
    for (const f of files) {
        sendFile(f);
    }
});

async function sendFile(file) {
    statusElement.textContent = `Sending ${file.name}...`;
    try {
        const arrayBuffer = await file.arrayBuffer();
        conn.send({
            type: 'file',
            file: {
                name: file.name,
                data: arrayBuffer
            }
        });
        statusElement.textContent = `Sent ${file.name}`;
    } catch (err) {
        console.error('Send error', err);
        statusElement.textContent = `Error sending ${file.name}`;
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
            <span>📄 ${file.name}</span>
            <span style="color: #888; font-size: 0.8em;">(Drag me out)</span>
        `;

        fileDiv.addEventListener('dragstart', (e) => {
            e.preventDefault();
            window.electronAPI.startDrag(tempPath);
        });

        fileList.appendChild(fileDiv);
        statusElement.textContent = `Received ${file.name}`;
    } catch (err) {
        console.error('Receive error', err);
        statusElement.textContent = `Error saving ${file.name}`;
    }
}

initPeer();

const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateInstallBtn = document.getElementById('update-install-btn');

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
                // Hide silently when no update is available
                break;
        }
    });
}

updateInstallBtn?.addEventListener('click', () => {
    window.electronAPI.installUpdate();
});
