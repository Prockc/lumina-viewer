import type { MeasureMode } from './types';

interface MeasureToolbarCallbacks {
    onMeasureMode: (mode: MeasureMode) => void;
    onClearMeasurements: () => void;
}

interface MeasureToolbarHandle {
    /** Enable/disable the clear button based on sketch content. */
    setHasMeasurements: (has: boolean) => void;
}

const ICONS: Record<string, string> = {
    // Tools toggle: horizontal ruler
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="19" height="10" rx="1.5"/><path d="M6.5 7v3M10 7v4M13.5 7v3M17 7v4"/></svg>',
    // Distance: ruler
    distance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="9.5" width="17.6" height="5" rx="1" transform="rotate(-45 12 12)"/><path d="M9.2 11.6l1.4 1.4M12 8.8l1.4 1.4M14.8 6l1.4 1.4"/></svg>',
    // Area: polygon
    area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l7.5 5.5-2.9 9H7.4l-2.9-9z"/><circle cx="12" cy="3.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="19.5" cy="9" r="1.4" fill="currentColor" stroke="none"/><circle cx="16.6" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="7.4" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="9" r="1.4" fill="currentColor" stroke="none"/></svg>',
    // Clear: trash
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/></svg>'
};

const group = (label: string): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'lumina-toolbar__group';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', label);
    return el;
};

const button = (icon: keyof typeof ICONS, label: string): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lumina-toolbar__btn';
    el.title = label;
    el.setAttribute('aria-label', label);
    el.innerHTML = ICONS[icon];
    return el;
};

/**
 * Sleek right-edge tool overlay: measurement tools (distance / area /
 * clear). Active tools light up in the Lumina brand color.
 * @param callbacks - Handlers invoked when the measure mode changes or the sketch is cleared.
 * @returns A handle for updating toolbar state.
 */
const installMeasureToolbar = (callbacks: MeasureToolbarCallbacks): MeasureToolbarHandle => {
    const root = document.createElement('div');
    root.id = 'lumina-toolbar';

    const measureGroup = group('Measure');

    // Primary toggle that collapses/expands the measurement tools
    const toggleBtn = button('tools', 'Measurement tools');
    toggleBtn.classList.add('lumina-toolbar__toggle');
    toggleBtn.setAttribute('aria-expanded', 'false');

    // Collapsible container holding the individual measurement tools
    const items = document.createElement('div');
    items.className = 'lumina-toolbar__items';

    const distanceBtn = button('distance', 'Measure distance');
    const areaBtn = button('area', 'Measure area');
    const clearBtn = button('clear', 'Clear measurements');
    clearBtn.disabled = true;
    items.append(distanceBtn, areaBtn, clearBtn);

    measureGroup.append(toggleBtn, items);
    root.append(measureGroup);
    document.body.appendChild(root);

    const setExpanded = (expanded: boolean): void => {
        measureGroup.classList.toggle('expanded', expanded);
        toggleBtn.setAttribute('aria-expanded', String(expanded));
    };

    toggleBtn.addEventListener('click', () => {
        setExpanded(!measureGroup.classList.contains('expanded'));
    });

    const toast = document.createElement('div');
    toast.id = 'lumina-toast';
    toast.className = 'lumina-toast--hidden';
    document.body.appendChild(toast);
    let toastTimer = 0;

    const showToast = (text: string): void => {
        toast.textContent = text;
        toast.classList.remove('lumina-toast--hidden');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(
            () => toast.classList.add('lumina-toast--hidden'),
            2600
        );
    };

    let measureMode: MeasureMode = null;

    const setMeasureMode = (mode: MeasureMode): void => {
        measureMode = measureMode === mode ? null : mode;
        distanceBtn.classList.toggle('active', measureMode === 'distance');
        areaBtn.classList.toggle('active', measureMode === 'area');
        // keep the collapsed toggle lit while a tool is active
        toggleBtn.classList.toggle('active', measureMode !== null);
        callbacks.onMeasureMode(measureMode);
        setExpanded(false); // auto-collapse after choosing a tool
        if (measureMode === 'distance') {
            showToast('Tap the model to place points along a path');
        } else if (measureMode === 'area') {
            showToast('Tap 3+ points to outline an area');
        }
    };

    distanceBtn.addEventListener('click', () => setMeasureMode('distance'));
    areaBtn.addEventListener('click', () => setMeasureMode('area'));
    clearBtn.addEventListener('click', () => {
        callbacks.onClearMeasurements();
        setExpanded(false); // auto-collapse after clearing
    });

    return {
        setHasMeasurements(has: boolean): void {
            clearBtn.disabled = !has;
        }
    };
};

export { installMeasureToolbar, MeasureToolbarCallbacks, MeasureToolbarHandle };
