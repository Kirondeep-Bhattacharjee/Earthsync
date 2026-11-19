import * as React from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ShaderMaterial,
  Vector3,
  type Group,
} from "three"
import { useInk } from "../lib/use-ink"

const DEFAULT_STAR_COUNT = 3500
const DRIFT_SPEED = 0.012 // radians per second, very slow
const PARALLAX = { x: 0.06, y: 0.04 } // how far the sky leans toward the pointer
const DIAGONAL = new Vector3(1, 1, 0).normalize() // same diagonal feel as the globe

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vTwinkle;

  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vTwinkle = 0.55 + 0.45 * sin(uTime * (0.5 + aSize * 0.18) + aPhase);
    gl_PointSize = aSize * uPixelRatio;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.05, d) * vTwinkle;
    gl_FragColor = vec4(uColor, alpha);
  }
`

function buildStars(count: number) {
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const phases = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    // Uniform direction on a sphere, at a random distance.
    const theta = Math.acos(2 * Math.random() - 1)
    const phi = Math.random() * Math.PI * 2
    const radius = 50 + Math.random() * 50

    positions[i * 3] = radius * Math.sin(theta) * Math.cos(phi)
    positions[i * 3 + 1] = radius * Math.cos(theta)
    positions[i * 3 + 2] = radius * Math.sin(theta) * Math.sin(phi)

    sizes[i] = 1.2 + Math.pow(Math.random(), 3) * 3.6 // mostly small, a few bright
    phases[i] = Math.random() * Math.PI * 2
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new BufferAttribute(positions, 3))
  geometry.setAttribute("aSize", new BufferAttribute(sizes, 1))
  geometry.setAttribute("aPhase", new BufferAttribute(phases, 1))
  return geometry
}

function Stars({
  color,
  count,
  reduceMotion,
  pointer,
}: {
  color: string
  count: number
  reduceMotion: boolean
  pointer: React.RefObject<{ x: number; y: number }>
}) {
  const group = React.useRef<Group>(null)
  const dpr = useThree((state) => state.viewport.dpr)
  const geometry = React.useMemo(() => buildStars(count), [count])

  const material = React.useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: 1 },
          uColor: { value: new Color("#ffffff") },
        },
      }),
    []
  )

  React.useEffect(() => {
    material.uniforms.uColor.value.set(color)
  }, [color, material])

  React.useEffect(() => {
    material.uniforms.uPixelRatio.value = dpr
  }, [dpr, material])

  React.useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  useFrame((state, delta) => {
    if (!reduceMotion) {
      material.uniforms.uTime.value += delta
      group.current?.rotateOnWorldAxis(DIAGONAL, delta * DRIFT_SPEED)
    }

    // Ease the camera toward the pointer for a little parallax.
    const p = pointer.current ?? { x: 0, y: 0 }
    state.camera.rotation.x += (-p.y * PARALLAX.y - state.camera.rotation.x) * 0.05
    state.camera.rotation.y += (-p.x * PARALLAX.x - state.camera.rotation.y) * 0.05
  })

  return (
    <group ref={group}>
      <points geometry={geometry} material={material} frustumCulled={false} />
    </group>
  )
}

// An occasional shooting star, drawn on a plane in front of the camera.
function ShootingStar({ color }: { color: string }) {
  const line = React.useRef<React.ComponentRef<typeof Line>>(null)
  const { viewport } = useThree()
  const run = React.useRef({ wait: 3, t: 0, active: false, x: 0, y: 0 })

  const DISTANCE = 30
  const DURATION = 0.9
  const SPEED = 26
  const DIR = React.useMemo(() => new Vector3(0.88, -0.48, 0).normalize(), [])

  useFrame((state, delta) => {
    const l = line.current
    if (!l) return
    const r = run.current
    const material = l.material as { opacity: number }

    if (!r.active) {
      r.wait -= delta
      material.opacity = 0
      if (r.wait <= 0) {
        // Visible half-extents at the plane in front of the camera.
        const cam = state.camera as { fov?: number; aspect?: number }
        const halfH = Math.tan(((cam.fov ?? 60) * Math.PI) / 360) * DISTANCE
        const halfW = halfH * (cam.aspect ?? viewport.aspect)
        r.x = (Math.random() * 1.2 - 0.9) * halfW
        r.y = (0.2 + Math.random() * 0.75) * halfH
        r.t = 0
        r.active = true
      }
      return
    }

    r.t += delta
    const progress = r.t / DURATION
    l.position.set(
      r.x + DIR.x * SPEED * r.t,
      r.y + DIR.y * SPEED * r.t,
      -DISTANCE
    )
    material.opacity = Math.sin(Math.min(progress, 1) * Math.PI) * 0.9

    if (progress >= 1) {
      r.active = false
      r.wait = 4 + Math.random() * 6
      material.opacity = 0
    }
  })

  return (
    <Line
      ref={line}
      points={[
        [0, 0, 0],
        [-DIR.x * 4, -DIR.y * 4, 0],
      ]}
      color={color}
      lineWidth={1.5}
      transparent
      opacity={0}
    />
  )
}

type SkyBackgroundProps = {
  children?: React.ReactNode
  /** Classes for the outer wrapper (for example "min-h-screen"). */
  className?: string
  /** Force star colour instead of following the theme. */
  ink?: "#000000" | "#ffffff"
  /** Number of stars. */
  count?: number
  /** Turn the occasional shooting star off. */
  shootingStars?: boolean
}

// Wrap a page in it: <SkyBackground className="min-h-screen">...</SkyBackground>
// The sky is fixed behind the content and never blocks clicks. Stars are white
// in dark mode and black in light mode; the page's own background shows through.
export default function SkyBackground({
  children,
  className,
  ink,
  count = DEFAULT_STAR_COUNT,
  shootingStars = true,
}: SkyBackgroundProps) {
  const container = React.useRef<HTMLDivElement>(null)
  const themeInk = useInk(container)
  const color = ink ?? themeInk

  const pointer = React.useRef({ x: 0, y: 0 })
  const [reduceMotion, setReduceMotion] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduceMotion(media.matches)
    sync()
    media.addEventListener("change", sync)

    // The sky ignores pointer events, so listen on the window instead.
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove)

    return () => {
      media.removeEventListener("change", sync)
      window.removeEventListener("pointermove", onMove)
    }
  }, [])

  return (
    <div
      ref={container}
      className={className}
      style={{ position: "relative", isolation: "isolate" }}
    >
      {/* Belt and braces: R3F's wrapper div and canvas set their own
          pointer-events, so force "none" on everything inside the sky layer. */}
      <style>{`[data-sky-layer], [data-sky-layer] * { pointer-events: none !important; }`}</style>
      <div
        aria-hidden
        data-sky-layer=""
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        <Canvas
          camera={{ position: [0, 0, 0], fov: 60, near: 0.1, far: 200 }}
          dpr={[1, 2]}
          gl={{ antialias: false, alpha: true }}
          // R3F's own wrapper sets pointer-events: auto, which overrides the
          // "none" on the parent and would swallow clicks meant for the page.
          style={{ pointerEvents: "none" }}
        >
          <Stars
            color={color}
            count={count}
            reduceMotion={reduceMotion}
            pointer={pointer}
          />
          {shootingStars && !reduceMotion && <ShootingStar color={color} />}
        </Canvas>
      </div>

      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  )
}