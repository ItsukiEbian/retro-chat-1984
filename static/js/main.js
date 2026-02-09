const socket = io();
const videosContainer = document.getElementById('videosContainer');
const statusDiv = document.getElementById('status');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

const FILTER_FPS = 30;

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// State
let localStream;      // The PROCESSED stream (Mosaic)
let rawStream;        // The raw camera stream
let peers = {};       // socketId -> { connection, videoEl } elements
let myRoomId = null;

// Hidden elements for processing
const hiddenVideo = document.createElement('video');
hiddenVideo.playsInline = true;
hiddenVideo.muted = true;
hiddenVideo.autoplay = true;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for no transparency

// --- 1. INITIALIZATION & ROOM SETUP ---
const urlParams = new URLSearchParams(window.location.search);
myRoomId = urlParams.get('room');

if (!myRoomId) {
    myRoomId = Math.random().toString(36).substring(7);
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + myRoomId;
    window.history.pushState({ path: newUrl }, '', newUrl);
}

function updateRoomIdDisplay() {
    const sid = document.getElementById('sidebarRoomId');
    const hid = document.getElementById('headerRoomId');
    if (sid) sid.textContent = myRoomId || '—';
    if (hid) hid.textContent = myRoomId || '—';
}
updateRoomIdDisplay();

// --- 2. MOSAIC PROCESSING LOGIC ---
function startMosaicProcessing() {
    processVideoFrame();
}

function processVideoFrame() {
    if (hiddenVideo.readyState === hiddenVideo.HAVE_ENOUGH_DATA) {
        if (canvas.width !== hiddenVideo.videoWidth || canvas.height !== hiddenVideo.videoHeight) {
            canvas.width = hiddenVideo.videoWidth;
            canvas.height = hiddenVideo.videoHeight;
        }
        const w = canvas.width;
        const h = canvas.height;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(hiddenVideo, 0, 0, w, h);
    }
    requestAnimationFrame(processVideoFrame);
}

// --- 3. START SEQUENCE ---
async function startSystem() {
    try {
        statusDiv.innerText = "カメラを起動しています...";

        // A. Get Raw Camera
        rawStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 }
            },
            audio: false
        });

        // B. Start Processing Loop
        hiddenVideo.srcObject = rawStream;
        await hiddenVideo.play().catch(e => console.log('Wait play:', e));
        startMosaicProcessing();

        // C. Capture Processed Stream
        localStream = canvas.captureStream(FILTER_FPS);

        // D. Show Local Video
        addVideoElement('local', localStream, 'あなた');

        // E. Join Room
        overlay.style.display = 'none';
        statusDiv.innerText = "接続済み: " + myRoomId;
        socket.emit('join_room', { room: myRoomId });

    } catch (err) {
        console.error("System Failure:", err);
        statusDiv.innerText = "エラー: " + err.name;
        alert("Camera Access Failed: " + err.message);
    }
}

startBtn.addEventListener('click', startSystem);

// --- 4. UI & GRID LOGIC ---
function addVideoElement(peerId, stream, labelText) {
    // Prevent duplicate entries
    if (document.getElementById('video-wrapper-' + peerId)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = 'video-wrapper-' + peerId;

    const label = document.createElement('h3');
    label.innerText = labelText || 'UNKNOWN ENTITY';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = (peerId === 'local'); // Mute self
    video.srcObject = stream;

    wrapper.appendChild(label);
    wrapper.appendChild(video);
    videosContainer.appendChild(wrapper);

    updateLayout();
}

function removeVideoElement(peerId) {
    const el = document.getElementById('video-wrapper-' + peerId);
    if (el) {
        el.remove();
        updateLayout();
    }
}

function updateLayout() {
    const count = videosContainer.children.length; // Includes local + remotes
    videosContainer.setAttribute('data-count', count);
}

// --- 5. WEBRTC (MESH TOPOLOGY) ---

// A. New User Joined -> We Call Them (Offer)
socket.on('user_joined', async (data) => {
    const targetId = data.sid;
    console.log('Target Acquired:', targetId);
    createPeerConnection(targetId, true); // true = initiator
});

// B. User Left -> Cleanup
socket.on('user_left', (data) => {
    const targetId = data.sid;
    console.log('Target Lost:', targetId);
    if (peers[targetId]) {
        peers[targetId].connection.close();
        delete peers[targetId];
    }
    removeVideoElement(targetId);
});

// C. Signaling Handling
socket.on('offer', async (data) => {
    const targetId = data.sender;
    const pc = createPeerConnection(targetId, false);

    await pc.setRemoteDescription(new RTCSessionDescription(data.description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer', {
        target: targetId,
        description: pc.localDescription,
        sender: socket.id
    });
});

socket.on('answer', async (data) => {
    const targetId = data.sender;
    const pc = peers[targetId]?.connection;
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
    }
});

