/**
 * TurboTwig UIManager — orchestrates windowlite windows, sidebar, dock/undock.
 * Replaces lil-gui with the custom windowed GUI system from planets.
 */

import { WindowManager } from './windowlite/window-manager';
import { Window } from './windowlite/window';
import './windowlite/windowlite.css';
import { Sidebar } from './sidebar';
import type { WebGL2Renderer } from '../renderer/WebGL2Renderer';
import type { ControlHandle } from './controls';
import type { SectionCallbacks } from './window-sections';
import {
    createSpeciesContent,
    createTrunkContent,
    createRootsContent,
    createBranchingContent,
    createLeavesContent,
    createWindContent,
    createAudioContent,
    createBarkGeomContent,
    createMaterialsContent,
    createLightingContent,
    createAtmosphereContent,
    createDisplayContent,
    createExportContent,
} from './window-sections';

/* ── Layout persistence ───────────────────────────────── */

const LAYOUT_STORAGE_KEY = 'turbotwig_window_layout';

interface LayoutState {
    dockedOrder: string[];
    detached: Record<string, { x: number; y: number; width: number; height: number }>;
    minimized: Record<string, boolean>;
}

/* ── SVG icons ────────────────────────────────────────── */

const ICONS: Record<string, string> = {
    species: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22V8"/><path d="M12 8C12 8 8 4 6 2"/><path d="M12 8C12 8 16 4 18 2"/><path d="M12 14C12 14 9 11 7 10"/><path d="M12 14C12 14 15 11 17 10"/></svg>',
    trunk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"/><path d="M10 4c0 4 4 4 4 8s-4 4-4 8"/></svg>',
    roots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M12 12c-2 3-6 5-8 8"/><path d="M12 12c2 3 6 5 8 8"/><path d="M12 12c-1 4-3 6-4 10"/><path d="M12 12c1 4 3 6 4 10"/></svg>',
    branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22V2"/><path d="M12 6l-6-4"/><path d="M12 6l6-4"/><path d="M12 12l-5-3"/><path d="M12 12l5-3"/><path d="M12 17l-4-2"/><path d="M12 17l4-2"/></svg>',
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 1 8-1 3.5-3 5.5-5 7"/><path d="M11 20c0-4 2-8 8-12"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M12.59 19.41A2 2 0 1 0 14 16H2"/><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    bark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M9 6c2 2 4 2 6 0"/><path d="M9 12c2 2 4 2 6 0"/><path d="M9 18c2 2 4 2 6 0"/></svg>',
    material: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    atmosphere: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/></svg>',
    display: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>',
};

/* ── Window definitions ───────────────────────────────── */

interface WindowDef {
    id: string;
    title: string;
    icon: string;
    color: string;
    startMinimized?: boolean;
    /** If true, starts as a detached floating window on first load */
    startDetached?: boolean;
    /** Default position/size for first-load detached windows */
    defaultPos?: { x: number; y: number; width: number; height: number };
}

const WINDOW_DEFS: WindowDef[] = [
    { id: 'species',    title: 'SPECIES',     icon: ICONS.species,    color: 'green' },
    { id: 'audio',      title: 'AUDIO',       icon: ICONS.audio,      color: 'cyan' },
    { id: 'trunk',      title: 'TRUNK',       icon: ICONS.trunk,      color: 'brown' },
    { id: 'roots',      title: 'ROOTS',       icon: ICONS.roots,      color: 'amber' },
    { id: 'branching',  title: 'BRANCHING',   icon: ICONS.branch,     color: 'green' },
    { id: 'leaves',     title: 'LEAVES',      icon: ICONS.leaf,       color: 'lime' },
    { id: 'wind',       title: 'WIND',        icon: ICONS.wind,       color: 'teal' },
    { id: 'bark-geom',  title: 'BARK GEOMETRY', icon: ICONS.bark,     color: 'orange' },
    { id: 'materials',  title: 'MATERIALS',   icon: ICONS.material,   color: 'grey' },
    { id: 'lighting',   title: 'LIGHTING',    icon: ICONS.light,      color: 'yellow' },
    { id: 'atmosphere', title: 'ATMOSPHERE',  icon: ICONS.atmosphere, color: 'purple' },
    { id: 'display',    title: 'DISPLAY',     icon: ICONS.display,    color: 'indigo' },
    { id: 'export',     title: 'EXPORT',      icon: ICONS.export,     color: 'red' },
    { id: 'stats',      title: 'STATS',       icon: ICONS.stats,      color: 'slate', startDetached: true },
];

