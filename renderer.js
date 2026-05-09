const myIdElement = document.getElementById('my-id');
const targetIdInput = document.getElementById('target-id');
const connectBtn = document.getElementById('connect-btn');
const statusElement = document.getElementById('status');
const dropzone = document.getElementById('dropzone');
const connectedIdElement = document.getElementById('connected-id');
const filesSection = document.getElementById('files-section');
const fileList = document.getElementById('file-list');

let peer = null;
let conn = null;

// Initialize PeerJS
function initPeer() {
    peer = new Peer();

    peer.on('open', (id) => {
        myIdElement.textContent = id;
        statusElement.textContent = 'Ready to connect or receive connections.';
    });

    peer.on('connection', (c) => {
        // Disconnect existing if any
        if (conn && conn.open) {
            conn.close();
        }
        conn = c;
        setupConnection();
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        statusElement.textContent = `Error: ${err.type}`;
        connectBtn.disabled = false;
    });
}

// Setup connection handlers
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

// Connect to another peer
connectBtn.addEventListener('click', () => {
    const targetId = targetIdInput.value.trim();
    if (!targetId) return;

    connectBtn.disabled = true;
    statusElement.textContent = 'Connecting...';
    
    conn = peer.connect(targetId);
    setupConnection();
});

// Click ID to copy
myIdElement.addEventListener('click', () => {
    navigator.clipboard.writeText(myIdElement.textContent);
    const originalText = myIdElement.textContent;
    myIdElement.textContent = 'Copied!';
    setTimeout(() => {
        myIdElement.textContent = originalText;
    }, 1000);
});

// Drag and Drop (Sending)
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
        const fileData = await window.electronAPI.readFile(file.path);
        if (fileData) {
            conn.send({
                type: 'file',
                file: {
                    name: file.name,
                    data: fileData
                }
            });
            statusElement.textContent = `Sent ${file.name}`;
        } else {
            statusElement.textContent = `Failed to read ${file.name}`;
        }
    } catch (err) {
        console.error('Send error', err);
        statusElement.textContent = `Error sending ${file.name}`;
    }
}

// Handle Incoming File
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

// Start
initPeer();
