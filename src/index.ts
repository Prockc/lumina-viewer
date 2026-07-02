import {
    Asset,
    Color,
    createGraphicsDevice,
    Entity,
    EventHandler,
    Keyboard,
    Mouse,
    platform,
    TouchDevice,
    type Texture,
    type AppBase,
    revision as engineRevision,
    version as engineVersion
} from 'playcanvas';

import { App } from './app';
import { observe } from './core/observe';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { VoxelCollider } from './voxel-collider';
import { initXr } from './xr';
import { version as appVersion } from '../package.json';

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void) => {
    const { contents, contentUrl, unified, aa } = config;
    const c = contents as unknown as ArrayBuffer;
    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
        let watermark = 0;

        // Track progress from the Blob URL Worker fetch (used for .sog files on iOS Safari).
        // Falls back silently to asset 'progress' events for all other load paths.
        const workerProgressHandler = (e: Event) => {
            const { received, total } = (e as CustomEvent).detail;
            if (total > 0) {
                const progress = Math.min(100, Math.trunc((received / total) * 100));
                if (progress > watermark) {
                    watermark = progress;
                    progressCallback(progress);
                }
            }
        };
        window.addEventListener('sse-fetch-progress', workerProgressHandler);

        asset.on('load', () => {
            window.removeEventListener('sse-fetch-progress', workerProgressHandler);
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: unified || filename.toLowerCase().endsWith('lod-meta.json'),
                asset
            });
            const material = entity.gsplat.unified ? app.scene.gsplat.material : entity.gsplat.material;
            material.setDefine('GSPLAT_AA', aa);
            material.setParameter('alphaClip', 1 / 255);
            app.root.addChild(entity);
            resolve(entity);
        });

        asset.on('progress', (received, length) => {
            const progress = Math.min(1, received / length) * 100;
            if (progress > watermark) {
                watermark = progress;
                progressCallback(Math.trunc(watermark));
            }
        });

        asset.on('error', (err) => {
            window.removeEventListener('sse-fetch-progress', workerProgressHandler);
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const loadSkybox = (app: AppBase, url: string) => {
    return new Promise<Asset>((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        asset.on('load', () => {
            resolve(asset);
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const createApp = async (canvas: HTMLCanvasElement, config: Config) => {
    // Prefer WebGPU (notably faster gsplat GPU sorting, especially on mobile) and only
    // fall back to WebGL2 if WebGPU is unavailable. `?webgpu` forces WebGPU with no fallback.
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: config.webgpu ? ['webgpu'] : ['webgpu', 'webgl2'],
        antialias: false,
        depth: true,
        stencil: false,
        xrCompatible: !config.webgpu,
        powerPreference: 'high-performance'
    });

    // Clamp the device pixel ratio so ultra-high-DPR phones (iPhone/Galaxy at DPR 3+)
    // don't drive 3x-resolution splat buffers. The manual sizing in initCanvas clamps
    // further (max 1080px on mobile + a 0.5 scale), but this caps any DPR-driven path too.
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

    const app = new App(canvas, {
        graphicsDevice: device,
        mouse: new Mouse(canvas),
        touch: new TouchDevice(canvas),
        keyboard: new Keyboard(window)
    });

    const cameraRoot = new Entity('camera root');
    app.root.addChild(cameraRoot);

    const camera = new Entity('camera');
    cameraRoot.addChild(camera);

    const light = new Entity('light');
    light.setEulerAngles(35, 45, 0);
    light.addComponent('light', {
        color: new Color(1.0, 0.98, 0.957),
        intensity: 1
    });
    app.root.addChild(light);

    app.scene.ambientLight.set(0.51, 0.55, 0.65);

    return { app, camera };
};

const initCanvas = (global: Global) => {
    const { app, events, state } = global;
    const { canvas } = app.graphicsDevice;

    const maxPixelDim = platform.mobile ? 1080 : 2160;
    const calcPixelRatio = () => Math.min(maxPixelDim / Math.min(screen.width, screen.height), window.devicePixelRatio);

    const deviceSize = { width: 0, height: 0 };

    const set = (width: number, height: number) => {
        const ratio = calcPixelRatio();
        deviceSize.width = width * ratio;
        deviceSize.height = height * ratio;
    };

    // While the camera is moving (flying to an annotation / heavy panning) render at a
    // reduced scale to prioritise framerate, then snap back to full quality once it stops.
    const movingScale = 0.7;

    const apply = () => {
        if (app.xr?.active) return;
        const base = state.retinaDisplay ? 1.0 : 0.5;
        const s = state.cameraMoving ? base * movingScale : base;
        const w = Math.ceil(deviceSize.width * s);
        const h = Math.ceil(deviceSize.height * s);
        if (w !== canvas.width || h !== canvas.height) {
            canvas.width = w;
            canvas.height = h;
        }
    };

    const resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        const e = entries[0]?.contentBoxSize?.[0];
        if (e) {
            set(e.inlineSize, e.blockSize);
            app.renderNextFrame = true;
        }
    });
    resizeObserver.observe(canvas);

    events.on('retinaDisplay:changed', () => {
        app.renderNextFrame = true;
    });

    // re-render when movement state flips so the resolution change takes effect immediately
    events.on('cameraMoving:changed', () => {
        app.renderNextFrame = true;
    });

    app.on('framerender', apply);

    // @ts-ignore
    app._allowResize = false;
    set(canvas.clientWidth, canvas.clientHeight);
    apply();
};

const main = async (canvas: HTMLCanvasElement, settingsJson: any, config: Config) => {
    const { app, camera } = await createApp(canvas, config);

    const events = new EventHandler();

    const state = observe(events, {
        loaded: false,
        readyToRender: false,
        retinaDisplay: platform.mobile ? localStorage.getItem('retinaDisplay') === 'true' : localStorage.getItem('retinaDisplay') !== 'false',
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        hasCollision: false,
        hasVoxelOverlay: false,
        voxelOverlayEnabled: false,
        isFullscreen: false,
        controlsHidden: false,
        gamingControls: platform.mobile ? localStorage.getItem('gamingControls') !== 'false' : localStorage.getItem('gamingControls') === 'true',
        measureMode: null,
        cameraMoving: false
    });

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera
    };

    initCanvas(global);

    app.start();

    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // XR (WebXR) requires a WebGL context, so only initialize it when we actually ended up
    // on WebGL2 (WebGPU was unavailable). On WebGPU devices XR is unavailable by design.
    if (!app.graphicsDevice.isWebGPU) {
        initXr(global);
    }

    initUI(global);

    const gsplatLoad = config.contentUrl ? loadGsplat(
        app,
        config,
        (progress: number) => {
            state.progress = progress;
        }
    ).catch((err: Error): null => {
        console.error('Failed to load model:', err);
        state.progress = 0;
        return null;
    }) : Promise.resolve(null);

    const skyboxLoad = config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl).then((asset) => {
            app.scene.envAtlas = asset.resource as Texture;
        });

    const voxelLoad = config.voxelUrl &&
        VoxelCollider.load(config.voxelUrl).catch((err: Error): null => {
            console.warn('Failed to load voxel data:', err);
            return null;
        });

    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        document.body.addEventListener('click', () => {
            if (sound) {
                sound.play();
            }
        }, {
            capture: true,
            once: true
        });
    }

    return new Viewer(global, gsplatLoad, skyboxLoad, voxelLoad);
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
