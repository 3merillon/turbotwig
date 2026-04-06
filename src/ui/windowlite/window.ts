/**
 * Window - A draggable, resizable window component.
 * Adapted from windowlite for planets project.
 *
 * Features kept: drag, resize, minimize/restore, show/hide, focus/blur, content management
 * Removed: close, maximize, minimizeTarget, persistence, icons, animations, blockContextMenu
 */

export interface WindowOptions {
    container: HTMLElement;
    id: string;
    title: string;
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number | null;
    maxHeight?: number | null;
    absoluteMinWidth?: number;
    absoluteMinHeight?: number;
    x?: number;
    y?: number;
    resizable?: boolean;
    draggable?: boolean;
    minimizable?: boolean;
    dockable?: boolean;
    safeMargin?: number;
    constrainToContainer?: boolean;
    fitContent?: boolean;
    icon?: string;
    className?: string;
    onShow?: () => void;
    onHide?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onResize?: (width: number, height: number) => void;
    onMove?: (x: number, y: number) => void;
    onMinimize?: () => void;
    onRestore?: () => void;
    onDock?: () => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}

const DEFAULT_OPTIONS: Omit<Required<WindowOptions>, 'container' | 'id' | 'title' | 'onShow' | 'onHide' | 'onFocus' | 'onBlur' | 'onResize' | 'onMove' | 'onMinimize' | 'onRestore' | 'onDock' | 'onDragStart' | 'onDragEnd'> = {
    width: 400,
    height: 300,
    minWidth: 200,
    minHeight: 48,
    maxWidth: null,
    maxHeight: null,
    absoluteMinWidth: 60,
    absoluteMinHeight: 48,
    x: 50,
    y: 50,
    resizable: true,
    draggable: true,
    minimizable: true,
    dockable: true,
    safeMargin: 8,
    constrainToContainer: true,
    fitContent: true,
    icon: '',
    className: '',
};

export class Window {
    readonly id: string;
    readonly title: string;
    element!: HTMLDivElement;
    header!: HTMLDivElement;
    content!: HTMLDivElement;
    readonly container: HTMLElement;
    options: WindowOptions & typeof DEFAULT_OPTIONS;

    isDragging = false;
    isResizing = false;
    private resizeDirection: string | null = null;
    private _activeHandle: HTMLElement | null = null;
    private _activePointerId: number | null = null;
    private _focused = false;
    private _minimized = false;

    // Fluid drag: natural height before any compression
    private _naturalHeight: number | null = null;

    // Drag state
    private dragStartX = 0;
    private dragStartY = 0;

    // Resize state
    private startX = 0;
    private startY = 0;
    private startWidth = 0;
    private startHeight = 0;
    private startLeft = 0;
    private startTop = 0;

    // Minimize restore state
    private _restoreHeight: number | null = null;

    // Static global pointer handler state
    private static _globalsInstalled = false;
    static _active: { win: Window; mode: 'drag' | 'resize'; pointerId: number | null } | null = null;

    constructor(options: WindowOptions) {
        if (!options.container) throw new Error('Window: container is required');
        if (!options.id) throw new Error('Window: id is required');
        if (!options.title) throw new Error('Window: title is required');

        this.options = { ...DEFAULT_OPTIONS, ...options } as any;
        this.container = options.container;
        this.id = options.id;
        this.title = options.title;

        // Ensure container has positioning context
        const containerPosition = getComputedStyle(this.container).position;
        if (containerPosition === 'static') {
            this.container.style.position = 'relative';
        }

        this._createWindow();
        this._attachEventListeners();

        // Ensure window fits after creation
        setTimeout(() => this.ensureFitInContainer(true), 0);
    }

