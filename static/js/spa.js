(function () {
    'use strict';

    var sidebar = document.getElementById('spaSidebar');
    var spaMain = document.getElementById('spaMain');
    var navItems = document.querySelectorAll('.spa-nav-item[data-section]');
    var sections = document.querySelectorAll('.spa-section');
    var enterStudyBtn = document.getElementById('enterStudyRoomBtn');
    var homeEnterBtn = document.getElementById('homeEnterStudyBtn');
    var exitStudyBtn = document.getElementById('exitStudyRoomBtn');
    var goalOverlay = document.getElementById('goalOverlay');
    var goalInput = document.getElementById('goalInput');
    var goalSubmitBtn = document.getElementById('goalSubmitBtn');
    var goalFeedback = document.getElementById('goalFeedback');
    var studyLockedOverlay = document.getElementById('studyLockedOverlay');

    var currentSection = 'home';
    var studyRoomInitialized = false;
    var studyTimerId = null;

    // ========== Section Switching ==========

    function switchToSection(sectionId) {
        if (currentSection === sectionId) return;

        var leavingStudy = currentSection === 'study';
        var enteringStudy = sectionId === 'study';

        sections.forEach(function (s) {
            s.classList.remove('spa-section-active');
        });
        var target = document.getElementById('section-' + sectionId);
        if (target) target.classList.add('spa-section-active');

        navItems.forEach(function (item) {
            item.classList.toggle('spa-nav-active', item.getAttribute('data-section') === sectionId);
        });

        if (enteringStudy) {
            sidebar.classList.add('collapsed');
        } else {
            sidebar.classList.remove('collapsed');
        }

        if (leavingStudy && studyRoomInitialized) {
            deactivateStudyRoom();
        }

        // Refresh next-reservation card whenever returning to Home
        if (sectionId === 'home' && typeof window.refreshNextReservation === 'function') {
            window.refreshNextReservation();
        }

        // Refresh notifications when switching to notifications tab
        if (sectionId === 'notifications' && typeof window.refreshNotifications === 'function') {
            window.refreshNotifications();
        }

        currentSection = sectionId;
    }

    // ========== Login Gate ==========

    function requireLogin() {
        if (window.IS_LOGGED_IN) return true;
        window.location.href = '/login/google';
        return false;
    }

    // ========== Study Room Activation ==========

    function isFreeUser() {
        return !window.IS_SUBSCRIBED || !window.PLAN_TYPE || window.PLAN_TYPE === 'free' || window.SUBSCRIPTION_STATUS === 'none';
    }

    function showStudyLockedModal() {
        if (studyLockedOverlay) studyLockedOverlay.style.display = 'flex';
    }

    function closeStudyLockedModal() {
        if (studyLockedOverlay) studyLockedOverlay.style.display = 'none';
    }

    function showGoalModal() {
        if (!requireLogin()) return;
        if (isFreeUser()) { showStudyLockedModal(); return; }
        if (!goalOverlay) return;
        goalOverlay.style.display = '';
        if (goalInput) { goalInput.value = ''; goalInput.focus(); }
        if (goalFeedback) { goalFeedback.hidden = true; goalFeedback.textContent = ''; }
        if (goalSubmitBtn) { goalSubmitBtn.disabled = false; goalSubmitBtn.textContent = '目標を設定して入室する'; }
    }

    function closeGoalModal() {
        if (!goalOverlay) return;
        goalOverlay.style.display = 'none';
        if (goalInput) goalInput.value = '';
        if (goalFeedback) { goalFeedback.hidden = true; goalFeedback.textContent = ''; }
        if (goalSubmitBtn) { goalSubmitBtn.disabled = false; goalSubmitBtn.textContent = '目標を設定して入室する'; }
    }

    function startStudyTimer() {
        stopStudyTimer();
        studyTimerId = setInterval(function () {
            fetch('/api/update_study_time', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minutes: 1 })
            }).catch(function () { });
        }, 60000);
    }

    function stopStudyTimer() {
        if (studyTimerId !== null) {
            clearInterval(studyTimerId);
            studyTimerId = null;
        }
    }

    function refreshHomeStudyTime() {
        if (!window.IS_LOGGED_IN) return;
        fetch('/api/get_study_time', { credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var el = document.querySelector('.spa-home-stat-value');
                if (el && data.display) el.textContent = data.display;
            })
            .catch(function () { });
    }

    function activateStudyRoom() {
        switchToSection('study');
        studyRoomInitialized = true;
        fetch('/api/enter_room', { method: 'POST', credentials: 'same-origin' }).catch(function () { });
        startStudyTimer();
    }

    function deactivateStudyRoom() {
        stopStudyTimer();
        if (typeof window.teardownStudyRoom === 'function') {
            window.teardownStudyRoom();
        }
        studyRoomInitialized = false;
        fetch('/api/exit_room', { method: 'POST', credentials: 'same-origin' }).catch(function () { });
        refreshHomeStudyTime();
    }

    window._onStudyRoomReady = function () {
        activateStudyRoom();
    };

    window.addEventListener('beforeunload', function () {
        stopStudyTimer();
    });

    // ========== Event Bindings ==========

    navItems.forEach(function (item) {
        item.addEventListener('click', function () {
            var section = item.getAttribute('data-section');
            if (!section) return;

            if (section === 'study') {
                if (studyRoomInitialized && typeof window.studyRoomIsActive === 'function' && window.studyRoomIsActive()) {
                    switchToSection('study');
                } else {
                    showGoalModal();
                }
                return;
            }

            // Block non-Pro users from route/compass tab
            if (section === 'route' && window.PLAN_TYPE !== 'pro') {
                var lockedOvl = document.getElementById('studyLockedOverlay');
                if (lockedOvl) {
                    var descEl = lockedOvl.querySelector('.locked-overlay-desc');
                    if (descEl) descEl.textContent = 'あなた専用の学習ルート作成や、メンターとの定期面談を利用するには、Proプランへのアップグレードが必要です。';
                    var titleEl = lockedOvl.querySelector('.overlay-card-header h1');
                    if (titleEl) titleEl.textContent = 'この機能はProプラン限定です';
                    lockedOvl.style.display = 'flex';
                }
                return;
            }

            switchToSection(section);
        });
    });

    if (enterStudyBtn) {
        enterStudyBtn.addEventListener('click', function () {
            showGoalModal();
        });
    }

    if (homeEnterBtn) {
        homeEnterBtn.addEventListener('click', function () {
            showGoalModal();
        });
    }

    document.querySelectorAll('.js-enter-study').forEach(function (btn) {
        if (btn === homeEnterBtn) return;
        btn.addEventListener('click', function () {
            showGoalModal();
        });
    });

    if (exitStudyBtn) {
        exitStudyBtn.addEventListener('click', function () {
            switchToSection('home');
        });
    }

    var goalCloseBtn = document.getElementById('goalCloseBtn');
    var goalCancelLink = document.getElementById('goalCancelLink');

    if (goalCloseBtn) {
        goalCloseBtn.addEventListener('click', function () {
            closeGoalModal();
        });
    }

    if (goalCancelLink) {
        goalCancelLink.addEventListener('click', function (e) {
            e.preventDefault();
            closeGoalModal();
        });
    }

    if (goalOverlay) {
        goalOverlay.addEventListener('click', function (e) {
            if (e.target === goalOverlay) closeGoalModal();
        });
    }

    // ---- Study Room Locked Modal ----
    var studyLockedCloseBtn = document.getElementById('studyLockedCloseBtn');
    var studyLockedPlanBtn = document.getElementById('studyLockedPlanBtn');

    if (studyLockedCloseBtn) {
        studyLockedCloseBtn.addEventListener('click', closeStudyLockedModal);
    }

    if (studyLockedOverlay) {
        studyLockedOverlay.addEventListener('click', function (e) {
            if (e.target === studyLockedOverlay) closeStudyLockedModal();
        });
    }

    if (studyLockedPlanBtn) {
        studyLockedPlanBtn.addEventListener('click', function () {
            closeStudyLockedModal();
            // Navigate to profile section and scroll to plan area
            var profileNavBtn = document.querySelector('.spa-nav-item[data-section="profile"]');
            if (profileNavBtn) profileNavBtn.click();
            setTimeout(function () {
                var planArea = document.querySelector('.profile-plan-area');
                if (planArea) planArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 200);
        });
    }

    // ---- Profile Edit Modal (Dynamic, single-field) ----
    var profileEditOverlay = document.getElementById('profileEditOverlay');
    var profileEditCloseBtn = document.getElementById('profileEditCloseBtn');
    var profileEditCancelLink = document.getElementById('profileEditCancelLink');
    var profileEditSaveBtn = document.getElementById('profileEditSaveBtn');
    var profileEditTitle = document.getElementById('profileEditTitle');
    var profileEditDesc = document.getElementById('profileEditDesc');
    var profileEditFieldWrap = document.getElementById('profileEditFieldWrap');

    var PROFILE_FIELDS = {
        nickname: {
            title: 'ニックネームの変更',
            desc: '自習室やレポートに表示される名前です。',
            type: 'text',
            placeholder: 'ニックネームを入力',
            maxlength: 64,
            displayId: 'profileDisplayName',
            apiKey: 'nickname',
            responseKey: 'name'
        },
        grade: {
            title: '学年の変更',
            desc: '現在の学年を選択してください。',
            type: 'select',
            options: [
                { value: '', label: '選択してください' },
                { value: '中学1年生', label: '中学1年生' },
                { value: '中学2年生', label: '中学2年生' },
                { value: '中学3年生', label: '中学3年生' },
                { value: '高校1年生', label: '高校1年生' },
                { value: '高校2年生', label: '高校2年生' },
                { value: '高校3年生', label: '高校3年生' },
                { value: '既卒', label: '既卒' },
                { value: 'その他', label: 'その他' }
            ],
            displayId: 'profileDisplayGrade',
            apiKey: 'grade',
            responseKey: 'grade'
        },
        target_school: {
            title: '志望校の変更',
            desc: '志望校を入力してください。',
            type: 'text',
            placeholder: '志望校を入力',
            maxlength: 128,
            displayId: 'profileDisplaySchool',
            apiKey: 'target_school',
            responseKey: 'target_school'
        }
    };

    var currentEditField = null;

    function openProfileEditModal(fieldKey, currentValue) {
        if (!profileEditOverlay || !PROFILE_FIELDS[fieldKey]) return;
        var cfg = PROFILE_FIELDS[fieldKey];
        currentEditField = fieldKey;

        if (profileEditTitle) profileEditTitle.textContent = cfg.title;
        if (profileEditDesc) profileEditDesc.textContent = cfg.desc;

        // Build input element dynamically
        if (profileEditFieldWrap) {
            profileEditFieldWrap.innerHTML = '';
            var label = document.createElement('label');
            label.className = 'profile-edit-label';
            label.textContent = cfg.title.replace('の変更', '');

            var input;
            if (cfg.type === 'select') {
                input = document.createElement('select');
                input.className = 'profile-edit-input profile-edit-select';
                input.id = 'profileEditInput';
                cfg.options.forEach(function (opt) {
                    var option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.label;
                    if (opt.value === currentValue) option.selected = true;
                    input.appendChild(option);
                });
            } else {
                input = document.createElement('input');
                input.type = 'text';
                input.className = 'profile-edit-input';
                input.id = 'profileEditInput';
                input.value = currentValue || '';
                input.placeholder = cfg.placeholder || '';
                if (cfg.maxlength) input.maxLength = cfg.maxlength;
            }

            label.setAttribute('for', 'profileEditInput');
            profileEditFieldWrap.appendChild(label);
            profileEditFieldWrap.appendChild(input);
        }

        if (profileEditSaveBtn) {
            profileEditSaveBtn.disabled = false;
            profileEditSaveBtn.textContent = '保存する';
        }

        profileEditOverlay.style.display = 'flex';

        // Focus the input after display
        setTimeout(function () {
            var inp = document.getElementById('profileEditInput');
            if (inp && inp.focus) inp.focus();
        }, 100);
    }

    function closeProfileEditModal() {
        if (!profileEditOverlay) return;
        profileEditOverlay.style.display = 'none';
        currentEditField = null;
    }

    // Bind rows
    document.querySelectorAll('.profile-row').forEach(function (row) {
        row.addEventListener('click', function () {
            var fieldKey = row.getAttribute('data-field');
            var currentValue = row.getAttribute('data-current') || '';
            openProfileEditModal(fieldKey, currentValue);
        });
    });

    if (profileEditCloseBtn) {
        profileEditCloseBtn.addEventListener('click', closeProfileEditModal);
    }

    if (profileEditCancelLink) {
        profileEditCancelLink.addEventListener('click', function (e) {
            e.preventDefault();
            closeProfileEditModal();
        });
    }

    if (profileEditOverlay) {
        profileEditOverlay.addEventListener('click', function (e) {
            if (e.target === profileEditOverlay) closeProfileEditModal();
        });
    }

    if (profileEditSaveBtn) {
        profileEditSaveBtn.addEventListener('click', function () {
            if (!currentEditField || !PROFILE_FIELDS[currentEditField]) return;
            var cfg = PROFILE_FIELDS[currentEditField];
            var input = document.getElementById('profileEditInput');
            if (!input) return;
            var newValue = (input.value || '').trim();

            profileEditSaveBtn.disabled = true;
            profileEditSaveBtn.textContent = '保存中…';

            var payload = {};
            payload[cfg.apiKey] = newValue;

            fetch('/api/update_profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.ok) {
                        // Update the display value in the list row
                        var displayEl = document.getElementById(cfg.displayId);
                        var displayValue = data[cfg.responseKey] || '';
                        if (displayEl) {
                            displayEl.textContent = displayValue || '未設定';
                            if (displayValue) {
                                displayEl.classList.remove('profile-row-placeholder');
                            } else {
                                displayEl.classList.add('profile-row-placeholder');
                            }
                        }

                        // Update data-current on the row
                        var row = document.querySelector('.profile-row[data-field="' + currentEditField + '"]');
                        if (row) row.setAttribute('data-current', displayValue);

                        // Update user name in profile header and home greeting
                        if (currentEditField === 'nickname') {
                            var userName = document.querySelector('.profile-user-name');
                            if (userName) userName.textContent = data.name || 'ユーザー';
                            var welcomeName = document.querySelector('.spa-home-wrapper h1');
                            if (welcomeName && data.name) {
                                welcomeName.textContent = 'おかえりなさい、' + data.name + ' さん';
                            }
                        }

                        closeProfileEditModal();
                    } else {
                        alert('保存に失敗しました。もう一度お試しください。');
                    }
                })
                .catch(function () {
                    alert('通信エラーが発生しました。');
                })
                .finally(function () {
                    profileEditSaveBtn.disabled = false;
                    profileEditSaveBtn.textContent = '保存する';
                });
        });
    }
})();

