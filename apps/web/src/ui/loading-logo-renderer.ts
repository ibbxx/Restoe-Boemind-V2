import shapes from "./loading-logo-shapes.json";

export interface LogoAnimation {
  setActive(active: boolean): void;
  dispose(): void;
}

type Wing = { vertices: number[]; triangles: number[]; projected: Float32Array };
type SpherePixel = { index: number; longitude: number; row: number; depth: number; shade: number; light: number; alpha: number };
const size = 256, scale = size / 5, center = size / 2, tau = Math.PI * 2;
const cycleSeconds = 8, frameInterval = 1000 / 60;
let texturePromise: Promise<ImageData> | undefined;

function loadTexture(): Promise<ImageData> {
  if (!texturePromise) {
    texturePromise = new Promise<ImageData>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Canvas 2D tidak tersedia.");
          context.drawImage(image, 0, 0);
          resolve(context.getImageData(0, 0, canvas.width, canvas.height));
        } catch (cause) { reject(cause); }
      };
      image.onerror = () => reject(new Error("Tekstur logo gagal dimuat."));
      image.src = "/loading-logo/earth.webp";
    }).catch(cause => { texturePromise = undefined; throw cause; });
  }
  return texturePromise;
}

export async function createLogoAnimation(canvas: HTMLCanvasElement): Promise<LogoAnimation> {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D tidak tersedia.");
  const texture = await loadTexture();
  canvas.width = size; canvas.height = size;
  const frame = context.createImageData(size, size);
  const pixels = frame.data, depth = new Float32Array(size * size);
  const sphere: SpherePixel[] = [];
  const prepare = (data: { vertices: number[]; triangles: number[] }[]): Wing[] =>
    data.map(shape => ({ ...shape, projected: new Float32Array(shape.vertices.length * 3) }));
  const red = prepare(shapes.red), blue = prepare(shapes.blue);

  for (let y = Math.floor(center - scale - 1); y <= Math.ceil(center + scale + 1); y++) {
    for (let x = Math.floor(center - scale - 1); x <= Math.ceil(center + scale + 1); x++) {
      let nx = (x + .5 - center) / scale, ny = (center - y - .5) / scale;
      const radius = Math.hypot(nx, ny);
      const coverage = Math.min(1, Math.max(0, (1 - radius) * scale + .5));
      if (!coverage) continue;
      if (radius > 1) { nx /= radius; ny /= radius; }
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const axisY = Math.cos(.2) * ny + Math.sin(.2) * nz;
      const axisZ = -Math.sin(.2) * ny + Math.cos(.2) * nz;
      const localX = Math.cos(.12) * nx - Math.sin(.12) * axisY;
      const localY = Math.sin(.12) * nx + Math.cos(.12) * axisY;
      const latitude = .5 - Math.asin(Math.max(-1, Math.min(1, localY))) / Math.PI;
      sphere.push({ index: y * size + x, longitude: .5 - Math.atan2(axisZ, localX) / tau,
        row: Math.min(texture.height - 1, Math.floor(latitude * texture.height)) * texture.width,
        depth: nz, shade: .68 + .32 * Math.max(0, -.424 * nx + .566 * ny + .707 * nz),
        light: 17 * Math.pow(Math.max(0, -.23 * nx + .31 * ny + .923 * nz), 24), alpha: coverage });
    }
  }

  function triangle(vertices: Float32Array, a: number, b: number, c: number, color: readonly number[]) {
    const ax = vertices[a]!, ay = vertices[a + 1]!, az = vertices[a + 2]!;
    const bx = vertices[b]!, by = vertices[b + 1]!, bz = vertices[b + 2]!;
    const cx = vertices[c]!, cy = vertices[c + 1]!, cz = vertices[c + 2]!;
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-7) return;
    const inverse = 1 / denominator;
    const ux = (by - cy) * inverse, uy = (cx - bx) * inverse;
    const vx = (cy - ay) * inverse, vy = (ax - cx) * inverse;
    const left = Math.max(0, Math.floor(Math.min(ax, bx, cx))), right = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const top = Math.max(0, Math.floor(Math.min(ay, by, cy))), bottom = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    let rowU = ux * (left + .5 - cx) + uy * (top + .5 - cy);
    let rowV = vx * (left + .5 - cx) + vy * (top + .5 - cy);
    let rowZ = cz + rowU * (az - cz) + rowV * (bz - cz);
    const zx = ux * (az - cz) + vx * (bz - cz), zy = uy * (az - cz) + vy * (bz - cz);
    const red = color[0]!, green = color[1]!, blue = color[2]!;
    for (let y = top; y <= bottom; y++) {
      let u = rowU, v = rowV, z = rowZ, index = y * size + left;
      for (let x = left; x <= right; x++, u += ux, v += vx, z += zx, index++) {
        if (u < -1e-6 || v < -1e-6 || 1 - u - v < -1e-6) continue;
        if (z <= depth[index]!) continue;
        depth[index] = z;
        const offset = index * 4;
        pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue; pixels[offset + 3] = 255;
      }
      rowU += uy; rowV += vy; rowZ += zy;
    }
  }

  function wing(parts: Wing[], spin: number, tiltX: number, tiltY: number, base: readonly number[]) {
    const ca = Math.cos(spin), sa = Math.sin(spin), cx = Math.cos(tiltX), sx = Math.sin(tiltX), cy = Math.cos(tiltY), sy = Math.sin(tiltY);
    const brightness = .72 + .28 * Math.max(0, -.424 * sy - .566 * sx * cy + .707 * cx * cy);
    const face = base.map(channel => channel * brightness), edge = face.map(channel => channel * .68);
    for (const part of parts) {
      const vertices = part.projected, count = part.vertices.length / 2;
      for (let i = 0; i < count; i++) {
        const x = part.vertices[i * 2]!, y = part.vertices[i * 2 + 1]!;
        const u = ca * x - sa * y, v = sa * x + ca * y;
        for (let side = 0; side < 2; side++) {
          const z = side ? -.0175 : .0175, offset = i * 6 + side * 3;
          vertices[offset] = center + (cy * u + sy * z) * scale;
          vertices[offset + 1] = center - (cx * v + sx * sy * u - sx * cy * z) * scale;
          vertices[offset + 2] = sx * v - cx * sy * u + cx * cy * z;
        }
      }
      for (let i = 0; i < count; i++) {
        const a = i * 6, b = (i + 1) % count * 6;
        triangle(vertices, a, a + 3, b, edge); triangle(vertices, a + 3, b + 3, b, edge);
      }
      for (let i = 0; i < part.triangles.length; i += 3) {
        triangle(vertices, part.triangles[i]! * 6, part.triangles[i + 1]! * 6, part.triangles[i + 2]! * 6, face);
      }
    }
  }

  function draw(seconds: number) {
    const angle = seconds / cycleSeconds * tau, tilt = Math.sin(angle);
    pixels.fill(0); depth.fill(-Infinity);
    // Kedalaman per piksel menjaga penutupan globe dan sayap tanpa potongan mask.
    wing(red, -angle * 3, .66 * tilt, .12 * Math.sin(angle * 2), [225, 41, 35]);
    wing(blue, angle * 2, -.4 * tilt, .5 * tilt, [20, 40, 92]);
    const turn = 170 / 360 + seconds / cycleSeconds;
    for (const sample of sphere) {
      if (sample.depth <= depth[sample.index]!) continue;
      const position = sample.longitude - turn;
      const longitude = position - Math.floor(position);
      const horizontal = longitude * texture.width, column = Math.floor(horizontal), blend = horizontal - column;
      const source = (sample.row + column) * 4;
      const next = (sample.row + (column + 1) % texture.width) * 4;
      const target = sample.index * 4, previousAlpha = pixels[target + 3]! / 255;
      const alpha = sample.alpha + previousAlpha * (1 - sample.alpha);
      const inverseAlpha = 1 / alpha;
      for (let channel = 0; channel < 3; channel++) {
        const value = Math.min(255, (texture.data[source + channel]! * (1 - blend) + texture.data[next + channel]! * blend) * sample.shade + sample.light);
        pixels[target + channel] = (value * sample.alpha + pixels[target + channel]! * previousAlpha * (1 - sample.alpha)) * inverseAlpha;
      }
      pixels[target + 3] = alpha * 255;
    }
    context!.putImageData(frame, 0, 0);
  }

  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let active = false, disposed = false, request = 0, origin: number | null = null, lastPaint = 0, seconds = 0;
  function tick(now: number) {
    if (disposed || !active || document.hidden || preference.matches) return;
    request = requestAnimationFrame(tick);
    if (origin === null) origin = now - seconds * 1000;
    const elapsed = now - lastPaint;
    // Toleransi kecil mencegah jitter timestamp RAF melewatkan frame pada layar 60 Hz.
    if (elapsed + .25 < frameInterval) return;
    seconds = ((now - origin) / 1000) % cycleSeconds;
    lastPaint = now - (elapsed >= frameInterval ? elapsed % frameInterval : 0);
    draw(seconds);
  }
  function refresh() {
    cancelAnimationFrame(request); origin = null; lastPaint = 0;
    if (disposed || !active) return;
    if (preference.matches) { seconds = 0; draw(0); }
    else if (!document.hidden) { draw(seconds); request = requestAnimationFrame(tick); }
  }
  document.addEventListener("visibilitychange", refresh);
  preference.addEventListener("change", refresh);
  draw(0);
  return {
    setActive(value) { active = value; refresh(); },
    dispose() {
      disposed = true; cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", refresh);
      preference.removeEventListener("change", refresh);
    },
  };
}
