/**
 * notifications.js — 通知システムUI
 */
(function () {
    'use strict';

    var notifList = document.getElementById('notifList');
    var badge = document.getElementById('navNotifBadge');
    var cachedNotifs = [];

    // ========== Badge ==========

    function updateBadge(notifications) {
        if (!badge) return;
        var unread = 0;
        for (var i = 0; i < notifications.length; i++) {
            if (!notifications[i].is_read) unread++;
        }
        if (unread > 0) {
            badge.style.display = '';
            badge.textContent = unread > 9 ? '9+' : String(unread);
        } else {
            badge.style.display = 'none';
        }
    }

    // ========== Date formatting ==========

    function formatDateTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var diff = now.getTime() - d.getTime();
        var mins = Math.floor(diff / 60000);
        if (mins < 1) return 'たった今';
        if (mins < 60) return mins + '分前';
        var hours = Math.floor(mins / 60);
        if (hours < 24) return hours + '時間前';
        var days = Math.floor(hours / 24);
        if (days < 7) return days + '日前';
        var m = d.getMonth() + 1;
        var dd = d.getDate();
        return m + '月' + dd + '日';
    }

    // ========== Category icon ==========

    function categoryIcon(cat) {
        switch (cat) {
            case 'direct': return 'mail';
            case 'global': return 'campaign';
            case 'system':
            default: return 'info';
        }
    }

    // ========== Render ==========

    function renderNotifications(notifications) {
        if (!notifList) return;
        if (!notifications || notifications.length === 0) {
            notifList.innerHTML =
                '<div class="notif-empty">' +
                '  <span class="material-symbols-outlined notif-empty-icon">notifications_off</span>' +
                '  <p>通知はまだありません。</p>' +
                '</div>';
            return;
        }

        var html = '';
        notifications.forEach(function (n) {
            var readClass = n.is_read ? 'notif-card-read' : 'notif-card-unread';
            var icon = categoryIcon(n.category);
            var hasLink = n.link_target && n.link_target.length > 0;
            html += '<div class="notif-card ' + readClass + '" data-notif-id="' + n.id + '"' +
                (hasLink ? ' data-link="' + escHtml(n.link_target) + '"' : '') + '>';
            html += '  <div class="notif-card-dot"></div>';
            html += '  <span class="material-symbols-outlined notif-card-icon">' + icon + '</span>';
            html += '  <div class="notif-card-body">';
            html += '    <div class="notif-card-title">' + escHtml(n.title) + '</div>';
            if (n.message) {
                html += '    <div class="notif-card-message">' + escHtml(n.message) + '</div>';
            }
            html += '    <div class="notif-card-time">' + formatDateTime(n.created_at) + '</div>';
            html += '  </div>';
            if (hasLink) {
                html += '  <span class="material-symbols-outlined notif-card-arrow">chevron_right</span>';
            }
            html += '</div>';
        });
        notifList.innerHTML = html;

        // Attach click listeners
        notifList.querySelectorAll('.notif-card').forEach(function (card) {
            card.addEventListener('click', function () {
                var id = parseInt(card.getAttribute('data-notif-id'), 10);
                var link = card.getAttribute('data-link') || '';
                handleNotifClick(id, link, card);
            });
        });
    }

    function escHtml(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // ========== Click handler ==========

    function handleNotifClick(id, linkTarget, cardEl) {
        // Mark as read
        fetch('/api/notifications/' + id + '/read', {
            method: 'POST',
            credentials: 'same-origin'
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok) {
                    // Update local state
                    cardEl.classList.remove('notif-card-unread');
                    cardEl.classList.add('notif-card-read');
                    for (var i = 0; i < cachedNotifs.length; i++) {
                        if (cachedNotifs[i].id === id) {
                            cachedNotifs[i].is_read = true;
                            break;
                        }
                    }
                    updateBadge(cachedNotifs);
                }
            })
            .catch(function () { /* silent */ });

        // Navigate to link target if present
        if (linkTarget) {
            // e.g. '#section-report' → 'report'
            var sectionId = linkTarget.replace('#section-', '').replace('#', '');
            if (sectionId) {
                // Use spa.js switchToSection via nav click simulation
                var navBtn = document.querySelector('.spa-nav-item[data-section="' + sectionId + '"]');
                if (navBtn) {
                    navBtn.click();
                }
            }
        }
    }

    // ========== Fetch ==========

    function fetchNotifications() {
        if (!window.IS_LOGGED_IN || !notifList) return;
        fetch('/api/notifications', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (notifs) {
                cachedNotifs = notifs;
                renderNotifications(notifs);
                updateBadge(notifs);
            })
            .catch(function () {
                if (notifList) {
                    notifList.innerHTML = '<p class="notif-loading">読み込みエラー</p>';
                }
            });
    }

    // ========== Init ==========

    fetchNotifications();

    // Expose refresh for external use (e.g. after tab switch)
    window.refreshNotifications = fetchNotifications;
})();