/* ── UIManager ─────────────────────────────────────────── */

export class UIManager {
    private sidebar: Sidebar;
    private sidebarManager: WindowManager;
    private mainManager: WindowManager;
    private mainContainer: HTMLElement;

    private dockedWindows = new Set<string>();
    private detachedWindows = new Set<string>();
    private windowSizes = new Map<string, { width: number; height: number }>();

    // All control handles for updateDisplay()
    private allHandles: ControlHandle[] = [];

    // Stats display element (inside the stats window)
    private statsEl!: HTMLDivElement;

    // Track which section content belongs to which window (for dock/undock DOM transfer)
    private sectionContent = new Map<string, HTMLElement>();

    // Drag-to-dock state
    private _dragOverSidebar = false;
    private _dragOverWinId: string | null = null;
    private _dragOverClientY = 0;
    private _dropIndicator: HTMLElement | null = null;

    // Stored event handlers for cleanup
    private _boundHandlers: { target: EventTarget; event: string; handler: EventListener }[] = [];

    constructor(
        private params: Record<string, any>,
        private renderer: WebGL2Renderer,
        private callbacks: SectionCallbacks,
    ) {
        // Use document.body as main viewport container
        this.mainContainer = document.body;

        // Create sidebar
        this.sidebar = new Sidebar();

        // Create window managers
        this.sidebarManager = new WindowManager({ container: this.sidebar.getContainer() });
        this.mainManager = new WindowManager({ container: this.mainContainer });

        // Body is our main container — undo WindowManager's overflow:hidden and position:relative
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        document.body.style.height = '100%';

        // Build section content
        this._buildSectionContent();

        // Restore layout or create default
        const layout = this._loadLayout();
        if (layout) {
            this._restoreLayout(layout);
        } else {
            this._createDefaultLayout();
        }

        // Global drag-to-dock
        this._setupGlobalDragToDock();

        // Save layout on relevant events (store references for cleanup)
        const saveLayout = () => this._saveLayout();
        const onPointerUp = () => {
            const a = Window._active;
            if (a && a.mode === 'resize' && this.detachedWindows.has(a.win.id)) {
                requestAnimationFrame(() => this._saveLayout());
            }
        };
        document.body.addEventListener('wl-window-dragend', saveLayout);
        document.body.addEventListener('wl-window-minimize', saveLayout);
        document.body.addEventListener('wl-window-restore', saveLayout);
        document.addEventListener('pointerup', onPointerUp, { passive: true });
        this._boundHandlers.push(
            { target: document.body, event: 'wl-window-dragend', handler: saveLayout },
            { target: document.body, event: 'wl-window-minimize', handler: saveLayout },
            { target: document.body, event: 'wl-window-restore', handler: saveLayout },
            { target: document, event: 'pointerup', handler: onPointerUp },
        );
    }

    /** Refresh all controls to match current param values. */
    updateDisplay(): void {
        for (const h of this.allHandles) h.update();
    }

    /** Update the stats window content. */
    updateStats(verts: number, tris: number, branches: number, leaves: number): void {
        const lines = [
            `Vertices: ${verts.toLocaleString()}`,
            `Triangles: ${tris.toLocaleString()}`,
            `Branches: ${branches}`,
            `Leaf quads: ${leaves.toLocaleString()}`,
        ];
        this.statsEl.textContent = '';
        lines.forEach((line, i) => {
            if (i > 0) this.statsEl.appendChild(document.createElement('br'));
            this.statsEl.appendChild(document.createTextNode(line));
        });
    }

    dispose(): void {
        for (const { target, event, handler } of this._boundHandlers) {
            target.removeEventListener(event, handler);
        }
        this._boundHandlers.length = 0;
        this.sidebarManager.destroy();
        this.mainManager.destroy();
        if (this.sidebar.wrapper.parentNode) {
            this.sidebar.wrapper.parentNode.removeChild(this.sidebar.wrapper);
        }
    }