    private _createWindow(): void {
        this.element = document.createElement('div');
        this.element.className = 'wl-window';
        if (this.options.className) {
            this.element.classList.add(...this.options.className.split(' ').filter(Boolean));
        }
        this.element.id = `wl-${this.id}`;
        this.element.style.width = `${this.options.width}px`;
        this.element.style.height = `${this.options.height}px`;
        this.element.style.left = `${this.options.x}px`;
        this.element.style.top = `${this.options.y}px`;
        this.element.style.zIndex = '1000';
        this.element.setAttribute('role', 'dialog');
        this.element.setAttribute('aria-labelledby', `wl-title-${this.id}`);

        // Header
        this.header = document.createElement('div');
        this.header.className = 'wl-header';
        if (this.options.draggable) this.header.style.touchAction = 'none';

        const titleContainer = document.createElement('div');
        titleContainer.className = 'wl-title-container';

        // Collapse chevron (rotates when minimized)
        const chevron = document.createElement('div');
        chevron.className = 'wl-section-chevron';
        chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,1 6,4 2,7"/></svg>';
        titleContainer.appendChild(chevron);

        if (this.options.icon) {
            const iconEl = document.createElement('div');
            iconEl.className = 'wl-icon';
            // Sanitize SVG icon: parse as HTML and only adopt safe nodes
            const parsed = new DOMParser().parseFromString(this.options.icon, 'text/html');
            while (parsed.body.firstChild) iconEl.appendChild(document.adoptNode(parsed.body.firstChild));
            titleContainer.appendChild(iconEl);
        }

        const titleEl = document.createElement('div');
        titleEl.className = 'wl-title';
        titleEl.id = `wl-title-${this.id}`;
        titleEl.textContent = this.title;
        titleContainer.appendChild(titleEl);

        this.header.appendChild(titleContainer);

        if (this.options.minimizable) {
            const controls = document.createElement('div');
            controls.className = 'wl-controls';

            // Minimize/Restore button — toggles between − and □
            const minBtn = document.createElement('button');
            minBtn.className = 'wl-minimize-btn wl-minrestore-btn';
            const minIcon = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="5" x2="8" y2="5"/></svg>';
            const restoreIcon = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="6" height="6" rx="0.5"/></svg>';
            minBtn.innerHTML = minIcon;
            minBtn.setAttribute('aria-label', 'Minimize window');
            minBtn.setAttribute('type', 'button');
            minBtn.onclick = (e) => {
                e.stopPropagation();
                this.toggleMinimize();
                minBtn.innerHTML = this._minimized ? restoreIcon : minIcon;
                minBtn.setAttribute('aria-label', this._minimized ? 'Restore window' : 'Minimize window');
            };
            controls.appendChild(minBtn);

            // Dock button (×) — docks window back to sidebar (only for dockable windows)
            if (this.options.dockable !== false) {
                const dockBtn = document.createElement('button');
                dockBtn.className = 'wl-minimize-btn wl-dock-btn';
                dockBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';
                dockBtn.setAttribute('aria-label', 'Dock to sidebar');
                dockBtn.setAttribute('type', 'button');
                dockBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.options.onDock?.();
                };
                controls.appendChild(dockBtn);
            }

            this.header.appendChild(controls);
        }

        // Content area
        this.content = document.createElement('div');
        this.content.className = 'wl-content';

        // Resize handles
        if (this.options.resizable) {
            const directions = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
            directions.forEach(dir => {
                const handle = document.createElement('div');
                handle.className = `wl-resize wl-resize-${dir}`;
                handle.dataset.direction = dir;
                handle.style.touchAction = 'none';
                this.element.appendChild(handle);
            });
        }

