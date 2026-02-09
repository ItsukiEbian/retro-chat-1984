const socket = io();
const videosContainer = document.getElementById('videosContainer');
const statusDiv = document.getElementById('status');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

const ROLE = window.ROLE || 'student';
const USER_NAME = window.USER_NAME || '';
let myRoomId = window.ROOM_ID || '';
const USER_DB_ID = window.USER_DB_ID || null;
const TOTAL_STUDY_TIME_MINUTES = typeof window.TOTAL_STUDY_TIME_MINUTES !== 'undefined' ? window.TOTAL_STUDY_TIME_MINUTES : 0;

// 再接続・席キープ用。localStorage で永続化
function getOrCreateUserId() {
    var key = 'videodesk_user_id';
    try {
        var id = localStorage.getItem(key);
        if (id && id.length >= 32) return id;
        var u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem(key, u);
        return u;
    } catch (e) { return ''; }
}
const USER_ID = getOrCreateUserId();

let amHost = false;           // 自分がホストか
let orderedSlots = [];        // 最大4。各要素は null | { sid, user_name, role, connected, is_host }

const FILTER_FPS = 30;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let localStream;
let rawStream;
let peers = {};            // sid -> { connection, pendingCandidates: [] }
let handRaiseState = {};  // sid -> { user_name, raised }
let roomParticipants = {};  // sid -> { user_name, role } (for admin student list)
let myHandRaised = false;
let currentPrivateSessionId = null;
let privatePeers = {};
let privateLocalStream = null;
let mainRoomIdForReturn = null;
var original_room_id = null;

// #region agent log
var DEBUG_LOG_ENDPOINT = 'http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60';
function debugLog(location, message, data, hypothesisId) {
    var payload = { location: location, message: message, data: data || {}, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: hypothesisId || null };
    fetch(DEBUG_LOG_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(function () {});
}
// #endregion

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
    if (sid) sid.textContent = myRoomId || '—';
}

