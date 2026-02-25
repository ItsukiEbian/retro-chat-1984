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

    function activateStudyRoom() {
        switchToSection('study');
        studyRoomInitialized = true;

        fetch('/api/enter_room', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    }

    function deactivateStudyRoom() {
        if (typeof window.teardownStudyRoom === 'function') {
            window.teardownStudyRoom();
        }
        studyRoomInitialized = false;

        fetch('/api/exit_room', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    }

    window._onStudyRoomReady = function () {
        activateStudyRoom();
    };

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

    if (exitStudyBtn) {
        exitStudyBtn.addEventListener('click', function () {
            switchToSection('home');
        });
    }
})();
