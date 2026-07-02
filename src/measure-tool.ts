import {
    BLEND_NORMAL,
    PRIMITIVE_LINESTRIP,
    SEMANTIC_POSITION,
    SORTMODE_NONE,
    createSphere,
    GraphNode,
    Layer,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Picker } from './picker';
import type { Global, MeasureMode } from './types';

const BRAND = { r: 0xdb / 255, g: 0x14 / 255, b: 0x6b / 255 };
/** Max tap travel (px) before a gesture counts as a look-drag, not a pick. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 600;

// flat brand-color shaders (GLSL + WGSL), depth test disabled via material
const vertexGLSL = /* glsl */ `
attribute vec3 vertex_position;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;

void main(void) {
    gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
}`;

const fragmentGLSL = /* glsl */ `
precision highp float;

uniform vec4 uColor;

void main(void) {
    gl_FragColor = uColor;
}`;

const vertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;

uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(vertex_position, 1.0);
    return output;
}
`;

const fragmentWGSL = /* wgsl */ `
uniform uColor: vec4f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = uniform.uColor;
    return output;
}
`;

const tmpVec = new Vec3();
const tmpScreen = new Vec3();

/**
 * Distance & area measurement built on the splat depth-pick interface.
 *
 * The viewer has no measurement UI of its own — it provides point picking
 * (gaussian splat depth raycast) and this tool does the rest: tap/click to
 * place vertices, polyline length in distance mode, planar polygon area
 * (Newell projection + shoelace) in area mode. All gizmos render
 * depth-test-off in the brand color so they stay legible inside the splat
 * cloud.
 */
class MeasureTool {
    private global: Global;

    private canvas: HTMLCanvasElement;

    private picker: Picker | null = null;

    private layer: Layer;

    private labelLayer: HTMLDivElement;

    private mode: MeasureMode = null;

    private points: Vec3[] = [];

    private markers: { instance: MeshInstance; node: GraphNode }[] = [];

    private labels: { el: HTMLDivElement; anchor: Vec3 }[] = [];

    private markerMesh: Mesh;

    private markerMaterial: ShaderMaterial;

    private lineMesh: Mesh;

    private lineInstance: MeshInstance;

    private pointerDown: { x: number; y: number; t: number } | null = null;

    /** Notified whenever the measurement sketch changes (for UI state). */
    onChange: ((pointCount: number) => void) | null = null;

    constructor(global: Global) {
        this.global = global;

        const { app, camera } = global;
        const device = app.graphicsDevice;
        this.canvas = device.canvas as HTMLCanvasElement;

        // dedicated overlay layer rendered after the splats
        this.layer = new Layer({
            name: 'Measure Layer',
            opaqueSortMode: SORTMODE_NONE,
            transparentSortMode: SORTMODE_NONE,
            passThrough: true,
            overrideClear: true
        });

        const layers = app.scene.layers;
        const worldLayer = layers.getLayerByName('World');
        layers.insert(this.layer, layers.getTransparentIndex(worldLayer) + 1);
        camera.camera.layers = camera.camera.layers.concat([this.layer.id]);

        const makeMaterial = () => {
            const material = new ShaderMaterial({
                uniqueName: 'measure-gizmo',
                attributes: {
                    vertex_position: SEMANTIC_POSITION
                },
                vertexGLSL: vertexGLSL,
                fragmentGLSL: fragmentGLSL,
                vertexWGSL: vertexWGSL,
                fragmentWGSL: fragmentWGSL
            });
            material.setParameter('uColor', [BRAND.r, BRAND.g, BRAND.b, 1.0]);
            material.blendType = BLEND_NORMAL;
            // gizmos stay legible inside the splat cloud
            material.depthTest = false;
            material.depthWrite = false;
            material.update();
            return material;
        };

        this.markerMaterial = makeMaterial();

        // unit sphere, scaled per frame to a constant on-screen size
        this.markerMesh = createSphere(device, {
            radius: 1,
            latitudeBands: 12,
            longitudeBands: 16
        });

        // polyline mesh, positions rebuilt whenever the sketch changes
        this.lineMesh = new Mesh(device);
        this.lineMesh.setPositions([0, 0, 0, 0, 0, 0]);
        this.lineMesh.update(PRIMITIVE_LINESTRIP);

        this.lineInstance = new MeshInstance(this.lineMesh, makeMaterial(), new GraphNode());
        this.lineInstance.cull = false;
        this.lineInstance.visible = false;
        this.layer.addMeshInstances([this.lineInstance], true);

        this.labelLayer = document.createElement('div');
        this.labelLayer.id = 'lumina-measure-labels';
        document.body.appendChild(this.labelLayer);

        this.canvas.addEventListener('pointerdown', this.handlePointerDown);
        this.canvas.addEventListener('pointerup', this.handlePointerUp);

        // keep labels glued to their anchors and markers at a constant
        // on-screen size
        app.on('framerender', this.frameUpdate);
    }

    getMode(): MeasureMode {
        return this.mode;
    }

    setMode(mode: MeasureMode): void {
        if (mode === this.mode) return;
        this.mode = mode;
        this.global.state.measureMode = mode;
        // A distance polyline and an area polygon are different sketches;
        // switching tools starts fresh.
        this.clear();
    }

    clear(): void {
        this.points = [];
        this.rebuildVisuals();
        this.onChange?.(0);
    }

    dispose(): void {
        this.global.app.off('framerender', this.frameUpdate);
        this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvas.removeEventListener('pointerup', this.handlePointerUp);
        this.clear();
        this.layer.removeMeshInstances([this.lineInstance]);
        this.picker?.release();
        this.labelLayer.remove();
    }

    // ----------------------------------------------------------------- //

    private readonly handlePointerDown = (e: PointerEvent): void => {
        if (!this.mode || !e.isPrimary) return;
        this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    };

    private readonly handlePointerUp = async (e: PointerEvent): Promise<void> => {
        if (!this.mode || !e.isPrimary || !this.pointerDown) return;
        const start = this.pointerDown;
        this.pointerDown = null;

        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        const elapsed = performance.now() - start.t;
        // A drag is camera navigation, not a measurement pick.
        if (moved > TAP_SLOP_PX || elapsed > TAP_MAX_MS) return;

        if (!this.picker) {
            this.picker = new Picker(this.global.app, this.global.camera);
        }

        const point = await this.picker.pick(
            e.offsetX / this.canvas.clientWidth,
            e.offsetY / this.canvas.clientHeight
        );
        // mode may have been switched off while the async pick was in flight
        if (!point || !this.mode) return;

        this.points.push(point);
        this.rebuildVisuals();
        this.onChange?.(this.points.length);
    };

    private readonly frameUpdate = (): void => {
        const { camera } = this.global;
        const cameraPos = camera.getPosition();

        for (const marker of this.markers) {
            const dist = marker.node.getPosition().distance(cameraPos);
            const s = Math.max(0.008, dist * 0.008);
            marker.node.setLocalScale(s, s, s);
        }

        if (this.labels.length === 0) return;

        const rect = this.canvas.getBoundingClientRect();
        for (const { el, anchor } of this.labels) {
            const behind = tmpVec.sub2(anchor, cameraPos).dot(camera.forward) <= 0;
            if (behind) {
                el.style.display = 'none';
                continue;
            }
            el.style.display = '';
            camera.camera.worldToScreen(anchor, tmpScreen);
            const x = rect.left + tmpScreen.x;
            const y = rect.top + tmpScreen.y;
            el.style.transform = `translate(-50%, -130%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        }
    };

    private rebuildVisuals(): void {
        const { app } = this.global;

        this.layer.removeMeshInstances(this.markers.map(m => m.instance));
        this.markers = [];

        for (const { el } of this.labels) el.remove();
        this.labels = [];

        for (const p of this.points) {
            const node = new GraphNode();
            node.setPosition(p);
            const instance = new MeshInstance(this.markerMesh, this.markerMaterial, node);
            instance.cull = false;
            this.markers.push({ instance, node });
        }
        this.layer.addMeshInstances(this.markers.map(m => m.instance), true);

        if (this.points.length >= 2) {
            const linePoints =
                this.mode === 'area' && this.points.length >= 3 ?
                    [...this.points, this.points[0]] : // close the polygon
                    this.points;
            const positions: number[] = [];
            for (const p of linePoints) positions.push(p.x, p.y, p.z);
            this.lineMesh.setPositions(positions);
            this.lineMesh.update(PRIMITIVE_LINESTRIP);
            this.lineInstance.visible = true;
        } else {
            this.lineInstance.visible = false;
        }

        if (this.mode === 'distance') this.buildDistanceLabels();
        if (this.mode === 'area') this.buildAreaLabel();

        app.renderNextFrame = true;
    }

    private buildDistanceLabels(): void {
        let total = 0;
        for (let i = 1; i < this.points.length; i++) {
            const a = this.points[i - 1];
            const b = this.points[i];
            const len = a.distance(b);
            total += len;
            const mid = new Vec3().add2(a, b).mulScalar(0.5);
            this.addLabel(formatLength(len), mid);
        }
        if (this.points.length > 2) {
            this.addLabel(
                `Σ ${formatLength(total)}`,
                this.points[this.points.length - 1],
                true
            );
        }
    }

    private buildAreaLabel(): void {
        if (this.points.length < 3) return;
        const area = polygonArea(this.points);
        const centroid = new Vec3();
        for (const p of this.points) centroid.add(p);
        centroid.divScalar(this.points.length);
        this.addLabel(formatArea(area), centroid, true);
    }

    private addLabel(text: string, anchor: Vec3, emphasis = false): void {
        const el = document.createElement('div');
        el.className = emphasis ?
            'lumina-measure-label lumina-measure-label--total' :
            'lumina-measure-label';
        el.textContent = text;
        this.labelLayer.appendChild(el);
        this.labels.push({ el, anchor: anchor.clone() });
    }
}

/** Splat captures are metric (meters); labels display Imperial units. */
const INCHES_PER_METER = 39.3701;
const SQ_INCHES_PER_SQ_METER = INCHES_PER_METER * INCHES_PER_METER;

function formatLength(meters: number): string {
    const inches = meters * INCHES_PER_METER;
    return `${inches.toFixed(1)} in`;
}

function formatArea(squareMeters: number): string {
    const squareInches = squareMeters * SQ_INCHES_PER_SQ_METER;
    return `${squareInches.toFixed(0)} in²`;
}

/**
 * Area of a (possibly non-planar) 3D polygon: Newell's method gives the
 * best-fit plane normal; half its magnitude is the projected area.
 * @param points - The polygon vertices in order.
 * @returns The polygon area in square scene units.
 */
function polygonArea(points: Vec3[]): number {
    const normal = new Vec3();
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        normal.x += (a.y - b.y) * (a.z + b.z);
        normal.y += (a.z - b.z) * (a.x + b.x);
        normal.z += (a.x - b.x) * (a.y + b.y);
    }
    return normal.length() / 2;
}

export { MeasureTool };