function updateHostBadge() {
    const el = document.getElementById('hostBadge');
    if (el) el.style.display = amHost ? 'inline-block' : 'none';
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
        var overlayWarning = document.getElementById('overlayCameraWarning');
        if (overlayWarning) { overlayWarning.hidden = true; overlayWarning.textContent = ''; }
        statusDiv.innerText = "接続中...";

        roomParticipants[socket.id] = { user_name: USER_NAME, role: ROLE, total_study_time_minutes: TOTAL_STUDY_TIME_MINUTES };
        socket.emit('join_room', {
            room: myRoomId || undefined,
            user_name: USER_NAME,
            role: ROLE,
            user_id: USER_ID || undefined,
            user_db_id: USER_DB_ID || undefined
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

function formatStudyTime(minutes) {
    if (minutes == null || minutes === undefined) return '';
    var m = parseInt(minutes, 10) || 0;
    var h = Math.floor(m / 60);
    var min = m % 60;
    if (h > 0 && min > 0) return h + '時間 ' + min + '分';
    if (h > 0) return h + '時間';
    return min + '分';
}

function createLocalWrapper(stream, labelText) {
    var wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper video-has-mosaic';
    wrapper.id = 'video-wrapper-local';
    wrapper.setAttribute('data-peer-id', 'local');
    var label = document.createElement('h3');
    label.innerText = labelText || '';
    var studyTimeEl = document.createElement('div');
    studyTimeEl.className = 'video-wrapper-study-time';
    studyTimeEl.textContent = '総勉強時間: ' + formatStudyTime(TOTAL_STUDY_TIME_MINUTES);
    var video = document.createElement('video');
    video.className = 'video-mosaic';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    video.play().catch(function () {});
    wrapper.appendChild(label);
    wrapper.appendChild(studyTimeEl);
    wrapper.appendChild(video);
    if (handRaiseState[socket.id]) updateHandIndicator(wrapper, handRaiseState[socket.id].raised);
    return wrapper;
}

function setVideoStreamAndHideSpinner(video, stream, wrapper) {
    if (!video || !stream) return;
    video.srcObject = stream;
    video.muted = (video.getAttribute('data-local') === 'true');
    video.play().catch(function () {});
    function onReady() {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('playing', onReady);
        if (wrapper) {
            var s = wrapper.querySelector('.video-loading-spinner');
            if (s) s.classList.add('is-hidden');
        }
    }
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('playing', onReady);
    if (video.readyState >= 2) onReady();
}

function addVideoElement(peerId, stream, labelText) {
    if (document.getElementById('video-wrapper-' + peerId)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper video-has-mosaic';
    wrapper.id = 'video-wrapper-' + peerId;
    wrapper.setAttribute('data-peer-id', peerId);

    const label = document.createElement('h3');
    label.innerText = labelText || '';
    const studyTimeEl = document.createElement('div');
    studyTimeEl.className = 'video-wrapper-study-time';
    const studyMin = (peerId === 'local' ? TOTAL_STUDY_TIME_MINUTES : (roomParticipants[peerId] && roomParticipants[peerId].total_study_time_minutes));
    studyTimeEl.textContent = studyMin != null ? ('総勉強時間: ' + formatStudyTime(studyMin)) : '';

    const video = document.createElement('video');
    video.className = 'video-mosaic';
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;
    video.setAttribute('data-local', peerId === 'local' ? 'true' : 'false');
    video.play().then(function () {}).catch(function (err) {
        video.muted = true;
        video.play().catch(function () {});
        showToast('画面をクリックすると映像が表示されます');
    });

    wrapper.appendChild(label);
    wrapper.appendChild(studyTimeEl);
    if (peerId !== 'local') wrapper.appendChild(createSpinnerEl());
    wrapper.appendChild(video);
    videosContainer.appendChild(wrapper);

    if (peerId !== 'local') {
        function hideSpinner() {
            video.removeEventListener('loadeddata', hideSpinner);
            video.removeEventListener('playing', hideSpinner);
            var s = wrapper.querySelector('.video-loading-spinner');
            if (s) s.classList.add('is-hidden');
        }
        video.addEventListener('loadeddata', hideSpinner);
        video.addEventListener('playing', hideSpinner);
        if (video.readyState >= 2) hideSpinner();
    }

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

function createEmptySlot() {
    var el = document.createElement('div');
    el.className = 'video-slot-empty';
    el.setAttribute('aria-label', '空き席');
    el.textContent = '空き席';
    return el;
}

function createSpinnerEl() {
    var spinner = document.createElement('div');
    spinner.className = 'video-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    return spinner;
}

function createRemotePlaceholder(slotInfo) {
    var el = document.createElement('div');
    el.className = 'video-wrapper video-slot-placeholder video-has-mosaic';
    el.id = 'video-wrapper-' + slotInfo.sid;
    el.setAttribute('data-peer-id', slotInfo.sid);
    el.setAttribute('data-sid', slotInfo.sid);
    var label = document.createElement('h3');
    label.textContent = slotInfo.connected ? (slotInfo.user_name || '接続中') : '接続切れ';
    var studyTimeEl = document.createElement('div');
    studyTimeEl.className = 'video-wrapper-study-time';
    studyTimeEl.textContent = (slotInfo.total_study_time_minutes != null) ? ('総勉強時間: ' + formatStudyTime(slotInfo.total_study_time_minutes)) : '';
    var connLabel = document.createElement('div');
    connLabel.className = 'video-connecting-label';
    connLabel.textContent = '接続中...';
    var video = document.createElement('video');
    video.className = 'video-mosaic';
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.setAttribute('data-local', 'false');
    el.appendChild(label);
    el.appendChild(studyTimeEl);
    el.appendChild(connLabel);
    el.appendChild(createSpinnerEl());
    el.appendChild(video);
    return el;
}

function renderVideoGrid() {
    if (!videosContainer || orderedSlots.length < 4) return;
    var localEl = document.getElementById('video-wrapper-local');
    var remoteEls = {};
    orderedSlots.forEach(function (s) {
        if (s && s.sid && s.sid !== socket.id) remoteEls[s.sid] = document.getElementById('video-wrapper-' + s.sid);
    });
    videosContainer.innerHTML = '';
    for (var i = 0; i < 4; i++) {
        if (!orderedSlots[i]) {
            videosContainer.appendChild(createEmptySlot());
        } else if (orderedSlots[i].sid === socket.id) {
            if (localEl) {
                videosContainer.appendChild(localEl);
            } else if (localStream) {
                var label = ROLE === 'admin' ? '管理者' : USER_NAME || 'あなた';
                var wrap = createLocalWrapper(localStream, label);
                videosContainer.appendChild(wrap);
            } else {
                videosContainer.appendChild(createEmptySlot());
            }
        } else {
            var sid = orderedSlots[i].sid;
            if (remoteEls[sid]) {
                videosContainer.appendChild(remoteEls[sid]);
            } else {
                videosContainer.appendChild(createRemotePlaceholder(orderedSlots[i]));
                (function (remoteSid) {
                    setTimeout(function () {
                        // #region agent log
                        if (!peers[remoteSid]) debugLog('room.js:renderVideoGrid', 'create_pc_delayed', { mySid: socket.id, targetId: remoteSid, isInitiator: socket.id < remoteSid }, 'H2');
                        // #endregion
                        if (!peers[remoteSid]) createPeerConnection(remoteSid, socket.id < remoteSid);
                    }, 80);
                })(sid);
            }
        }
    }
    applyHandStates();
    updateLayout();
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

socket.on('room_assigned', (data) => {
    if (currentPrivateSessionId) return;
    myRoomId = data.room_id || myRoomId;
    amHost = !!data.is_host;
    var raw = data.participants || [];
    orderedSlots = raw.slice(0, 4);
    while (orderedSlots.length < 4) orderedSlots.push(null);
    roomParticipants = {};
    orderedSlots.forEach(function (s) {
        if (s && s.sid) roomParticipants[s.sid] = { user_name: s.user_name || '', role: s.role || 'student', total_study_time_minutes: s.total_study_time_minutes };
    });
    // #region agent log
    var participantSids = raw.filter(function (s) { return s && s.sid; }).map(function (s) { return s.sid; });
    var remotes = participantSids.filter(function (sid) { return sid !== socket.id; });
    debugLog('room.js:room_assigned', 'room_assigned', { mySid: socket.id, participantSids: participantSids, remotes: remotes, willCreatePc200ms: remotes.map(function (sid) { return { targetSid: sid, isInitiator: socket.id < sid }; }) }, 'H2');
    // #endregion
    updateRoomIdDisplay();
    updateHostBadge();
    if (statusDiv) statusDiv.innerText = "";
    renderVideoGrid();
});

socket.on('room_state', (data) => {
    if (currentPrivateSessionId) return;
    var raw = data.participants || [];
    orderedSlots = raw.slice(0, 4);
    while (orderedSlots.length < 4) orderedSlots.push(null);
    roomParticipants = {};
    orderedSlots.forEach(function (s) {
        if (s && s.sid) roomParticipants[s.sid] = { user_name: s.user_name || '', role: s.role || 'student', total_study_time_minutes: s.total_study_time_minutes };
    });
    renderVideoGrid();
});

socket.on('host_changed', (data) => {
    const name = data.new_host_name || '参加者';
    showToast(name + 'さんが新しいホストになりました');
    amHost = (data.new_host_sid === socket.id);
    updateHostBadge();
});

socket.on('user_joined', (data) => {
    const targetId = data.sid;
    if (targetId === socket.id) return;
    // #region agent log
    debugLog('room.js:user_joined', 'user_joined', { mySid: socket.id, joinedSid: targetId, isInitiator: socket.id < targetId, willCreatePc80ms: true }, 'H2');
    // #endregion
    const userName = data.user_name || ('参加者 ' + targetId.substr(0, 6));
    const role = data.role || 'student';
    const totalMin = data.total_study_time_minutes != null ? data.total_study_time_minutes : 0;
    roomParticipants[targetId] = { user_name: userName, role: role, total_study_time_minutes: totalMin };
    if (handRaiseState[targetId] === undefined) handRaiseState[targetId] = { user_name: userName, raised: false };
    else handRaiseState[targetId].user_name = userName;
    var slotInfo = { sid: targetId, user_name: userName, role: role, connected: true, is_host: false, total_study_time_minutes: totalMin };
    for (var i = 0; i < 4; i++) {
        if (!orderedSlots[i]) { orderedSlots[i] = slotInfo; break; }
    }
    var tid = targetId;
    setTimeout(function () {
        // #region agent log
        if (!peers[tid]) debugLog('room.js:user_joined', 'create_pc_80ms_fired', { mySid: socket.id, targetId: tid, isInitiator: socket.id < tid }, 'H2');
        // #endregion
        if (!peers[tid]) createPeerConnection(tid, socket.id < tid);
    }, 80);
    renderVideoGrid();
    if (ROLE === 'admin') renderStudentList();
});

socket.on('request_offer_to', function (data) {
    var newSid = data.new_sid;
    if (!newSid || newSid === socket.id) return;
    roomParticipants[newSid] = roomParticipants[newSid] || { user_name: '接続中', role: 'student' };
    createPeerConnection(newSid, socket.id < newSid);
});

socket.on('user_left', (data) => {
    const targetId = data.sid;
    const leftName = data.user_name || '参加者';
    if (leftName) showToast(leftName + 'さんが退出しました');
    delete roomParticipants[targetId];
    if (peers[targetId]) {
        peers[targetId].connection.close();
        delete peers[targetId];
    }
    delete handRaiseState[targetId];
    for (var i = 0; i < orderedSlots.length; i++) {
        if (orderedSlots[i] && orderedSlots[i].sid === targetId) { orderedSlots[i] = null; break; }
    }
    removeVideoElement(targetId);
    renderVideoGrid();
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
        if (s.role) {
            var existing = roomParticipants[s.sid] || {};
            roomParticipants[s.sid] = { user_name: s.user_name, role: s.role, total_study_time_minutes: existing.total_study_time_minutes };
        }
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

async function flushPendingIceCandidates(peer) {
    if (!peer || !peer.pendingCandidates || !peer.connection) return;
    for (var i = 0; i < peer.pendingCandidates.length; i++) {
        try {
            await peer.connection.addIceCandidate(new RTCIceCandidate(peer.pendingCandidates[i]));
        } catch (e) {
            console.error("ICE flush", e);
        }
    }
    peer.pendingCandidates = [];
}

socket.on('offer', async (data) => {
    const targetId = data.sender;
    // #region agent log
    debugLog('room.js:offer', 'offer_received', { mySid: socket.id, sender: targetId, hadPeersBefore: !!peers[targetId] }, 'H1');
    // #endregion
    if (currentPrivateSessionId) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:offer_private',message:'handling_offer_in_private',data:{sender:targetId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(function(){});
        // #endregion
        var pc = privateCreatePeerConnection(targetId, '', false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        await flushPendingIceCandidates(privatePeers[targetId]);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { target: targetId, description: pc.localDescription, sender: socket.id });
    } else {
        const pc = createPeerConnection(targetId, false);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        } catch (err) {
            // #region agent log
            debugLog('room.js:offer', 'setRemoteDescription_failed', { mySid: socket.id, sender: targetId, error: String(err && err.message), signalingState: pc.signalingState }, 'H1');
            // #endregion
            throw err;
        }
        await flushPendingIceCandidates(peers[targetId]);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { target: targetId, description: pc.localDescription, sender: socket.id });
        // #region agent log
        debugLog('room.js:offer', 'answer_sent_after_offer', { mySid: socket.id, targetId: targetId }, 'H3');
        // #endregion
    }
});

socket.on('answer', async (data) => {
    const targetId = data.sender;
    var peer = currentPrivateSessionId ? privatePeers[targetId] : peers[targetId];
    var pc = peer && peer.connection;
    // #region agent log
    debugLog('room.js:answer', 'answer_received', { mySid: socket.id, sender: targetId, hasPc: !!pc, signalingState: pc ? pc.signalingState : null }, 'H1');
    // #endregion
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        await flushPendingIceCandidates(peer);
        // #region agent log
        debugLog('room.js:answer', 'answer_applied', { mySid: socket.id, targetId: targetId }, 'H3');
        // #endregion
    }
});

function addIceCandidateSafe(pc, candidate, pendingCandidates) {
    if (!pc || !candidate) return Promise.resolve();
    if (pc.remoteDescription && pc.remoteDescription.type) {
        return pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function (e) {
            console.error("ICE addIceCandidate", e);
        });
    }
    if (pendingCandidates) pendingCandidates.push(candidate);
    return Promise.resolve();
}

socket.on('ice_candidate', async (data) => {
    const targetId = data.sender;
    const candidate = data.candidate;
    if (!candidate) return;
    if (currentPrivateSessionId) {
        var pr = privatePeers[targetId];
        var pc = pr && pr.connection;
        if (pr && !pr.pendingCandidates) pr.pendingCandidates = [];
        addIceCandidateSafe(pc, candidate, pr && pr.pendingCandidates);
    } else {
        var peer = peers[targetId];
        var pc = peer && peer.connection;
        if (peer && !peer.pendingCandidates) peer.pendingCandidates = [];
        addIceCandidateSafe(pc, candidate, peer && peer.pendingCandidates);
    }
});

var WEBRTC_DEBUG = true;
function webrtcLog(prefix, targetId, msg, extra) {
    if (!WEBRTC_DEBUG) return;
    var s = '[WebRTC] ' + prefix + ' →' + (targetId ? targetId.substr(0, 8) : '') + ': ' + msg;
    if (extra) s += ' ' + JSON.stringify(extra);
    console.log(s);
}

function createPeerConnection(targetId, isInitiator) {
    // #region agent log
    if (peers[targetId]) {
        debugLog('room.js:createPeerConnection', 'returned_existing', { mySid: socket.id, targetId: targetId, isInitiator: isInitiator }, 'H1');
        return peers[targetId].connection;
    }
    debugLog('room.js:createPeerConnection', 'created_new', { mySid: socket.id, targetId: targetId, isInitiator: isInitiator }, 'H1');
    // #endregion
    const pc = new RTCPeerConnection(rtcConfig);
    webrtcLog('PC', targetId, 'created', { isInitiator: isInitiator });

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onsignalingstatechange = function () {
        webrtcLog('PC', targetId, 'signalingState', { state: pc.signalingState });
    };
    pc.oniceconnectionstatechange = function () {
        webrtcLog('PC', targetId, 'iceConnectionState', { state: pc.iceConnectionState });
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (peers[targetId] && peers[targetId].connection === pc && !(peers[targetId].iceRestarting)) {
                var peer = peers[targetId];
                peer.iceRestarting = true;
                webrtcLog('PC', targetId, 'ICE restart (createOffer iceRestart:true)');
                pc.createOffer({ iceRestart: true }).then(function (offer) {
                    return pc.setLocalDescription(offer);
                }).then(function () {
                    socket.emit('offer', { target: targetId, description: pc.localDescription, sender: socket.id });
                    setTimeout(function () { if (peer) peer.iceRestarting = false; }, 3000);
                }).catch(function (err) {
                    console.warn('[WebRTC] ICE restart error', err);
                    if (peer) peer.iceRestarting = false;
                });
            }
        }
    };

    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!remoteStream) {
            console.warn('[WebRTC] ontrack: no stream', targetId);
            return;
        }
        webrtcLog('ontrack', targetId, 'stream received', { id: remoteStream.id, tracks: remoteStream.getTracks().length });
        const wrap = document.getElementById('video-wrapper-' + targetId);
        if (wrap && wrap.classList.contains('video-slot-placeholder')) {
            wrap.classList.remove('video-slot-placeholder');
            var connLabel = wrap.querySelector('.video-connecting-label');
            if (connLabel) connLabel.remove();
            const video = wrap.querySelector('video');
            if (video) {
                video.setAttribute('autoplay', '');
                video.setAttribute('playsinline', '');
                video.muted = true;
                video.srcObject = remoteStream;
                video.play().then(function () {
                    webrtcLog('ontrack', targetId, 'video.play() ok');
                }).catch(function (err) {
                    console.warn('[WebRTC] video.play() blocked', err);
                    video.muted = true;
                    video.play().catch(function () {});
                    showToast('画面をクリックすると映像が表示されます');
                });
                var s = wrap.querySelector('.video-loading-spinner');
                if (s) s.classList.add('is-hidden');
                function onReady() {
                    video.removeEventListener('loadeddata', onReady);
                    video.removeEventListener('playing', onReady);
                    var sp = wrap.querySelector('.video-loading-spinner');
                    if (sp) sp.classList.add('is-hidden');
                }
                video.addEventListener('loadeddata', onReady);
                video.addEventListener('playing', onReady);
                if (video.readyState >= 2) onReady();
            }
            var label = wrap.querySelector('h3');
            if (label) label.textContent = (handRaiseState[targetId] && handRaiseState[targetId].user_name) || (roomParticipants[targetId] && roomParticipants[targetId].user_name) || ('参加者 ' + targetId.substr(0, 6));
            var studyTimeEl = wrap.querySelector('.video-wrapper-study-time');
            if (studyTimeEl && roomParticipants[targetId] && roomParticipants[targetId].total_study_time_minutes != null) {
                studyTimeEl.textContent = '総勉強時間: ' + formatStudyTime(roomParticipants[targetId].total_study_time_minutes);
            }
            if (handRaiseState[targetId]) updateHandIndicator(wrap, handRaiseState[targetId].raised);
        } else if (!wrap) {
            const userName = (handRaiseState[targetId] && handRaiseState[targetId].user_name) || (roomParticipants[targetId] && roomParticipants[targetId].user_name) || ('参加者 ' + targetId.substr(0, 6));
            addVideoElement(targetId, remoteStream, userName);
            var wrapAfter = document.getElementById('video-wrapper-' + targetId);
            if (wrapAfter) {
                var st = wrapAfter.querySelector('.video-wrapper-study-time');
                if (st && roomParticipants[targetId] && roomParticipants[targetId].total_study_time_minutes != null) {
                    st.textContent = '総勉強時間: ' + formatStudyTime(roomParticipants[targetId].total_study_time_minutes);
                }
            }
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice_candidate', { target: targetId, candidate: event.candidate, sender: socket.id });
        }
    };

    peers[targetId] = { connection: pc, pendingCandidates: [] };

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
        // #region agent log
        debugLog('room.js:makeOffer', 'offer_sent', { mySid: socket.id, targetId: targetId }, 'H1');
        // #endregion
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

var qrPopup = document.getElementById('qrPopup');
var qrPopupBackdrop = document.getElementById('qrPopupBackdrop');
var qrPopupClose = document.getElementById('qrPopupClose');
var sidebarShareBtn = document.getElementById('sidebarShareBtn');
var sidebarSettingsBtn = document.getElementById('sidebarSettingsBtn');
var qrcodePopupDiv = document.getElementById('qrcodePopup');
var roomUrlPopupP = document.getElementById('roomUrlPopup');
var copyUrlBtnPopup = document.getElementById('copyUrlBtnPopup');

function openQrPopup() {
    var base = window.location.origin + (window.location.pathname.replace(/\/room\/?$/, '').replace(/\?.*$/, '') || '/');
    if (!base.endsWith('/')) base += '/';
    var currentUrl = base + '?room_id=' + encodeURIComponent(myRoomId || '');
    if (roomUrlPopupP) roomUrlPopupP.textContent = currentUrl;
    if (qrcodePopupDiv) {
        qrcodePopupDiv.innerHTML = '';
        new QRCode(qrcodePopupDiv, { text: currentUrl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.H });
    }
    if (qrPopup) { qrPopup.classList.add('is-open'); qrPopup.setAttribute('aria-hidden', 'false'); }
    if (qrPopupBackdrop) { qrPopupBackdrop.classList.add('is-open'); qrPopupBackdrop.setAttribute('aria-hidden', 'false'); }
}

function closeQrPopup() {
    if (qrPopup) { qrPopup.classList.remove('is-open'); qrPopup.setAttribute('aria-hidden', 'true'); }
    if (qrPopupBackdrop) { qrPopupBackdrop.classList.remove('is-open'); qrPopupBackdrop.setAttribute('aria-hidden', 'true'); }
}

if (sidebarShareBtn) sidebarShareBtn.addEventListener('click', openQrPopup);
if (qrPopupClose) qrPopupClose.addEventListener('click', closeQrPopup);
if (qrPopupBackdrop) qrPopupBackdrop.addEventListener('click', closeQrPopup);

if (copyUrlBtnPopup && roomUrlPopupP) {
    copyUrlBtnPopup.addEventListener('click', function () {
        var url = roomUrlPopupP.textContent || (window.location.origin + '/' + (window.location.pathname.replace(/\/room\/?$/, '') || '') + '?room_id=' + (myRoomId || ''));
        navigator.clipboard.writeText(url).then(function () {
            copyUrlBtnPopup.textContent = 'コピーしました';
            setTimeout(function () { copyUrlBtnPopup.textContent = 'URLをコピー'; }, 2000);
        });
    });
}

// ---------- Private Session ----------
var mainRoomContent = document.getElementById('mainRoomContent');
var privateRoomContent = document.getElementById('privateRoomContent');
var privateVideosContainer = document.getElementById('privateVideosContainer');
var privatePendingOthers = [];
var endPrivateSessionBtn = document.getElementById('endPrivateSessionBtn');
var privateMicBtn = document.getElementById('privateMicBtn');
var privateCameraBtn = document.getElementById('privateCameraBtn');
var privateChatMessages = document.getElementById('privateChatMessages');
var privateChatInput = document.getElementById('privateChatInput');
var privateChatSendBtn = document.getElementById('privateChatSendBtn');
var privatePhotoInput = document.getElementById('privatePhotoInput');
var privateAudioUnlockBanner = document.getElementById('privateAudioUnlockBanner');
var privateAudioUnlockBtn = document.getElementById('privateAudioUnlockBtn');

function setRoomContext(context) {
    if (document.body) document.body.setAttribute('data-room-context', context === 'private' ? 'private' : 'main');
}

function closePrivateRoom() {
    currentPrivateSessionId = null;
    privatePendingOthers = [];
    setRoomContext('main');
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
    if (privateMicBtn) {
        privateMicBtn.classList.remove('on');
        privateMicBtn.classList.add('muted');
    }
    if (privateCameraBtn) {
        privateCameraBtn.classList.remove('on');
        privateCameraBtn.classList.add('muted');
    }
    if (privateAudioUnlockBanner) privateAudioUnlockBanner.hidden = true;
    if (privateVideosContainer) privateVideosContainer.innerHTML = '';
    if (privateChatMessages) privateChatMessages.innerHTML = '';
    if (mainRoomContent) mainRoomContent.hidden = false;
    if (privateRoomContent) privateRoomContent.hidden = true;
}

socket.on('private_participants', function (data) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:private_participants',message:'private_participants',data:{mySid:socket.id,participantsCount:data.participants?data.participants.length:0,hasContainer:!!privateVideosContainer,hasPrivateSession:!!currentPrivateSessionId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(function(){});
    // #endregion
    if (!currentPrivateSessionId || !data.participants || !privateVideosContainer) return;
    var others = data.participants.filter(function (p) { return p.sid !== socket.id; });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:private_participants',message:'others_and_local',data:{othersCount:others.length,otherSids:others.map(function(p){return p.sid;}),hasPrivateLocalStream:!!privateLocalStream},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3,H5'})}).catch(function(){});
    // #endregion
    if (!privateLocalStream) {
        privatePendingOthers = others.slice();
        return;
    }
    others.forEach(function (p) {
        var isInitiator = socket.id < p.sid;
        privateCreatePeerConnection(p.sid, p.user_name, isInitiator);
    });
});

