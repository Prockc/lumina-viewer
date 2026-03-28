import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import nipplejs from 'nipplejs';
import './App.css';

export default function App() {
  const containerRef = useRef(null);
  const joystickRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const modelName = urlParams.get('model');
    const s3BucketUrl = 'https://YOUR_BUCKET_NAME.s3.us-east-1.amazonaws.com/';
    const targetAsset = modelName ? `${s3BucketUrl}${modelName}` : null;

    if (!targetAsset) {
      console.error("No model specified. Use ?model=filename.lcc in URL.");
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

    renderer.setSize(window.innerWidth, window.innerHeight);
    containerRef.current.appendChild(renderer.domElement);
    camera.position.set(0, 0, 5);

    const absoluteUrl = new URL(targetAsset, window.location.href).href;
    window.LCC.LCCRender.load(
      { scene, camera, renderer, canvas: renderer.domElement, renderLib: THREE, url: absoluteUrl, appKey: "eyJrIjoidiJ9" },
      absoluteUrl,
      (res) => {
        console.log("🟢 LCC Success:", res);
        setIsLoading(false);
      },
      (res) => {
        console.log("🔵 LCC Progress:", res);
      },
      (err) => {
        console.error("🔴 LCC Error:", err);
      }
    );

    const joystickManager = nipplejs.create({
      zone: joystickRef.current,
      mode: 'static',
      position: { left: '50px', bottom: '50px' },
      color: 'white',
      size: 100
    });

    let moveVector = new THREE.Vector3(0, 0, 0);

    joystickManager.on('move', (evt, data) => {
      if (data && data.angle) {
        const angle = data.angle.radian;
        const force = data.force;
        moveVector.set(Math.cos(angle) * force, 0, -Math.sin(angle) * force);
      }
    });

    joystickManager.on('end', () => {
      moveVector.set(0, 0, 0);
    });

    const animate = () => {
      requestAnimationFrame(animate);
      if (moveVector.lengthSq() > 0) {
        camera.translateX(moveVector.x * 0.05);
        camera.translateZ(moveVector.z * 0.05);
      }
      window.LCC.LCCRender.update();
      renderer.render(scene, camera);
    };
    animate();

    const onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
      joystickManager.destroy();
      renderer.dispose();
      containerRef.current?.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div ref={joystickRef} style={{ position: 'absolute', bottom: 0, left: 0, width: '150px', height: '150px', zIndex: 999 }} />
      {isLoading && (
        <div id="custom-loader" className="lumina-loader">
          <div className="lumina-spinner" />
          <div>Loading Spatial Data...</div>
        </div>
      )}
    </div>
  );
}
