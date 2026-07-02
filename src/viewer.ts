import {
    BoundingBox,
    CameraFrame,
    type CameraComponent,
    Color,
    type Entity,
    type Layer,
    RenderTarget,
    Mat4,
    MiniStats,
    ShaderChunks,
    type TextureHandler,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    TONEMAP_NONE,
    TONEMAP_LINEAR,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_NEUTRAL,
    Vec3,
    GSplatComponent,
    GSPLAT_RENDERER_AUTO,
    platform
} from 'playcanvas';

import { App } from './app';
import { Annotations } from './annotations';
import { CameraManager } from './camera-manager';
import { Camera } from './cameras/camera';
import { DebugLines } from './debug-lines';
import { nearlyEquals } from './core/math';
import { InputController } from './input-controller';
import { MeasureTool } from './measure-tool';
import { installMeasureToolbar } from './measure-toolbar';
import type { ExperienceSettings, PostEffectSettings } from './settings';
import type { Global } from './types';
import type { VoxelCollider } from './voxel-collider';
import { VoxelDebugOverlay } from './voxel-debug-overlay';
import { WalkCursor } from './walk-cursor';

// PlayCanvas 2.20 added a `depth` parameter to prepareOutputFromGamma (used for fog).
// We bypass gamma decode / tonemap / fog and write gamma-space colors directly, so the
// extra argument is accepted but ignored. The signature must match the engine's call site.
const gammaChunkGlsl = `
vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
    return gammaColor;
}
`;

const gammaChunkWgsl = `
fn prepareOutputFromGamma(gammaColor: vec3f, depth: f32) -> vec3f {
    return gammaColor;
}
`;

const tonemapTable: Record<string, number> = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};

const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    } else {
        bloom.intensity = 0;
    }

    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    } else {
        grading.enabled = false;
    }

    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    } else {
        vignette.intensity = 0;
    }

    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    } else {
        fringing.intensity = 0;
    }
};

const anyPostEffectEnabled = (settings: PostEffectSettings): boolean => {
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
};

const vec = new Vec3();

