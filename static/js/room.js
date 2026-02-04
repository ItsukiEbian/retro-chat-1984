const socket = io();
const videosContainer = document.getElementById('videosContainer');
const statusDiv = document.getElementById('status');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

const ROLE = window.ROLE || 'student';
const USER_NAME = window.USER_NAME || '';
let myRoomId = window.ROOM_ID || '';

const PIXEL_SIZE = 15;
const FILTER_FPS = 30;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let localStream;
let rawStream;
let peers = {};
let handRaiseState = {};  // sid -> { user_name, raised }
let roomParticipants = {};  // sid -> { user_name, role } (for admin student list)
let myHandRaised = false;
let currentPrivateSessionId = null;
let privatePeers = {};
let privateLocalStream = null;
let mainRoomIdForReturn = null;

const hiddenVideo = document.createElement('video');
hiddenVideo.playsInline = true;
hiddenVideo.muted = true;
hiddenVideo.autoplay = true;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

// ---------- Camera / mediaDevices support ----------
var MEDIA_DEVICES_UNAVAILABLE_MSG = 'HTTPS接続が必要であるか、お使いのブラウザが対応していません。スマホや他端末では HTTPS のURL（ngrok 等）をご利用ください。';

function checkMediaDevicesSupport() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        return { supported: false, message: MEDIA_DEVICES_UNAVAILABLE_MSG };
    }
    return { supported: true, message: '' };
}

function logMediaError(context, err) {
    console.error('[Video Desk] ' + context + ':', err);
    if (err && (err.name || err.message)) {
        console.error('[Video Desk] Error name:', err.name, '| message:', err.message);
        if (err.stack) console.error('[Video Desk] Stack:', err.stack);
    }
}

function showMediaErrorAlert(userMessage, err) {
    logMediaError('getUserMedia', err);
    alert(userMessage);
}

function updateRoomIdDisplay() {
    const sid = document.getElementById('sidebarRoomId');
    const hid = document.getElementById('headerRoomId');
    if (sid) sid.textContent = myRoomId || '—';
    if (hid) hid.textContent = myRoomId || '—';
}
updateRoomIdDisplay();

// ---------- Notification sound (admin) ----------
function playNotificationSound() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
        console.warn('Notification sound failed', e);
    }
}

var soundTestBtn = document.getElementById('soundTestBtn');
if (soundTestBtn) soundTestBtn.addEventListener('click', playNotificationSound);

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
        const sw = Math.floor(w / PIXEL_SIZE);
        const sh = Math.floor(h / PIXEL_SIZE);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(hiddenVideo, 0, 0, sw, sh);
        ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, w, h);
    }
    requestAnimationFrame(processVideoFrame);
}

async function startSystem() {
    var support = checkMediaDevicesSupport();
    if (!support.supported) {
        statusDiv.innerText = "カメラを利用できません";
        showMediaErrorAlert(support.message, new Error('navigator.mediaDevices is undefined'));
        return;
    }
    try {
        if (statusDiv) statusDiv.innerText = "カメラを起動しています...";

        rawStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
            audio: false
        });

        hiddenVideo.srcObject = rawStream;
        await hiddenVideo.play().catch(e => console.log('Wait play:', e));
        startMosaicProcessing();

        localStream = canvas.captureStream(FILTER_FPS);

        const localLabel = ROLE === 'admin' ? '管理者' : USER_NAME || 'あなた';
        addVideoElement('local', localStream, localLabel);

        overlay.style.display = 'none';
        statusDiv.innerText = "接続済み: " + myRoomId;

        roomParticipants[socket.id] = { user_name: USER_NAME, role: ROLE };
        socket.emit('join_room', {
            room: myRoomId,
            user_name: USER_NAME,
            role: ROLE
        });
        if (ROLE === 'admin') renderStudentList();
    } catch (err) {
        if (statusDiv) statusDiv.innerText = "エラー: " + (err.name || 'UnknownError');
        var userMsg = "カメラへのアクセスに失敗しました。\n\n" + (err.message || '');
        showMediaErrorAlert(userMsg, err);
    }
}