        this.element.appendChild(this.header);
        this.element.appendChild(this.content);
        this.container.appendChild(this.element);
    }

    private _attachEventListeners(): void {
        Window._installGlobalPointerHandlers();

        if (this.options.draggable) {
            this.header.addEventListener('pointerdown', (e) => this._startDrag(e), { passive: false });
        }

        if (this.options.resizable) {
            this.element.addEventListener('pointerdown', (e) => {
                const handle = (e.target as HTMLElement).closest('.wl-resize') as HTMLElement | null;
                if (handle) {
                    this._startResize(e, handle);
                }
            }, { passive: false });
        }

        this.element.addEventListener('pointerdown', () => this.focus(), { passive: true });
    }

    private static _installGlobalPointerHandlers(): void {
        if (Window._globalsInstalled) return;
        Window._globalsInstalled = true;
        Window._active = null;

        const onMove = (e: PointerEvent) => {
            const a = Window._active;
            if (!a || !a.win) return;
            if (a.pointerId != null && e.pointerId != null && e.pointerId !== a.pointerId) return;
            if (a.mode === 'drag') a.win._drag(e);
            else if (a.mode === 'resize') a.win._resize(e);
        };

        const onUp = (e: PointerEvent) => {
            const a = Window._active;
            if (!a || !a.win) return;
            if (a.pointerId != null && e.pointerId != null && e.pointerId !== a.pointerId) return;
            try {
                if (a.mode === 'drag') a.win._stopDrag();
                else if (a.mode === 'resize') a.win._stopResize();
            } finally {
                Window._active = null;
            }
        };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup', onUp, { passive: true });
        document.addEventListener('pointercancel', onUp, { passive: true });
    }

    private _getContainerBounds(): { width: number; height: number } {
        const rect = this.container.getBoundingClientRect();
        return {
            width: this.container.clientWidth || rect.width,
            height: this.container.clientHeight || rect.height,
        };
    }

    // =========================================
    // DRAG
    // =========================================

    // Last known client coordinates during drag (for external listeners)
    lastDragClientX = 0;
    lastDragClientY = 0;

    // Deferred drag: only engage after 5px movement (allows header click for collapse)
    private _dragPendingStart = false;
    private _dragOriginX = 0;
    private _dragOriginY = 0;

    _startDrag(e: PointerEvent): void {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.wl-minimize-btn')) return;

        e.preventDefault();
        this.focus();

        // Don't engage drag yet — wait for movement threshold
        this._dragPendingStart = true;
        this._dragOriginX = e.clientX;
        this._dragOriginY = e.clientY;
        this._activePointerId = e.pointerId ?? null;
        Window._active = { win: this, mode: 'drag', pointerId: this._activePointerId };

        if (this._activePointerId != null && this.element.setPointerCapture) {
            try { this.element.setPointerCapture(this._activePointerId); } catch {}
        }
    }

    private _engageDrag(e: PointerEvent): void {
        this._dragPendingStart = false;
        this.isDragging = true;

        const containerRect = this.container.getBoundingClientRect();
        this.dragStartX = this._dragOriginX - containerRect.left - this.element.offsetLeft;
        this.dragStartY = this._dragOriginY - containerRect.top - this.element.offsetTop;

        // Store natural height for fluid drag
        this._naturalHeight = this.element.offsetHeight;

        this.element.classList.add('wl-dragging');
        this.element.style.cursor = 'move';
        document.body.style.cursor = 'move';

        this.lastDragClientX = e.clientX;
        this.lastDragClientY = e.clientY;
        this.options.onDragStart?.();
        this._dispatchDragEvent('dragstart', e.clientX, e.clientY);
    }

    /**
     * Start drag programmatically (for seamless detach transfer).
     * Call this after creating a window to put it into active drag mode.
     */
    startDragProgrammatic(clientX: number, clientY: number): void {
        this.isDragging = true;
        Window._active = { win: this, mode: 'drag', pointerId: null };
        this._naturalHeight = this.element.offsetHeight;

        const containerRect = this.container.getBoundingClientRect();
        this.dragStartX = 10;
        this.dragStartY = 10;

        // Position window at cursor
        const x = clientX - containerRect.left - this.dragStartX;
        const y = clientY - containerRect.top - this.dragStartY;
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;

        this.element.classList.add('wl-dragging');
        this.element.style.cursor = 'move';
        document.body.style.cursor = 'move';

        this.lastDragClientX = clientX;
        this.lastDragClientY = clientY;
        this.options.onDragStart?.();
        this._dispatchDragEvent('dragstart', clientX, clientY);
    }

    private _drag(e: PointerEvent): void {
        // Check if we need to engage drag (movement threshold)
        if (this._dragPendingStart) {
            const dx = Math.abs(e.clientX - this._dragOriginX);
            const dy = Math.abs(e.clientY - this._dragOriginY);
            if (dx < 5 && dy < 5) return;
            this._engageDrag(e);
        }
        if (!this.isDragging) return;

        const containerRect = this.container.getBoundingClientRect();
        const margin = this.options.safeMargin;
        const w = this.element.offsetWidth;

        // Use visual viewport for mobile-correct screen dimensions
        const vp = window.visualViewport;
        const viewW = vp ? vp.width : window.innerWidth;
        const viewH = vp ? vp.height : window.innerHeight;

        let newX = e.clientX - containerRect.left - this.dragStartX;
        let newY = e.clientY - containerRect.top - this.dragStartY;

        // Clamp X to screen edges
        if (this.options.constrainToContainer) {
            newX = Math.max(margin, Math.min(newX, viewW - w - margin));
        }

        // Clamp Y: top edge stays on screen, header always fully visible
        const headerH = this.header.offsetHeight;
        newY = Math.max(margin, Math.min(newY, viewH - headerH - margin));

        this.element.style.left = `${newX}px`;
        this.element.style.top = `${newY}px`;

        // Fluid height: compress window if it overflows the bottom, expand back when pulled up
        if (this._naturalHeight != null && !this._minimized) {
            const availH = viewH - margin - newY;
            const headerH = this.header.offsetHeight;
            const minH = Math.max(headerH, this.options.absoluteMinHeight || headerH);

            if (availH < this._naturalHeight) {
                // Compress: shrink window, content scrolls within remaining space
                this.element.style.height = `${Math.max(minH, availH)}px`;
            } else {
                // Expand back to natural height
                this.element.style.height = `${this._naturalHeight}px`;
            }
        }

        this.lastDragClientX = e.clientX;
        this.lastDragClientY = e.clientY;
        this.options.onMove?.(newX, newY);
        this._dispatchDragEvent('dragmove', e.clientX, e.clientY);
    }

    private _stopDrag(): void {
        const wasDragging = this.isDragging;

        this.isDragging = false;
        this._dragPendingStart = false;
        this._naturalHeight = null;
        this.element.classList.remove('wl-dragging');
        this.element.style.cursor = '';
        document.body.style.cursor = '';

        if (this._activePointerId != null && this.element.releasePointerCapture) {
            try { this.element.releasePointerCapture(this._activePointerId); } catch {}
        }
        this._activePointerId = null;

        if (wasDragging) {
            this._dispatchDragEvent('dragend', this.lastDragClientX, this.lastDragClientY);
            this.options.onDragEnd?.();
        }
    }

    private _dispatchDragEvent(type: string, clientX: number, clientY: number): void {
        try {
            this.element.dispatchEvent(new CustomEvent(`wl-window-${type}`, {
                bubbles: true,
                detail: { id: this.id, window: this, clientX, clientY }
            }));
        } catch {}
    }

    // =========================================
    // RESIZE
    // =========================================

    private _startResize(e: PointerEvent, handle: HTMLElement): void {
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        this.isResizing = true;
        this.resizeDirection = handle.dataset.direction!;
        this._activeHandle = handle;
        this.focus();

        this._activePointerId = e.pointerId ?? null;
        Window._active = { win: this, mode: 'resize', pointerId: this._activePointerId };

        const containerRect = this.container.getBoundingClientRect();
        this.startX = e.clientX - containerRect.left;
        this.startY = e.clientY - containerRect.top;
        this.startWidth = this.element.offsetWidth;
        this.startHeight = this.element.offsetHeight;
        this.startLeft = this.element.offsetLeft;
        this.startTop = this.element.offsetTop;

        this.element.classList.add('wl-resizing');
        handle.classList.add('wl-resizing');

        if (this._activePointerId != null && this.element.setPointerCapture) {
            try { this.element.setPointerCapture(this._activePointerId); } catch {}
        }
    }

    private _resize(e: PointerEvent): void {
        if (!this.isResizing) return;

        const containerRect = this.container.getBoundingClientRect();
        const clientX = e.clientX - containerRect.left;
        const clientY = e.clientY - containerRect.top;
        const deltaX = clientX - this.startX;
        const deltaY = clientY - this.startY;
        let dir = this.resizeDirection!;

        // When minimized to header, only allow horizontal resize
        if (this._minimized) {
            dir = dir.replace('n', '').replace('s', '');
            if (!dir) return;
        }

        const bounds = this._getContainerBounds();
        const margin = this.options.safeMargin;

        let left = this.startLeft;
        let top = this.startTop;
        let right = this.startLeft + this.startWidth;
        let bottom = this.startTop + this.startHeight;

        if (dir.includes('e')) right = this.startLeft + this.startWidth + deltaX;
        if (dir.includes('w')) left = this.startLeft + deltaX;
        if (dir.includes('s')) bottom = this.startTop + this.startHeight + deltaY;
        if (dir.includes('n')) top = this.startTop + deltaY;

        // Container bounds
        if (this.options.constrainToContainer) {
            left = Math.max(margin, left);
            top = Math.max(margin, top);
            right = Math.min(bounds.width - margin, right);
            bottom = Math.min(bounds.height - margin, bottom);
        }

        const minW = this.options.minWidth;
        const minH = this.options.minHeight;
        const maxW = this.options.maxWidth || Infinity;
        const maxH = this.options.maxHeight || Infinity;

        // Enforce min/max width
        if ((right - left) < minW) {
            if (dir.includes('w') && !dir.includes('e')) left = right - minW;
            else right = left + minW;
        }
        if ((right - left) > maxW) {
            if (dir.includes('w') && !dir.includes('e')) left = right - maxW;
            else right = left + maxW;
        }

        // Enforce min/max height
        if ((bottom - top) < minH) {
            if (dir.includes('n') && !dir.includes('s')) top = bottom - minH;
            else bottom = top + minH;
        }
        if ((bottom - top) > maxH) {
            if (dir.includes('n') && !dir.includes('s')) top = bottom - maxH;
            else bottom = top + maxH;
        }

        // Re-clamp to container
        if (this.options.constrainToContainer) {
            left = Math.max(margin, left);
            top = Math.max(margin, top);
            if (right - left < minW) right = left + minW;
            if (bottom - top < minH) bottom = top + minH;
            const clampedRight = Math.min(bounds.width - margin, right);
            const clampedBottom = Math.min(bounds.height - margin, bottom);
            if (clampedRight - left >= minW) right = clampedRight;
            if (clampedBottom - top >= minH) bottom = clampedBottom;
        }

        // Fit content constraint — prevent expanding beyond content height
        if (this.options.fitContent && !this._minimized) {
            this.element.style.width = `${right - left}px`;
            const tightH = Math.max(this._measureTightHeight(), minH);
            const proposedH = bottom - top;
            if (proposedH > tightH) {
                if (dir.includes('n') && !dir.includes('s')) {
                    top = bottom - tightH;
                } else {
                    bottom = top + tightH;
                }
            }
        }

        const newW = right - left;
        let newH = bottom - top;

        if (this._minimized) {
            newH = this.header.offsetHeight;
        }

        this.element.style.left = `${left}px`;
        this.element.style.top = `${top}px`;
        this.element.style.width = `${newW}px`;
        this.element.style.height = `${newH}px`;

        this.options.onResize?.(newW, newH);
    }

    private _measureTightHeight(): number {
        const currentContentH = this.content.offsetHeight;
        const currentWindowH = this.element.offsetHeight;
        const savedFlex = this.content.style.flex;
        this.content.style.flex = '0 0 auto';
        const naturalContentH = this.content.offsetHeight;
        this.content.style.flex = savedFlex;
        return currentWindowH - currentContentH + naturalContentH;
    }

    private _stopResize(): void {
        if (!this.isResizing) return;

        this.isResizing = false;
        this.resizeDirection = null;
        this.element.classList.remove('wl-resizing');
        if (this._activeHandle) {
            this._activeHandle.classList.remove('wl-resizing');
            this._activeHandle = null;
        }

        if (this._activePointerId != null && this.element.releasePointerCapture) {
            try { this.element.releasePointerCapture(this._activePointerId); } catch {}
        }
        this._activePointerId = null;
    }

    // =========================================
    // FIT IN CONTAINER
    // =========================================

    ensureFitInContainer(autoShrink = true): void {
        const bounds = this._getContainerBounds();
        const margin = this.options.safeMargin;
        const minW = this.options.minWidth;
        const minH = this.options.minHeight;
        const absoluteMinW = this.options.absoluteMinWidth;
        const absoluteMinH = this.options.absoluteMinHeight;

        const availW = Math.max(absoluteMinW, bounds.width - margin * 2);
        const availH = Math.max(absoluteMinH, bounds.height - margin * 2);

        let w = this.element.offsetWidth || this.options.width;
        let h = this.element.offsetHeight || this.options.height;

        const isMinimizedToHeader = this._minimized;

        if (autoShrink) {
            w = Math.max(absoluteMinW, Math.min(Math.max(w, minW), availW));
            if (!isMinimizedToHeader) {
                h = Math.max(absoluteMinH, Math.min(Math.max(h, minH), availH));
            }
        }

        this.element.style.width = `${w}px`;
        this.element.style.height = `${h}px`;

        let x = this.element.offsetLeft || this.options.x;
        let y = this.element.offsetTop || this.options.y;

        const maxX = Math.max(margin, margin + availW - w);
        const maxY = Math.max(margin, margin + availH - h);

        x = Math.max(margin, Math.min(x, maxX));
        y = Math.max(margin, Math.min(y, maxY));

        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;
    }

    // =========================================
    // SHOW / HIDE
    // =========================================

    show(): void {
        this.element.classList.add('wl-active');
        this.ensureFitInContainer(true);
        this.focus();
        this.options.onShow?.();
        this._dispatchEvent('show');
    }

    hide(): void {
        if (!this.isVisible()) return;
        this.element.classList.remove('wl-active', 'wl-focused');
        this._focused = false;
        this.options.onHide?.();
        this._dispatchEvent('hide');
    }

    toggle(): void {
        if (this.isVisible()) this.hide();
        else this.show();
    }

    isVisible(): boolean {
        return this.element.classList.contains('wl-active');
    }

    // =========================================
    // FOCUS
    // =========================================

    focus(): void {
        const siblings = this.container.querySelectorAll('.wl-window');
        siblings.forEach(w => w.classList.remove('wl-focused'));

        this.element.classList.add('wl-focused');
        this._focused = true;

        // Search globally for max z-index (windows + sidebar compete)
        const allStackable = document.querySelectorAll('.wl-window, .wl-sidebar');
        let maxZ = 2000;
        allStackable.forEach(el => {
            const z = parseInt((el as HTMLElement).style.zIndex) || 0;
            if (z > maxZ) maxZ = z;
        });
        this.element.style.zIndex = String(maxZ + 1);

        this.options.onFocus?.();
        this._dispatchEvent('focus');
    }

    blur(): void {
        this.element.classList.remove('wl-focused');
        this._focused = false;
        this.options.onBlur?.();
        this._dispatchEvent('blur');
    }

    isFocused(): boolean {
        return this._focused;
    }

    // =========================================
    // MINIMIZE / RESTORE
    // =========================================

    minimize(): void {
        if (this._minimized) return;

        this._restoreHeight = this.element.offsetHeight;
        this._minimized = true;
        this.element.classList.add('wl-minimized');

        // Animate content collapse via maxHeight
        const contentHeight = this.content.scrollHeight;
        this.content.style.maxHeight = `${contentHeight}px`;
        this.content.style.overflow = 'hidden';
        this.content.offsetHeight; // force reflow
        this.content.style.transition = 'max-height 0.2s ease';
        this.content.style.maxHeight = '0';

        // For detached windows (explicit height), also animate window height
        if (this.options.resizable) {
            // Account for window's own border (border-box sizing) — only top border,
            // the header's border-bottom visually replaces the window's bottom border
            const cs = getComputedStyle(this.element);
            const targetHeight = this.header.offsetHeight + (parseFloat(cs.borderTopWidth) || 0);
            this.element.style.height = `${this._restoreHeight}px`;
            this.element.offsetHeight; // reflow
            this.element.style.transition = 'height 0.2s ease';
            this.element.style.height = `${targetHeight}px`;

            // Hide all resize handles except E/W (allow width resize when collapsed)
            const handles = this.element.querySelectorAll('.wl-resize');
            handles.forEach(h => {
                const dir = (h as HTMLElement).dataset.direction;
                (h as HTMLElement).style.display = (dir === 'e' || dir === 'w') ? '' : 'none';
            });
        }

        const onEnd = () => {
            this.content.removeEventListener('transitionend', onEnd);
            this.content.style.transition = '';
            this.element.style.transition = '';
            this.content.style.display = 'none';
        };
        this.content.addEventListener('transitionend', onEnd);

        this.options.onMinimize?.();
        this._dispatchEvent('minimize');
    }

    restore(): void {
        if (!this._minimized) return;

        this._minimized = false;
        this.element.classList.remove('wl-minimized');

        // Show content before animating
        this.content.style.display = '';

        // Animate content expand
        this.content.style.transition = 'max-height 0.2s ease';
        this.content.style.maxHeight = `${this.content.scrollHeight}px`;

        // For detached windows, also animate window height back
        if (this.options.resizable) {
            // Clamp restore height to viewport
            const viewH = window.innerHeight;
            const y = this.element.offsetTop;
            let targetHeight = this._restoreHeight || this._measureTightHeight();
            if (y + targetHeight > viewH) {
                targetHeight = Math.max(this.options.minHeight, viewH - y);
            }

            this.element.style.transition = 'height 0.2s ease';
            this.element.style.height = `${targetHeight}px`;

            // Re-enable all resize handles
            const handles = this.element.querySelectorAll('.wl-resize');
            handles.forEach(h => (h as HTMLElement).style.display = '');
        }

        const onEnd = () => {
            this.content.removeEventListener('transitionend', onEnd);
            this.content.style.transition = '';
            this.content.style.maxHeight = '';
            this.content.style.overflow = '';
            this.element.style.transition = '';
        };
        this.content.addEventListener('transitionend', onEnd);

        this._restoreHeight = null;
        this.options.onRestore?.();
        this._dispatchEvent('restore');
    }

    toggleMinimize(): void {
        if (this._minimized) this.restore();
        else this.minimize();
    }

    /** Set minimized state instantly (no animation). Used when creating a window that should start minimized. */
    setMinimizedInstant(): void {
        if (this._minimized) return;
        this._restoreHeight = this.element.offsetHeight || this._measureTightHeight();
        this._minimized = true;
        this.element.classList.add('wl-minimized');
        if (this.options.resizable) {
            const cs = getComputedStyle(this.element);
            this.element.style.height = `${this.header.offsetHeight + (parseFloat(cs.borderTopWidth) || 0)}px`;
        }
        this.content.style.maxHeight = '0';
        this.content.style.overflow = 'hidden';
        this.content.style.display = 'none';
        if (this.options.resizable) {
            this.element.querySelectorAll('.wl-resize').forEach(h => {
                const dir = (h as HTMLElement).dataset.direction;
                (h as HTMLElement).style.display = (dir === 'e' || dir === 'w') ? '' : 'none';
            });
        }
        // Update button icon
        const minBtn = this.element.querySelector('.wl-minrestore-btn');
        if (minBtn) {
            minBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="6" height="6" rx="0.5"/></svg>';
            minBtn.setAttribute('aria-label', 'Restore window');
        }
    }

    isMinimized(): boolean {
        return this._minimized;
    }

    // =========================================
    // CONTENT
    // =========================================

    setContent(html: string): void {
        this.content.innerHTML = html;
    }

    setContentElement(element: HTMLElement): void {
        this.content.innerHTML = '';
        this.content.appendChild(element);
    }

    appendContent(element: HTMLElement): void {
        this.content.appendChild(element);
    }

    clearContent(): void {
        this.content.innerHTML = '';
    }

    getContentElement(): HTMLDivElement {
        return this.content;
    }

    // =========================================
    // POSITION & SIZE
    // =========================================

    setPosition(x: number, y: number): void {
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;
    }

    setSize(width: number, height: number): void {
        const bounds = this._getContainerBounds();
        const margin = this.options.safeMargin;
        const availW = Math.max(0, bounds.width - margin * 2);
        const availH = Math.max(0, bounds.height - margin * 2);
        const w = Math.min(Math.max(this.options.minWidth, width), availW);
        const h = Math.min(Math.max(this.options.minHeight, height), availH);
        this.element.style.width = `${w}px`;
        this.element.style.height = `${h}px`;
    }

    getState(): { x: number; y: number; width: number; height: number; visible: boolean; minimized: boolean } {
        return {
            x: this.element.offsetLeft,
            y: this.element.offsetTop,
            width: this.element.offsetWidth,
            height: this.element.offsetHeight,
            visible: this.isVisible(),
            minimized: this._minimized,
        };
    }

    autoFitHeight(): void {
        this.element.style.height = `${this._measureTightHeight()}px`;
    }

    setTitle(title: string): void {
        const titleEl = this.header.querySelector('.wl-title');
        if (titleEl) titleEl.textContent = title;
    }

    // =========================================
    // EVENTS & CLEANUP
    // =========================================

    _dispatchEvent(type: string): void {
        try {
            const event = new CustomEvent(`wl-window-${type}`, {
                bubbles: true,
                detail: { id: this.id, window: this }
            });
            this.element.dispatchEvent(event);
        } catch {}
    }

    destroy(): void {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}
