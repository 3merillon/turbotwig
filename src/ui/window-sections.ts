/**
 * TurboTwig window section content factories.
 * Each function builds the HTML content for one window panel,
 * returning the container element and an array of ControlHandles for updateDisplay().
 */

import type { WebGL2Renderer } from '../renderer/WebGL2Renderer';
import { hexToLinearRGB, srgbToLinear, cssColorToHex } from '../renderer/math';
import { presetNames } from '../presets/presetRegistry';
import {
    sliderRow, checkboxRow, dropdownRow, colorRow, buttonRow,
    checkboxColorRow,
    type ControlHandle,
} from './controls';

export interface SectionResult {
    element: HTMLElement;
    handles: ControlHandle[];
}

export interface SectionCallbacks {
    onPresetChange(name: string): void;
    onParamChange(): void;
    onExportGLB(): void;
    onExportGLTF(): void;
    onSaveConfig(): void;
    onLoadConfig(): void;
    onAudioToggle(enabled: boolean): void;
}

type P = Record<string, any>;

function build(handles: ControlHandle[]): SectionResult {
    const el = document.createElement('div');
    for (const h of handles) el.appendChild(h.element);
    return { element: el, handles };
}

// =============================================
// Compound caps row: master checkbox + 3 inline sub-toggles
// =============================================
function capsRow(p: P, onChange: () => void): ControlHandle {
    const row = document.createElement('div');
    row.className = 'tt-row';

    const lbl = document.createElement('div');
    lbl.className = 'tt-label';
    lbl.textContent = 'Caps';
    lbl.title = 'Generate end-caps';

    const widget = document.createElement('div');
    widget.className = 'tt-widget';
    widget.style.gap = '6px';

    // Master checkbox — reflects "any sub-toggle on"
    const master = document.createElement('input');
    master.type = 'checkbox';
    master.className = 'tt-checkbox';

    const subKeys = ['capBranchTips', 'capRootTips', 'capTrunkBottom'] as const;
    const subLabels = ['Branches', 'Roots', 'Trunk'];
    const subs: HTMLInputElement[] = [];

    function syncMaster() {
        master.checked = subKeys.some(k => !!p[k]);
    }

    for (let i = 0; i < subKeys.length; i++) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tt-checkbox';
        cb.checked = !!p[subKeys[i]];
        cb.style.marginLeft = i === 0 ? '4px' : '2px';
        cb.addEventListener('change', () => {
            p[subKeys[i]] = cb.checked;
            syncMaster();
            onChange();
        });

        const span = document.createElement('span');
        span.textContent = subLabels[i];
        span.style.fontSize = '9px';
        span.style.opacity = '0.6';
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => { cb.click(); });

        subs.push(cb);
        widget.appendChild(cb);
        widget.appendChild(span);
    }

    syncMaster();

    master.addEventListener('change', () => {
        const on = master.checked;
        for (let i = 0; i < subKeys.length; i++) {
            p[subKeys[i]] = on;
            subs[i].checked = on;
        }
        onChange();
    });

    widget.insertBefore(master, widget.firstChild);
    row.appendChild(lbl);
    row.appendChild(widget);

    return {
        element: row,
        update() {
            for (let i = 0; i < subKeys.length; i++) subs[i].checked = !!p[subKeys[i]];
            syncMaster();
        },
    };
}

// =============================================
// SPECIES
// =============================================
export function createSpeciesContent(p: P, cb: SectionCallbacks): SectionResult {
    return build([
        dropdownRow(p, 'preset', 'Preset', [...presetNames], (v) => cb.onPresetChange(v)),
        sliderRow(p, 'seed', 'Seed', 0, 99999, 1, () => cb.onParamChange()),
    ]);
}