function addPrivateVideoElement(peerId, stream, labelText) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:addPrivateVideoElement',message:'add_called',data:{peerId:peerId,hasContainer:!!privateVideosContainer,alreadyExists:!!document.getElementById('private-video-'+peerId)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(function(){});
    // #endregion
    if (!privateVideosContainer || document.getElementById('private-video-' + peerId)) return;
    var placeholder = document.getElementById('private-video-remote-placeholder');
    if (peerId !== 'local') {
        if (placeholder) placeholder.remove();
    } else if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.id = 'private-video-remote-placeholder';
        placeholder.className = 'private-video-remote private-video-placeholder';
        placeholder.setAttribute('aria-label', '相手の映像');
        placeholder.textContent = '相手の映像（接続待ち）';
        privateVideosContainer.appendChild(placeholder);
    }
    var wrap = document.createElement('div');
    wrap.className = 'private-video-wrapper video-wrapper private-video-' + (peerId === 'local' ? 'local' : 'remote');
    wrap.id = 'private-video-' + peerId;
    var label = document.createElement('h3');
    label.textContent = labelText || '';
    var video = document.createElement('video');
    video.className = 'video-mosaic';
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('data-local', peerId === 'local' ? 'true' : 'false');
    video.muted = (peerId === 'local');
    if (peerId !== 'local') {
        video.muted = false;
        video.volume = typeof privateRemoteVolume === 'number' ? privateRemoteVolume : 1;
    }
    video.srcObject = stream;
    video.play().catch(function () {});
    wrap.appendChild(label);
    wrap.appendChild(video);
    if (peerId !== 'local') {
        var meterWrap = document.createElement('div');
        meterWrap.className = 'private-voice-meter-wrap';
        meterWrap.setAttribute('aria-label', '相手の音量');
        var meterLabel = document.createElement('span');
        meterLabel.className = 'private-voice-meter-label';
        meterLabel.textContent = '相手の音量';
        var meterCanvas = document.createElement('canvas');
        meterCanvas.className = 'private-voice-meter';
        meterCanvas.width = 200;
        meterCanvas.height = 24;
        meterWrap.appendChild(meterLabel);
        meterWrap.appendChild(meterCanvas);
        wrap.appendChild(meterWrap);
    }
    privateVideosContainer.appendChild(wrap);
}

