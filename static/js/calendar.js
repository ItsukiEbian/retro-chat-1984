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
    var selectedSlots = {};

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

    function isPastOrToday(d) {
        return d <= today;
    }

    function getWeekDates(offset) {
        var dates = [];
        var start = new Date(today);
        start.setDate(start.getDate() + offset * 7);
        for (var i = 0; i < 7; i++) {
            var d = new Date(start);
            d.setDate(d.getDate() + i);
            dates.push(d);
        }
        return dates;
    }

    function renderDateStrip() {
        dateStrip.innerHTML = '';
        var dates = getWeekDates(weekOffset);

        dates.forEach(function (d) {
            var cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cal-date-cell';
            cell.setAttribute('data-date', dateKey(d));

            if (isSameDay(d, today)) {
                cell.classList.add('cal-date-today');
            }
            if (isPastOrToday(d)) {
                cell.classList.add('cal-date-past');
            }
            if (selectedDate && isSameDay(d, selectedDate)) {
                cell.classList.add('cal-date-active');
            }

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

            cell.addEventListener('click', function () {
                selectDate(d);
            });

            dateStrip.appendChild(cell);
        });
    }

    function selectDate(d) {
        selectedDate = d;
        selectedSlots = {};

        document.querySelectorAll('.cal-date-cell').forEach(function (c) {
            c.classList.remove('cal-date-active');
        });
        var key = dateKey(d);
        var target = dateStrip.querySelector('[data-date="' + key + '"]');
        if (target) target.classList.add('cal-date-active');

        renderTimeline();
        updateFab();
    }

    function slotTimeLabel(index) {
        var h = Math.floor(index / 2);
        var m = (index % 2) * 30;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function renderTimeline() {
        timeline.innerHTML = '';
        var locked = !selectedDate || isPastOrToday(selectedDate);
        var dk = selectedDate ? dateKey(selectedDate) : '';

        for (var i = 0; i < SLOTS_PER_DAY; i++) {
            var slot = document.createElement('div');
            slot.className = 'cal-slot';
            slot.setAttribute('data-slot', i);

            if (locked) {
                slot.classList.add('cal-slot-locked');
            }

            var timeEl = document.createElement('div');
            timeEl.className = 'cal-slot-time';
            timeEl.textContent = slotTimeLabel(i);

            var body = document.createElement('div');
            body.className = 'cal-slot-body';

            var label = document.createElement('span');
            label.className = 'cal-slot-label';

            if (locked) {
                var lockIcon = document.createElement('span');
                lockIcon.className = 'material-symbols-outlined cal-slot-lock-icon';
                lockIcon.textContent = 'lock';
                body.appendChild(lockIcon);
                label.textContent = '予約不可';
            } else {
                var slotKey = dk + '_' + i;
                if (selectedSlots[slotKey]) {
                    slot.classList.add('cal-slot-selected');
                    label.textContent = '選択中';
                } else {
                    label.textContent = '空き';
                }
            }

            body.appendChild(label);
            slot.appendChild(timeEl);
            slot.appendChild(body);

            (function (idx, isLocked) {
                slot.addEventListener('click', function () {
                    if (isLocked) {
                        showToast('当日の予約追加・変更はできません。今日もしっかり頑張りましょう！');
                        return;
                    }
                    toggleSlot(idx);
                });
            })(i, locked);

            timeline.appendChild(slot);
        }
    }

    function toggleSlot(index) {
        if (!selectedDate) return;
        var dk = dateKey(selectedDate);
        var key = dk + '_' + index;
        if (selectedSlots[key]) {
            delete selectedSlots[key];
        } else {
            selectedSlots[key] = true;
        }
        renderTimeline();
        updateFab();
    }

    function getSelectedCount() {
        var count = 0;
        for (var k in selectedSlots) {
            if (selectedSlots.hasOwnProperty(k)) count++;
        }
        return count;
    }

    function getSelectedRange() {
        if (!selectedDate) return '';
        var indices = [];
        var dk = dateKey(selectedDate);
        for (var k in selectedSlots) {
            if (selectedSlots.hasOwnProperty(k) && k.indexOf(dk) === 0) {
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
        var count = getSelectedCount();
        if (count > 0) {
            fab.classList.add('cal-fab-visible');
            if (fabText) {
                fabText.textContent = getSelectedRange() + ' 予約する';
            }
        } else {
            fab.classList.remove('cal-fab-visible');
        }
    }

    if (fab) {
        fab.addEventListener('click', function () {
            var count = getSelectedCount();
            if (count === 0) return;
            showToast('予約しました（' + getSelectedRange() + '）');
            selectedSlots = {};
            renderTimeline();
            updateFab();
        });
    }

    if (prevBtn) {
        prevBtn.addEventListener('click', function () {
            weekOffset--;
            renderDateStrip();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            weekOffset++;
            renderDateStrip();
        });
    }

    function init() {
        var tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        selectedDate = tomorrow;
        renderDateStrip();
        renderTimeline();
        updateFab();
    }

    init();
})();