// =============================================
// TRUNK
// =============================================
export function createTrunkContent(p: P, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    return build([
        sliderRow(p, 'initialRadius', 'Radius', 0.05, 2.0, 0.05, regen),
        sliderRow(p, 'angle', 'Branch Angle', 5, 160, 1, regen),
        sliderRow(p, 'initialLength', 'Segment Len', 0.5, 6.0, 0.1, regen),
        sliderRow(p, 'radialSegments', 'Cyl. Sides', 3, 32, 1, regen),
        sliderRow(p, 'radialSegmentsDepthStep', 'Sides Depth Drop', 0, 5, 1, regen),
        sliderRow(p, 'lengthSubdivision', 'Length Subdiv', 0, 10, 0.1, regen),
        sliderRow(p, 'tropismStrength', 'Gravity Bend', 0, 0.3, 0.005, regen),
        sliderRow(p, 'flattenBias', 'Flatten Bias', 0, 1, 0.05, regen),
        sliderRow(p, 'branchWeight', 'Branch Weight', 0, 1, 0.05, regen),
        sliderRow(p, 'phototropism', 'Phototropism', 0, 0.3, 0.005, regen),
        sliderRow(p, 'kinkAngle', 'Node Kink', 0, 15, 0.5, regen),
        sliderRow(p, 'kinkVariance', 'Kink Variance', 0, 10, 0.5, regen),
        sliderRow(p, 'kinkRestore', 'Kink Restore', 0, 3, 0.1, regen),
        checkboxRow(p, 'trunkTaperEnabled', 'Custom Taper', regen),
        sliderRow(p, 'trunkTaperAmount', 'Trunk Taper', 0, 1, 0.05, regen),
        sliderRow(p, 'trunkTaperPower', 'Taper Curve', 0.2, 3, 0.05, regen),
    ]);
}

// =============================================
// ROOTS
// =============================================
export function createRootsContent(p: P, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    return build([
        sliderRow(p, 'rootCount', 'Root Count', 0, 10, 1, regen),
        sliderRow(p, 'rootLength', 'Root Length', 0.05, 0.6, 0.01, regen),
        sliderRow(p, 'trunkExtension', 'Underground', 0, 4, 0.1, regen),
        sliderRow(p, 'rootRadiusFraction', 'Thickness', 0.1, 1.0, 0.05, regen),
        sliderRow(p, 'rootPitchAngle', 'Pitch Angle', 5, 60, 1, regen),
        sliderRow(p, 'rootFlare', 'Root Flare', 1.0, 2.5, 0.05, regen),
        sliderRow(p, 'rootFlareHeight', 'Flare Height', 1, 10, 0.5, regen),
        sliderRow(p, 'rootGravity', 'Root Gravity', 0, 1, 0.05, regen),
        sliderRow(p, 'rootHeight', 'Root Height', -1, 2, 0.05, regen),
        sliderRow(p, 'rootSurfaceOffset', 'Surface Offset', -1, 1, 0.05, regen),
        sliderRow(p, 'rootTaperAmount', 'Root Taper', 0, 1, 0.05, regen),
        sliderRow(p, 'rootTaperPower', 'Taper Curve', 0.2, 3, 0.05, regen),
        sliderRow(p, 'rootKinkAngle', 'Root Kink', 0, 20, 0.5, regen),
        sliderRow(p, 'rootPullDownRadius', 'Pull Radius', 0, 10, 0.1, regen),
        sliderRow(p, 'rootPullDownStrength', 'Pull Strength', 0, 1, 0.05, regen),
        sliderRow(p, 'subRootLevels', 'Sub Levels', 0, 4, 1, regen),
        sliderRow(p, 'subRootCount', 'Sub Count', 0, 5, 1, regen),
        sliderRow(p, 'subRootScale', 'Sub Scale', 0.2, 3, 0.05, regen),
    ]);
}

// =============================================
// BRANCHING
// =============================================
export function createBranchingContent(p: P, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    const smartFitHandle = checkboxRow(p, 'smartFitEnabled', 'Smart Fit', regen);
    // Welding requires smart fit — lock it when weld is active
    if (p.weldEnabled) smartFitHandle.setDisabled?.(true);

    return build([
        sliderRow(p, 'iterations', 'Iterations', 1, 6, 1, regen),
        sliderRow(p, 'subBranchAngle', 'Branch Angle', 5, 90, 1, regen),
        sliderRow(p, 'angleVariance', 'Angle Var.', 0, 25, 0.5, regen),
        sliderRow(p, 'lengthScale', 'Length Scale', 0.3, 3.0, 0.01, regen),
        sliderRow(p, 'whorlTaper', 'Whorl Taper', 0.5, 1.2, 0.01, regen),
        sliderRow(p, 'whorlMaxBranches', 'Whorl Branches', 1, 8, 1, regen),
        sliderRow(p, 'whorlBranchReduction', 'Whorl Reduction', 0, 2, 0.1, regen),
        sliderRow(p, 'radiusScale', 'Radius Scale', 0.2, 0.9, 0.01, regen),
        sliderRow(p, 'taperAmount', 'Taper Amount', 0, 1, 0.05, regen),
        sliderRow(p, 'taperPower', 'Taper Curve', 0.2, 3.0, 0.05, regen),
        sliderRow(p, 'contactFlare', 'Contact Flare', 0, 1, 0.05, regen),
        sliderRow(p, 'contactFlareLength', 'Flare Length', 0.05, 0.5, 0.01, regen),
        sliderRow(p, 'tipRadius', 'Tip Radius', 0, 0.5, 0.005, regen),
        capsRow(p, regen),
        smartFitHandle,
        checkboxRow(p, 'weldEnabled', 'Branch Welding', (on) => {
            if (on && !p.smartFitEnabled) {
                p.smartFitEnabled = true;
                smartFitHandle.update();
            }
            smartFitHandle.setDisabled?.(on);
            regen();
        }),
        checkboxRow(p, 'vertexWeldEnabled', 'Vertex Weld', regen),
        sliderRow(p, 'branchJitter', 'Branch Jitter', 0, 0.2, 0.005, regen),
        sliderRow(p, 'branchMinPoints', 'Min Points', 2, 8, 1, regen),
        checkboxRow(p, 'collisionAvoidance', 'Relaxation', regen),
        sliderRow(p, 'relaxIterations', 'Relax Iters', 1, 15, 1, regen),
        sliderRow(p, 'relaxStrength', 'Relax Str.', 0.01, 1.0, 0.01, regen),
        sliderRow(p, 'relaxRadius', 'Relax Radius', 0.5, 3.0, 0.05, regen),
    ]);
}