/* ===== Monthly Report Modal ===== */
(function () {
    'use strict';
    var btn = document.getElementById('reportMonthlyBtn');
    var overlay = document.getElementById('reportModalOverlay');
    var closeBtn = document.getElementById('reportModalClose');
    var titleEl = document.getElementById('reportModalTitle');
    var bodyEl = document.getElementById('reportModalBody');
    if (!btn || !overlay) return;

    function openModal() { overlay.classList.add('visible'); }
    function closeModal() { overlay.classList.remove('visible'); }

    closeBtn && closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    btn.addEventListener('click', function () {
        // Block free-plan users
        var isFree = !window.IS_SUBSCRIBED || !window.PLAN_TYPE || window.PLAN_TYPE === 'free' || window.SUBSCRIPTION_STATUS === 'none';
        if (isFree) {
            var lockedOverlay = document.getElementById('studyLockedOverlay');
            if (lockedOverlay) lockedOverlay.style.display = 'flex';
            return;
        }
        bodyEl.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:24px 0">読み込み中…</p>';
        openModal();

        fetch('/api/monthly_report', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                titleEl.textContent = (data.month_label || '先月') + ' 学習レポート';

                if (!data.has_data) {
                    bodyEl.innerHTML =
                        '<div class="report-modal-empty">' +
                        '  <span class="material-symbols-outlined report-modal-empty-icon">auto_stories</span>' +
                        '  <p class="report-modal-empty-msg">' +
                        '    先月の学習データはまだありません。<br>' +
                        '    今月から学習を記録して、<br>来月のレポート作成を楽しみにしましょう！' +
                        '  </p>' +
                        '  <div class="report-modal-stats">' +
                        '    <div class="report-modal-stat"><span class="report-modal-stat-label">累計学習時間</span><span class="report-modal-stat-value">--</span></div>' +
                        '    <div class="report-modal-stat"><span class="report-modal-stat-label">達成率</span><span class="report-modal-stat-value">--</span></div>' +
                        '  </div>' +
                        '</div>';
                    return;
                }

                var rpt = data.report;
                bodyEl.innerHTML =
                    '<div class="report-modal-data">' +
                    '  <div class="report-modal-stats">' +
                    '    <div class="report-modal-stat">' +
                    '      <span class="report-modal-stat-label">累計学習時間</span>' +
                    '      <span class="report-modal-stat-value">' + (rpt.total_display || '--') + '</span>' +
                    '    </div>' +
                    '    <div class="report-modal-stat">' +
                    '      <span class="report-modal-stat-label">月間日数</span>' +
                    '      <span class="report-modal-stat-value">' + (rpt.days_in_month || '--') + '日</span>' +
                    '    </div>' +
                    '  </div>' +
                    '  <p class="report-modal-note">学習記録が蓄積されるにつれ、詳細なレポートが生成されます。引き続き頑張りましょう！</p>' +
                    '</div>';
            })
            .catch(function () {
                bodyEl.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:24px 0">読み込みに失敗しました</p>';
            });
    });
})();

