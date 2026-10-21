"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { gsap } from "gsap";

const clamp = (p: number) => Math.min(1, Math.max(0, p));
const lerp = (a: number, b: number, p: number) => a * (1 - p) + b * p;
const ease = (p: number, g: number) => p < .5 ? .5 * (2 * p) ** g : 1 - .5 * (2 * (1 - p)) ** g;
const elastic = (p: number) => p <= 0 ? 0 : p >= 1 ? 1 : 2 ** (-8 * p) * Math.sin((p * 8 - .75) * 2 * Math.PI / 4.5) + 1;
function spiral(p: number) {
  const progress = Math.sqrt(ease(clamp(1.2 * p), 1.8));
  return { x: 170 * progress * Math.cos(12 * Math.PI * progress), y: 170 * progress * Math.sin(12 * Math.PI * progress) + 28 };
}

export function SpiralAnimation({ centerRef }: { centerRef?: RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let seed = 1234;
    const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const stars = Array.from({ length: 14000 }, () => {
      const angle = random() * Math.PI * 2, distance = 30 * random() + 15;
      const direction = random() > .5 ? 1 : -1, expansion = 1.2 + random() * .8, scale = .7 + random() * .6;
      const location = (1 - (1 - random()) ** 3) / 1.3;
      return { angle, distance, direction, expansion, scale, location, x: distance * Math.cos(angle), y: distance * Math.sin(angle), z: lerp(-200 + random() * 3200, 1700, .3 * location), weight: random() ** 2, origin: spiral(location) };
    });
    const background = Array.from({ length: 2400 }, () => ({ x: random(), y: random(), radius: .035 + random() * .04, alpha: .15 + random() * .35 }));
    const state = { time: 0 };
    let width = 0, height = 0;
    const dot = (x: number, y: number, radius: number) => {
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    };
    const render = () => {
      if (width <= 0 || height <= 0) return;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      for (const star of background) {
        ctx.globalAlpha = star.alpha;
        const x = ((star.x + state.time * .015) % 1) * width;
        ctx.fillRect(x, star.y * height, star.radius * 2, star.radius * 2);
      }
      ctx.globalAlpha = 1;
      const bounds = canvas.getBoundingClientRect();
      const center = centerRef?.current?.getBoundingClientRect();
      ctx.save(); ctx.translate(center ? center.left + center.width / 2 - bounds.left : width / 2, center ? center.top + center.height / 2 - bounds.top : height / 2);
      const zoom = Math.min(.25, Math.min(width, height) / 1600);
      ctx.scale(zoom, zoom);
      const t1 = clamp(state.time / .57), t2 = clamp((state.time - .32) / .68);
      // Kamera selalu di belakang partikel agar kedalaman tidak mendekati nol.
      const camera = -1800 - ease(t2 ** 1.2, 1.8) * 1600;
      ctx.rotate(-Math.PI * ease(t2, 2.7)); ctx.fillStyle = "#fff";
      const project = (x: number, y: number, z: number, size: number) => {
        const depth = z - camera;
        if (depth > 1) {
          ctx.globalAlpha = Math.min(.65, Math.max(.15, size / 12));
          dot(100 * x / depth, 100 * y / depth, (.05 + .025 * Math.min(1, size / 12)) / zoom);
          ctx.globalAlpha = 1;
        }
      };
      for (let i = 0; i < 80; i++) {
        const position = spiral(t1 - .00015 * i);
        const p = Math.sin(state.time * Math.PI * 2) * .5 + .5;
        const angle = -Math.PI * .75 + (i % 2 === 0 ? -1 : 1) * Math.PI * elastic(p);
        const radius = Math.sqrt(12.5) * (1 + Math.sin(p * Math.PI) * .05 * (1 - p));
        const size = (1.3 * (1 - t1) + 3 * Math.sin(Math.PI * t1)) * lerp(1.1, .1, i / 80);
        dot(position.x + 2.5 + radius * Math.cos(angle), position.y + 2.5 + radius * Math.sin(angle), Math.min(.075 / zoom, Math.max(0, size / 2)));
      }
      for (const star of stars) {
        const q = t1 - star.location;
        if (q <= 0) continue;
        const p = clamp(4 * q);
        const easing = p < .3 ? lerp(p, p * p, p / .3) : p < .7 ? lerp(p * p, elastic(p), (p - .3) / .4) : elastic(p);
        let x: number, y: number;
        if (p < .3) {
          x = star.origin.x + star.x * easing; y = star.origin.y + star.y * easing;
        } else if (p < .7) {
          const mid = (p - .3) / .4, curve = Math.sin(mid * Math.PI) * star.direction * 1.5;
          x = star.origin.x + lerp(star.x * .3, star.x * .7, mid) - star.y * .4 * curve * mid;
          y = star.origin.y + lerp(star.y * .3, star.y * .7, mid) + star.x * .4 * curve * mid;
        } else {
          const end = (p - .7) / .3, angle = star.angle + 1.2 * star.direction * end * Math.PI;
          x = star.origin.x + lerp(star.x * .7, star.distance * star.expansion * 1.5 * Math.cos(angle), end);
          y = star.origin.y + lerp(star.y * .7, star.distance * star.expansion * 1.5 * Math.sin(angle), end);
        }
        const size = p < .6 ? 1 + p * .2 : lerp(1.2, star.scale, (p - .6) / .4);
        project((star.z + 400) * x / 100, (star.z + 400) * y / 100, star.z, 8.5 * star.weight * size);
      }
      if (state.time > .32) project(0, -112, 3400, 2.5);
      ctx.restore();
    };
    const tween = gsap.to(state, { time: 1, duration: 15, repeat: -1, ease: "none", onUpdate: render, paused: true });
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePlayback = () => {
      if (media.matches) { tween.pause(); state.time = .45; render(); }
      else if (document.hidden) tween.pause();
      else tween.play();
    };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width; height = entry.contentRect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); render(); updatePlayback();
    });
    observer.observe(canvas);
    media.addEventListener("change", updatePlayback);
    document.addEventListener("visibilitychange", updatePlayback);
    return () => { observer.disconnect(); tween.kill(); media.removeEventListener("change", updatePlayback); document.removeEventListener("visibilitychange", updatePlayback); };
  }, [centerRef]);
  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
