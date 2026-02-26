/**
 * meeting_calendar.js — 面談予約カレンダー＆面談管理UI
 */
(function () {
    'use strict';

    // ========== Route Section: 面談カード動的表示 ==========

    var interviewCard = document.getElementById('routeInterviewCard');
    var interviewDate = document.getElementById('routeInterviewDate');
    var interviewBtn = document.getElementById('routeInterviewBtn');
    var bookBtn = document.getElementById('routeBookMeetingBtn');
    var cancelBtn = document.getElementById('routeCancelMeetingBtn');

    var currentMeeting = null; // { id, date, time_slot, room_token }
    var currentMeetingType = 'regular'; // 'initial' or 'regular'

    var initialCard = document.getElementById('routeInitialMeetingCard');
    var initialBookBtn = document.getElementById('routeBookInitialBtn');
    var remainingEl = document.getElementById('routeMeetingRemaining');

    function formatMeetingDisplay(m) {
        if (!m) return '';
        var d = new Date(m.date + 'T00:00:00');
        var wday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
        var mm = d.getMonth() + 1;
        var dd = d.getDate();
        var parts = m.time_slot.split(':');
        var endH = parseInt(parts[0], 10);
        var endM = parseInt(parts[1], 10) + 30;
        if (endM >= 60) { endH++; endM -= 60; }
        var endStr = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
        return mm + '月' + dd + '日（' + wday + '） ' + m.time_slot + ' 〜 ' + endStr;
    }

    function refreshMeetingCard() {
        if (!interviewDate) return;
        fetch('/api/next_meeting')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                currentMeeting = data;
                if (data && data.room_token) {
                    interviewDate.textContent = formatMeetingDisplay(data);
                    if (interviewBtn) {
                        interviewBtn.href = '/meeting/' + data.room_token;
                        interviewBtn.style.display = '';
                    }
                    if (bookBtn) bookBtn.style.display = 'none';
                    if (cancelBtn) cancelBtn.style.display = '';
                } else {
                    interviewDate.textContent = '面談の予約はありません';
                    if (interviewBtn) interviewBtn.style.display = 'none';
                    if (bookBtn) bookBtn.style.display = '';
                    if (cancelBtn) cancelBtn.style.display = 'none';
                }
            })
            .catch(function () {
                if (interviewDate) interviewDate.textContent = '読み込みエラー';
            });
    }

    // Cancel meeting
    if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
            if (!currentMeeting || !currentMeeting.id) return;
            if (!confirm('面談予約をキャンセルしますか？')) return;
            fetch('/api/meeting_reservations', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: currentMeeting.id })
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.ok) {
                        refreshMeetingCard();
                    } else {
                        alert(data.error || 'キャンセルに失敗しました');
                    }
                });
        });
    }

    // ========== Meeting Calendar Modal ==========

    var overlay = document.getElementById('meetingCalOverlay');
    var closeBtn = document.getElementById('meetingCalCloseBtn');
    var dateStrip = document.getElementById('mcalDateStrip');
    var timeline = document.getElementById('mcalTimeline');
    var fab = document.getElementById('mcalFab');
    var fabText = document.getElementById('mcalFabText');
    var prevBtn2 = document.getElementById('mcalPrevWeek');
    var nextBtn2 = document.getElementById('mcalNextWeek');

    var DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
    // 30-min slots: 48 per day (00:00 - 23:30)
    var SLOTS_PER_DAY = 48;

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var weekOffset = 0;
    var selectedDate = null;
    var selectedSlot = null; // { date, time_slot }
    var studyReservations = {}; // dateStr -> Set of time_slot strings

    function dateKey(d) {
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + dd;
    }

    function isSameDay(a, b) {
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    function isPast(d) {
        var cmp = new Date(d);
        cmp.setHours(0, 0, 0, 0);
        return cmp < today;
    }

    function isToday(d) {
        return isSameDay(d, today);
    }

    function slotTimeLabel(index) {
        var h = Math.floor(index / 2);
        var m = (index % 2 === 0) ? '00' : '30';
        return String(h).padStart(2, '0') + ':' + m;
    }

    function getWeekDates(offset) {
        var start = new Date(today);
        start.setDate(start.getDate() - start.getDay() + offset * 7);
        var dates = [];
        for (var i = 0; i < 7; i++) {
            var d = new Date(start);
            d.setDate(start.getDate() + i);
            dates.push(d);
        }
        return dates;
    }

    function fetchStudyReservations(dateStr, cb) {
        fetch('/api/reservations?date=' + dateStr)
            .then(function (r) { return r.json(); })
            .then(function (rows) {
                var set = new Set();
                rows.forEach(function (r) { set.add(r.time_slot); });
                studyReservations[dateStr] = set;
                if (cb) cb();
            })
            .catch(function () { if (cb) cb(); });
    }

    function renderDateStrip() {
        if (!dateStrip) return;
        var dates = getWeekDates(weekOffset);
        dateStrip.innerHTML = '';
        dates.forEach(function (d) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cal-date-item';
            if (isPast(d)) btn.classList.add('cal-date-past');
            if (isToday(d)) btn.classList.add('cal-date-today');
            if (selectedDate && isSameDay(d, selectedDate)) btn.classList.add('cal-date-active');

            var dayLabel = document.createElement('span');
            dayLabel.className = 'cal-date-day';
            dayLabel.textContent = DAY_NAMES[d.getDay()];
            var numLabel = document.createElement('span');
            numLabel.className = 'cal-date-num';
            numLabel.textContent = d.getDate();

            btn.appendChild(dayLabel);
            btn.appendChild(numLabel);

            btn.addEventListener('click', function () {
                if (isPast(d)) return;
                selectDate(d);
            });
            dateStrip.appendChild(btn);
        });
    }

    function selectDate(d) {
        selectedDate = d;
        selectedSlot = null;
        renderDateStrip();
        var dk = dateKey(d);
        if (!studyReservations[dk]) {
            fetchStudyReservations(dk, function () { renderTimeline(); });
        } else {
            renderTimeline();
        }
        updateFab();
    }

    function renderTimeline() {
        if (!timeline || !selectedDate) return;
        timeline.innerHTML = '';
        var dk = dateKey(selectedDate);
        var studySet = studyReservations[dk] || new Set();
        var now = new Date();
        var isSelectedToday = isToday(selectedDate);

        for (var i = 0; i < SLOTS_PER_DAY; i++) {
            var tl = slotTimeLabel(i);
            var row = document.createElement('div');
            row.className = 'cal-slot';
            row.setAttribute('data-index', i);

            var label = document.createElement('span');
            label.className = 'cal-slot-time';
            label.textContent = tl;
            row.appendChild(label);

            var content = document.createElement('span');
            content.className = 'cal-slot-content';

            var isPastSlot = false;
            if (isSelectedToday) {
                var slotH = Math.floor(i / 2);
                var slotM = (i % 2) * 30;
                var slotDate = new Date(selectedDate);
                slotDate.setHours(slotH, slotM, 0, 0);
                if (slotDate <= now) isPastSlot = true;
            }

            if (isPastSlot) {
                row.classList.add('cal-slot-past');
                content.textContent = '';
            } else if (studySet.has(tl)) {
                row.classList.add('cal-slot-disabled');
                content.textContent = '自習予定';
            } else {
                row.classList.add('cal-slot-available');
                content.textContent = '空き';
                // Check if this slot is selected
                if (selectedSlot && selectedSlot.date === dk && selectedSlot.time_slot === tl) {
                    row.classList.add('cal-slot-selected');
                    content.textContent = '✓ 選択中';
                }
                (function (slotIndex, slotTime, slotDateKey) {
                    row.addEventListener('click', function () {
                        toggleSlot(slotDateKey, slotTime);
                    });
                })(i, tl, dk);
            }

            row.appendChild(content);
            timeline.appendChild(row);
        }
    }

    function toggleSlot(dk, tl) {
        if (selectedSlot && selectedSlot.date === dk && selectedSlot.time_slot === tl) {
            selectedSlot = null;
        } else {
            selectedSlot = { date: dk, time_slot: tl };
        }
        renderTimeline();
        updateFab();
    }

    function updateFab() {
        if (!fab) return;
        if (selectedSlot) {
            fab.style.display = '';
            if (fabText) {
                var parts = selectedSlot.time_slot.split(':');
                var endH = parseInt(parts[0], 10);
                var endM = parseInt(parts[1], 10) + 30;
                if (endM >= 60) { endH++; endM -= 60; }
                var endStr = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
                fabText.textContent = selectedSlot.time_slot + '〜' + endStr + ' で予約する';
            }
        } else {
            fab.style.display = 'none';
        }
    }

    function submitMeetingReservation() {
        if (!selectedSlot) return;
        fetch('/api/meeting_reservations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: selectedSlot.date, time_slot: selectedSlot.time_slot, meeting_type: currentMeetingType })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok) {
                    closeMeetingCalendar();
                    refreshMeetingCard();
                    refreshMeetingStatus();
                    showMeetingToast('面談を予約しました！');
                } else {
                    alert(data.error || '予約に失敗しました');
                }
            })
            .catch(function () {
                alert('通信エラーが発生しました');
            });
    }

    // Open / Close
    function openMeetingCalendar() {
        if (!overlay) return;
        weekOffset = 0;
        selectedDate = new Date(today);
        selectedSlot = null;
        renderDateStrip();
        var dk = dateKey(selectedDate);
        fetchStudyReservations(dk, function () { renderTimeline(); });
        updateFab();
        overlay.style.display = '';
    }

    function closeMeetingCalendar() {
        if (overlay) overlay.style.display = 'none';
    }

    // Book button opens modal
    if (bookBtn) {
        bookBtn.addEventListener('click', function () {
            currentMeetingType = 'regular';
            openMeetingCalendar();
        });
    }

    if (initialBookBtn) {
        initialBookBtn.addEventListener('click', function () {
            currentMeetingType = 'initial';
            openMeetingCalendar();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeMeetingCalendar);
    }

    if (overlay) {
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeMeetingCalendar();
        });
    }

    if (fab) {
        fab.addEventListener('click', function () {
            if (selectedSlot) submitMeetingReservation();
        });
    }

    if (prevBtn2) {
        prevBtn2.addEventListener('click', function () {
            weekOffset--;
            renderDateStrip();
        });
    }

    if (nextBtn2) {
        nextBtn2.addEventListener('click', function () {
            weekOffset++;
            renderDateStrip();
        });
    }

    // ========== Toast ==========
    function showMeetingToast(msg) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast toast-success';
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(function () { toast.classList.add('toast-visible'); }, 10);
        setTimeout(function () {
            toast.classList.remove('toast-visible');
            setTimeout(function () { toast.remove(); }, 300);
        }, 3000);
    }

    // ========== Admin: 面談予約一覧 ==========

    var adminList = document.getElementById('adminMeetingList');

    function refreshAdminMeetingList() {
        if (!adminList) return;
        fetch('/api/admin/meeting_reservations')
            .then(function (r) { return r.json(); })
            .then(function (rows) {
                if (!Array.isArray(rows) || rows.length === 0) {
                    adminList.innerHTML = '<p class="admin-meeting-empty">現在予約されている面談はありません。</p>';
                    return;
                }
                var html = '';
                rows.forEach(function (r) {
                    var d = new Date(r.date + 'T00:00:00');
                    var wday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
                    var display = (d.getMonth() + 1) + '月' + d.getDate() + '日（' + wday + '） ' + r.time_slot;
                    html += '<div class="admin-meeting-item">';
                    html += '  <div class="admin-meeting-info">';
                    html += '    <span class="admin-meeting-user">' + escHtml(r.user_name) + '</span>';
                    html += '    <span class="admin-meeting-datetime">' + display + '</span>';
                    html += '  </div>';
                    html += '  <a href="/meeting/' + r.room_token + '" class="admin-meeting-enter-btn">';
                    html += '    <span>面談ルームに入る</span>';
                    html += '    <span class="material-symbols-outlined">arrow_forward</span>';
                    html += '  </a>';
                    html += '</div>';
                });
                adminList.innerHTML = html;
            })
            .catch(function () {
                adminList.innerHTML = '<p class="admin-meeting-empty">読み込みエラー</p>';
            });
    }

    function escHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // ========== Admin: 生徒の学習ルート管理 ==========

    var adminRouteList = document.getElementById('adminRouteStudentList');

    function refreshAdminRouteList() {
        if (!adminRouteList) return;
        fetch('/api/admin/students')
            .then(function (r) { return r.json(); })
            .then(function (rows) {
                if (!Array.isArray(rows) || rows.length === 0) {
                    adminRouteList.innerHTML = '<p class="admin-meeting-empty">生徒がいません。</p>';
                    return;
                }
                adminRouteList.innerHTML = '';
                rows.forEach(function (stu) {
                    var card = document.createElement('div');
                    card.className = 'admin-route-card';

                    var header = document.createElement('div');
                    header.className = 'admin-route-card-header';
                    header.innerHTML = '<span class="admin-route-card-name">' + escHtml(stu.name || stu.email || 'ID:' + stu.id) + '</span>' +
                        (stu.is_subscribed ? '<span class="admin-route-badge-pro">Pro</span>' : '<span class="admin-route-badge-free">Free</span>');
                    card.appendChild(header);

                    var ta = document.createElement('textarea');
                    ta.className = 'admin-route-textarea';
                    ta.placeholder = '学習ルート・参考書リストを入力…';
                    ta.value = stu.learning_route_text || '';
                    ta.rows = 5;
                    card.appendChild(ta);

                    var btnRow = document.createElement('div');
                    btnRow.className = 'admin-route-btn-row';
                    var saveBtn = document.createElement('button');
                    saveBtn.type = 'button';
                    saveBtn.className = 'admin-route-save-btn';
                    saveBtn.textContent = '保存する';
                    (function (userId, textarea, button) {
                        button.addEventListener('click', function () {
                            button.disabled = true;
                            button.textContent = '保存中…';
                            fetch('/api/admin/update_route/' + userId, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ learning_route_text: textarea.value })
                            })
                                .then(function (r) { return r.json(); })
                                .then(function (data) {
                                    button.disabled = false;
                                    if (data.ok) {
                                        button.textContent = '✓ 保存しました';
                                        setTimeout(function () { button.textContent = '保存する'; }, 2000);
                                    } else {
                                        button.textContent = '保存する';
                                        alert(data.error || '保存に失敗しました');
                                    }
                                })
                                .catch(function () {
                                    button.disabled = false;
                                    button.textContent = '保存する';
                                    alert('通信エラー');
                                });
                        });
                    })(stu.id, ta, saveBtn);
                    btnRow.appendChild(saveBtn);
                    card.appendChild(btnRow);

                    adminRouteList.appendChild(card);
                });
            })
            .catch(function () {
                adminRouteList.innerHTML = '<p class="admin-meeting-empty">読み込みエラー</p>';
            });
    }

    // ========== Init ==========

    function refreshMeetingStatus() {
        if (!window.IS_LOGGED_IN) return;
        fetch('/api/meeting_status', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (s) {
                // Initial card
                if (initialCard) {
                    if (s.is_within_7_days && !s.has_booked_initial && (s.is_pro || true)) {
                        initialCard.style.display = '';
                    } else {
                        initialCard.style.display = 'none';
                    }
                }
                // Remaining count
                if (remainingEl) {
                    var rem = s.remaining_regular_meetings;
                    remainingEl.textContent = '今月のご利用可能回数：あと ' + rem + ' 回';
                    if (rem <= 0 && bookBtn) {
                        bookBtn.disabled = true;
                        bookBtn.querySelector('span:first-child').textContent = '今月の面談枠はすべて消化しました';
                    } else if (bookBtn) {
                        bookBtn.disabled = false;
                        bookBtn.querySelector('span:first-child').textContent = '面談の日程調整をする';
                    }
                }
            })
            .catch(function () { });
    }

    function init() {
        if (window.IS_LOGGED_IN) {
            refreshMeetingCard();
            refreshMeetingStatus();
            if (window.ROLE === 'admin') {
                refreshAdminMeetingList();
                refreshAdminRouteList();
            }
        }
    }

    init();
})();
