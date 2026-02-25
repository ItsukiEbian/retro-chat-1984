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

        currentSection = sectionId;
    }

    // ========== Login Gate ==========

    function requireLogin() {
        if (window.IS_LOGGED_IN) return true;
        window.location.href = '/login/google';
        return false;
    }

    // ========== Study Room Activation ==========

    function showGoalModal() {
        if (!requireLogin()) return;
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
            }).catch(function () {});
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
            .catch(function () {});
    }

    function activateStudyRoom() {
        switchToSection('study');
        studyRoomInitialized = true;
        fetch('/api/enter_room', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
        startStudyTimer();
    }

    function deactivateStudyRoom() {
        stopStudyTimer();
        if (typeof window.teardownStudyRoom === 'function') {
            window.teardownStudyRoom();
        }
        studyRoomInitialized = false;
        fetch('/api/exit_room', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
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

    // ---- Profile Edit Modal ----
    var profileEditOverlay = document.getElementById('profileEditOverlay');
    var profileEditBtn = document.getElementById('profileEditBtn');
    var profileEditCloseBtn = document.getElementById('profileEditCloseBtn');
    var profileEditCancelLink = document.getElementById('profileEditCancelLink');
    var profileEditSaveBtn = document.getElementById('profileEditSaveBtn');

    function openProfileEditModal() {
        if (!profileEditOverlay) return;
        var gradeSelect = document.getElementById('profileEditGrade');
        if (gradeSelect) {
            var current = (document.getElementById('profileDisplayGrade') || {}).textContent || '';
            current = current.trim();
            for (var i = 0; i < gradeSelect.options.length; i++) {
                if (gradeSelect.options[i].value === current) {
                    gradeSelect.selectedIndex = i;
                    break;
                }
            }
        }
        profileEditOverlay.style.display = 'flex';
    }

    function closeProfileEditModal() {
        if (!profileEditOverlay) return;
        profileEditOverlay.style.display = 'none';
    }

    if (profileEditBtn) {
        profileEditBtn.addEventListener('click', openProfileEditModal);
    }

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
            var nickname = (document.getElementById('profileEditName') || {}).value || '';
            var grade = (document.getElementById('profileEditGrade') || {}).value || '';
            var school = (document.getElementById('profileEditSchool') || {}).value || '';

            profileEditSaveBtn.disabled = true;
            profileEditSaveBtn.textContent = '保存中…';

            fetch('/api/update_profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nickname: nickname,
                    grade: grade,
                    target_school: school
                })
            })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.ok) {
                    var dn = document.getElementById('profileDisplayName');
                    var dg = document.getElementById('profileDisplayGrade');
                    var ds = document.getElementById('profileDisplaySchool');
                    if (dn) dn.textContent = data.name || '未設定';
                    if (dg) dg.textContent = data.grade || '未設定';
                    if (ds) ds.textContent = data.target_school || '未設定';

                    var welcomeName = document.querySelector('.spa-home-wrapper h1');
                    if (welcomeName && data.name) {
                        welcomeName.innerHTML = data.name + 'さん、<br>お帰りなさい。';
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