    // =========================================
    // SECTION CONTENT BUILDING
    // =========================================

    private _buildSectionContent(): void {
        const p = this.params;
        const r = this.renderer;
        const cb = this.callbacks;

        // Stats content — plain container updated by App via updateStats()
        this.statsEl = document.createElement('div');
        this.statsEl.style.cssText = 'font: 11px Consolas, Monaco, monospace; line-height: 1.6; color: rgba(255,255,255,0.7); padding: 2px 4px;';
        this.statsEl.innerHTML = 'Vertices: \u2014<br>Triangles: \u2014<br>Branches: \u2014<br>Leaf quads: \u2014';

        const sections: Record<string, { element: HTMLElement; handles: ControlHandle[] }> = {
            'species':    createSpeciesContent(p, cb),
            'trunk':      createTrunkContent(p, cb),
            'roots':      createRootsContent(p, cb),
            'branching':  createBranchingContent(p, cb),
            'leaves':     createLeavesContent(p, r, cb),
            'wind':       createWindContent(p),
            'audio':      createAudioContent(p, cb),
            'bark-geom':  createBarkGeomContent(p, cb),
            'materials':  createMaterialsContent(p, r, cb),
            'lighting':   createLightingContent(p, r),
            'atmosphere': createAtmosphereContent(p, r),
            'display':    createDisplayContent(p, r),
            'export':     createExportContent(cb),
            'stats':      { element: this.statsEl, handles: [] },
        };

        for (const [id, section] of Object.entries(sections)) {
            this.sectionContent.set(id, section.element);
            this.allHandles.push(...section.handles);
        }
    }

    // =========================================
    // LAYOUT
    // =========================================

    private _createDefaultLayout(): void {
        for (const def of WINDOW_DEFS) {
            if (def.startDetached) {
                this._createDetachedWindowDirect(def, null, false);
            } else {
                this._createDockedWindow(def);
            }
        }
    }

    private _restoreLayout(layout: LayoutState): void {
        // Restore docked windows in saved order
        for (const id of layout.dockedOrder) {
            const def = WINDOW_DEFS.find(d => d.id === id);
            if (!def) continue;
            this._createDockedWindow(def);
            if (layout.minimized[id]) {
                const win = this.sidebarManager.get(id);
                if (win) win.setMinimizedInstant();
            }
        }
        // Restore detached windows
        for (const [id, pos] of Object.entries(layout.detached)) {
            const def = WINDOW_DEFS.find(d => d.id === id);
            if (!def) continue;
            this._createDetachedWindowDirect(def, pos, !!layout.minimized[id]);
        }
        // Any new windows not in saved layout
        for (const def of WINDOW_DEFS) {
            if (!layout.dockedOrder.includes(def.id) && !(def.id in layout.detached)) {
                if (def.startDetached) {
                    this._createDetachedWindowDirect(def, null, false);
                } else {
                    this._createDockedWindow(def);
                }
            }
        }
    }

    private _createDockedWindow(def: WindowDef): void {
        const content = this.sectionContent.get(def.id);
        if (!content) return;

        const win = this.sidebarManager.create({
            id: def.id,
            title: def.title,
            icon: def.icon,
            draggable: false,
            resizable: false,
            minimizable: true,
            dockable: false,
            fitContent: true,
        });

        win.element.setAttribute('data-color', def.color);
        win.content.appendChild(content);
        win.show();
        this.dockedWindows.add(def.id);

        if (def.startMinimized && !this._loadLayout()) {
            win.setMinimizedInstant();
        }

        // Section header click → toggle, drag → detach
        this._setupSectionDrag(win, def);
    }

