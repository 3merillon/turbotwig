/**
 * Sidebar - Collapsible right-side panel for TurboTwig.
 * Adapted from planets project's windowlite sidebar.
 */

import './sidebar.css';

const STORAGE_KEY = 'turbotwig_sidebar';
const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 310;

export class Sidebar {
    wrapper: HTMLDivElement;
    titlebar: HTMLDivElement;
    container: HTMLDivElement;
    private resizeHandle: HTMLDivElement;
    private _isOpen = true;
    private _width: number;
    private _isResizing = false;
    private _resizeStartX = 0;
    private _resizeStartWidth = 0;

    constructor() {
        const state = this._loadState();
        this._width = state.width;
        this._isOpen = !state.collapsed;

        this.wrapper = document.createElement('div');
        this.wrapper.className = 'wl-sidebar wl-sidebar-right';
        this.wrapper.style.width = this._isOpen ? `${this._width}px` : '26px';
        this.wrapper.style.zIndex = '2000';
        if (!this._isOpen) this.wrapper.classList.add('wl-sidebar-collapsed');

        // Header
        this.titlebar = document.createElement('div');
        this.titlebar.className = 'wl-sidebar-header';
        this.titlebar.style.cursor = 'pointer';

        const titleContainer = document.createElement('div');
        titleContainer.className = 'wl-sidebar-title-container';

        // Animated TurboTwig icon — stylized double-T / kanji-like twig
        const iconEl = document.createElement('div');
        iconEl.className = 'sidebar-header-icon';
        iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" style="display:block;width:100%;height:100%">
            <!-- Trunk -->
            <line x1="12" y1="22" x2="12" y2="5" stroke-width="2.2" class="tt-trunk"/>
            <!-- Upper branches (T-top) — attached at y=7 -->
            <g class="tt-upper" style="transform-origin: 12px 7px; animation: tt-wind 3s ease-in-out infinite">
                <path d="M12 7 Q9 5 4 3.5" stroke-width="1.8"/>
                <path d="M12 7 Q15 5 20 3.5" stroke-width="1.8"/>
                <circle cx="4" cy="3.5" r="0.8" fill="currentColor" stroke="none" opacity="0.5"/>
                <circle cx="20" cy="3.5" r="0.8" fill="currentColor" stroke="none" opacity="0.5"/>
            </g>
            <!-- Lower branches — attached at y=14 -->
            <g class="tt-lower" style="transform-origin: 12px 14px; animation: tt-wind 3.5s ease-in-out infinite reverse">
                <path d="M12 14 Q9.5 12 6 10.5" stroke-width="1.4"/>
                <path d="M12 14 Q14.5 12 18 10.5" stroke-width="1.4"/>
                <circle cx="6" cy="10.5" r="0.6" fill="currentColor" stroke="none" opacity="0.4"/>
                <circle cx="18" cy="10.5" r="0.6" fill="currentColor" stroke="none" opacity="0.4"/>
            </g>
        </svg>`;
        titleContainer.appendChild(iconEl);

        const titleEl = document.createElement('div');
        titleEl.className = 'wl-sidebar-title';
        titleEl.textContent = 'TURBOTWIG';
        titleContainer.appendChild(titleEl);

        this.titlebar.appendChild(titleContainer);
        this.titlebar.addEventListener('click', () => this.toggle());

        // Body
        this.container = document.createElement('div');
        this.container.className = 'wl-sidebar-body sidebar-container wl-container';

        // Credit notice — lives inside the scrolling body, pinned after all sections
        const credit = document.createElement('div');
        credit.className = 'sidebar-credit';
        const year = new Date().getFullYear();
        credit.innerHTML = `
            <div class="sidebar-credit-line">© ${year} Cyril Monkewitz</div>
            <div class="sidebar-credit-handle">[<span class="sidebar-credit-handle-name">3merillon</span>]</div>
            <div class="sidebar-credit-icons">
                <a class="sidebar-credit-icon" href="https://3merillon.com" target="_blank" rel="noopener noreferrer" aria-label="3merillon.com" title="3merillon.com"><img src="https://3merillon.com/favicon.ico" alt="" width="16" height="16" referrerpolicy="no-referrer"></a>
                <a class="sidebar-credit-icon" href="https://x.com/3merillon" target="_blank" rel="noopener noreferrer" aria-label="@3merillon on X" title="@3merillon on X"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2H21.5l-7.53 8.6L22.5 22h-6.803l-5.33-6.77L4.3 22H1.04l8.06-9.21L1 2h6.95l4.82 6.2L18.244 2zm-1.19 18h1.84L7.06 4H5.11l11.944 16z"/></svg></a>
                <a class="sidebar-credit-icon" href="https://github.com/3merillon/turbotwig" target="_blank" rel="noopener noreferrer" aria-label="View on GitHub" title="View on GitHub"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.69-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.92-.26 1.9-.38 2.88-.39.98.01 1.96.13 2.88.39 2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .3.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.73 18.27.5 12 .5z"/></svg></a>
            </div>
        `;
        this.container.appendChild(credit);

        // Resize handle
        this.resizeHandle = document.createElement('div');
        this.resizeHandle.className = 'wl-sidebar-resize-handle';
        this.resizeHandle.style.touchAction = 'none';
        this.resizeHandle.addEventListener('pointerdown', (e) => this._startResize(e), { passive: false });

        this.wrapper.appendChild(this.resizeHandle);
        this.wrapper.appendChild(this.titlebar);
        this.wrapper.appendChild(this.container);
        document.body.appendChild(this.wrapper);

        this.wrapper.addEventListener('pointerdown', () => this.bringToFront(), { passive: true });

        // Period key toggle
        document.addEventListener('keydown', (e) => {
            if (e.key === '.') {
                const tag = (e.target as HTMLElement).tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
                e.preventDefault();
                this.toggle();
            }
        });
    }

    getContainer(): HTMLDivElement { return this.container; }
    getWidth(): number { return this._width; }
    isOpen(): boolean { return this._isOpen; }

    bringToFront(): void {
        const allStackable = document.querySelectorAll('.wl-window, .wl-sidebar');
        let maxZ = 2000;
        allStackable.forEach(el => {
            const z = parseInt((el as HTMLElement).style.zIndex) || 0;
            if (z > maxZ) maxZ = z;
        });
        this.wrapper.style.zIndex = String(maxZ + 1);
    }

    open(): void {
        if (this._isOpen) return;
        this._isOpen = true;
        this.wrapper.classList.remove('wl-sidebar-collapsed');
        this.wrapper.style.width = `${this._width}px`;
        this._saveState();
    }

    close(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this.wrapper.classList.add('wl-sidebar-collapsed');
        this.wrapper.style.width = '26px';
        this._saveState();
    }

    toggle(): void {
        if (this._isOpen) this.close();
        else this.open();
    }

    private _startResize(e: PointerEvent): void {
        if (e.button !== 0) return;
        if (!this._isOpen) return;
        e.preventDefault();
        this._isResizing = true;
        this._resizeStartX = e.clientX;
        this._resizeStartWidth = this._width;

        this.wrapper.classList.add('wl-sidebar-resizing');
        this.resizeHandle.classList.add('wl-resizing');
        document.body.style.cursor = 'ew-resize';
        this.resizeHandle.setPointerCapture(e.pointerId);

        const onMove = (ev: PointerEvent) => {
            if (!this._isResizing) return;
            const delta = this._resizeStartX - ev.clientX;
            const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this._resizeStartWidth + delta));
            this._width = newWidth;
            this.wrapper.style.width = `${newWidth}px`;
        };

        const onUp = () => {
            this._isResizing = false;
            this.wrapper.classList.remove('wl-sidebar-resizing');
            this.resizeHandle.classList.remove('wl-resizing');
            document.body.style.cursor = '';
            this._saveState();
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
        };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup', onUp, { passive: true });
        document.addEventListener('pointercancel', onUp, { passive: true });
    }

    private _loadState(): { width: number; collapsed: boolean } {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const s = JSON.parse(stored);
                return {
                    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, s.width || DEFAULT_WIDTH)),
                    collapsed: !!s.collapsed,
                };
            }
        } catch {}
        return { width: DEFAULT_WIDTH, collapsed: false };
    }

    private _saveState(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                width: this._width,
                collapsed: !this._isOpen,
            }));
        } catch {}
    }
}