// ========== Privacy Policy Modal ==========
(function () {
    'use strict';
    var openBtn = document.getElementById('openPrivacyPolicy');
    var overlay = document.getElementById('privacyModalOverlay');
    var closeBtn = document.getElementById('privacyModalClose');
    if (!openBtn || !overlay) return;

    openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        overlay.style.display = 'flex';
    });
    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            overlay.style.display = 'none';
        });
    }
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.style.display = 'none';
    });
})();

// ========== Terms of Service Modal ==========
(function () {
    'use strict';
    var openBtn = document.getElementById('openTerms');
    var overlay = document.getElementById('termsModalOverlay');
    var closeBtn = document.getElementById('termsModalClose');
    if (!openBtn || !overlay) return;

    openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        overlay.style.display = 'flex';
    });
    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            overlay.style.display = 'none';
        });
    }
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.style.display = 'none';
    });
})();

// ========== Disclaimer Modal ==========
(function () {
    'use strict';
    var openBtn = document.getElementById('openDisclaimer');
    var overlay = document.getElementById('disclaimerModalOverlay');
    var closeBtn = document.getElementById('disclaimerModalClose');
    if (!openBtn || !overlay) return;

    openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        overlay.style.display = 'flex';
    });
    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            overlay.style.display = 'none';
        });
    }
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.style.display = 'none';
    });
})();