// =============================================
// LEAVES
// =============================================
export function createLeavesContent(p: P, r: WebGL2Renderer, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    return build([
        checkboxRow(p, 'showLeaves', 'Show Leaves', (v) => { r.showLeaves = v; regen(); }),
        sliderRow(p, 'leafDensity', 'Density', 0, 15, 0.5, regen),
        sliderRow(p, 'leafSize', 'Size', 0.1, 4.0, 0.1, regen),
        sliderRow(p, 'leafMinDepth', 'Min Depth', 0, 6, 1, regen),
        checkboxRow(p, 'clusterMode', 'Cluster Mode', regen),
        sliderRow(p, 'clusterSize', 'Cluster Size', 1.0, 5.0, 0.1, regen),
        sliderRow(p, 'leafDroop', 'Droop', 0, 1, 0.05, regen),
        sliderRow(p, 'leafSpread', 'Spread', 0, 1, 0.05, regen),
        checkboxRow(p, 'tipLeaves', 'Tip Leaves', regen),
        sliderRow(p, 'tipLeafMinDepth', 'Tip Min Depth', 0, 6, 1, regen),
        sliderRow(p, 'leafHorizontality', 'Horizontality', 0, 1, 0.05, regen),
        sliderRow(p, 'leafHorizontalityNoise', 'Horiz. Noise', 0, 1, 0.05, regen),
        sliderRow(p, 'leafVerticality', 'Verticality', 0, 1, 0.05, regen),
        sliderRow(p, 'leafVerticalityNoise', 'Vert. Noise', 0, 1, 0.05, regen),
        sliderRow(p, 'leafWorldUp', 'World Up', 0, 1, 0.05, regen),
        dropdownRow(p, 'leafOrientationMode', 'Orientation', ['branch', 'sky', 'pendant', 'radial'], regen),
    ]);
}

// =============================================
// WIND
// =============================================
export function createWindContent(p: P): SectionResult {
    return build([
        sliderRow(p, 'windSpeed', 'Speed', 0, 15, 0.1),
        sliderRow(p, 'windAzimuth', 'Azimuth', 0, 360, 1),
        sliderRow(p, 'windElevation', 'Elevation', -90, 90, 1),
        sliderRow(p, 'gustStrength', 'Gust Str.', 0, 1, 0.05),
        sliderRow(p, 'windBias', 'Wind Bias', 0, 1, 0.05),
        sliderRow(p, 'windVerticalDamping', 'Trunk V.Damp', 0, 1, 0.05),
        sliderRow(p, 'leafVerticalDamping', 'Leaf V.Damp', 0, 1, 0.05),
        sliderRow(p, 'leafPushStrength', 'Leaf Push', 0, 2, 0.05),
        sliderRow(p, 'trunkStiffness', 'Trunk Stiff.', 1, 5, 0.1),
        sliderRow(p, 'branchFlexibility', 'Branch Flex', 0, 2, 0.05),
        sliderRow(p, 'maxSway', 'Max Sway', 0.5, 10, 0.5),
    ]);
}