if (startBtn) startBtn.addEventListener('click', startSystem);

// ページ読み込み時にカメラ対応をチェックし、非対応ならボタン無効化・警告表示
function initMediaDevicesCheck() {
    var support = checkMediaDevicesSupport();
    var overlayWarning = document.getElementById('overlayCameraWarning');
    if (!support.supported) {
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.setAttribute('aria-disabled', 'true');
        }
        if (overlayWarning) {
            overlayWarning.hidden = false;
            overlayWarning.textContent = support.message;
        }
    } else {
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.removeAttribute('aria-disabled');
        }
        if (overlayWarning) overlayWarning.hidden = true;
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMediaDevicesCheck);
} else {
    initMediaDevicesCheck();
}

function updateHandIndicator(wrapperEl, raised) {
    if (!wrapperEl) return;
    let badge = wrapperEl.querySelector('.hand-badge');
    if (raised) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'hand-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = '✋';
            wrapperEl.appendChild(badge);
        }
        badge.classList.add('is-raised');
    } else {
        if (badge) badge.classList.remove('is-raised');
    }
}

function applyHandStates() {
    ['local'].concat(Object.keys(peers)).forEach(peerId => {
        const wrapper = document.getElementById('video-wrapper-' + peerId);
        if (!wrapper) return;
        const sid = peerId === 'local' ? socket.id : peerId;
        const state = handRaiseState[sid];
        updateHandIndicator(wrapper, state && state.raised);
    });
}