function startPrivateVoiceMeter(stream, canvasEl) {
    if (!canvasEl || !stream) return;
    var hasAudio = stream.getAudioTracks && stream.getAudioTracks().length > 0;
    var ctx = null;
    var source = null;
    var analyser = null;
    var dataArray = null;
    if (hasAudio) {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) { hasAudio = false; dataArray = new Uint8Array(32); }
        else {
            ctx = new AudioContext();
            source = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            dataArray = new Uint8Array(analyser.frequencyBinCount);
        }
    }
    if (!dataArray) dataArray = new Uint8Array(32);
    var w = canvasEl.width;
    var h = canvasEl.height;
    var ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    var stopped = false;
    function draw() {
        if (stopped || !canvasEl.parentNode) return;
        if (hasAudio && analyser) analyser.getByteFrequencyData(dataArray);
        ctx2d.fillStyle = 'rgba(248,249,250,0.95)';
        ctx2d.fillRect(0, 0, w, h);
        var barCount = Math.min(32, dataArray.length);
        var barW = (w / barCount) - 2;
        for (var i = 0; i < barCount; i++) {
            var v = hasAudio ? (dataArray[Math.floor((i / barCount) * dataArray.length)] || 0) : 0;
            var barH = Math.max(2, (v / 255) * h * 0.9);
            ctx2d.fillStyle = 'rgba(26,115,232,0.85)';
            ctx2d.fillRect(i * (w / barCount) + 1, h - barH, barW, barH);
        }
        requestAnimationFrame(draw);
    }
    draw();
    return function stop() { stopped = true; if (ctx) try { ctx.close(); } catch (e) {} };
}