    private _createDetachedWindowDirect(
        def: WindowDef,
        pos: { x: number; y: number; width: number; height: number } | null,
        minimized: boolean,
    ): void {
        const content = this.sectionContent.get(def.id);
        if (!content) return;

        const x = pos?.x ?? 0;
        const y = pos?.y ?? 0;
        const w = pos?.width ?? 200;
        const h = pos?.height ?? 200;

        const win = this.mainManager.create({
            id: def.id,
            title: def.title,
            icon: def.icon,
            width: w,
            height: h,
            minWidth: def.startDetached ? 150 : 200,
            x, y,
            resizable: true,
            draggable: true,
            minimizable: true,
            fitContent: true,
            safeMargin: 0,
            onDock: () => this._dockWindow(def.id, 0),
        });

        win.element.setAttribute('data-color', def.color);
        win.content.appendChild(content);
        win.show();
        this.detachedWindows.add(def.id);

        if (minimized) {
            win.setMinimizedInstant();
        } else {
            // Fit height to content after layout, then reposition if bottom-anchored
            requestAnimationFrame(() => {
                win.autoFitHeight();
                if (!pos && def.startDetached) {
                    win.element.style.width = `${win.options.minWidth}px`;
                    const fitH = win.element.offsetHeight;
                    win.setPosition(0, window.innerHeight - fitH);
                }
            });
        }
    }

    // =========================================
    // DETACH (sidebar → viewport)
    // =========================================

    private _detachWindow(id: string, clientX: number, clientY: number): void {
        const def = WINDOW_DEFS.find(d => d.id === id);
        if (!def) return;

        const dockedWin = this.sidebarManager.get(id);
        if (!dockedWin) return;

        const wasMinimized = dockedWin.isMinimized();
        const content = this.sectionContent.get(id);
        if (!content) return;

        // Clear any inline max-height from minimize animation
        if (wasMinimized) content.style.maxHeight = '';

        // Remove from sidebar
        this.sidebarManager.remove(id);
        this.dockedWindows.delete(id);

        // Recall saved size or use defaults
        const saved = this.windowSizes.get(id) || { width: 300, height: 300 };

        const win = this.mainManager.create({
            id: def.id,
            title: def.title,
            icon: def.icon,
            width: saved.width,
            height: saved.height,
            x: clientX - 10,
            y: clientY - 10,
            resizable: true,
            draggable: true,
            minimizable: true,
            fitContent: true,
            safeMargin: 0,
            onDock: () => this._dockWindow(id, 0),
        });

        win.element.setAttribute('data-color', def.color);
        win.content.appendChild(content);
        win.show();
        if (!wasMinimized) win.autoFitHeight();
        this.detachedWindows.add(id);

        if (wasMinimized) win.setMinimizedInstant();

        // Immediately start dragging
        win.startDragProgrammatic(clientX, clientY);
        this._saveLayout();
    }

    // =========================================
    // DOCK (viewport → sidebar)
    // =========================================

    private _dockWindow(id: string, insertIndex?: number): void {
        const def = WINDOW_DEFS.find(d => d.id === id);
        if (!def) return;

        const detachedWin = this.mainManager.get(id);
        if (!detachedWin) return;

        const wasMinimized = detachedWin.isMinimized();
        const content = this.sectionContent.get(id);
        if (!content) return;

        // Save window size for next detach
        this.windowSizes.set(id, {
            width: detachedWin.element.offsetWidth,
            height: detachedWin.element.offsetHeight,
        });

        // Remove from viewport
        this.mainManager.remove(id);
        this.detachedWindows.delete(id);

        // Create in sidebar
        const win = this.sidebarManager.create({
            id: def.id,
            title: def.title,
            icon: def.icon,
            draggable: false,
            resizable: false,
            minimizable: true,
            dockable: false,
            fitContent: true,
        });

        win.element.setAttribute('data-color', def.color);
        win.content.appendChild(content);

        // Insert at specific position if given (0 = top of sidebar)
        if (insertIndex !== undefined) {
            // Exclude the just-created window itself from the position calculation
            const others = Array.from(this.sidebar.container.querySelectorAll('.wl-window'))
                .filter(el => el !== win.element);
            if (insertIndex <= 0 || others.length === 0) {
                // Insert at top
                this.sidebar.container.insertBefore(win.element, this.sidebar.container.firstChild);
            } else if (insertIndex < others.length) {
                this.sidebar.container.insertBefore(win.element, others[insertIndex]);
            }
            // else: already appended at end by constructor
        }

        win.show();
        this.dockedWindows.add(id);

        if (wasMinimized) win.setMinimizedInstant();
        this._setupSectionDrag(win, def);

        // Open sidebar if closed
        if (!this.sidebar.isOpen()) this.sidebar.open();
        this._saveLayout();
    }