// ========== Paywall Logic ==========
(function () {
    'use strict';

    function checkPaywalls() {
        if (!window.IS_LOGGED_IN) return;

        // Route section requires Pro plan (not just any paid plan)
        var isNotPro = window.PLAN_TYPE !== 'pro';

        var sectionRoute = document.getElementById('section-route');
        var routeOverlay = document.getElementById('routeLockedOverlay');

        if (sectionRoute && routeOverlay) {
            if (isNotPro) {
                sectionRoute.classList.add('is-locked');
                routeOverlay.style.display = 'flex';
                // Update overlay text to Pro-specific message
                var overlayTitle = routeOverlay.querySelector('.locked-overlay-title');
                var overlayDesc = routeOverlay.querySelector('.locked-overlay-desc');
                if (overlayTitle) overlayTitle.textContent = 'この機能はProプラン限定です';
                if (overlayDesc) overlayDesc.textContent = 'あなた専用の学習ルート作成や、メンターとの定期面談を利用するには、Proプランへのアップグレードが必要です。';
            } else {
                sectionRoute.classList.remove('is-locked');
                routeOverlay.style.display = 'none';
            }
        }
    }

    // Run on init
    checkPaywalls();

    // Handle overlay button click to jump to profile settings
    var lockedOverlayBtn = document.getElementById('lockedOverlayBtn');
    if (lockedOverlayBtn) {
        lockedOverlayBtn.addEventListener('click', function () {
            var profileNavBtn = document.querySelector('.spa-nav-item[data-section="profile"]');
            if (profileNavBtn) {
                profileNavBtn.click();
            }
        });
    }
})();

