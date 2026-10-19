"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { LogoAnimation } from "./loading-logo-renderer.ts";

export function LoadingIndicator({ active, label }: { active: boolean; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<LogoAnimation | null>(null);
  const activeRef = useRef(active);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    activeRef.current = active;
    animationRef.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let animation: LogoAnimation | undefined;
    void import("./loading-logo-renderer.ts").then(async ({ createLogoAnimation }) => {
      if (disposed) return;
      animation = await createLogoAnimation(canvas);
      if (disposed) { animation.dispose(); return; }
      animationRef.current = animation;
      animation.setActive(activeRef.current);
      setReady(true);
    }).catch(() => { /* Logo sumber tetap tampil jika Canvas atau tekstur tidak tersedia. */ });
    return () => {
      disposed = true;
      animationRef.current = null;
      animation?.dispose();
    };
  }, []);

  return <div className="app-loading" hidden={!active} aria-hidden="true">
    <div className="loading-logo">
      <canvas ref={canvasRef} width={256} height={256} hidden={!ready} />
      <Image src="/loading-logo/logo.png" alt="" width={172} height={177} loading="eager" hidden={ready} />
    </div>
    <span>{label}</span>
  </div>;
}