function addVideoElement(peerId, stream, labelText) {
    if (document.getElementById('video-wrapper-' + peerId)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = 'video-wrapper-' + peerId;
    wrapper.setAttribute('data-peer-id', peerId);

    const label = document.createElement('h3');
    label.innerText = labelText || '';

    const scanlines = document.createElement('div');
    scanlines.className = 'scanlines';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = (peerId === 'local');
    video.srcObject = stream;

    wrapper.appendChild(label);
    wrapper.appendChild(scanlines);
    wrapper.appendChild(video);
    videosContainer.appendChild(wrapper);

    const sid = peerId === 'local' ? socket.id : peerId;
    if (handRaiseState[sid]) updateHandIndicator(wrapper, handRaiseState[sid].raised);
    updateLayout();
}

function removeVideoElement(peerId) {
    const el = document.getElementById('video-wrapper-' + peerId);
    if (el) el.remove();
    delete handRaiseState[peerId];
    updateLayout();
}

function updateLayout() {
    if (videosContainer) videosContainer.setAttribute('data-count', videosContainer.children.length);
}

function renderStudentList() {
    var listEl = document.getElementById('studentList');
    if (!listEl || ROLE !== 'admin') return;
    var students = Object.keys(roomParticipants).filter(function (sid) {
        return sid !== socket.id && roomParticipants[sid] && roomParticipants[sid].role === 'student';
    });
    listEl.innerHTML = students.map(function (sid) {
        var p = roomParticipants[sid];
        var name = (p && p.user_name) || ('参加者 ' + sid.substr(0, 6));
        var raised = handRaiseState[sid] && handRaiseState[sid].raised;
        return '<li class="student-item">' +
            '<span class="student-name">' + escapeHtml(name) + (raised ? ' <span class="student-raised">✋</span>' : '') + '</span>' +
            '<button type="button" class="btn-primary btn-start-session" data-student-sid="' + escapeHtml(sid) + '">対応開始 (Start Session)</button>' +
            '</li>';
    }).join('');
    listEl.querySelectorAll('.btn-start-session').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var studentSid = btn.getAttribute('data-student-sid');
            if (studentSid) socket.emit('start_private_session', { student_sid: studentSid });
        });
    });
}
function escapeHtml(s) {
    if (!s) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

socket.on('user_joined', async (data) => {
    const targetId = data.sid;
    const userName = data.user_name || ('参加者 ' + targetId.substr(0, 6));
    const role = data.role || 'student';
    roomParticipants[targetId] = { user_name: userName, role: role };
    if (handRaiseState[targetId] === undefined) handRaiseState[targetId] = { user_name: userName, raised: false };
    else handRaiseState[targetId].user_name = userName;
    createPeerConnection(targetId, true);
    if (ROLE === 'admin') renderStudentList();
});

socket.on('user_left', (data) => {
    const targetId = data.sid;
    delete roomParticipants[targetId];
    if (peers[targetId]) {
        peers[targetId].connection.close();
        delete peers[targetId];
    }
    delete handRaiseState[targetId];
    removeVideoElement(targetId);
    if (ROLE === 'admin') renderStudentList();
});

socket.on('hand_raise_update', (data) => {
    const { sid, user_name, raised } = data;
    handRaiseState[sid] = { user_name: user_name || (handRaiseState[sid] && handRaiseState[sid].user_name) || '', raised: !!raised };
    applyHandStates();

    if (ROLE === 'admin') {
        renderStudentList();
        if (raised && user_name) {
            showToast(user_name + 'さんが挙手しました');
            playNotificationSound();
        }
    }
});

socket.on('hand_states', (data) => {
    (data.states || []).forEach(s => {
        handRaiseState[s.sid] = { user_name: s.user_name, raised: !!s.raised };
        if (s.role) roomParticipants[s.sid] = { user_name: s.user_name, role: s.role };
    });
    applyHandStates();
    if (ROLE === 'admin') renderStudentList();
});

function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

socket.on('offer', async (data) => {
    const targetId = data.sender;
    if (currentPrivateSessionId) {
        var pc = privateCreatePeerConnection(targetId, '', false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { target: targetId, description: pc.localDescription, sender: socket.id });
    } else {
        const pc = createPeerConnection(targetId, false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { target: targetId, description: pc.localDescription, sender: socket.id });
    }
});

socket.on('answer', async (data) => {
    const targetId = data.sender;
    var pc = currentPrivateSessionId ? (privatePeers[targetId] && privatePeers[targetId].connection) : peers[targetId]?.connection;
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.description));
});

socket.on('ice_candidate', async (data) => {
    const targetId = data.sender;
    var pc = currentPrivateSessionId ? (privatePeers[targetId] && privatePeers[targetId].connection) : peers[targetId]?.connection;
    if (pc && data.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error("ICE Error", e);
        }
    }
});

function createPeerConnection(targetId, isInitiator) {
    if (peers[targetId]) return peers[targetId].connection;

    const pc = new RTCPeerConnection(rtcConfig);

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!document.getElementById('video-wrapper-' + targetId)) {
            const userName = (handRaiseState[targetId] && handRaiseState[targetId].user_name) || ('参加者 ' + targetId.substr(0, 6));
            addVideoElement(targetId, remoteStream, userName);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice_candidate', { target: targetId, candidate: event.candidate, sender: socket.id });
        }
    };

    peers[targetId] = { connection: pc };

    if (isInitiator) {
        makeOffer(pc, targetId);
    }
    return pc;
}

async function makeOffer(pc, targetId) {
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: targetId, description: pc.localDescription, sender: socket.id });
    } catch (err) {
        console.error("Offer Error:", err);
    }
}

var handRaiseBtn = document.getElementById('handRaiseBtn');
if (handRaiseBtn) {
    handRaiseBtn.addEventListener('click', function () {
        myHandRaised = !myHandRaised;
        handRaiseBtn.setAttribute('aria-pressed', myHandRaised ? 'true' : 'false');
        handRaiseBtn.classList.toggle('is-active', myHandRaised);
        socket.emit('hand_raise', { raised: myHandRaised });
        handRaiseState[socket.id] = handRaiseState[socket.id] || { user_name: USER_NAME, raised: false };
        handRaiseState[socket.id].raised = myHandRaised;
        applyHandStates();
    });
}

