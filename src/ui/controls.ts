/**
 * TurboTwig control builder — creates typed HTML control rows
 * that bind to a params object and fire callbacks on change.
 */

import './controls.css';

export interface ControlHandle {
    element: HTMLElement;
    update: () => void;
    /** Disable/enable the control (greyed out, non-interactive). */
    setDisabled?: (disabled: boolean) => void;
}

function formatValue(v: number, step: number): string {
    if (step >= 1) return String(Math.round(v));
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    return v.toFixed(Math.min(decimals, 4));
}

/** Create a slider row: label | [====o====] 0.50 */
export function sliderRow(
    params: Record<string, any>,
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    onChange?: (v: number) => void,
): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = label;
    lbl.title = label;

    const widget = document.createElement('div');
    widget.className = 'tt-widget';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'tt-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(params[key]);

    const valSpan = document.createElement('span');
    valSpan.className = 'tt-value';
    valSpan.textContent = formatValue(params[key], step);

    // Click on value to edit directly
    valSpan.addEventListener('dblclick', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tt-value-input';
        input.value = valSpan.textContent || '';
        valSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const parsed = parseFloat(input.value);
            if (!isNaN(parsed)) {
                const clamped = Math.max(min, Math.min(max, parsed));
                params[key] = clamped;
                slider.value = String(clamped);
                valSpan.textContent = formatValue(clamped, step);
                onChange?.(clamped);
            }
            input.replaceWith(valSpan);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') input.replaceWith(valSpan);
        });
    });

    // Gesture gate: prevent slider from capturing vertical drags meant for scrolling
    const THRESHOLD = 5;

    function updateSliderFromPointer(clientX: number) {
        const rect = slider.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const val = min + ratio * (max - min);
        const stepped = Math.round(val / step) * step;
        const clamped = Math.max(min, Math.min(max, stepped));
        slider.value = String(clamped);
        params[key] = clamped;
        valSpan.textContent = formatValue(clamped, step);
        onChange?.(clamped);
    }

    slider.addEventListener('pointerdown', (e) => {
        const startX = e.clientX;
        const startY = e.clientY;
        let resolved = false;
        let dragging = false;

        // Prevent slider from immediately capturing the pointer
        e.preventDefault();

        const onMove = (ev: PointerEvent) => {
            if (!resolved) {
                const dx = Math.abs(ev.clientX - startX);
                const dy = Math.abs(ev.clientY - startY);
                if (dx < THRESHOLD && dy < THRESHOLD) return;
                resolved = true;
                dragging = dx >= dy;
            }
            if (dragging) {
                updateSliderFromPointer(ev.clientX);
            }
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            // If never moved past threshold, treat as a click
            if (!resolved) {
                updateSliderFromPointer(startX);
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        params[key] = v;
        valSpan.textContent = formatValue(v, step);
        onChange?.(v);
    });

    widget.appendChild(slider);
    widget.appendChild(valSpan);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() {
            slider.value = String(params[key]);
            valSpan.textContent = formatValue(params[key], step);
        },
    };
}

/** Create a checkbox row: label | [x] */
export function checkboxRow(
    params: Record<string, any>,
    key: string,
    label: string,
    onChange?: (v: boolean) => void,
): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = label;
    lbl.title = label;

    const widget = document.createElement('div');
    widget.className = 'tt-widget';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tt-checkbox';
    cb.checked = !!params[key];

    cb.addEventListener('change', () => {
        params[key] = cb.checked;
        onChange?.(cb.checked);
    });

    widget.appendChild(cb);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() { cb.checked = !!params[key]; },
        setDisabled(disabled: boolean) {
            cb.disabled = disabled;
            row.classList.toggle('tt-disabled', disabled);
        },
    };
}

/** Checkbox + color picker merged on one row: label | [x] [======color======] #hex */
export function checkboxColorRow(
    params: Record<string, any>,
    checkKey: string,
    colorKey: string,
    label: string,
    onCheckChange?: (v: boolean) => void,
    onColorChange?: (v: string) => void,
): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = label;
    lbl.title = label;

    const widget = document.createElement('div');
    widget.className = 'tt-widget';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tt-checkbox';
    cb.checked = !!params[checkKey];

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'tt-color tt-color-fill';
    color.value = params[colorKey];

    const hex = document.createElement('span');
    hex.className = 'tt-hex';
    hex.textContent = params[colorKey];

    cb.addEventListener('change', () => {
        params[checkKey] = cb.checked;
        onCheckChange?.(cb.checked);
    });

    color.addEventListener('input', () => {
        params[colorKey] = color.value;
        hex.textContent = color.value;
        onColorChange?.(color.value);
    });

    widget.appendChild(cb);
    widget.appendChild(color);
    widget.appendChild(hex);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() {
            cb.checked = !!params[checkKey];
            color.value = params[colorKey];
            hex.textContent = params[colorKey];
        },
    };
}

/** Create a dropdown row: label | [option v] */
export function dropdownRow(
    params: Record<string, any>,
    key: string,
    label: string,
    options: string[],
    onChange?: (v: string) => void,
): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = label;
    lbl.title = label;

    const widget = document.createElement('div');
    widget.className = 'tt-widget';

    const select = document.createElement('select');
    select.className = 'tt-select';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
    }
    select.value = params[key];

    select.addEventListener('change', () => {
        params[key] = select.value;
        onChange?.(select.value);
    });

    widget.appendChild(select);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() { select.value = params[key]; },
    };
}

/** Create a color picker row: label | [======color======] #hex */
export function colorRow(
    params: Record<string, any>,
    key: string,
    label: string,
    onChange?: (v: string) => void,
): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = label;
    lbl.title = label;

    const widget = document.createElement('div');
    widget.className = 'tt-widget';

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'tt-color tt-color-fill';
    color.value = params[key];

    const hex = document.createElement('span');
    hex.className = 'tt-hex';
    hex.textContent = params[key];

    color.addEventListener('input', () => {
        params[key] = color.value;
        hex.textContent = color.value;
        onChange?.(color.value);
    });

    widget.appendChild(color);
    widget.appendChild(hex);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() {
            color.value = params[key];
            hex.textContent = params[key];
        },
    };
}

/** Create a button row */
export function buttonRow(label: string, onClick: () => void): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const btn = document.createElement('button');
    btn.className = 'tt-button';
    btn.textContent = label;
    btn.addEventListener('click', onClick);

    row.appendChild(btn);

    return { element: row, update() {} };
}
