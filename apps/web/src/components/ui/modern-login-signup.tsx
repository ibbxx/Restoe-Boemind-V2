"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEventHandler } from "react";
import type { PlaneGeometry, ShaderMaterial, WebGLRenderer } from "three";
import { Eye, EyeOff } from "lucide-react";
import Image from "next/image";

const vertexShader = `
  out vec2 fragCoord;
  uniform vec2 u_resolution;
  void main() {
    gl_Position = vec4(position, 1.0);
    fragCoord = (position.xy + 1.0) * 0.5 * u_resolution;
    fragCoord.y = u_resolution.y - fragCoord.y;
  }
`;

const fragmentShader = `
  precision highp float;
  in vec2 fragCoord;
  out vec4 fragColor;
  uniform float u_time;
  uniform vec2 u_resolution;
  uniform float u_total_size;
  uniform float u_dot_size;
  const float opacities[10] = float[10](0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1.0);
  float random(vec2 cell) {
    return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  }
  void main() {
    vec2 st = fragCoord - floor(mod(u_resolution, u_total_size) * 0.5);
    vec2 cell = floor(st / u_total_size);
    vec2 local = mod(st, u_total_size);
    float offset = random(cell);
    float value = random(cell + floor(u_time / 5.0 + offset) * 17.0);
    float opacity = opacities[min(9, int(value * 10.0))];
    opacity *= step(0.0, st.x) * step(0.0, st.y);
    opacity *= (1.0 - step(u_dot_size, local.x)) * (1.0 - step(u_dot_size, local.y));
    float intro = distance(u_resolution / (2.0 * u_total_size), cell) * 0.01 + offset * 0.15;
    opacity *= step(intro, u_time * 3.0);
    fragColor = vec4(vec3(0.0), opacity);
  }
`;

function DotBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false, animation = 0;
    let renderer: WebGLRenderer | undefined;
    let geometry: PlaneGeometry | undefined;
    let material: ShaderMaterial | undefined;
    let observer: ResizeObserver | undefined;
    let removeListeners = () => {};
    const release = () => {
      cancelAnimationFrame(animation);
      observer?.disconnect(); removeListeners();
      geometry?.dispose(); material?.dispose(); renderer?.dispose();
    };

    void import("three").then(THREE => {
      if (disposed) return;
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
      const view = renderer;
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const uniforms = {
        u_time: { value: 0 },
        u_resolution: { value: new THREE.Vector2() },
        u_total_size: { value: 20 },
        u_dot_size: { value: 3 },
      };
      material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, glslVersion: THREE.GLSL3, transparent: true, depthTest: false, depthWrite: false });
      geometry = new THREE.PlaneGeometry(2, 2);
      scene.add(new THREE.Mesh(geometry, material));
      const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
      const start = performance.now();
      let contextLost = false;
      const render = () => {
        if (disposed || contextLost) return;
        uniforms.u_time.value = preference.matches ? 60 : (performance.now() - start) / 1000;
        view.render(scene, camera);
      };
      const tick = () => {
        if (disposed || contextLost || document.hidden || preference.matches) return;
        render(); animation = requestAnimationFrame(tick);
      };
      const refresh = () => {
        cancelAnimationFrame(animation);
        if (disposed || document.hidden || contextLost) return;
        render();
        if (!preference.matches) animation = requestAnimationFrame(tick);
      };
      observer = new ResizeObserver(([entry]) => {
        if (!entry || disposed) return;
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        view.setPixelRatio(ratio); view.setSize(width, height, false);
        view.getDrawingBufferSize(uniforms.u_resolution.value);
        uniforms.u_total_size.value = 10 * ratio;
        uniforms.u_dot_size.value = 1.5 * ratio;
        refresh();
      });
      const onLost = (event: Event) => { event.preventDefault(); contextLost = true; cancelAnimationFrame(animation); setReady(false); };
      const onRestored = () => { contextLost = false; refresh(); setReady(true); };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
      document.addEventListener("visibilitychange", refresh);
      preference.addEventListener("change", refresh);
      removeListeners = () => {
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        document.removeEventListener("visibilitychange", refresh);
        preference.removeEventListener("change", refresh);
      };
      observer.observe(canvas);
      setReady(true);
    }).catch(() => { release(); if (!disposed) setReady(false); });

    return () => { disposed = true; release(); };
  }, []);

  return <div className="modern-login-dots" aria-hidden="true" data-ready={ready}>
    <canvas ref={canvasRef} />
  </div>;
}

export default function SignIn({ onSubmit, busy, error }: { onSubmit: FormEventHandler<HTMLFormElement>; busy: boolean; error: string }) {
  const [visible, setVisible] = useState(false);
  return <div className="signin-shell modern-login">
    <DotBackground />
    <div className="modern-login-vignette" aria-hidden="true" />
    <div className="modern-login-card" aria-labelledby="modern-login-title">
      <div className="modern-login-mark"><Image src="/image.png" alt="Logo RBI" width={38} height={39} priority /></div>
      <h1 id="modern-login-title">Masuk ke akun</h1>
      <p className="modern-login-subtitle">Sistem Evaluasi Vendor</p>
      {error && <p className="modern-login-error" role="alert">{error}</p>}
      <form onSubmit={onSubmit} aria-busy={busy}>
        <fieldset disabled={busy}>
          <div>
            <label htmlFor="modern-login-email">Email</label>
            <input id="modern-login-email" name="email" type="email" autoComplete="username" placeholder="nama@perusahaan.com" required />
          </div>
          <div>
            <label htmlFor="modern-login-password">Kata sandi</label>
            <div className="modern-login-password">
              <input id="modern-login-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" placeholder="Masukkan kata sandi" required />
              <button type="button" aria-label={visible ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
                {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <button type="submit" className="modern-login-submit">{busy ? "Memproses…" : "Masuk dengan Email"}</button>
        </fieldset>
      </form>
      <div className="modern-login-divider" />
      <p className="modern-login-footer">Gunakan akun yang terdaftar untuk mengakses workspace Anda.</p>
    </div>
  </div>;
}