var rightPanel = document.getElementById('rightPanel');
var panelBackdrop = document.getElementById('panelBackdrop');
var panelClose = document.getElementById('panelClose');
var panelTitle = document.getElementById('panelTitle');
var panelViewShare = document.getElementById('panelViewShare');
var panelViewSettings = document.getElementById('panelViewSettings');
var sidebarShareBtn = document.getElementById('sidebarShareBtn');
var sidebarSettingsBtn = document.getElementById('sidebarSettingsBtn');
var qrBtn = document.getElementById('qrBtn');
var qrcodeDiv = document.getElementById('qrcode');
var roomUrlP = document.getElementById('roomUrl');
var copyUrlBtn = document.getElementById('copyUrlBtn');

function openPanel(view) {
    if (panelViewShare) panelViewShare.classList.remove('is-visible');
    if (panelViewSettings) panelViewSettings.classList.remove('is-visible');
    if (view === 'share') {
        if (panelViewShare) panelViewShare.classList.add('is-visible');
        if (panelTitle) panelTitle.textContent = '共有';
        var currentUrl = window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(myRoomId);
        if (roomUrlP) roomUrlP.textContent = currentUrl;
        if (qrcodeDiv) {
            qrcodeDiv.innerHTML = '';
            new QRCode(qrcodeDiv, { text: currentUrl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.H });
        }
    } else if (view === 'settings') {
        if (panelViewSettings) panelViewSettings.classList.add('is-visible');
        if (panelTitle) panelTitle.textContent = '設定';
    }
    if (rightPanel) rightPanel.classList.add('is-open');
    if (panelBackdrop) {
        panelBackdrop.classList.add('is-open');
        panelBackdrop.setAttribute('aria-hidden', 'false');
    }
}

function closePanel() {
    if (rightPanel) rightPanel.classList.remove('is-open');
    if (panelBackdrop) {
        panelBackdrop.classList.remove('is-open');
        panelBackdrop.setAttribute('aria-hidden', 'true');
    }
}

if (qrBtn) qrBtn.addEventListener('click', function () { openPanel('share'); });
if (sidebarShareBtn) sidebarShareBtn.addEventListener('click', function () { openPanel('share'); });
if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', function () { openPanel('settings'); });
if (panelClose) panelClose.addEventListener('click', closePanel);
if (panelBackdrop) panelBackdrop.addEventListener('click', closePanel);

if (copyUrlBtn && roomUrlP) {
    copyUrlBtn.addEventListener('click', function () {
        var url = roomUrlP.textContent || (window.location.origin + window.location.pathname + '?room=' + myRoomId);
        navigator.clipboard.writeText(url).then(function () {
            copyUrlBtn.textContent = 'コピーしました';
            setTimeout(function () { copyUrlBtn.textContent = 'URLをコピー'; }, 2000);
        });
    });
}

// ---------- Private Session ----------
var mainRoomContent = document.getElementById('mainRoomContent');
var privateRoomContent = document.getElementById('privateRoomContent');
var privateVideosContainer = document.getElementById('privateVideosContainer');
var endPrivateSessionBtn = document.getElementById('endPrivateSessionBtn');
var privateMicBtn = document.getElementById('privateMicBtn');
var privateCameraBtn = document.getElementById('privateCameraBtn');
var privateChatMessages = document.getElementById('privateChatMessages');
var privateChatInput = document.getElementById('privateChatInput');
var privateChatSendBtn = document.getElementById('privateChatSendBtn');
var privatePhotoInput = document.getElementById('privatePhotoInput');