// =============================================
// AUDIO
// =============================================
export function createAudioContent(p: P, cb: SectionCallbacks): SectionResult {
    return build([
        checkboxRow(p, 'audioEnabled', 'Enable', (v) => cb.onAudioToggle(v)),
        checkboxRow(p, 'audioMute', 'Mute'),
        sliderRow(p, 'masterVolume', 'Master Vol', 0, 1.5, 0.01),
        sliderRow(p, 'lowBandGain', 'Low Band', 0, 1, 0.01),
        sliderRow(p, 'midBandGain', 'Mid Band', 0, 1, 0.01),
        sliderRow(p, 'highBandGain', 'High Band', 0, 1, 0.01),
        sliderRow(p, 'airBandGain', 'Air Band', 0, 1, 0.01),
        sliderRow(p, 'gustAttack', 'Gust Attack', 0.3, 4.0, 0.05),
        sliderRow(p, 'gustRelease', 'Gust Release', 0.5, 6.0, 0.05),
        sliderRow(p, 'stereoWidth', 'Stereo Width', 0, 2, 0.01),
        sliderRow(p, 'reverbMix', 'Reverb Mix', 0, 1, 0.01),
        sliderRow(p, 'reverbRoomSize', 'Room Size', 0, 1, 0.01),
        sliderRow(p, 'reverbDamping', 'Damping', 0, 1, 0.01),
        sliderRow(p, 'eqTilt', 'EQ Tilt', -1, 1, 0.01),
        sliderRow(p, 'eqPresence', 'Presence', -6, 6, 0.1),
        sliderRow(p, 'eqAir', 'Air', -6, 6, 0.1),
        sliderRow(p, 'compressionAmount', 'Compression', 0, 1, 0.01),
    ]);
}

// =============================================
// BARK GEOMETRY
// =============================================
export function createBarkGeomContent(p: P, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    return build([
        sliderRow(p, 'barkNoiseAmount', 'Noise Amt', 0, 0.5, 0.01, regen),
        sliderRow(p, 'barkNoiseFreq', 'Noise Freq', 0.5, 15, 0.5, regen),
        sliderRow(p, 'barkNoiseOctaves', 'Octaves', 1, 4, 1, regen),
        sliderRow(p, 'barkTwist', 'Twist Rate', -2.0, 2.0, 0.05, regen),
        sliderRow(p, 'barkTwistNoise', 'Twist Noise', 0, 2.0, 0.05, regen),
        sliderRow(p, 'barkTwistNoiseFreq', 'Twist N.Freq', 0.5, 5.0, 0.1, regen),
        sliderRow(p, 'barkUvTwist', 'UV Twist', 0, 2.0, 0.05, regen),
    ]);
}

// =============================================
// MATERIALS
// =============================================
export function createMaterialsContent(p: P, r: WebGL2Renderer, cb: SectionCallbacks): SectionResult {
    const regen = () => cb.onParamChange();
    return build([
        sliderRow(p, 'barkTileU', 'Bark Tile U', 1, 10, 0.5, regen),
        sliderRow(p, 'barkTileV', 'Bark Tile V', 1, 10, 0.5, regen),
        checkboxRow(p, 'parallaxEnabled', 'Parallax', (v) => { r.parallaxEnabled = v; }),
        sliderRow(p, 'parallaxScale', 'POM Scale', 0, 0.1, 0.001, (v) => { r.parallaxScale = v; }),
        sliderRow(p, 'parallaxSteps', 'POM Steps', 4, 32, 1, (v) => { r.parallaxSteps = v; }),
        sliderRow(p, 'parallaxFadeNear', 'POM Fade Near', 5, 50, 1, (v) => { r.parallaxFadeNear = v; }),
        sliderRow(p, 'parallaxFadeFar', 'POM Fade Far', 10, 100, 1, (v) => { r.parallaxFadeFar = v; }),
    ]);
}

