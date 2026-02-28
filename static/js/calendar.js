(function () {
    'use strict';

    var dateStrip = document.getElementById('calDateStrip');
    var timeline = document.getElementById('calTimeline');
    var fab = document.getElementById('calFab');
    var fabText = document.getElementById('calFabText');
    var prevBtn = document.getElementById('calPrevWeek');
    var nextBtn = document.getElementById('calNextWeek');

    if (!dateStrip || !timeline) return;

    var DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
    var MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    var SLOTS_PER_DAY = 48;

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var weekOffset = 0;
    var selectedDate = null;
    var pendingSelections = {};
    var reservedSlots = {};

    var toastEl = null;
    var toastTimer = null;

    function createToast() {
        if (toastEl) return;
        toastEl = document.createElement('div');
        toastEl.className = 'cal-toast';
        document.body.appendChild(toastEl);
    }

    function showToast(msg) {
        createToast();
        toastEl.textContent = msg;
        toastEl.classList.add('cal-toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('cal-toast-show');
        }, 3000);
    }

    function dateKey(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function isSameDay(a, b) {
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    function isPast(d) {
        var yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        return d <= yesterday;
    }

    function isToday(d) {
        return isSameDay(d, today);
    }

    function isFuture(d) {
        return d > today;
    }

    function slotTimeLabel(index) {
        var h = Math.floor(index / 2);
        var m = (index % 2) * 30;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function slotIndexFromTime(ts) {
        var parts = ts.split(':');
        return parseInt(parts[0], 10) * 2 + (parseInt(parts[1], 10) >= 30 ? 1 : 0);
    }

    function getWeekDates(offset) {
        var dates = [];
        var start = new Date(today);
        // Always start from Sunday of the current week
        var dayOfWeek = start.getDay(); // 0=Sun, 1=Mon, ...
        start.setDate(start.getDate() - dayOfWeek + offset * 7);
        for (var i = 0; i < 7; i++) {
            var d = new Date(start);
            d.setDate(d.getDate() + i);
            dates.push(d);
        }
        return dates;
    }

    function fetchReservations(dateStr, cb) {
        if (!window.IS_LOGGED_IN) { cb([]); return; }
        fetch('/api/reservations?date=' + dateStr, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) { cb(Array.isArray(data) ? data : []); })
            .catch(function () { cb([]); });
    }

    function renderDateStrip() {
        dateStrip.innerHTML = '';
        var dates = getWeekDates(weekOffset);

        dates.forEach(function (d) {
            var cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cal-date-cell';
            cell.setAttribute('data-date', dateKey(d));

            if (isToday(d)) cell.classList.add('cal-date-today');
            if (isPast(d)) cell.classList.add('cal-date-past');
            if (selectedDate && isSameDay(d, selectedDate)) cell.classList.add('cal-date-active');

            var dow = document.createElement('span');
            dow.className = 'cal-date-dow';
            dow.textContent = DAY_NAMES[d.getDay()];

            var day = document.createElement('span');
            day.className = 'cal-date-day';
            day.textContent = d.getDate();

            var month = document.createElement('span');
            month.className = 'cal-date-month';
            month.textContent = MONTH_NAMES[d.getMonth()];

            cell.appendChild(dow);
            cell.appendChild(day);
            cell.appendChild(month);

            cell.addEventListener('click', function (e) { e.stopPropagation(); selectDate(d); });
            dateStrip.appendChild(cell);
        });

        // Auto-scroll to center the active date on mobile
        scrollDateStripToActive();
    }

    function scrollDateStripToActive() {
        var activeCell = dateStrip.querySelector('.cal-date-active') || dateStrip.querySelector('.cal-date-today');
        if (!activeCell) return;
        requestAnimationFrame(function () {
            var stripRect = dateStrip.getBoundingClientRect();
            var cellRect = activeCell.getBoundingClientRect();
            var scrollTarget = activeCell.offsetLeft - (stripRect.width / 2) + (cellRect.width / 2);
            dateStrip.scrollTo({ left: scrollTarget, behavior: 'smooth' });
        });
    }

    function selectDate(d) {
        selectedDate = d;
        pendingSelections = {};

        document.querySelectorAll('.cal-date-cell').forEach(function (c) {
            c.classList.remove('cal-date-active');
        });
        var target = dateStrip.querySelector('[data-date="' + dateKey(d) + '"]');
        if (target) target.classList.add('cal-date-active');

        fadeTimeline(function () {
            loadAndRenderTimeline();
        });
        updateFab();
    }

    // ===== Timeline Fade Helper =====
    var timelineWrap = document.getElementById('calTimelineWrap');
    function fadeTimeline(callback) {
        if (!timelineWrap) { callback(); return; }
        timelineWrap.classList.add('cal-timeline-fading');
        setTimeout(function () {
            callback();
            // Allow a frame for DOM update, then fade in
            requestAnimationFrame(function () {
                timelineWrap.classList.remove('cal-timeline-fading');
            });
        }, 130);
    }

    function loadAndRenderTimeline() {
        if (!selectedDate) { renderTimeline(); return; }
        var dk = dateKey(selectedDate);
        fetchReservations(dk, function (rows) {
            reservedSlots = {};
            rows.forEach(function (r) {
                var idx = slotIndexFromTime(r.time_slot);
                reservedSlots[dk + '_' + idx] = true;
            });
            renderTimeline();
        });
    }

    function renderTimeline() {
        timeline.innerHTML = '';
        if (!selectedDate) return;

        var dk = dateKey(selectedDate);
        var past = isPast(selectedDate);
        var todayDate = isToday(selectedDate);
        var future = isFuture(selectedDate);

        for (var i = 0; i < SLOTS_PER_DAY; i++) {
            var slot = document.createElement('div');
            slot.className = 'cal-slot';
            slot.setAttribute('data-slot', i);

            var slotKey = dk + '_' + i;
            var isReserved = !!reservedSlots[slotKey];
            var isPending = !!pendingSelections[slotKey];

            // Check if this slot's time has already passed (today only)
            var isPastTime = false;
            if (todayDate) {
                var now = new Date();
                var slotH = Math.floor(i / 2);
                var slotM = (i % 2) * 30;
                if (slotH < now.getHours() || (slotH === now.getHours() && slotM < now.getMinutes())) {
                    isPastTime = true;
                }
            }

            var timeEl = document.createElement('div');
            timeEl.className = 'cal-slot-time';
            timeEl.textContent = slotTimeLabel(i);

            var body = document.createElement('div');
            body.className = 'cal-slot-body';

            var label = document.createElement('span');
            label.className = 'cal-slot-label';

            if (past || isPastTime) {
                slot.classList.add('cal-slot-locked');
                var lockIcon = document.createElement('span');
                lockIcon.className = 'material-symbols-outlined cal-slot-lock-icon';
                lockIcon.textContent = 'lock';
                body.appendChild(lockIcon);
                label.textContent = isReserved ? '予約済' : '終了';
            } else if (todayDate) {
                if (isReserved) {
                    slot.classList.add('cal-slot-reserved');
                    label.textContent = '予約済';
                } else if (isPending) {
                    slot.classList.add('cal-slot-selected');
                    label.textContent = '選択中';
                } else {
                    label.textContent = '空き';
                }
            } else {
                if (isReserved && !isPending) {
                    slot.classList.add('cal-slot-reserved');
                    label.textContent = '予約済（タップで取消）';
                } else if (isPending) {
                    slot.classList.add('cal-slot-selected');
                    label.textContent = '選択中';
                } else {
                    label.textContent = '空き';
                }
            }

            body.appendChild(label);
            slot.appendChild(timeEl);
            slot.appendChild(body);

            (function (idx, locked, isToday_, isFuture_, reserved, key, pastTime) {
                slot.addEventListener('click', function () {
                    // Block free-plan users from reserving
                    var tier = window.USER_TIER || document.body.getAttribute('data-user-tier') || 'guest';
                    var isFree = (tier === 'free' || tier === 'guest');
                    if (isFree) {
                        var lockedOverlay = document.getElementById('studyLockedOverlay');
                        if (lockedOverlay) lockedOverlay.style.display = 'flex';
                        return;
                    }
                    if (locked || pastTime) {
                        showToast('過去の時間は予約できません。');
                        return;
                    }
                    if (isToday_ && reserved) {
                        showToast('当日の予約キャンセルはできません。今日も頑張りましょう！');
                        return;
                    }
                    if (isFuture_ && reserved && !pendingSelections[key]) {
                        cancelReservation(idx);
                        return;
                    }
                    togglePending(idx);
                });
            })(i, past, todayDate, future, isReserved, slotKey, isPastTime);

            timeline.appendChild(slot);
        }
    }

    function togglePending(index) {
        if (!selectedDate) return;
        var key = dateKey(selectedDate) + '_' + index;
        if (reservedSlots[key]) return;
        if (pendingSelections[key]) {
            delete pendingSelections[key];
        } else {
            pendingSelections[key] = true;
        }
        renderTimeline();
        updateFab();
    }

    function cancelReservation(index) {
        if (!selectedDate) return;
        var dk = dateKey(selectedDate);
        var ts = slotTimeLabel(index);
        fetch('/api/reservations', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slots: [{ date: dk, time_slot: ts }] })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok) {
                    showToast(ts + ' の予約をキャンセルしました');
                    loadAndRenderTimeline();
                    refreshNextReservation();
                } else {
                    showToast(data.error || 'キャンセルできませんでした');
                }
            })
            .catch(function () { showToast('通信エラーが発生しました'); });
    }

    function getPendingCount() {
        var count = 0;
        for (var k in pendingSelections) {
            if (pendingSelections.hasOwnProperty(k)) count++;
        }
        return count;
    }

    function getPendingRange() {
        if (!selectedDate) return '';
        var indices = [];
        var dk = dateKey(selectedDate);
        for (var k in pendingSelections) {
            if (pendingSelections.hasOwnProperty(k) && k.indexOf(dk) === 0) {
                indices.push(parseInt(k.split('_').pop(), 10));
            }
        }
        if (indices.length === 0) return '';
        indices.sort(function (a, b) { return a - b; });
        var first = indices[0];
        var last = indices[indices.length - 1];
        return slotTimeLabel(first) + ' 〜 ' + slotTimeLabel(last + 1 < SLOTS_PER_DAY ? last + 1 : SLOTS_PER_DAY);
    }

    function updateFab() {
        if (!fab) return;
        var count = getPendingCount();
        if (count > 0) {
            fab.classList.add('cal-fab-visible');
            if (fabText) fabText.textContent = getPendingRange() + ' 予約する';
        } else {
            fab.classList.remove('cal-fab-visible');
        }
    }

    function submitReservations() {
        if (!selectedDate) return;
        var dk = dateKey(selectedDate);
        var slots = [];
        for (var k in pendingSelections) {
            if (pendingSelections.hasOwnProperty(k) && k.indexOf(dk) === 0) {
                var idx = parseInt(k.split('_').pop(), 10);
                slots.push({ date: dk, time_slot: slotTimeLabel(idx) });
            }
        }
        if (slots.length === 0) return;

        fetch('/api/reservations', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slots: slots })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok) {
                    showToast('予約しました（' + getPendingRange() + '）');
                    pendingSelections = {};
                    updateFab();
                    loadAndRenderTimeline();
                    refreshNextReservation();
                } else {
                    showToast(data.error || '予約できませんでした');
                    pendingSelections = {};
                    updateFab();
                    loadAndRenderTimeline();
                }
            })
            .catch(function () { showToast('通信エラーが発生しました'); });
    }

    if (fab) {
        fab.addEventListener('click', function () {
            if (getPendingCount() === 0) return;
            submitReservations();
        });
    }

    // ===== Slide animation helper for arrow buttons =====
    function slideWeek(direction) {
        // direction: -1 = next week (slide left), 1 = prev week (slide right)
        var stripWidth = dateStrip.offsetWidth;
        var slideOut = direction * stripWidth;

        // Slide current strip out
        dateStrip.style.transform = 'translateX(' + slideOut + 'px)';

        fadeTimeline(function () {
            // After slide-out transition, update week and render
            setTimeout(function () {
                weekOffset += (direction === -1 ? 1 : -1);
                // Disable transition, position new strip on opposite side
                dateStrip.classList.add('cal-strip-dragging');
                dateStrip.style.transform = 'translateX(' + (-slideOut) + 'px)';
                renderDateStrip();

                // Next frame: re-enable transition and slide in
                requestAnimationFrame(function () {
                    dateStrip.classList.remove('cal-strip-dragging');
                    dateStrip.style.transform = 'translateX(0)';
                });
            }, 200);
        });
    }

    if (prevBtn) {
        prevBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            slideWeek(1);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            slideWeek(-1);
        });
    }

    // ===== Home: Next Reservation =====

    function formatReservationDisplay(data) {
        if (!data || !data.date || !data.time_slot) return null;
        var parts = data.date.split('-');
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        var todayCheck = new Date();
        todayCheck.setHours(0, 0, 0, 0);
        var prefix;
        if (d.getTime() === todayCheck.getTime()) {
            prefix = '本日';
        } else {
            var tomorrowCheck = new Date(todayCheck);
            tomorrowCheck.setDate(tomorrowCheck.getDate() + 1);
            if (d.getTime() === tomorrowCheck.getTime()) {
                prefix = '明日';
            } else {
                prefix = (d.getMonth() + 1) + '/' + d.getDate() + '（' + DAY_NAMES[d.getDay()] + '）';
            }
        }
        // Calculate end time (start + 30 min)
        var tsParts = data.time_slot.split(':');
        var startH = parseInt(tsParts[0], 10);
        var startM = parseInt(tsParts[1], 10);
        var endM = startM + 30;
        var endH = startH;
        if (endM >= 60) { endM -= 60; endH += 1; }
        var endTime = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
        return prefix + ' ' + data.time_slot + ' 〜 ' + endTime;
    }

    var _resCheckTimer = null;

    function refreshNextReservation() {
        if (!window.IS_LOGGED_IN) return;
        var card = document.getElementById('homeNextReservation');
        var timeEl = document.getElementById('homeNextResTime');
        if (!card) return;

        fetch('/api/next_reservation', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.date) {
                    var display = formatReservationDisplay(data);
                    if (timeEl) timeEl.textContent = display || '—';
                    card.classList.remove('home-next-res-empty');
                    var enterBtn = card.querySelector('.home-next-res-enter-btn');
                    if (enterBtn) {
                        enterBtn.style.display = '';
                        updateEnterBtnState(enterBtn, data);
                    }
                    var emptyMsg = card.querySelector('.home-next-res-empty-msg');
                    if (emptyMsg) emptyMsg.remove();
                } else {
                    if (timeEl) timeEl.textContent = '次の予約はありません';
                    card.classList.add('home-next-res-empty');
                    var enterBtn2 = card.querySelector('.home-next-res-enter-btn');
                    if (enterBtn2) enterBtn2.style.display = 'none';
                    if (!card.querySelector('.home-next-res-empty-msg')) {
                        var link = document.createElement('button');
                        link.type = 'button';
                        link.className = 'home-next-res-cal-btn home-next-res-empty-msg';
                        link.innerHTML = '<span class="material-symbols-outlined">calendar_month</span><span>カレンダーで予約する</span>';
                        link.addEventListener('click', function () {
                            var navBtn = document.querySelector('.spa-nav-item[data-section="calendar"]');
                            if (navBtn) navBtn.click();
                        });
                        card.querySelector('.home-next-res-inner').appendChild(link);
                    }
                }
            })
            .catch(function () { });
    }

    function updateEnterBtnState(btn, data) {
        clearInterval(_resCheckTimer);
        var spanEl = btn.querySelector('span:last-child') || btn.lastElementChild;

        function check() {
            var now = new Date();
            var parts = data.date.split('-');
            var tsParts = data.time_slot.split(':');
            var slotStart = new Date(
                parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
                parseInt(tsParts[0], 10), parseInt(tsParts[1], 10), 0
            );
            var diff = slotStart.getTime() - now.getTime();
            var minsBefore = diff / 60000;

            if (minsBefore <= 10) {
                btn.disabled = false;
                btn.classList.remove('home-next-res-enter-disabled');
                if (spanEl) spanEl.textContent = '自習室に入る';
                clearInterval(_resCheckTimer);
            } else {
                btn.disabled = true;
                btn.classList.add('home-next-res-enter-disabled');
                if (spanEl) spanEl.textContent = '開始10分前から入室可能';
            }
        }

        check();
        _resCheckTimer = setInterval(check, 30000);
    }

    window.refreshNextReservation = refreshNextReservation;

    function init() {
        selectedDate = new Date(today);
        renderDateStrip();
        loadAndRenderTimeline();
        updateFab();
        refreshNextReservation();
    }

    // ===== Native-like swipe gesture for week navigation =====
    (function () {
        var wrap = document.querySelector('.cal-date-strip-wrap');
        if (!wrap || !dateStrip) return;

        var startX = 0;
        var startY = 0;
        var currentX = 0;
        var isDragging = false;
        var isHorizontal = null; // null = undecided, true = horizontal, false = vertical
        var DIRECTION_LOCK_THRESHOLD = 8; // px to decide direction
        var SNAP_THRESHOLD = 0.25; // 25% of strip width to trigger week change

        wrap.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentX = startX;
            isDragging = true;
            isHorizontal = null;
            dateStrip.classList.add('cal-strip-dragging');
        }, { passive: true });

        wrap.addEventListener('touchmove', function (e) {
            if (!isDragging || e.touches.length !== 1) return;
            var touchX = e.touches[0].clientX;
            var touchY = e.touches[0].clientY;
            var dx = touchX - startX;
            var dy = touchY - startY;

            // Decide direction lock on first significant move
            if (isHorizontal === null) {
                if (Math.abs(dx) > DIRECTION_LOCK_THRESHOLD || Math.abs(dy) > DIRECTION_LOCK_THRESHOLD) {
                    isHorizontal = Math.abs(dx) > Math.abs(dy);
                }
                if (!isHorizontal) return; // Not yet decided or vertical
            }

            if (!isHorizontal) return; // Vertical scroll, don't interfere

            // Prevent vertical scrolling while swiping horizontally
            e.preventDefault();
            currentX = touchX;
            var deltaX = currentX - startX;

            // Apply rubber-band resistance at edges
            var resistance = 0.4;
            var stripWidth = dateStrip.offsetWidth;
            if (Math.abs(deltaX) > stripWidth * 0.5) {
                var excess = Math.abs(deltaX) - stripWidth * 0.5;
                deltaX = (deltaX > 0 ? 1 : -1) * (stripWidth * 0.5 + excess * resistance);
            }

            dateStrip.style.transform = 'translateX(' + deltaX + 'px)';
        }, { passive: false });

        wrap.addEventListener('touchend', function () {
            if (!isDragging) return;
            isDragging = false;
            dateStrip.classList.remove('cal-strip-dragging');

            if (!isHorizontal) {
                dateStrip.style.transform = 'translateX(0)';
                return;
            }

            var deltaX = currentX - startX;
            var stripWidth = dateStrip.offsetWidth;
            var threshold = stripWidth * SNAP_THRESHOLD;

            if (Math.abs(deltaX) > threshold) {
                // Swipe far enough — navigate to next/prev week
                var direction = deltaX > 0 ? 1 : -1; // 1 = prev, -1 = next
                var slideOut = direction * stripWidth;

                // Slide out to the direction of the swipe
                dateStrip.style.transform = 'translateX(' + slideOut + 'px)';

                fadeTimeline(function () {
                    setTimeout(function () {
                        weekOffset += (direction === 1 ? -1 : 1);
                        // Position new content on opposite side (no transition)
                        dateStrip.classList.add('cal-strip-dragging');
                        dateStrip.style.transform = 'translateX(' + (-slideOut) + 'px)';
                        renderDateStrip();

                        // Slide in to center
                        requestAnimationFrame(function () {
                            dateStrip.classList.remove('cal-strip-dragging');
                            dateStrip.style.transform = 'translateX(0)';
                        });
                    }, 200);
                });
            } else {
                // Not far enough — snap back
                dateStrip.style.transform = 'translateX(0)';
            }

            startX = startY = currentX = 0;
        }, { passive: true });

        // Cancel on touch cancel
        wrap.addEventListener('touchcancel', function () {
            isDragging = false;
            isHorizontal = null;
            dateStrip.classList.remove('cal-strip-dragging');
            dateStrip.style.transform = 'translateX(0)';
        }, { passive: true });
    })();

    init();
})();