socket.on('ice_candidate', async (data) => {
    const targetId = data.sender;
    const pc = peers[targetId]?.connection;
    if (pc && data.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error("ICE Error", e);
        }
    }
});

// D. Connection Factory
function createPeerConnection(targetId, isInitiator) {
    if (peers[targetId]) return peers[targetId].connection;

    const pc = new RTCPeerConnection(rtcConfig);

    // Add local PROCESSED tracks
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // Handle incoming streams
    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        // Only add if not exists
        if (!document.getElementById('video-wrapper-' + targetId)) {
            addVideoElement(targetId, remoteStream, '参加者 ' + targetId.substr(0, 6));
        }
    };

    // Handle ICE
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice_candidate', {
                target: targetId,
                candidate: event.candidate,
                sender: socket.id // Ensure sender ID is passed
            });
        }
    };

    // Save state
    peers[targetId] = { connection: pc };

    // If initiator, create offer
    if (isInitiator) {
        makeOffer(pc, targetId);
    }

    return pc;
}

async function makeOffer(pc, targetId) {
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
            target: targetId,
            description: pc.localDescription,
            sender: socket.id
        });
    } catch (err) {
        console.error("Offer Error:", err);
    }
}

// --- 6. Right panel (Share / Settings) ---
const rightPanel = document.getElementById('rightPanel');
const panelBackdrop = document.getElementById('panelBackdrop');
const panelClose = document.getElementById('panelClose');
const panelTitle = document.getElementById('panelTitle');
const panelViewShare = document.getElementById('panelViewShare');
const panelViewSettings = document.getElementById('panelViewSettings');
const sidebarShareBtn = document.getElementById('sidebarShareBtn');
const sidebarSettingsBtn = document.getElementById('sidebarSettingsBtn');
const qrBtn = document.getElementById('qrBtn');
const qrcodeDiv = document.getElementById('qrcode');
const roomUrlP = document.getElementById('roomUrl');
const copyUrlBtn = document.getElementById('copyUrlBtn');

function openPanel(view) {
    panelViewShare.classList.remove('is-visible');
    panelViewSettings.classList.remove('is-visible');
    if (view === 'share') {
        panelViewShare.classList.add('is-visible');
        panelTitle.textContent = '共有';
        const currentUrl = window.location.href;
        if (roomUrlP) roomUrlP.textContent = currentUrl;
        if (qrcodeDiv) {
            qrcodeDiv.innerHTML = '';
            new QRCode(qrcodeDiv, {
                text: currentUrl,
                width: 180,
                height: 180,
                correctLevel: QRCode.CorrectLevel.H
            });
        }
    } else if (view === 'settings') {
        panelViewSettings.classList.add('is-visible');
        panelTitle.textContent = '設定';
    }
    rightPanel.classList.add('is-open');
    if (panelBackdrop) {
        panelBackdrop.classList.add('is-open');
        panelBackdrop.setAttribute('aria-hidden', 'false');
    }
}

function closePanel() {
    rightPanel.classList.remove('is-open');
    if (panelBackdrop) {
        panelBackdrop.classList.remove('is-open');
        panelBackdrop.setAttribute('aria-hidden', 'true');
    }
}

if (qrBtn) qrBtn.addEventListener('click', () => openPanel('share'));
if (sidebarShareBtn) sidebarShareBtn.addEventListener('click', () => openPanel('share'));
if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', () => openPanel('settings'));
if (panelClose) panelClose.addEventListener('click', closePanel);
if (panelBackdrop) panelBackdrop.addEventListener('click', closePanel);

if (copyUrlBtn && roomUrlP) {
    copyUrlBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(roomUrlP.textContent || window.location.href).then(() => {
            copyUrlBtn.textContent = 'コピーしました';
            setTimeout(() => { copyUrlBtn.textContent = 'URLをコピー'; }, 2000);
        });
    });
}