function privateCreatePeerConnection(targetId, userName, isInitiator) {
    // #region agent log
    var hadExisting = !!privatePeers[targetId];
    var trackCount = privateLocalStream ? privateLocalStream.getTracks().length : 0;
    fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:privateCreatePeerConnection',message:'create_or_reuse',data:{targetId:targetId,isInitiator:isInitiator,hadExisting:hadExisting,hasPrivateLocalStream:!!privateLocalStream,trackCount:trackCount},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5,H3'})}).catch(function(){});
    // #endregion
    if (privatePeers[targetId]) return privatePeers[targetId].connection;
    var pc = new RTCPeerConnection(rtcConfig);
    if (privateLocalStream) privateLocalStream.getTracks().forEach(function (t) { pc.addTrack(t, privateLocalStream); });
    pc.ontrack = function (event) {
        var remoteStream = event.streams[0];
        // #region agent log
        (function(){
            var vt = remoteStream && remoteStream.getVideoTracks ? remoteStream.getVideoTracks().length : 0;
            var at = remoteStream && remoteStream.getAudioTracks ? remoteStream.getAudioTracks().length : 0;
            fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:private_ontrack',message:'ontrack',data:{targetId:targetId,hasStream:!!remoteStream,videoTracks:vt,audioTracks:at},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H5'})}).catch(function(){});
        })();
        // #endregion
        if (!remoteStream) return;
        var audioTracks = remoteStream.getAudioTracks ? remoteStream.getAudioTracks() : [];
        var videoTracks = remoteStream.getVideoTracks ? remoteStream.getVideoTracks() : [];
        if (WEBRTC_DEBUG) console.log('[WebRTC] private ontrack →' + targetId.substr(0, 8) + ': stream id=' + remoteStream.id + ' audioTracks=' + audioTracks.length + ' videoTracks=' + videoTracks.length);
        audioTracks.forEach(function (t) { t.enabled = true; });
        if (!document.getElementById('private-video-' + targetId)) {
            addPrivateVideoElement(targetId, remoteStream, userName);
            var el = document.getElementById('private-video-' + targetId);
            if (el) {
                var v = el.querySelector('video');
                if (v) {
                    v.setAttribute('autoplay', '');
                    v.setAttribute('playsinline', '');
                    v.muted = false;
                    v.volume = typeof privateRemoteVolume === 'number' ? privateRemoteVolume : 1;
                    v.srcObject = remoteStream;
                    v.play().then(function () {
                        if (WEBRTC_DEBUG) console.log('[WebRTC] private video.play() ok →' + targetId.substr(0, 8));
                    }).catch(function (err) {
                        console.warn('[WebRTC] private video.play() blocked', err);
                        var overlay = document.createElement('button');
                        overlay.type = 'button';
                        overlay.className = 'private-audio-click-overlay';
                        overlay.textContent = '音声を開始するには画面をクリックしてください';
                        overlay.addEventListener('click', function () {
                            v.muted = false;
                            v.volume = typeof privateRemoteVolume === 'number' ? privateRemoteVolume : 1;
                            v.play().catch(function () {});
                            overlay.remove();
                            privateUnmuteAllRemoteVideos();
                        });
                        el.appendChild(overlay);
                    });
                    setTimeout(function () { privateUnmuteAllRemoteVideos(); }, 100);
                }
                var meterCanvas = el.querySelector('.private-voice-meter');
                if (meterCanvas) startPrivateVoiceMeter(remoteStream, meterCanvas);
            }
        }
    };
    pc.oniceconnectionstatechange = function () {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (privatePeers[targetId] && privatePeers[targetId].connection === pc) {
                try {
                    pc.createOffer({ iceRestart: true }).then(function (offer) {
                        return pc.setLocalDescription(offer);
                    }).then(function () {
                        socket.emit('offer', { target: targetId, description: pc.localDescription, sender: socket.id });
                    }).catch(function (err) { console.warn('Private ICE restart error', err); });
                } catch (e) { console.warn('Private ICE restart', e); }
            }
        }
    };
    pc.onicecandidate = function (event) {
        if (event.candidate) socket.emit('ice_candidate', { target: targetId, candidate: event.candidate, sender: socket.id });
    };
    privatePeers[targetId] = { connection: pc, pendingCandidates: [] };
    if (isInitiator) privateMakeOffer(pc, targetId);
    return pc;
}

