/**
 * WindowManager - Coordinates multiple Window instances within a container.
 * Adapted from windowlite for planets project.
 *
 * Kept: window registry, create, container setup, ResizeObserver, events
 * Removed: cross-manager, keyboard shortcuts, persistence, themes, focus navigation
 */

import { Window } from './window';
import type { WindowOptions } from './window';

export interface WindowManagerOptions {
    container: HTMLElement;
    zIndexBase?: number;
}

type EventHandler = (id: string, win: Window) => void;

export class WindowManager {
    readonly container: HTMLElement;
    private windows = new Map<string, Window>();
    private _eventHandlers = new Map<string, EventHandler[]>();
    private _resizeObserver: ResizeObserver | null = null;
    private _resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    private _windowEventHandler: ((e: Event) => void) | null = null;

    constructor(options: WindowManagerOptions) {
        if (!options.container) {
            throw new Error('WindowManager: container is required');
        }

        this.container = options.container;

        // Ensure container has positioning context
        const containerPosition = getComputedStyle(this.container).position;
        if (containerPosition === 'static') {
            this.container.style.position = 'relative';
        }

        this.container.classList.add('wl-container');
        this._setupWindowEventListeners();
        this._setupResizeObserver();
    }

    // =========================================
    // WINDOW MANAGEMENT
    // =========================================

    create(options: Omit<WindowOptions, 'container'>): Window {
        if (!options.id) throw new Error('WindowManager.create: id is required');
        if (this.windows.has(options.id)) {
            throw new Error(`WindowManager.create: window '${options.id}' already exists`);
        }

        const win = new Window({
            ...options,
            container: this.container,
        });
        this.windows.set(options.id, win);
        return win;
    }

    get(id: string): Window | undefined {
        return this.windows.get(id);
    }

    getAll(): Map<string, Window> {
        return new Map(this.windows);
    }

    getVisible(): Window[] {
        return Array.from(this.windows.values()).filter(w => w.isVisible());
    }

    getMinimized(): Window[] {
        return Array.from(this.windows.values()).filter(w => w.isMinimized());
    }

    /**
     * Remove a window from the registry and destroy its DOM
     */
    remove(id: string): void {
        const win = this.windows.get(id);
        if (win) {
            win.destroy();
            this.windows.delete(id);
        }
    }

    /**
     * Unregister a window without destroying it (for transfers between managers)
     */
    unregister(id: string): Window | undefined {
        const win = this.windows.get(id);
        if (win) {
            this.windows.delete(id);
        }
        return win;
    }

    // =========================================
    // EVENTS
    // =========================================

    on(event: string, handler: EventHandler): void {
        if (!this._eventHandlers.has(event)) {
            this._eventHandlers.set(event, []);
        }
        this._eventHandlers.get(event)!.push(handler);
    }

    off(event: string, handler: EventHandler): void {
        const handlers = this._eventHandlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) handlers.splice(index, 1);
        }
    }

    private _emit(event: string, id: string, win: Window): void {
        const eventMap: Record<string, string> = {
            'show': 'windowOpen',
            'hide': 'windowClose',
            'focus': 'focusChange',
        };
        const externalEvent = eventMap[event] || event;
        const handlers = this._eventHandlers.get(externalEvent);
        if (handlers) {
            handlers.forEach(handler => {
                try { handler(id, win); } catch (e) {
                    console.error('WindowManager event handler error:', e);
                }
            });
        }
    }

    private _setupWindowEventListeners(): void {
        this._windowEventHandler = (e: Event) => {
            const ce = e as CustomEvent;
            const type = ce.type.replace('wl-window-', '');
            this._emit(type, ce.detail.id, ce.detail.window);
        };

        this.container.addEventListener('wl-window-show', this._windowEventHandler);
        this.container.addEventListener('wl-window-hide', this._windowEventHandler);
        this.container.addEventListener('wl-window-focus', this._windowEventHandler);
        this.container.addEventListener('wl-window-blur', this._windowEventHandler);
        this.container.addEventListener('wl-window-dragstart', this._windowEventHandler);
        this.container.addEventListener('wl-window-dragmove', this._windowEventHandler);
        this.container.addEventListener('wl-window-dragend', this._windowEventHandler);
    }

    // =========================================
    // RESIZE OBSERVER
    // =========================================

    private _setupResizeObserver(): void {
        if (typeof ResizeObserver === 'undefined') return;

        this._resizeObserver = new ResizeObserver(() => {
            this._handleContainerResize();
        });

        this._resizeObserver.observe(this.container);
    }

    private _handleContainerResize(): void {
        for (const win of this.windows.values()) {
            if (win.isVisible()) {
                win.ensureFitInContainer(true);
            }
        }
    }

    // =========================================
    // CLEANUP
    // =========================================

    destroy(): void {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = null;
        }
        if (this._windowEventHandler) {
            this.container.removeEventListener('wl-window-show', this._windowEventHandler);
            this.container.removeEventListener('wl-window-hide', this._windowEventHandler);
            this.container.removeEventListener('wl-window-focus', this._windowEventHandler);
            this.container.removeEventListener('wl-window-blur', this._windowEventHandler);
            this.container.removeEventListener('wl-window-dragstart', this._windowEventHandler);
            this.container.removeEventListener('wl-window-dragmove', this._windowEventHandler);
            this.container.removeEventListener('wl-window-dragend', this._windowEventHandler);
        }
        for (const win of this.windows.values()) {
            win.destroy();
        }
        this.windows.clear();
        this._eventHandlers.clear();
    }
}