// ========== Logout Button ==========
(function () {
    'use strict';
    var logoutBtn = document.getElementById('btnLogout');
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (confirm('ログアウトしますか？')) {
            window.location.href = '/logout';
        }
    });
})();

// ========== Checkout Button BFCache Reset ==========
window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return; // Only act on BFCache restore
    var checkoutBtns = document.querySelectorAll('.js-checkout-btn');
    checkoutBtns.forEach(function (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
        var plan = btn.getAttribute('data-plan');
        if (plan === 'standard') {
            btn.innerHTML =
                '<span style="display:flex;flex-direction:column;align-items:flex-start;gap:2px">' +
                '<span style="font-size:14px;font-weight:600">Standardプランを7日間無料で試す</span>' +
                '<span style="font-size:11px;opacity:0.8">月額 24,800円（税込）</span>' +
                '</span>' +
                '<span class="material-symbols-outlined">arrow_forward</span>';
        } else if (plan === 'pro') {
            btn.innerHTML =
                '<span style="display:flex;flex-direction:column;align-items:flex-start;gap:2px">' +
                '<span style="font-size:14px;font-weight:600">Proプランを7日間無料で試す</span>' +
                '<span style="font-size:11px;opacity:0.7">月額 49,800円（税込）</span>' +
                '</span>' +
                '<span class="material-symbols-outlined">arrow_forward</span>';
        }
    });
});