function privateMakeOffer(pc, targetId) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/57d916de-fd2e-49ae-86c2-8155e201bf60',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'room.js:privateMakeOffer',message:'sending_offer',data:{targetId:targetId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(function(){});
    // #endregion
    pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
    }).then(function () {
        socket.emit('offer', { target: targetId, description: pc.localDescription, sender: socket.id });
    }).catch(function (err) { console.error('Private offer error', err); });
}

socket.on('redirect_to_main_room', function (data) {
    closePrivateRoom();
    myHandRaised = false;
    if (handRaiseBtn) {
        handRaiseBtn.setAttribute('aria-pressed', 'false');
        handRaiseBtn.classList.remove('is-active');
    }
    handRaiseState[socket.id] = handRaiseState[socket.id] || { user_name: USER_NAME, raised: false };
    handRaiseState[socket.id].raised = false;
    socket.emit('hand_raise', { raised: false });
    applyHandStates();
    var roomToJoin = (data && data.main_room) || original_room_id || (function () { try { return sessionStorage.getItem('videodesk_original_room'); } catch (e) { return null; } })();
    original_room_id = null;
    mainRoomIdForReturn = null;
    try { sessionStorage.removeItem('videodesk_original_room'); } catch (e) {}
    if (roomToJoin) {
        myRoomId = roomToJoin;
        socket.emit('join_room', { room: roomToJoin, user_name: USER_NAME, role: ROLE, user_id: USER_ID || undefined });
        if (statusDiv) statusDiv.innerText = '';
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
    original_room_id = myRoomId || mainRoomIdForReturn;
    try { sessionStorage.setItem('videodesk_original_room', original_room_id); } catch (e) {}
    if (!sessionId || !mainRoomIdForReturn) return;
    currentPrivateSessionId = sessionId;
    setRoomContext('private');
    if (mainRoomContent) mainRoomContent.hidden = true;
    if (privateRoomContent) privateRoomContent.hidden = false;
    Object.keys(peers).forEach(function (sid) {
        if (peers[sid] && peers[sid].connection) peers[sid].connection.close();
        removeVideoElement(sid);
    });
    peers = {};
    socket.emit('join_private_room', { session_id: sessionId, user_name: USER_NAME, role: ROLE });
    var support = checkMediaDevicesSupport();
    if (!support.supported) {
        showMediaErrorAlert(support.message, new Error('navigator.mediaDevices is undefined'));
        if (privateRoomContent) privateRoomContent.hidden = true;
        if (mainRoomContent) mainRoomContent.hidden = false;
        return;
    }
    var banner = document.getElementById('privateMediaStartBanner');
    var videoSection = document.getElementById('privateVideoSection');
    var startBtn = document.getElementById('privateMediaStartBtn');
    if (banner) banner.hidden = false;
    if (videoSection) videoSection.hidden = false;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'カメラ・マイクを開始'; }
    /* 対面ルーム入室時にカメラ・マイクを自動で有効化 */
    setTimeout(function () { startPrivateRoomMedia(); }, 150);
});