function closePrivateRoom() {
    currentPrivateSessionId = null;
    if (privatePeers) {
        Object.keys(privatePeers).forEach(function (sid) {
            if (privatePeers[sid] && privatePeers[sid].connection) privatePeers[sid].connection.close();
        });
        privatePeers = {};
    }
    if (privateLocalStream) {
        privateLocalStream.getTracks().forEach(function (t) { t.stop(); });
        privateLocalStream = null;
    }
    if (privateVideosContainer) privateVideosContainer.innerHTML = '';
    if (privateChatMessages) privateChatMessages.innerHTML = '';
    if (mainRoomContent) mainRoomContent.hidden = false;
    if (privateRoomContent) privateRoomContent.hidden = true;
}

socket.on('private_participants', function (data) {
    if (!currentPrivateSessionId || !data.participants || !privateVideosContainer) return;
    var others = data.participants.filter(function (p) { return p.sid !== socket.id; });
    if (privateLocalStream) {
        addPrivateVideoElement('local', privateLocalStream, ROLE === 'admin' ? '管理者' : USER_NAME);
    }
    others.forEach(function (p) {
        var isInitiator = socket.id < p.sid;
        privateCreatePeerConnection(p.sid, p.user_name, isInitiator);
    });
});

function addPrivateVideoElement(peerId, stream, labelText) {
    if (!privateVideosContainer || document.getElementById('private-video-' + peerId)) return;
    var wrap = document.createElement('div');
    wrap.className = 'private-video-wrapper video-wrapper';
    wrap.id = 'private-video-' + peerId;
    var label = document.createElement('h3');
    label.textContent = labelText || '';
    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = (peerId === 'local');
    video.srcObject = stream;
    wrap.appendChild(label);
    wrap.appendChild(video);
    privateVideosContainer.appendChild(wrap);
}

function privateCreatePeerConnection(targetId, userName, isInitiator) {
    if (privatePeers[targetId]) return privatePeers[targetId].connection;
    var pc = new RTCPeerConnection(rtcConfig);
    if (privateLocalStream) privateLocalStream.getTracks().forEach(function (t) { pc.addTrack(t, privateLocalStream); });
    pc.ontrack = function (event) {
        var remoteStream = event.streams[0];
        if (!document.getElementById('private-video-' + targetId)) addPrivateVideoElement(targetId, remoteStream, userName);
    };
    pc.onicecandidate = function (event) {
        if (event.candidate) socket.emit('ice_candidate', { target: targetId, candidate: event.candidate, sender: socket.id });
    };
    privatePeers[targetId] = { connection: pc };
    if (isInitiator) privateMakeOffer(pc, targetId);
    return pc;
}

function privateMakeOffer(pc, targetId) {
    pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
    }).then(function () {
        socket.emit('offer', { target: targetId, description: pc.localDescription, sender: socket.id });
    }).catch(function (err) { console.error('Private offer error', err); });
}

socket.on('redirect_to_main_room', function (data) {
    var mainRoom = data.main_room;
    closePrivateRoom();
    mainRoomIdForReturn = null;
    if (mainRoom) {
        myRoomId = mainRoom;
        socket.emit('join_room', { room: mainRoom, user_name: USER_NAME, role: ROLE });
        if (statusDiv) statusDiv.innerText = '接続済み: ' + mainRoom;
        updateRoomIdDisplay();
    }
});

if (endPrivateSessionBtn) {
    endPrivateSessionBtn.addEventListener('click', function () {
        if (currentPrivateSessionId) socket.emit('end_private_session', {});
    });
}