// store the original isColorBufferSrgb so the override in updatePostEffects is idempotent
const origIsColorBufferSrgb = RenderTarget.prototype.isColorBufferSrgb;

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    cameraManager: CameraManager;

    annotations: Annotations;

    measureTool: MeasureTool | null = null;

    forceRenderNextFrame = false;

    voxelOverlay: VoxelDebugOverlay | null = null;

    walkCursor: WalkCursor | null = null;

    origChunks: {
        glsl: {
            gsplatOutputVS: string
        },
        wgsl: {
            gsplatOutputVS: string
        }
    };

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void> | undefined, voxelLoad: Promise<VoxelCollider> | undefined) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        this.origChunks = {
            glsl: {
                gsplatOutputVS: ShaderChunks.get(graphicsDevice, 'glsl').get('gsplatOutputVS')
            },
            wgsl: {
                gsplatOutputVS: ShaderChunks.get(graphicsDevice, 'wgsl').get('gsplatOutputVS')
            }
        };

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // configure the camera
        this.configureCamera(settings);

        // reconfigure camera when entering/exiting XR
        app.xr.on('start', () => this.configureCamera(settings));
        app.xr.on('end', () => this.configureCamera(settings));

        // construct debug ministats
        if (config.ministats) {
            const options = MiniStats.getDefaultOptions() as any;
            options.cpu.enabled = false;
            options.stats = options.stats.filter((s: any) => s.name !== 'DrawCalls');
            options.stats.push({
                name: 'VRAM',
                stats: ['vram.tex'],
                decimalPlaces: 1,
                multiplier: 1 / (1024 * 1024),
                unitsName: 'MB',
                watermark: 1024
            }, {
                name: 'Splats',
                stats: ['frame.gsplats'],
                decimalPlaces: 3,
                multiplier: 1 / 1000000,
                unitsName: 'M',
                watermark: 5
            });

            // eslint-disable-next-line no-new
            new MiniStats(app, options);
        }

        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();

        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;

            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }

            if (this.forceRenderNextFrame) {
                app.renderNextFrame = true;
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });

        const applyCamera = (camera: Camera) => {
            const cameraEntity = global.camera;

            cameraEntity.setPosition(camera.position);
            cameraEntity.setEulerAngles(camera.angles);
            cameraEntity.camera.fov = camera.fov;

            cameraEntity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;

            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();

            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);

            const far = Math.max(dist + boundRadius, 1e-2);
            const near = Math.max(dist - boundRadius, far / (1024 * 16));

            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = near;
        };

        // movement-aware rendering state: detect camera motion in the update loop (which
        // runs every frame) so we can force a render through it — independent of the idle
        // timer and the framerender matrix-diff, which can otherwise skip frames during a
        // goto/transition and make it look choppy.
        const prevCamPos = new Vec3();
        const prevCamAngles = new Vec3();
        let camMoving = false;
        let stillFrames = 0;

        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);

                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);

                // apply to the camera entity
                applyCamera(this.cameraManager.camera);

                // detect camera motion this frame (covers transitions, goto tweens and panning)
                const cam = this.cameraManager.camera;
                const moved =
                    cam.position.distance(prevCamPos) > 1e-4 ||
                    Math.abs(cam.angles.x - prevCamAngles.x) > 1e-3 ||
                    Math.abs(cam.angles.y - prevCamAngles.y) > 1e-3 ||
                    Math.abs(cam.angles.z - prevCamAngles.z) > 1e-3;
                prevCamPos.copy(cam.position);
                prevCamAngles.copy(cam.angles);

                if (moved) {
                    stillFrames = 0;
                    if (!camMoving) {
                        camMoving = true;
                        state.cameraMoving = true;
                    }
                    // task 1: guarantee a rendered frame for every frame of camera motion
                    app.renderNextFrame = true;
                } else if (camMoving) {
                    // debounce the damped tail of a transition before declaring it stopped
                    if (++stillFrames >= 3) {
                        camMoving = false;
                        state.cameraMoving = false;   // task 2: snap back to full quality
                    }
                    app.renderNextFrame = true;
                }
            }

        });

        // Render voxel debug overlay
        app.on('prerender', () => {
            this.voxelOverlay?.update();
        });

        // update state on first frame
        events.on('firstFrame', () => {
            state.loaded = true;
            state.animationPaused = !!config.noanim;
        });

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad, voxelLoad]).then((results) => {
            const gsplatEntity = results[0]; // may be null if load failed or no URL
            const collider = results[2];

            // get scene bounding box
            if (gsplatEntity) {
                const gsplatBbox = gsplatEntity.gsplat.customAabb;
                if (gsplatBbox) {
                    sceneBound.setFromTransformedAabb(gsplatBbox, gsplatEntity.getWorldTransform());
                }
            }

            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);

                // Measurement (distance / area) on top of the splat picker.
                this.measureTool = new MeasureTool(global);
                const measureToolbar = installMeasureToolbar({
                    onMeasureMode: mode => this.measureTool.setMode(mode),
                    onClearMeasurements: () => this.measureTool.clear()
                });
                this.measureTool.onChange = count => measureToolbar.setHasMeasurements(count > 0);
            }

            this.inputController = new InputController(global);
            this.inputController.collider = collider ?? null;

            state.hasCollision = !!collider;

            // Inherit the gsplat entity's full world transform (rotation, translation, scale).
            // The walk controller uses this to convert between world space and voxel space correctly.
            if (gsplatEntity && collider) {
                collider.setEntityTransform(gsplatEntity.getWorldTransform());
            }

            // Create voxel debug overlay (WebGPU compute shader, requires supportsCompute)
            if (collider && config.webgpu && app.graphicsDevice.supportsCompute) {
                this.voxelOverlay = new VoxelDebugOverlay(app, collider, camera);
                this.voxelOverlay.mode = config.heatmap ? 'heatmap' : 'overlay';
                state.hasVoxelOverlay = true;

                events.on('voxelOverlayEnabled:changed', (value: boolean) => {
                    this.voxelOverlay.enabled = value;
                    app.renderNextFrame = true;
                });
            }

            // ?voxeldebug: AABB wireframe of the (now-transformed) grid + log bounds
            if (collider && config.voxeldebug) {
                const res = collider.voxelResolution;
                const gMinX = collider.gridMinX, gMinY = collider.gridMinY, gMinZ = collider.gridMinZ;
                const gMaxX = gMinX + collider.numVoxelsX * res;
                const gMaxY = gMinY + collider.numVoxelsY * res;
                const gMaxZ = gMinZ + collider.numVoxelsZ * res;

                // Transform all 8 corners of the voxel AABB to world space via the entity transform.
                // This gives a correct world-space AABB regardless of rotation/translation/scale.
                const fwdM = collider.voxelToWorld;
                const voxCorners: [number, number, number][] = [
                    [gMinX, gMinY, gMinZ], [gMaxX, gMinY, gMinZ],
                    [gMinX, gMaxY, gMinZ], [gMaxX, gMaxY, gMinZ],
                    [gMinX, gMinY, gMaxZ], [gMaxX, gMinY, gMaxZ],
                    [gMinX, gMaxY, gMaxZ], [gMaxX, gMaxY, gMaxZ]
                ];
                const pcMin = new Vec3(Infinity, Infinity, Infinity);
                const pcMax = new Vec3(-Infinity, -Infinity, -Infinity);
                const voxPt = new Vec3();
                const worldPt = new Vec3();
                for (const [cx, cy, cz] of voxCorners) {
                    voxPt.set(cx, cy, cz);
                    if (fwdM) {
                        fwdM.transformPoint(voxPt, worldPt);
                    } else {
                        worldPt.set(-cx, -cy, cz);
                    }
                    if (worldPt.x < pcMin.x) pcMin.x = worldPt.x;
                    if (worldPt.y < pcMin.y) pcMin.y = worldPt.y;
                    if (worldPt.z < pcMin.z) pcMin.z = worldPt.z;
                    if (worldPt.x > pcMax.x) pcMax.x = worldPt.x;
                    if (worldPt.y > pcMax.y) pcMax.y = worldPt.y;
                    if (worldPt.z > pcMax.z) pcMax.z = worldPt.z;
                }

                console.log('[VoxelDebug] Transformed grid AABB in PlayCanvas world space:', {
                    min: [+pcMin.x.toFixed(3), +pcMin.y.toFixed(3), +pcMin.z.toFixed(3)],
                    max: [+pcMax.x.toFixed(3), +pcMax.y.toFixed(3), +pcMax.z.toFixed(3)],
                    size: [+(pcMax.x - pcMin.x).toFixed(3), +(pcMax.y - pcMin.y).toFixed(3), +(pcMax.z - pcMin.z).toFixed(3)]
                });

                // Wireframe box every frame (DebugLines shaders are always-visible, no depth clipping)
                const debugLines = new DebugLines(app as unknown as App, camera);
                app.on('prerender', () => {
                    debugLines.box(pcMin, pcMax);
                    debugLines.update();
                });

                // Auto-enable the WebGPU per-voxel overlay too if it was created
                if (this.voxelOverlay) {
                    state.voxelOverlayEnabled = true;
                }
            }

            this.cameraManager = new CameraManager(global, sceneBound, collider);
            applyCamera(this.cameraManager.camera);

            if (collider) {
                this.walkCursor = new WalkCursor(app, camera, collider, events, state);
            }

            if (!gsplatEntity) {
                // No model loaded (load failed or no URL) — show empty viewer
                state.readyToRender = true;
                app.renderNextFrame = true;
                app.once('frameend', () => {
                    events.fire('firstFrame');
                    window.firstFrame?.();
                });
                return;
            }

            const gsplat = gsplatEntity.gsplat as GSplatComponent;

            const { instance } = gsplat;
            if (instance) {
                // kick off gsplat sorting immediately now that camera is in position
                instance.sort(camera);

                // listen for sorting updates to trigger first frame events
                instance.sorter?.on('updated', () => {
                    // request frame render when sorting changes
                    app.renderNextFrame = true;

                    if (!state.readyToRender) {
                        // we're ready to render once the first sort has completed
                        state.readyToRender = true;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }
                });
            } else {

                const { gsplat } = app.scene;

                // quality ranges (millions of splats). Trimmed from the 2.17-era values to
                // claw back the framerate the heavier 2.20 raster pipeline costs, favouring a
                // smooth framerate over maximum raw splat count. Bump these back up if a device
                // has headroom and you want more detail.
                const ranges = {
                    mobile: {
                        low: 1,
                        high: 1.5
                    },
                    desktop: {
                        low: 2,
                        high: 3
                    }
                };

                const quality = platform.mobile ? ranges.mobile : ranges.desktop;

                // start by streaming in low lod
                const lodLevels = gsplatEntity.gsplat.resource?.octree?.lodLevels;
                if (lodLevels) {
                    gsplat.lodRangeMax = gsplat.lodRangeMin = lodLevels - 1;
                }

                // these two allow LOD behind camera to drop, saves lots of splats
                gsplat.lodUpdateAngle = 90;
                gsplat.lodBehindPenalty = 5;

                // same performance, but rotating on slow devices does not give us unsorted splats on sides
                gsplat.radialSorting = true;

                const eventHandler = app.systems.gsplat;

                // idle timer: force continuous rendering until 4s of inactivity
                let idleTime = 0;
                this.forceRenderNextFrame = true;

                app.on('update', (dt: number) => {
                    idleTime += dt;
                    this.forceRenderNextFrame = idleTime < 4;
                });

                events.on('inputEvent', (type: string) => {
                    if (type !== 'interact') {
                        idleTime = 0;
                    }
                });

                eventHandler.on('frame:ready', (_camera: CameraComponent, _layer: Layer, ready: boolean, loading: number) => {
                    if (loading > 0 || !ready) {
                        idleTime = 0;
                    }
                });

                let current = 0;
                let watermark = 1;
                const readyHandler = (camera: CameraComponent, layer: Layer, ready: boolean, loading: number) => {
                    if (ready && loading === 0) {
                        // scene is done loading
                        eventHandler.off('frame:ready', readyHandler);

                        state.readyToRender = true;

                        // handle quality mode changes
                        const updateLod = () => {
                            const settings = state.retinaDisplay ? quality.high : quality.low;
                            gsplatEntity.gsplat.splatBudget = settings * 1000000;
                            gsplat.lodRangeMin = 0;
                            gsplat.lodRangeMax = 1000;
                        };
                        events.on('retinaDisplay:changed', updateLod);
                        updateLod();

                        // debug colorize lods
                        gsplat.colorizeLod = config.colorize;

                        // PlayCanvas 2.20 replaced the `gpuSorting` boolean with a `renderer`
                        // selector. AUTO picks the fastest path per device: GPU-side sorting on
                        // WebGPU and CPU-side sorting on WebGL (WebGL has no GPU-sort path), so it
                        // is the most performant sorting method available on every device.
                        // (?gpusort is now a no-op — re-wire to `gsplat.renderer` if manual control
                        // is ever needed.)
                        gsplat.renderer = GSPLAT_RENDERER_AUTO;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }

                    // update loading status
                    if (loading !== current) {
                        watermark = Math.max(watermark, loading);
                        current = watermark - loading;
                        state.progress = Math.trunc(current / watermark * 100);
                    }
                };

                eventHandler.on('frame:ready', readyHandler);
            }
        });
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, config, camera } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;

        // hpr override takes precedence over settings.highPrecisionRendering
        const highPrecisionRendering = config.hpr ?? settings.highPrecisionRendering;

        const enableCameraFrame = !app.xr.active && !config.nofx && (anyPostEffectEnabled(postEffectSettings) || highPrecisionRendering);

        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = highPrecisionRendering ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F] : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunkGlsl);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', gammaChunkWgsl);

            // ensure the final compose blit doesn't perform linear->gamma conversion.
            RenderTarget.prototype.isColorBufferSrgb = function (index) {
                return this === app.graphicsDevice.backBuffer ? true : origIsColorBufferSrgb.call(this, index);
            };

            camera.camera.clearColor = new Color(background.color);
        } else {
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }

            // restore gsplat output shader chunks to engine defaults
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', this.origChunks.glsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', this.origChunks.wgsl.gsplatOutputVS);

            // restore original isColorBufferSrgb behavior
            RenderTarget.prototype.isColorBufferSrgb = origIsColorBufferSrgb;

            if (!app.xr.active) {
                camera.camera.toneMapping = tonemapTable[settings.tonemapping];
                camera.camera.clearColor = new Color(background.color);
            }
        }
    }
}

export { Viewer };
