import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export default function App() {
  const containerRef = useRef(null);

  useEffect(() => {
    // 1. SCENE & CAMERA SETUP
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.0)); // Prevent pitch black

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(0, 10, 20); // Step back from the center

    // 2. RENDERER & DOM MOUNT
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    if (containerRef.current) {
      containerRef.current.innerHTML = ''; // Clear container
      containerRef.current.appendChild(renderer.domElement);
    }

    // 3. ANIMATION LOOP
    const animate = () => {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    // 4. PURE XGRIDS ENGINE INITIALIZATION
    const targetAsset = "https://s3.us-east-1.amazonaws.com/tours.luminaspatial.net/Testing/lcc_test/3463_ARecon_2_acre.lcc";

    if (window.LCC && window.LCC.LCCRender) {
      console.log("🚀 Starting pure XGrids load...");
      window.LCC.LCCRender.load({
        scene: scene,
        camera: camera,
        renderer: renderer,
        canvas: renderer.domElement,
        renderLib: THREE,
        url: targetAsset
      }, targetAsset);
    } else {
      console.error("🔴 LCC SDK not loaded! Check index.html script tag.");
    }

    // Resize handler
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  return <div ref={containerRef} style={{ width: '100vw', height: '100vh', backgroundColor: '#000' }} />;
}