function startPrivateRoomMedia() {
    var banner = document.getElementById('privateMediaStartBanner');
    var btn = document.getElementById('privateMediaStartBtn');
    if (!btn || !currentPrivateSessionId) return;
    if (privateLocalStream) {
        if (banner) banner.hidden = true;
        return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '取得中...';
    var audioConstraints = { echoCancellation: true, noiseSuppression: true };
    navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: audioConstraints
    }).then(function (stream) {
        privateLocalStream = stream;
        var audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = true;
            if (privateMicBtn) {
                privateMicBtn.classList.add('on');
                privateMicBtn.classList.remove('muted');
            }
        }
        if (privateCameraBtn) privateCameraBtn.classList.add('on');
        if (banner) banner.hidden = true;
        if (privateVideosContainer) addPrivateVideoElement('local', stream, ROLE === 'admin' ? '管理者' : USER_NAME);
        privatePendingOthers.forEach(function (p) {
            var isInitiator = socket.id < p.sid;
            privateCreatePeerConnection(p.sid, p.user_name, isInitiator);
        });
        privatePendingOthers = [];
        Object.keys(privatePeers).forEach(function (sid) {
            var pc = privatePeers[sid] && privatePeers[sid].connection;
            if (pc && pc.getSenders && pc.getSenders().length === 0 && privateLocalStream) {
                privateLocalStream.getTracks().forEach(function (t) { pc.addTrack(t, privateLocalStream); });
                pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
                    socket.emit('offer', { target: sid, description: pc.localDescription, sender: socket.id });
                }).catch(function (err) { console.warn('Private re-offer error', err); });
            }
        });
        socket.emit('private_media_ready', {});
        showToast('カメラ・マイクが有効になりました');
    }).catch(function (err) {
        logMediaError('Private room getUserMedia', err);
        showMediaErrorAlert('個別ルームのカメラ・マイクにアクセスできません。ブラウザの許可を確認してください。' + (err.message ? '\n' + err.message : ''), err);
        btn.disabled = false;
        btn.textContent = 'カメラ・マイクを開始';
    });
}

