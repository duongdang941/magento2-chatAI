/** windowMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.windowMethods = function (context) {
const { config, urls } = context;
const {
    sanitizeHtml,
    hydrateProductGridHtml,
    getBrowserFormKey,
    resolveWebSocketUrl,
    PET_SPRITESHEET_COLUMNS,
    PET_SPRITESHEET_ROWS,
    PET_FRAME_LIBRARY,
    petFramePosition,
    IMAGE_UPLOAD_MAX_BYTES,
    IMAGE_UPLOAD_MAX_COUNT,
    IMAGE_UPLOAD_TYPES,
    MAX_MODEL_HISTORY_MESSAGES
} = context.helpers;

        return {
            launcherStyle() {
                if (!this.launcherPosition) {
                    return {
                        left: 'auto',
                        top: 'auto',
                        right: '1.5rem',
                        bottom: '1.5rem'
                    };
                }
                return {
                    left: this.launcherPosition.x + 'px',
                    top: this.launcherPosition.y + 'px',
                    right: 'auto',
                    bottom: 'auto'
                };
            },

            isLauncherOnLeft() {
                return this.launcherPosition ? this.launcherPosition.x < (window.innerWidth / 2) : false;
            },

            isLauncherOnTop() {
                return this.launcherPosition ? this.launcherPosition.y < (window.innerHeight / 2) : false;
            },

            restoreLauncherPosition() {
                try {
                    const raw = localStorage.getItem(this.launcherStorageKey);
                    if (!raw) return;
                    const parsed = JSON.parse(raw);
                    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                        this.launcherPosition = this.clampLauncherCoordinates(parsed.x, parsed.y);
                    }
                } catch (e) {}
            },

            saveLauncherPosition() {
                if (!this.launcherPosition) return;
                try {
                    localStorage.setItem(this.launcherStorageKey, JSON.stringify(this.launcherPosition));
                } catch (e) {}
            },

            resetLauncherPosition() {
                this.launcherPosition = null;
                try {
                    localStorage.removeItem(this.launcherStorageKey);
                } catch (e) {}
            },

            clampLauncherPosition() {
                if (!this.launcherPosition) return;
                this.launcherPosition = this.clampLauncherCoordinates(this.launcherPosition.x, this.launcherPosition.y);
                this.saveLauncherPosition();
            },

            canManipulateChatWindow() {
                const hasCoarsePointer = typeof window.matchMedia === 'function'
                    && window.matchMedia('(pointer: coarse)').matches;

                // A narrow desktop window still needs drag/resize. Touch-first
                // devices use the dedicated full-screen mobile experience instead.
                return window.innerWidth > 640 && window.innerHeight >= 520 && !hasCoarsePointer;
            },

            isCompactViewport() {
                return this.getResponsiveWindowWidth() <= 820;
            },

            isNarrowViewport() {
                return this.getResponsiveWindowWidth() <= 460;
            },

            isTinyViewport() {
                return this.getResponsiveWindowWidth() <= 390;
            },

            getResponsiveWindowWidth() {
                const fallbackWidth = this.chatWindowLayout?.width
                    || Math.min(1040, Math.max(320, window.innerWidth - 16));
                return this.chatWindowWidth || fallbackWidth;
            },

            isMobileLayout() {
                const hasCoarsePointer = typeof window.matchMedia === 'function'
                    && window.matchMedia('(pointer: coarse)').matches;
                // A narrow desktop chat window uses the same overlay drawer as
                // touch devices, so its sidebar never takes space from content.
                return this.isCompactViewport() || window.innerWidth <= 640 || hasCoarsePointer;
            },

            observeChatWindowWidth() {
                const shell = this.$refs.chatWindowShell;
                if (!shell) return;

                const updateWidth = (width) => {
                    this.chatWindowWidth = Math.round(width);
                    this.syncCompactSidebarState();
                };

                updateWidth(shell.getBoundingClientRect().width);
                if (typeof ResizeObserver !== 'undefined') {
                    this.chatWindowResizeObserver?.disconnect();
                    this.chatWindowResizeObserver = new ResizeObserver(entries => {
                        entries.forEach(entry => updateWidth(entry.contentRect.width));
                    });
                    this.chatWindowResizeObserver.observe(shell);
                }
            },

            syncCompactSidebarState() {
                if (!this.isCompactViewport()) this.closeMobileSidebar();
            },

            toggleMobileSidebar() {
                if (!this.isCompactViewport()) return;
                this.isMobileSidebarOpen = !this.isMobileSidebarOpen;
            },

            closeMobileSidebar() {
                this.isMobileSidebarOpen = false;
            },

            getChatWindowBounds() {
                const margin = 16;
                const maxWidth = Math.max(320, window.innerWidth - (margin * 2));
                const maxHeight = Math.max(320, window.innerHeight - (margin * 2));
                return {
                    margin,
                    // Desktop windows can shrink into the narrow layout. Below
                    // this point a full-screen touch layout is more usable.
                    minWidth: Math.min(360, maxWidth),
                    minHeight: Math.min(460, maxHeight),
                    maxWidth,
                    maxHeight
                };
            },

            normalizeChatWindowLayout(layout) {
                const bounds = this.getChatWindowBounds();
                const width = Math.min(Math.max(Number(layout.width) || bounds.maxWidth, bounds.minWidth), bounds.maxWidth);
                const height = Math.min(Math.max(Number(layout.height) || bounds.maxHeight, bounds.minHeight), bounds.maxHeight);
                const maxX = Math.max(bounds.margin, window.innerWidth - width - bounds.margin);
                const maxY = Math.max(bounds.margin, window.innerHeight - height - bounds.margin);

                return {
                    x: Math.min(Math.max(bounds.margin, Number(layout.x) || bounds.margin), maxX),
                    y: Math.min(Math.max(bounds.margin, Number(layout.y) || bounds.margin), maxY),
                    width,
                    height
                };
            },

            getCurrentChatWindowLayout() {
                const shell = this.$refs.chatWindowShell;
                if (shell) {
                    const rect = shell.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return this.normalizeChatWindowLayout({
                            x: rect.left,
                            y: rect.top,
                            width: rect.width,
                            height: rect.height
                        });
                    }
                }

                const bounds = this.getChatWindowBounds();
                return this.normalizeChatWindowLayout({
                    x: (window.innerWidth - bounds.maxWidth) / 2,
                    y: (window.innerHeight - bounds.maxHeight) / 2,
                    width: bounds.maxWidth,
                    height: bounds.maxHeight
                });
            },

            chatWindowStyle() {
                if (!this.chatWindowLayout || !this.canManipulateChatWindow()) return '';
                const layout = this.normalizeChatWindowLayout(this.chatWindowLayout);
                return 'left:' + layout.x + 'px;top:' + layout.y + 'px;width:' + layout.width + 'px;height:' + layout.height + 'px;transform:none;';
            },

            restoreChatWindowLayout() {
                try {
                    const raw = localStorage.getItem(this.chatWindowStorageKey);
                    if (!raw) return;
                    const layout = JSON.parse(raw);
                    if (['x', 'y', 'width', 'height'].every(key => Number.isFinite(layout[key]))) {
                        this.chatWindowLayout = this.normalizeChatWindowLayout(layout);
                    }
                } catch (e) {}
            },

            saveChatWindowLayout() {
                if (!this.chatWindowLayout) return;
                try {
                    localStorage.setItem(this.chatWindowStorageKey, JSON.stringify(this.chatWindowLayout));
                } catch (e) {}
            },

            clampChatWindowLayout() {
                if (!this.chatWindowLayout) return;
                this.chatWindowLayout = this.normalizeChatWindowLayout(this.chatWindowLayout);
                this.saveChatWindowLayout();
            },

            startChatWindowDrag(event) {
                if (!this.canManipulateChatWindow() || (event.pointerType === 'mouse' && event.button !== 0)) return;
                if (event.target.closest('button, a, input, textarea, select, label')) return;

                const layout = this.getCurrentChatWindowLayout();
                this.chatWindowLayout = layout;
                this.chatWindowInteraction = {
                    pointerId: event.pointerId,
                    mode: 'drag',
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: layout
                };
                this.isWindowDragging = true;

                if (event.currentTarget.setPointerCapture) {
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
                }
                event.preventDefault();
            },

            startChatWindowResize(event, direction) {
                if (!this.canManipulateChatWindow() || (event.pointerType === 'mouse' && event.button !== 0)) return;

                const layout = this.getCurrentChatWindowLayout();
                this.chatWindowLayout = layout;
                this.chatWindowInteraction = {
                    pointerId: event.pointerId,
                    mode: 'resize',
                    direction,
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: layout
                };
                this.isWindowResizing = true;

                if (event.currentTarget.setPointerCapture) {
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
                }
            },

            moveChatWindow(event) {
                const interaction = this.chatWindowInteraction;
                if (!interaction || event.pointerId !== interaction.pointerId) return;

                const dx = event.clientX - interaction.startX;
                const dy = event.clientY - interaction.startY;
                const origin = interaction.origin;

                if (interaction.mode === 'drag') {
                    this.chatWindowLayout = this.normalizeChatWindowLayout({
                        x: origin.x + dx,
                        y: origin.y + dy,
                        width: origin.width,
                        height: origin.height
                    });
                    event.preventDefault();
                    return;
                }

                const bounds = this.getChatWindowBounds();
                const right = origin.x + origin.width;
                const bottom = origin.y + origin.height;
                let left = origin.x;
                let top = origin.y;
                let nextRight = right;
                let nextBottom = bottom;
                const direction = interaction.direction;

                if (direction.includes('w')) {
                    left = Math.min(Math.max(bounds.margin, origin.x + dx), right - bounds.minWidth);
                }
                if (direction.includes('e')) {
                    nextRight = Math.max(origin.x + bounds.minWidth, Math.min(window.innerWidth - bounds.margin, right + dx));
                }
                if (direction.includes('n')) {
                    top = Math.min(Math.max(bounds.margin, origin.y + dy), bottom - bounds.minHeight);
                }
                if (direction.includes('s')) {
                    nextBottom = Math.max(origin.y + bounds.minHeight, Math.min(window.innerHeight - bounds.margin, bottom + dy));
                }

                this.chatWindowLayout = this.normalizeChatWindowLayout({
                    x: left,
                    y: top,
                    width: nextRight - left,
                    height: nextBottom - top
                });
                event.preventDefault();
            },

            endChatWindowInteraction(event) {
                if (!this.chatWindowInteraction || event.pointerId !== this.chatWindowInteraction.pointerId) return;

                this.clampChatWindowLayout();
                this.saveChatWindowLayout();
                this.chatWindowInteraction = null;
                this.isWindowDragging = false;
                this.isWindowResizing = false;
                this.$nextTick(() => this.syncCompactSidebarState());
            },

            getLauncherDimensions() {
                const root = this.$el || document.querySelector('.afd-ai-chat');
                if (root) {
                    const rect = root.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return { width: rect.width, height: rect.height };
                    }
                }
                return { width: 80, height: 87 };
            },

            clampLauncherCoordinates(x, y) {
                const margin = 10;
                const size = this.getLauncherDimensions();
                const maxX = Math.max(margin, window.innerWidth - size.width - margin);
                const maxY = Math.max(margin, window.innerHeight - size.height - margin);
                return {
                    x: Math.min(Math.max(margin, x), maxX),
                    y: Math.min(Math.max(margin, y), maxY)
                };
            },

            startLauncherDrag(event) {
                if (event.pointerType === 'mouse' && event.button !== 0) return;

                const root = event.currentTarget.closest('.afd-ai-chat');
                if (!root) return;

                const rect = root.getBoundingClientRect();
                this.dragStart = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    originX: rect.left,
                    originY: rect.top
                };
                this.isDragging = true;
                this.dragMoved = false;
                this.suppressLauncherClick = false;
                this.setPetDragState('running');

                if (event.currentTarget.setPointerCapture) {
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
                }
            },

            moveLauncher(event) {
                if (!this.isDragging || !this.dragStart || event.pointerId !== this.dragStart.pointerId) return;

                const dx = event.clientX - this.dragStart.startX;
                const dy = event.clientY - this.dragStart.startY;
                if (!this.dragMoved && Math.hypot(dx, dy) < 5) return;

                const previousX = Number.isFinite(this.dragStart.lastX) ? this.dragStart.lastX : this.dragStart.startX;
                const stepX = event.clientX - previousX;
                this.dragStart.lastX = event.clientX;
                this.dragMoved = true;
                this.launcherPosition = this.clampLauncherCoordinates(
                    this.dragStart.originX + dx,
                    this.dragStart.originY + dy
                );
                if (stepX >= 4) {
                    this.setPetDragState('running-right');
                } else if (stepX <= -4) {
                    this.setPetDragState('running-left');
                } else if (!this.petDragState) {
                    this.setPetDragState('running');
                }
                event.preventDefault();
            },

            endLauncherDrag(event) {
                if (!this.isDragging || !this.dragStart || event.pointerId !== this.dragStart.pointerId) return;

                this.isDragging = false;
                this.setPetDragState(null);
                this.suppressLauncherClick = this.dragMoved;
                if (this.dragMoved) {
                    this.saveLauncherPosition();
                }
                this.dragStart = null;
                this.dragMoved = false;

                if (this.suppressLauncherClick) {
                    setTimeout(() => { this.suppressLauncherClick = false; }, 0);
                }
            },

            handleLauncherClick(event) {
                if (this.suppressLauncherClick) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                this.toggleChat();
            },
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