    // =========================================
    // SECTION DRAG (within sidebar / detach)
    // =========================================

    private _setupSectionDrag(win: Window, def: WindowDef): void {
        const header = win.header;

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('.wl-minimize-btn')) return;

            // Per-gesture state — keep all state inside this closure so stale handlers
            // from a cancelled gesture can never corrupt a fresh one.
            const pointerId = e.pointerId;
            const startX = e.clientX;
            const startY = e.clientY;
            let dragHappened = false;
            let lastClientY = 0;
            let detached = false;

            const cleanup = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerCancel);
                this._hideDropIndicator();
            };

            const onPointerMove = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!dragHappened && Math.abs(dx) + Math.abs(dy) > 5) {
                    dragHappened = true;
                }
                if (!dragHappened) return;
                lastClientY = ev.clientY;

                // Check if dragged outside sidebar left edge → detach
                const sidebarRect = this.sidebar.wrapper.getBoundingClientRect();
                if (ev.clientX < sidebarRect.left - 10) {
                    detached = true;
                    cleanup();
                    this._detachWindow(def.id, ev.clientX, ev.clientY);
                    return;
                }

                // Reorder within sidebar
                this._showDropIndicator(ev.clientY, win.element);
            };

            const onPointerUp = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                cleanup();
                if (detached) return;

                if (!dragHappened) {
                    // Tap → toggle minimize
                    win.toggleMinimize();
                    this._saveLayout();
                } else {
                    // Reorder to where cursor ended
                    const insertIdx = this._getInsertIndex(lastClientY);
                    if (insertIdx !== undefined) {
                        const children = Array.from(this.sidebar.container.querySelectorAll('.wl-window'));
                        if (insertIdx < children.length) {
                            this.sidebar.container.insertBefore(win.element, children[insertIdx]);
                        } else {
                            this.sidebar.container.appendChild(win.element);
                        }
                    }
                    this._saveLayout();
                }
            };

            // Browser cancels our pointer (e.g. touch-action: pan-y takes over for scrolling).
            // We must tear down cleanly — otherwise a stale pointerup on the next tap toggles twice.
            const onPointerCancel = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                cleanup();
            };

            document.addEventListener('pointermove', onPointerMove, { passive: true });
            document.addEventListener('pointerup', onPointerUp, { passive: true });
            document.addEventListener('pointercancel', onPointerCancel, { passive: true });
        };

        // Override the default drag behavior for docked windows
        header.addEventListener('pointerdown', onPointerDown, { passive: true });
    }

    // =========================================
    // DRAG-TO-DOCK (from viewport to sidebar)
    // =========================================

    private _isDraggingDetached = false;

    private _setupGlobalDragToDock(): void {
        document.addEventListener('pointermove', (e: PointerEvent) => {
            const active = Window._active;
            if (!active || active.mode !== 'drag') {
                if (this._isDraggingDetached) {
                    this._isDraggingDetached = false;
                    this.sidebar.wrapper.classList.remove('dock-zone');
                }
                return;
            }
            const win = active.win;
            if (!this.detachedWindows.has(win.id)) return;

            // Show faint dock zone on sidebar whenever dragging a detached window
            if (!this._isDraggingDetached) {
                this._isDraggingDetached = true;
                this.sidebar.wrapper.classList.add('dock-zone');
            }

            const sidebarRect = this.sidebar.wrapper.getBoundingClientRect();
            const overSidebar = e.clientX >= sidebarRect.left && e.clientX <= sidebarRect.right
                && e.clientY >= sidebarRect.top && e.clientY <= sidebarRect.bottom;

            if (overSidebar) {
                if (!this._dragOverSidebar) {
                    this._dragOverSidebar = true;
                    this.sidebar.container.classList.add('dock-highlight');
                }
                this._dragOverWinId = win.id;
                this._dragOverClientY = e.clientY;
                this._showDropIndicator(e.clientY);

                if (!this.sidebar.isOpen()) {
                    this.sidebar.wrapper.classList.add('dock-target');
                }
            } else {
                if (this._dragOverSidebar) {
                    this._dragOverSidebar = false;
                    this._dragOverWinId = null;
                    this.sidebar.container.classList.remove('dock-highlight');
                    this.sidebar.wrapper.classList.remove('dock-target');
                    this._hideDropIndicator();
                }
            }
        }, { passive: true });

        document.addEventListener('pointerup', () => {
            if (this._dragOverSidebar && this._dragOverWinId) {
                const winId = this._dragOverWinId;
                if (this.detachedWindows.has(winId)) {
                    const insertIdx = this._getInsertIndex(this._dragOverClientY);
                    this._dockWindow(winId, insertIdx);
                }
            }
            this._isDraggingDetached = false;
            this._dragOverSidebar = false;
            this._dragOverWinId = null;
            this.sidebar.wrapper.classList.remove('dock-zone');
            this.sidebar.container.classList.remove('dock-highlight');
            this.sidebar.wrapper.classList.remove('dock-target');
            this._hideDropIndicator();
        }, { passive: true });
    }

    // =========================================
    // DROP INDICATOR
    // =========================================

    private _showDropIndicator(clientY: number, excludeEl?: HTMLElement): void {
        if (!this._dropIndicator) {
            this._dropIndicator = document.createElement('div');
            this._dropIndicator.className = 'sidebar-drop-indicator';
        }

        const sidebarBody = this.sidebar.container;
        const children = Array.from(sidebarBody.querySelectorAll('.wl-window'));

        let insertBefore: Element | null = null;
        for (const child of children) {
            const rect = child.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                insertBefore = child;
                break;
            }
        }

        // Hide indicator if drop would be at the dragged element's own position
        if (excludeEl) {
            if (insertBefore === excludeEl || insertBefore === excludeEl.nextElementSibling) {
                this._hideDropIndicator();
                return;
            }
            if (!insertBefore && children[children.length - 1] === excludeEl) {
                this._hideDropIndicator();
                return;
            }
        }

        if (insertBefore) {
            sidebarBody.insertBefore(this._dropIndicator, insertBefore);
        } else {
            sidebarBody.appendChild(this._dropIndicator);
        }
    }

    private _hideDropIndicator(): void {
        if (this._dropIndicator && this._dropIndicator.parentNode) {
            this._dropIndicator.parentNode.removeChild(this._dropIndicator);
        }
    }

    private _getInsertIndex(clientY: number): number | undefined {
        const children = Array.from(this.sidebar.container.querySelectorAll('.wl-window'));
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return i;
            }
        }
        return children.length;
    }

    // =========================================
    // LAYOUT PERSISTENCE
    // =========================================

    private _saveLayout(): void {
        const dockedOrder: string[] = [];
        const sidebarChildren = this.sidebar.container.querySelectorAll('.wl-window');
        sidebarChildren.forEach(el => {
            const id = el.id.replace('wl-', '');
            if (this.dockedWindows.has(id)) dockedOrder.push(id);
        });

        const detached: Record<string, { x: number; y: number; width: number; height: number }> = {};
        for (const id of this.detachedWindows) {
            const win = this.mainManager.get(id);
            if (win) {
                detached[id] = {
                    x: win.element.offsetLeft,
                    y: win.element.offsetTop,
                    width: win.element.offsetWidth,
                    height: win.element.offsetHeight,
                };
            }
        }

        const minimized: Record<string, boolean> = {};
        for (const id of this.dockedWindows) {
            const win = this.sidebarManager.get(id);
            if (win?.isMinimized()) minimized[id] = true;
        }
        for (const id of this.detachedWindows) {
            const win = this.mainManager.get(id);
            if (win?.isMinimized()) minimized[id] = true;
        }

        const state: LayoutState = { dockedOrder, detached, minimized };
        try {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
        } catch {}
    }

    private _loadLayout(): LayoutState | null {
        try {
            const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
            if (stored) return JSON.parse(stored);
        } catch {}
        return null;
    }
}