var privateMediaStartBtn = document.getElementById('privateMediaStartBtn');
if (privateMediaStartBtn) privateMediaStartBtn.addEventListener('click', startPrivateRoomMedia);

var privateRemoteVolume = 1;

function privateUnmuteAllRemoteVideos() {
    if (!privateVideosContainer) return;
    privateVideosContainer.querySelectorAll('video').forEach(function (v) {
        if (v.getAttribute('data-local') !== 'true') {
            v.muted = false;
            v.volume = typeof privateRemoteVolume === 'number' ? privateRemoteVolume : 1;
            if (v.srcObject && v.srcObject.getAudioTracks) {
                v.srcObject.getAudioTracks().forEach(function (t) { t.enabled = true; });
            }
            v.play().then(function () {}).catch(function (err) {
                if (WEBRTC_DEBUG) console.warn('[WebRTC] private unmute play failed', err);
            });
        }
    });
    privateVideosContainer.querySelectorAll('.private-audio-click-overlay').forEach(function (o) { o.remove(); });
}

socket.on('private_audio_sync', function () {
    if (!currentPrivateSessionId) return;
    if (privateLocalStream) {
        var at = privateLocalStream.getAudioTracks()[0];
        if (at) at.enabled = true;
        if (privateMicBtn) { privateMicBtn.classList.add('on'); privateMicBtn.classList.remove('muted'); }
    }
    privateUnmuteAllRemoteVideos();
});

if (privateMicBtn) privateMicBtn.addEventListener('click', function () {
    if (!privateLocalStream) return;
    var audioTrack = privateLocalStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        privateMicBtn.classList.toggle('on', audioTrack.enabled);
        privateMicBtn.classList.toggle('muted', !audioTrack.enabled);
        if (audioTrack.enabled) privateUnmuteAllRemoteVideos();
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
var privateRemoteVolumeSlider = document.getElementById('privateRemoteVolumeSlider');
if (privateRemoteVolumeSlider) {
    privateRemoteVolumeSlider.addEventListener('input', function () {
        privateRemoteVolume = parseInt(this.value, 10) / 100;
        if (privateVideosContainer) {
            privateVideosContainer.querySelectorAll('video').forEach(function (v) {
                if (v.getAttribute('data-local') !== 'true') v.volume = privateRemoteVolume;
            });
        }
    });
}

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
    // 送信者本人にはサーバーから返さない（ローカルで既に追加済みのため二重表示を防ぐ）
    if (data.sender_sid === socket.id) return;
    appendChatMessage(data.user_name || '', data.text || '', false);
});
socket.on('private_chat_image', function (data) {
    if (data.sender_sid === socket.id) return;
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