// =============================================
// LIGHTING
// =============================================
export function createLightingContent(p: P, r: WebGL2Renderer): SectionResult {
    const handles: ControlHandle[] = [
        sliderRow(p, 'sunIntensity', 'Sun Int.', 0, 20, 0.1, (v) => { r.sunIntensity = v; }),
        sliderRow(p, 'sunAzimuth', 'Sun Azimuth', 0, 360, 1),
        sliderRow(p, 'sunElevation', 'Sun Elev.', 1, 90, 1),
        sliderRow(p, 'ambientIntensity', 'Ambient', 0, 4, 0.05, (v) => { r.ambientIntensity = v; }),
    ];

    handles.push(
        checkboxRow(p, 'shadows', 'Shadows', (v) => { r.shadowsEnabled = v; }),
        sliderRow(p, 'shadowBias', 'Shadow Bias', 0, 0.01, 0.0001, (v) => { r.shadowBias = v; }),
        sliderRow(p, 'shadowNormalBias', 'Normal Bias', 0, 0.2, 0.005, (v) => { r.shadowNormalBias = v; }),
        sliderRow(p, 'shadowSoftness', 'Softness', 0.5, 10, 0.25, (v) => { r.shadowSoftness = v; }),
        sliderRow(p, 'shadowFadeStart', 'Fade Start', 1, 50, 1, (v) => { r.shadowFadeStart = v; }),
        sliderRow(p, 'shadowFadeEnd', 'Fade End', 5, 100, 1, (v) => { r.shadowFadeEnd = v; }),
        checkboxRow(p, 'showGizmo', 'Show Gizmo', (v) => { r.gizmoVisible = v; }),
        colorRow(p, 'backgroundColor', 'Background', (v) => {
            const hex = cssColorToHex(v);
            const srgb = [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255] as [number, number, number];
            r.backgroundColor = srgb;
            r.fogColor = [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
        }),
    );

    return build(handles);
}

// =============================================
// ATMOSPHERE
// =============================================
export function createAtmosphereContent(p: P, r: WebGL2Renderer): SectionResult {
    return build([
        checkboxRow(p, 'skyEnabled', 'Enable', (v) => { r.skyEnabled = v; }),
        sliderRow(p, 'skyRayleighScale', 'Rayleigh', 0.1, 3.0, 0.05, (v) => { r.skyRayleighScale = v; }),
        sliderRow(p, 'skyMieScale', 'Mie', 0.1, 3.0, 0.05, (v) => { r.skyMieScale = v; }),
        sliderRow(p, 'skyMieAnisotropy', 'Mie Aniso.', 0.0, 0.999, 0.01, (v) => { r.skyMieAnisotropy = v; }),
        colorRow(p, 'skyGroundAlbedo', 'Ground Color', (v) => {
            const hex = cssColorToHex(v);
            r.skyGroundAlbedo = [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255];
        }),
        sliderRow(p, 'skyRaySteps', 'Ray Steps', 4, 32, 4, (v) => { r.skyRaySteps = v; }),
    ]);
}

// =============================================
// DISPLAY
// =============================================
function debugViewToInt(view?: string): number {
    switch (view) {
        case 'uv': return 1;
        case 'normal': return 2;
        case 'tangent': return 3;
        case 'normalMap': return 4;
        case 'displacement': return 5;
        default: return 0;
    }
}

export function createDisplayContent(p: P, r: WebGL2Renderer): SectionResult {
    return build([
        checkboxColorRow(p, 'showBarkWire', 'wireframeBarkColor', 'Bark Wire',
            (v) => { r.barkWire = v; },
            (v) => { r.wireframeBarkColor = [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255]; },
        ),
        checkboxColorRow(p, 'showLeafWire', 'wireframeLeafColor', 'Leaf Wire',
            (v) => { r.leafWire = v; },
            (v) => { r.wireframeLeafColor = [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255]; },
        ),
        checkboxRow(p, 'wireframeOnTop', 'Wire On Top', (v) => { r.wireframeOnTop = v; }),
        checkboxRow(p, 'enableNormalMap', 'Normal Map', (v) => { r.normalMappingEnabled = v; }),
        sliderRow(p, 'barkNormalStrength', 'Bark Normal', 0, 5, 0.1, (v) => { r.barkNormalScale = v; }),
        sliderRow(p, 'leafNormalStrength', 'Leaf Normal', 0, 5, 0.1, (v) => { r.leafNormalScale = v; }),
        sliderRow(p, 'leafSSS', 'Leaf SSS', 0, 1, 0.01, (v) => { r.leafSSSStrength = v; }),
        dropdownRow(p, 'debugView', 'Debug View', ['none', 'uv', 'normal', 'tangent', 'normalMap', 'displacement'],
            (v) => { r.debugView = debugViewToInt(v); }),
    ]);
}

// =============================================
// EXPORT
// =============================================
export function createExportContent(cb: SectionCallbacks): SectionResult {
    return build([
        buttonRow('Export GLB', () => cb.onExportGLB()),
        buttonRow('Export glTF', () => cb.onExportGLTF()),
        buttonRow('Save Config', () => cb.onSaveConfig()),
        buttonRow('Load Config', () => cb.onLoadConfig()),
    ]);
}
