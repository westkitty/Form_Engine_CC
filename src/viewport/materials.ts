import * as THREE from 'three';

export type ViewMode = 'studio' | 'clay' | 'matcap' | 'flat' | 'normals' | 'checker' | 'silhouette';

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  studio: 'Studio (own material)', clay: 'Clay', matcap: 'Matcap', flat: 'Flat shaded', normals: 'Normals', checker: 'UV checker', silhouette: 'Silhouette',
};

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Shared view-mode materials (one instance each, never per frame). */
export class MaterialLibrary {
  readonly clay = new THREE.MeshStandardMaterial({ color: 0xc9b8a3, roughness: 0.62, metalness: 0 });
  readonly flat = new THREE.MeshStandardMaterial({ color: 0xc9b8a3, roughness: 0.7, flatShading: true });
  readonly normals = new THREE.MeshNormalMaterial();
  readonly silhouette = new THREE.MeshBasicMaterial({ color: 0x15171c });
  readonly matcap: THREE.MeshMatcapMaterial;
  readonly checker: THREE.MeshStandardMaterial;
  readonly wire = new THREE.MeshBasicMaterial({ color: 0x0e1014, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false });
  /** Mask overlay: reads the per-vertex `aMask` attribute; drawn on top of any view mode. */
  readonly maskOverlay = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    uniforms: { uColor: { value: new THREE.Color(0x2b6cff) } },
    vertexShader: `attribute float aMask; varying float vMask;
      void main(){ vMask = aMask; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; varying float vMask;
      void main(){ if (vMask < 0.003) discard; gl_FragColor = vec4(uColor, 0.58 * vMask); }`,
  });

  constructor() {
    this.matcap = new THREE.MeshMatcapMaterial({
      matcap: canvasTexture(256, (ctx, s) => {
        const g = ctx.createRadialGradient(s * 0.38, s * 0.32, s * 0.02, s * 0.5, s * 0.5, s * 0.52);
        g.addColorStop(0, '#fff3e4'); g.addColorStop(0.35, '#cdb9a2'); g.addColorStop(0.75, '#6e5c4c'); g.addColorStop(1, '#1d1814');
        ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
        const rim = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.4, s * 0.5, s * 0.5, s * 0.5);
        rim.addColorStop(0, 'rgba(255,200,140,0)'); rim.addColorStop(1, 'rgba(255,190,120,0.35)');
        ctx.fillStyle = rim; ctx.fillRect(0, 0, s, s);
      }),
    });
    const checker = canvasTexture(512, (ctx, s) => {
      const n = 16, c = s / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { ctx.fillStyle = (x + y) % 2 ? '#e8e2d8' : '#3a3f4a'; ctx.fillRect(x * c, y * c, c, c); }
      ctx.fillStyle = '#d18a3a'; ctx.font = `${c * 0.5}px sans-serif`;
      for (let y = 0; y < n; y += 4) for (let x = 0; x < n; x += 4) ctx.fillText(`${x / 4}${y / 4}`, x * c + 4, y * c + c * 0.7);
    });
    checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
    this.checker = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8 });
  }

  forMode(mode: ViewMode, base: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    switch (mode) {
      case 'studio': return base;
      case 'clay': return this.clay;
      case 'flat': return this.flat;
      case 'matcap': return this.matcap;
      case 'normals': return this.normals;
      case 'checker': return this.checker;
      case 'silhouette': return this.silhouette;
    }
  }
}