socket.on('redirect_to_private', function (data) {
    var sessionId = data.session_id;
    mainRoomIdForReturn = data.main_room;
    if (!sessionId || !mainRoomIdForReturn) return;
    currentPrivateSessionId = sessionId;
    if (mainRoomContent) mainRoomContent.hidden = true;
    if (privateRoomContent) privateRoomContent.hidden = false;
    socket.emit('join_private_room', { session_id: sessionId, user_name: USER_NAME, role: ROLE });
    var support = checkMediaDevicesSupport();
    if (!support.supported) {
        showMediaErrorAlert(support.message, new Error('navigator.mediaDevices is undefined'));
        if (privateRoomContent) privateRoomContent.hidden = true;
        if (mainRoomContent) mainRoomContent.hidden = false;
        return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: true }).then(function (stream) {
        privateLocalStream = stream;
        if (privateVideosContainer) addPrivateVideoElement('local', stream, ROLE === 'admin' ? '管理者' : USER_NAME);
        if (privateMicBtn) privateMicBtn.classList.add('on');
        if (privateCameraBtn) privateCameraBtn.classList.add('on');
    }).catch(function (err) {
        logMediaError('Private room getUserMedia', err);
        showMediaErrorAlert('個別ルームのカメラ・マイクにアクセスできません。' + (err.message ? '\n' + err.message : ''), err);
        if (privateRoomContent) privateRoomContent.hidden = true;
        if (mainRoomContent) mainRoomContent.hidden = false;
    });
});

if (privateMicBtn) privateMicBtn.addEventListener('click', function () {
    if (!privateLocalStream) return;
    var audioTrack = privateLocalStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        privateMicBtn.classList.toggle('on', audioTrack.enabled);
        privateMicBtn.classList.toggle('muted', !audioTrack.enabled);
    }
});
if (privateCameraBtn) privateCameraBtn.addEventListener('click', function () {
    if (!privateLocalStream) return;
    var videoTrack = privateLocalStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        privateCameraBtn.classList.toggle('on', videoTrack.enabled);
        privateCameraBtn.classList.toggle('muted', !videoTrack.enabled);
    }
});

function appendChatMessage(userName, text, isImage, dataUrl) {
    if (!privateChatMessages) return;
    var div = document.createElement('div');
    div.className = 'private-chat-msg';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'private-chat-name';
    nameSpan.textContent = userName + ': ';
    div.appendChild(nameSpan);
    if (isImage && dataUrl) {
        var img = document.createElement('img');
        img.src = dataUrl;
        img.className = 'private-chat-img';
        img.alt = 'image';
        div.appendChild(img);
    } else {
        div.appendChild(document.createTextNode(text));
    }
    privateChatMessages.appendChild(div);
    privateChatMessages.scrollTop = privateChatMessages.scrollHeight;
}

socket.on('private_chat', function (data) {
    appendChatMessage(data.user_name || '', data.text || '', false);
});
socket.on('private_chat_image', function (data) {
    appendChatMessage(data.user_name || '', '', true, data.data_url);
});

if (privateChatSendBtn && privateChatInput) {
    privateChatSendBtn.addEventListener('click', function () {
        var text = (privateChatInput.value || '').trim();
        if (!text || !currentPrivateSessionId) return;
        socket.emit('private_chat', { text: text });
        appendChatMessage(USER_NAME || '自分', text, false);
        privateChatInput.value = '';
    });
    privateChatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); privateChatSendBtn.click(); }
    });
}

function resizeImageToDataUrl(file, maxSize, quality, callback) {
    var img = document.createElement('img');
    var url = URL.createObjectURL(file);
    img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (w <= maxSize && h <= maxSize) {
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0);
            callback(c.toDataURL('image/jpeg', quality));
            return;
        }
        var scale = maxSize / Math.max(w, h);
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = nw; canvas.height = nh;
        canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
        callback(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = function () { URL.revokeObjectURL(url); callback(null); };
    img.src = url;
}

if (privatePhotoInput) {
    privatePhotoInput.addEventListener('change', function () {
        var file = this.files[0];
        if (!file || !file.type.startsWith('image/') || !currentPrivateSessionId) return;
        this.value = '';
        resizeImageToDataUrl(file, 800, 0.8, function (dataUrl) {
            if (dataUrl) {
                socket.emit('private_chat_image', { data_url: dataUrl });
                appendChatMessage(USER_NAME || '自分', '', true, dataUrl);
            }
        });
    });
}
