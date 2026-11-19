import * as React from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import {
  DoubleSide,
  Quaternion,
  Vector3,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type PerspectiveCamera,
} from "three"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import {
  IconCompass,
  IconMessageCircle,
  IconUserPlus,
  IconUsers,
  type Icon,
} from "@tabler/icons-react"
import { useInk } from "../lib/use-ink"
import WordStage, {
  measureWord,
  sameMetrics,
  type GlobeTrack,
  type WordMetrics,
} from "./earthsync-word"

const LINE_WIDTH = 1.5
const LINE_RADIUS = 1.004 // sits just above the sphere surface to avoid z-fighting
const SPIN_SPEED = 0.18 // radians per second (only used when idleSpin is on)
const CAMERA_DISTANCE = 4 // where the camera ends up, straight on

// ---- Layout --------------------------------------------------------------------
// The component is a row: the globe (a square as tall as the component) on the
// left, the word "Sync" on the right.
const TEXT_SCALE = 122 // size of the word, as a percentage of the component's height
const GLOBE_FILL = 0.85 // the globe's diameter, as a share of its square
// The globe's canvas reaches this far past the square on every side (as a share
// of the square), so the globe has room to run around the arena. The camera's
// field of view is worked out so the globe keeps the same size on screen.
const INSET = 0.4
const FOV =
  (2 *
    Math.atan(
      (0.5 + INSET) /
        ((GLOBE_FILL / 2) * Math.sqrt(CAMERA_DISTANCE * CAMERA_DISTANCE - 1))
    ) *
    180) /
  Math.PI

const SPIN_AXIS = new Vector3(1, 1, 0).normalize() // diagonal auto-spin axis
const X_AXIS = new Vector3(1, 0, 0)
const Y_AXIS = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1) // points at the camera
const IDENTITY = new Quaternion()

const MAX_FLING = 8 // rad/s cap on release velocity
const FRICTION = 2.5 // how quickly a fling slows down
const RESUME_RATE = 0.6 // how quickly the auto-spin eases back in
const TURN_RATE = 5 // how quickly the globe turns a pin to the front

const MARKER_RADIUS = 1.03 // pins float slightly above the surface

// ---- Intro: the globe is launched into an arena like a beyblade --------------
// The globe is dropped in at the far side of a round arena, circles it in
// big sweeping laps (passing close to the camera, then far away), spirals
// inward as it loses speed, wobbles, lurches off the wall a few times, tips
// over in the middle and rocks to rest. Meanwhile the camera starts high and
// far back and swoops down and in until it is level with the globe, which is
// exactly the straight-on view the page ends with.
//
// When the globe finally tips over and hits the floor, a burst of stardust
// leaves it and flies into the word "Sync" (see earthsync-word.tsx).
//
// Units: the globe has radius 1. The arena floor is at y = -1.
const INTRO_DELAY = 0.35 // pause before the drop
const DROP_HEIGHT = 0.8 // how high above the floor it is released
const FLOOR_Y = -1
const ARENA_R = 1.85 // radius of the arena wall ring
const START_ANGLE = -Math.PI / 2 // start on the far side (away from the camera)
const R_START = 0.95 // lap radius at the start
const R_END = 0.2 // lap radius when the spin runs out
const ORBIT_0 = 4.2 // lap speed (rad/s) at full spin; bigger = more laps
const BANK_MAX = 0.3 // how far it leans into the turn while circling

const SPIN_UP = 0.5 // time to reach full spin
const OMEGA_0 = 18 // top spin speed, rad/s
const TAU = 1.3 // spin decay time constant; bigger = longer spin
const GRAVITY = 16 // hops fall back down at this rate
const TIP_LEAN = 0.62 // how far it tips over at the end, radians
const SETTLE_TIP = 0.3 // seconds to fall to the tipped position
const SETTLE_REST = 1.3 // seconds of rocking after the tip

// Time (seconds after the delay) when the spin has run out and the tip begins.
const T_SPIN_END = SPIN_UP + TAU * Math.log(1 / 0.05)
// Time when everything has come to rest.
const T_END = T_SPIN_END + SETTLE_TIP + SETTLE_REST

// Camera: starts high and far, ends level at CAMERA_DISTANCE.
const FAR_DISTANCE = 6.2
const EL_START = 0.36 // starting camera height angle, radians
const AZ_SWAY = 0.28 // side-to-side drift of the camera while it descends
const LOOK_Y = -0.3 // the camera looks a little below the globe at first
const CAM_START = 1.0 // when the camera starts moving in

// Each stumble fires when the spin speed drops below `at` (fraction of top
// speed): a hop, plus a shove toward (+) or away from (-) the wall.
const STUMBLES = [
  { at: 0.3, vy: 1.6, vr: 1.3 },
  { at: 0.2, vy: 2.0, vr: -1.4 },
  { at: 0.12, vy: 2.3, vr: 1.3 },
  { at: 0.07, vy: 1.8, vr: -1.0 },
]

const TRAIL_N = 45 // dots in the path left on the floor
const TRAIL_EVERY = 0.04 // seconds between dots
const TRAIL_LIFE = 1.8 // seconds a dot lasts

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const smooth = (u: number) => u * u * (3 - 2 * u)

export type GlobeLink = {
  label: string
  to: string
  icon: Icon
  /** Position of the pin on the globe, in degrees. lon 0 faces the camera at start. */
  lat: number
  lon: number
}

// Change `to` to match your routes. The pins are spread around the globe. The
// page shows these same links as a visible menu, and pointing at one turns the
// globe to its pin.
export const DEFAULT_LINKS: GlobeLink[] = [
  { label: "Friends", to: "/friends", icon: IconUsers, lat: 22, lon: 0 },
  { label: "Connect", to: "/connect", icon: IconCompass, lat: -22, lon: 90 },
  { label: "Requests", to: "/requests", icon: IconUserPlus, lat: 22, lon: 180 },
  { label: "Chats", to: "/chats", icon: IconMessageCircle, lat: -22, lon: 270 },
]

// Continent contours copied from earthsync-mark.svg (same 240x240 viewBox).
const CONTINENT_PATHS = [
  "M47 62l9-8 11 2 6-7 12 3 5 9-5 8-12 1-5 9-10-2-4-8-9 1z",
  "M76 91l10-7 13 3 7 10-4 13-8 7-2 15-8 11-7-8 1-13-8-9 2-13z",
  "M111 48l12-8 18 3 9 8-6 8-16 1-7 8-10-5z",
  "M145 82l10-7 13 3 7 8-5 8-12 1-6 8-10-4z",
  "M153 111l13-6 17 5 9 12-5 11-14 2-8 11-12-3-6-12z",
  "M139 148l13-5 13 7 4 14-7 12-4 20-10 13-8-7 1-18-8-13z",
]

// The SVG is a front-facing orthographic view, so map each 2D point back onto
// the front hemisphere of a unit sphere.
function toSphere(x: number, y: number) {
  const nx = (x - 120) / 116
  const ny = -(y - 120) / 116
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
  return new Vector3(nx, ny, nz).normalize().multiplyScalar(LINE_RADIUS)
}

function fromLatLon(lat: number, lon: number, radius: number) {
  const phi = (lat * Math.PI) / 180
  const theta = (lon * Math.PI) / 180
  return new Vector3(
    Math.cos(phi) * Math.sin(theta),
    Math.sin(phi),
    Math.cos(phi) * Math.cos(theta)
  ).multiplyScalar(radius)
}

function buildContinents(): Vector3[][] {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${CONTINENT_PATHS.map(
    (d) => `<path d="${d}"/>`
  ).join("")}</svg>`

  const lines: Vector3[][] = []

  for (const path of new SVGLoader().parse(svg).paths) {
    for (const subPath of path.subPaths) {
      const front = subPath.getPoints().map((p) => toSphere(p.x, p.y))
      front.push(front[0].clone()) // close the outline

      // Mirror to the back so the globe still looks right while spinning.
      const back = front.map((p) => new Vector3(-p.x, p.y, -p.z))

      lines.push(front, back)
    }
  }

  return lines
}

function buildGrid(): Vector3[][] {
  const steps = 128
  const lines: Vector3[][] = []

  // Two latitude rings, like the mark.
  for (const y of [0.2, -0.2]) {
    const r = Math.sqrt(1 - y * y)
    const ring: Vector3[] = []

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2
      ring.push(
        new Vector3(Math.cos(t) * r, y, Math.sin(t) * r).multiplyScalar(
          LINE_RADIUS
        )
      )
    }

    lines.push(ring)
  }

  // Two meridian great circles (each covers a meridian and its opposite).
  for (const lon of [0.42, -0.42]) {
    const dir = new Vector3(Math.sin(lon), 0, Math.cos(lon))
    const ring: Vector3[] = []

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2
      ring.push(
        dir
          .clone()
          .multiplyScalar(Math.cos(t))
          .add(new Vector3(0, Math.sin(t), 0))
          .multiplyScalar(LINE_RADIUS)
      )
    }

    lines.push(ring)
  }

  return lines
}

// A flat circle in the XY plane. Used for the globe's outline, the arena and
// the shadow; each is turned and scaled into place where it is used.
function circle(radius: number, steps = 128) {
  const points: Vector3[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    points.push(new Vector3(Math.cos(t) * radius, Math.sin(t) * radius, 0))
  }
  return points
}

// A pin on the globe. It is a small dot; when its menu item is pointed at, it
// grows and sends out a ring, like a ping. The label itself lives in the page,
// where it is always visible and can be reached with a keyboard.
function Marker({
  link,
  color,
  active,
}: {
  link: GlobeLink
  color: string
  active: boolean
}) {
  const dot = React.useRef<Mesh>(null)
  const ring = React.useRef<Mesh>(null)
  const grow = React.useRef(0)

  const position = React.useMemo(
    () => fromLatLon(link.lat, link.lon, MARKER_RADIUS),
    [link.lat, link.lon]
  )
  // Turns the flat ring so it faces straight out from the globe.
  const orientation = React.useMemo(
    () => new Quaternion().setFromUnitVectors(Z_AXIS, position.clone().normalize()),
    [position]
  )

  useFrame(({ clock }, delta) => {
    grow.current += ((active ? 1 : 0) - grow.current) * (1 - Math.exp(-delta * 8))

    dot.current?.scale.setScalar(1 + grow.current * 1.2)

    const r = ring.current
    if (r) {
      const pulse = (clock.elapsedTime * 0.9) % 1
      r.visible = grow.current > 0.02
      r.scale.setScalar(1 + pulse * 1.4)
      ;(r.material as MeshBasicMaterial).opacity = grow.current * (1 - pulse)
    }
  })

  return (
    <group position={position} quaternion={orientation}>
      <mesh ref={dot}>
        <sphereGeometry args={[0.028, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh ref={ring} visible={false}>
        <ringGeometry args={[0.05, 0.058, 40]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

// ---- Intro simulation --------------------------------------------------------

type Sample = { x: number; z: number; t: number }

type IntroState = {
  phase: "spin" | "settle" | "done"
  t: number // seconds since mount
  released: boolean // the dust has been let go
  kick: number // index of the next stumble
  phi: number // direction the globe is leaning (precession)
  lean: number
  lean0: number // lean at the moment the settle began
  s: number // seconds since the settle began
  tipped: boolean
  theta: number // angle around the arena
  dR: number // sideways shove off the lap radius
  vR: number
  bank: number // lean into the turn
  x: number
  y: number
  z: number
  vy: number
  shake: number
  pulse: number // seconds since the impact rings started, -1 = idle
  q0: Quaternion // orientation when the settle began
  samples: Sample[] // the path on the floor
  sampleClock: number
  decorHidden: boolean
}

function makeIntro(skip: boolean): IntroState {
  return {
    phase: skip ? "done" : "spin",
    t: 0,
    released: skip,
    kick: 0,
    phi: 0,
    lean: 0,
    lean0: 0,
    s: 0,
    tipped: false,
    theta: START_ANGLE,
    dR: 0,
    vR: 0,
    bank: 0,
    x: skip ? 0 : R_START * Math.cos(START_ANGLE),
    y: skip ? 0 : DROP_HEIGHT,
    z: skip ? 0 : R_START * Math.sin(START_ANGLE),
    vy: 0,
    shake: 0,
    pulse: -1,
    q0: new Quaternion(),
    samples: [],
    sampleClock: 0,
    decorHidden: skip,
  }
}

const _axis = new Vector3()
const _qWob = new Quaternion()
const _qBank = new Quaternion()

function stepIntro(
  i: IntroState,
  g: Group,
  rg: Group,
  dt: number,
  onRelease: () => void
) {
  const t = i.t - INTRO_DELAY

  if (i.phase === "spin") {
    // Spin speed: quick ramp up, then a long exponential decay.
    const q = t / SPIN_UP
    const omega =
      t < SPIN_UP ? OMEGA_0 * q * q : OMEGA_0 * Math.exp(-(t - SPIN_UP) / TAU)
    const r = omega / OMEGA_0 // 1 = full speed, 0 = stopped

    g.rotateY(omega * dt) // spin around the globe's own (leaning) axis

    // Wobble: almost upright at speed, leaning more and more as it slows.
    const w = clamp((0.4 - r) / 0.4, 0, 1)
    i.lean = 0.03 + 0.38 * w * w
    i.phi += (1.4 + 8 * (1 - r)) * dt // the lean circles faster as it slows

    // Laps: the track spirals inward; a shove can push it off the track and
    // a spring pulls it back.
    const u = clamp(t / T_SPIN_END, 0, 1)
    const track = R_END + (R_START - R_END) * Math.pow(1 - u, 1.4)
    i.theta += ORBIT_0 * (0.35 + 0.65 * r) * dt
    i.vR += (-14 * i.dR - 3 * i.vR) * dt
    i.dR += i.vR * dt
    const rad = Math.max(0.05, track + i.dR)
    i.x = rad * Math.cos(i.theta)
    i.z = rad * Math.sin(i.theta)
    i.bank = BANK_MAX * clamp(rad / R_START, 0, 1.2) * (0.4 + 0.6 * r)

    // Stumbles: a hop and a shove each time it loses enough speed.
    const next = STUMBLES[i.kick]
    if (next && t > SPIN_UP && r < next.at) {
      i.vy = next.vy
      i.vR += next.vr
      i.shake = Math.max(i.shake, 0.02)
      i.kick += 1
    }

    // Out of spin: start tipping over. The dust waits for the thud.
    if (t > SPIN_UP && r < 0.05) {
      i.phase = "settle"
      i.s = 0
      i.tipped = false
      i.lean0 = i.lean
      i.q0.copy(g.quaternion)
    }
  } else {
    // Settle: slide to the middle, fall over to one side, hit the ground,
    // rock back to upright.
    i.s += dt

    const glide = 1 - Math.exp(-dt * 5)
    i.x -= i.x * glide
    i.z -= i.z * glide
    i.bank *= Math.exp(-dt * 6)

    // Turn the globe back to its starting face while it rocks.
    const e = clamp(i.s / 0.7, 0, 1)
    g.quaternion.copy(i.q0).slerp(IDENTITY, smooth(e))

    if (i.s < SETTLE_TIP) {
      const u = i.s / SETTLE_TIP
      i.lean = i.lean0 + (TIP_LEAN - i.lean0) * u * u
    } else {
      if (!i.tipped) {
        // The final thud.
        i.tipped = true
        i.vy = 2.6
        i.shake = 0.07
        i.pulse = 0
        // The dust leaves the globe on the same beat as the thud and its rings.
        if (!i.released) {
          i.released = true
          onRelease()
        }
      }
      const k = i.s - SETTLE_TIP
      i.lean = TIP_LEAN * Math.exp(-4.2 * k) * Math.cos(11 * k)
    }

    if (i.s > SETTLE_TIP + SETTLE_REST) {
      i.phase = "done"
      i.lean = 0
      i.bank = 0
      i.x = i.y = i.z = i.vy = 0
      g.quaternion.identity()
    }
  }

  // Hop: simple gravity with damped bounces on the floor. The first landing
  // after the drop is the thud of the launch.
  i.vy -= GRAVITY * dt
  i.y += i.vy * dt
  if (i.y < 0) {
    if (i.vy < -1.2) i.shake = Math.max(i.shake, -i.vy * 0.012)
    i.y = 0
    i.vy = Math.abs(i.vy) > 1 ? -i.vy * 0.4 : 0
  }

  // Lean: the wobble, plus a bank into the turn (toward the arena's middle).
  _qWob.setFromAxisAngle(_axis.set(Math.cos(i.phi), 0, Math.sin(i.phi)), i.lean)
  const rad = Math.hypot(i.x, i.z)
  if (i.bank > 0.001 && rad > 0.01) {
    _qBank.setFromAxisAngle(_axis.set(-i.z / rad, 0, i.x / rad), i.bank)
    rg.quaternion.copy(_qBank).multiply(_qWob)
  } else {
    rg.quaternion.copy(_qWob)
  }
}

type FadeLine = { material: { opacity: number } }

const _v = new Vector3()
const _dir = new Vector3()
const _c = new Vector3()

function Globe({
  color,
  links,
  activeTo,
  reduceMotion,
  idleSpin,
  dragTarget,
  track,
  onRelease,
}: {
  color: string
  links: GlobeLink[]
  activeTo: string | null
  reduceMotion: boolean
  idleSpin: boolean
  dragTarget: HTMLElement | null
  track: React.MutableRefObject<GlobeTrack>
  onRelease: () => void
}) {
  // Nested groups:
  //   pos   moves the whole globe through the arena (laps, hops)
  //   rig   leans it over (wobble and bank)
  //   group spins around its own axis, and takes the drag from the pointer
  // Beside them: `sil` is the globe's outline (always turned to face the
  // camera), `arena`, `shadow` and the trail dots are drawn on the floor.
  const pos = React.useRef<Group>(null)
  const rig = React.useRef<Group>(null)
  const group = React.useRef<Group>(null)
  const sil = React.useRef<Group>(null)
  const arena = React.useRef<Group>(null)
  const shadow = React.useRef<Group>(null)
  const rings = React.useRef<(Mesh | null)[]>([])
  const dots = React.useRef<(Mesh | null)[]>([])
  const arenaLines = React.useRef<(FadeLine | null)[]>([])
  const shadowLine = React.useRef<FadeLine | null>(null)

  const lines = React.useMemo(() => [...buildGrid(), ...buildContinents()], [])
  const outline = React.useMemo(() => circle(1), [])
  const wall = React.useMemo(() => circle(ARENA_R), [])
  const hub = React.useMemo(() => circle(0.32), [])
  const patch = React.useMemo(() => circle(0.75, 64), [])
  const pinDirections = React.useMemo(
    () => new Map(links.map((l) => [l.to, fromLatLon(l.lat, l.lon, 1)])),
    [links]
  )

  const releaseCallback = React.useRef(onRelease)
  React.useEffect(() => {
    releaseCallback.current = onRelease
  }, [onRelease])

  const [introInit] = React.useState(() => makeIntro(reduceMotion))
  const intro = React.useRef(introInit)

  const drag = React.useRef({
    active: false,
    x: 0,
    y: 0,
    t: 0,
    vx: 0, // fling velocity around the world Y axis (rad/s)
    vy: 0, // fling velocity around the world X axis (rad/s)
    auto: 1, // 0..1 weight of the diagonal auto-spin
  })

  // If someone turns on reduced motion mid-intro, skip straight to the end.
  React.useEffect(() => {
    const i = intro.current
    if (!reduceMotion || i.phase === "done") return
    i.phase = "done"
    i.lean = 0
    i.bank = 0
    i.x = i.y = i.z = i.vy = 0
    group.current?.quaternion.identity()
    rig.current?.quaternion.identity()
    if (!i.released) {
      i.released = true
      releaseCallback.current()
    }
  }, [reduceMotion])

  // Drag to rotate: the surface follows the cursor, then keeps its momentum.
  // The listeners sit on the square the globe lives in (the canvas itself is
  // bigger than that and lets clicks through).
  React.useEffect(() => {
    const el = dragTarget
    if (!el) return
    const s = drag.current

    el.style.cursor = "grab"
    // Vertical swipes still scroll the page on touch screens, so the globe
    // never traps someone's scrolling. Sideways drags turn it.
    el.style.touchAction = "pan-y"

    const onDown = (e: PointerEvent) => {
      if (intro.current.phase !== "done") return // let the launch play out
      s.active = true
      s.x = e.clientX
      s.y = e.clientY
      s.t = e.timeStamp
      s.vx = 0
      s.vy = 0
      s.auto = 0
      el.setPointerCapture(e.pointerId)
      el.style.cursor = "grabbing"
    }

    const onMove = (e: PointerEvent) => {
      const g = group.current
      if (!s.active || !g) return

      // Radians per pixel, so a point on the globe tracks the cursor.
      const k = 1 / (el.clientWidth * 0.415)
      const ax = (e.clientX - s.x) * k
      const ay = (e.clientY - s.y) * k
      const dt = Math.max((e.timeStamp - s.t) / 1000, 0.001)

      s.x = e.clientX
      s.y = e.clientY
      s.t = e.timeStamp

      g.rotateOnWorldAxis(Y_AXIS, ax)
      g.rotateOnWorldAxis(X_AXIS, ay)

      // Smoothed velocity for the fling on release.
      s.vx = Math.max(-MAX_FLING, Math.min(MAX_FLING, s.vx * 0.5 + (ax / dt) * 0.5))
      s.vy = Math.max(-MAX_FLING, Math.min(MAX_FLING, s.vy * 0.5 + (ay / dt) * 0.5))
    }

    const onUp = (e: PointerEvent) => {
      if (!s.active) return
      s.active = false

      // Held still before letting go: no fling.
      if (e.timeStamp - s.t > 80) {
        s.vx = 0
        s.vy = 0
      }

      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      el.style.cursor = "grab"
    }

    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)

    return () => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      el.style.cursor = ""
      el.style.touchAction = ""
    }
  }, [dragTarget])

  useFrame((state, delta) => {
    const g = group.current
    const rg = rig.current
    const ps = pos.current
    const sl = sil.current
    const i = intro.current
    const s = drag.current
    const dt = Math.min(delta, 0.05) // a hidden tab should not skip the show
    const running = i.phase !== "done"

    // ---- Simulation ---------------------------------------------------------
    if (running) {
      i.t += dt
      if (i.t >= INTRO_DELAY && g && rg) {
        stepIntro(i, g, rg, dt, () => releaseCallback.current())
      }
    }
    if (ps) ps.position.set(i.x, i.y, i.z)

    // ---- Camera: high and far at first, then down and in --------------------
    i.shake *= Math.exp(-dt * 7)
    const tt = running ? clamp(i.t - INTRO_DELAY, 0, T_END) : T_END
    const cp = smooth(clamp((tt - CAM_START) / (T_END - CAM_START), 0, 1))
    const k = 1 - cp // 1 at the start, 0 when settled
    const dist = CAMERA_DISTANCE + (FAR_DISTANCE - CAMERA_DISTANCE) * k
    const el = EL_START * k
    const az = AZ_SWAY * Math.sin(tt * 0.9) * k
    const flat = dist * Math.cos(el)
    state.camera.position.set(
      flat * Math.sin(az) + (Math.random() - 0.5) * i.shake,
      dist * Math.sin(el) + (Math.random() - 0.5) * i.shake,
      flat * Math.cos(az)
    )
    state.camera.lookAt(0, LOOK_Y * k, 0)

    // ---- Tell the dust where the globe is on screen -------------------------
    // The dust is drawn on a separate layer, in pixels. Each frame it is told
    // where the globe's centre is and how big the globe looks, so the burst
    // starts from the globe wherever it is.
    {
      const cam = state.camera as PerspectiveCamera
      cam.updateMatrixWorld()
      _c.set(i.x, i.y, i.z).applyMatrix4(cam.matrixWorldInverse)
      const depth = Math.max(1.05, -_c.z)
      const focal = state.size.height / 2 / Math.tan((cam.fov * Math.PI) / 360)
      const tr = track.current
      tr.dx = (focal * _c.x) / depth
      tr.dy = (focal * _c.y) / depth
      tr.r = focal / Math.sqrt(depth * depth - 1)
      tr.valid = true
    }

    // ---- The globe's outline, and the impact rings that live with it --------
    // The outline of a sphere is a circle facing the camera, which changes
    // size and angle as the globe moves, so it is recomputed every frame.
    if (sl) {
      _v.set(i.x, i.y, i.z)
      _dir.copy(state.camera.position).sub(_v)
      const d = _dir.length()
      _dir.divideScalar(d)
      sl.position.copy(_v).addScaledVector(_dir, 1 / d)
      sl.scale.setScalar(Math.sqrt(1 - 1 / (d * d)))
      sl.quaternion.setFromUnitVectors(Z_AXIS, _dir)
    }

    if (i.pulse >= 0) {
      i.pulse += dt
      rings.current.forEach((m, n) => {
        if (!m) return
        const u = clamp((i.pulse - n * 0.14) / 0.9, 0, 1)
        m.visible = u > 0 && u < 1
        m.scale.setScalar(1 + (1 - (1 - u) * (1 - u)) * 0.9)
        ;(m.material as MeshBasicMaterial).opacity = 0.75 * (1 - u)
      })
      if (i.pulse > 1.4) i.pulse = -1
    }

    // ---- Floor: arena, shadow and trail. They give the eye something to
    // measure the globe's distance against, and fade away as the camera
    // comes down to eye level. ----------------------------------------------
    if (running) {
      const fadeIn = clamp(i.t / 0.6, 0, 1)

      if (arena.current) arena.current.visible = true
      arenaLines.current.forEach((l) => {
        if (l) l.material.opacity = 0.5 * k * fadeIn
      })

      if (shadow.current) {
        shadow.current.visible = true
        shadow.current.position.set(i.x, FLOOR_Y + 0.005, i.z)
        shadow.current.scale.setScalar(1 / (1 + i.y * 0.9))
      }
      if (shadowLine.current) {
        shadowLine.current.material.opacity = (0.55 * k * fadeIn) / (1 + i.y)
      }

      // Trail: remember where the globe has been, newest first.
      if (i.t >= INTRO_DELAY) {
        i.sampleClock += dt
        if (i.sampleClock >= TRAIL_EVERY) {
          i.sampleClock = 0
          i.samples.unshift({ x: i.x, z: i.z, t: i.t })
          if (i.samples.length > TRAIL_N) i.samples.pop()
        }
      }
      dots.current.forEach((m, n) => {
        if (!m) return
        const sample = i.samples[n]
        if (!sample) {
          m.visible = false
          return
        }
        const a = clamp(1 - (i.t - sample.t) / TRAIL_LIFE, 0, 1)
        m.visible = a > 0.01
        m.position.set(sample.x, FLOOR_Y + 0.01, sample.z)
        m.scale.setScalar(0.4 + a)
        ;(m.material as MeshBasicMaterial).opacity = 0.7 * a * k
      })
    } else if (!i.decorHidden) {
      i.decorHidden = true
      if (arena.current) arena.current.visible = false
      if (shadow.current) shadow.current.visible = false
      dots.current.forEach((m) => {
        if (m) m.visible = false
      })
    }

    if (running) return

    // ---- After the intro: drag, fling, pin turning ---------------------------
    if (!g || s.active) return

    // A menu item is being pointed at: turn the globe by the shortest way so
    // that item's pin faces the viewer, and hold it there.
    const target = activeTo ? pinDirections.get(activeTo) : undefined
    if (target) {
      s.vx = 0
      s.vy = 0
      s.auto = 0

      _v.copy(target).applyQuaternion(g.quaternion)
      _qBank.setFromUnitVectors(_v, Z_AXIS)
      _qWob.identity().slerp(_qBank, reduceMotion ? 1 : 1 - Math.exp(-delta * TURN_RATE))
      g.quaternion.premultiply(_qWob)
      return
    }

    // Fling momentum fades out...
    const damping = Math.exp(-delta * FRICTION)
    s.vx *= damping
    s.vy *= damping
    g.rotateOnWorldAxis(Y_AXIS, s.vx * delta)
    g.rotateOnWorldAxis(X_AXIS, s.vy * delta)

    // ...and, if idleSpin is on, the slow diagonal spin eases back in.
    s.auto = Math.min(1, s.auto + delta * RESUME_RATE)
    if (idleSpin && !reduceMotion) {
      g.rotateOnWorldAxis(SPIN_AXIS, delta * SPIN_SPEED * s.auto)
    }
  })

  return (
    <>
      <group ref={pos}>
        <group ref={rig}>
          <group ref={group}>
            {/* Invisible sphere: writes depth only, so lines on the far side
                (and floor lines behind the globe) are hidden and the page
                background shows through. */}
            <mesh>
              <sphereGeometry args={[1, 64, 64]} />
              <meshBasicMaterial colorWrite={false} />
            </mesh>

            {lines.map((points, n) => (
              <Line key={n} points={points} color={color} lineWidth={LINE_WIDTH} />
            ))}

            {links.map((link) => (
              <Marker
                key={link.to}
                link={link}
                color={color}
                active={link.to === activeTo}
              />
            ))}
          </group>
        </group>
      </group>

      {/* Outline of the globe, plus the rings that burst out on the final thud. */}
      <group ref={sil}>
        <Line points={outline} color={color} lineWidth={LINE_WIDTH} depthTest={false} />
        {[0, 1].map((n) => (
          <mesh
            key={n}
            ref={(el) => {
              rings.current[n] = el
            }}
            visible={false}
          >
            <ringGeometry args={[0.985, 1, 128]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
        ))}
      </group>

      {/* The arena: a wall ring and a small hub, flat on the floor. */}
      <group
        ref={arena}
        position={[0, FLOOR_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={!intro.current.decorHidden}
      >
        <Line
          ref={(l) => {
            arenaLines.current[0] = l as unknown as FadeLine | null
          }}
          points={wall}
          color={color}
          lineWidth={1}
          transparent
          opacity={0}
        />
        <Line
          ref={(l) => {
            arenaLines.current[1] = l as unknown as FadeLine | null
          }}
          points={hub}
          color={color}
          lineWidth={1}
          transparent
          opacity={0}
        />
      </group>

      {/* Shadow under the globe: shrinks and fades as it hops. */}
      <group
        ref={shadow}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={!intro.current.decorHidden}
      >
        <Line
          ref={(l) => {
            shadowLine.current = l as unknown as FadeLine | null
          }}
          points={patch}
          color={color}
          lineWidth={1.25}
          transparent
          opacity={0}
        />
      </group>

      {/* Trail: dots left on the floor along the path. */}
      {Array.from({ length: TRAIL_N }, (_, n) => (
        <mesh
          key={n}
          ref={(el) => {
            dots.current[n] = el
          }}
          visible={false}
        >
          <sphereGeometry args={[0.025, 8, 8]} />
          <meshBasicMaterial color={color} transparent opacity={0} />
        </mesh>
      ))}
    </>
  )
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

// The parent must give this BOTH a height and a width. The height sets the
// globe's size (the globe is a square as tall as the component) and the word
// "Sync" sits to its right, sized from that same height. A width of about 3.8
// times the height fits, for example className="aspect-[3.8/1] w-[min(80vw,60rem)]".
// The word is star dust (see earthsync-word.tsx): when the globe tips over and
// hits the floor at the end of its launch, the dust bursts out of it and flies
// into the word.
// Pass `ink` to force a colour instead of following the theme.
// Pass `links={[]}` to hide the pins, or your own list to change them.
// Pass `activeTo` (a link's `to`) to turn the globe to that pin and ping it.
// Pass `idleSpin` to keep the globe slowly turning after the intro (off by default).
export default function EarthSyncGlobe({
  className,
  ink,
  links = DEFAULT_LINKS,
  activeTo = null,
  idleSpin = false,
}: {
  className?: string
  ink?: "#000000" | "#ffffff"
  links?: GlobeLink[]
  activeTo?: string | null
  idleSpin?: boolean
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const spacer = React.useRef<HTMLDivElement>(null)
  const themeInk = useInk(container)

  const [reduceMotion, setReduceMotion] = React.useState(prefersReducedMotion)
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduceMotion(media.matches)
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])

  // `go` fires the dust. With reduced motion there is no show: the word is simply there.
  const [go, setGo] = React.useState(reduceMotion)
  const handleRelease = React.useCallback(() => setGo(true), [])

  // Where the globe is on screen, written by the globe every frame and read by the dust.
  const track = React.useRef<GlobeTrack>({
    valid: false,
    dx: 0,
    dy: 0,
    r: 0,
  })

  // The square the globe ends up in. It takes the drag.
  const [dragEl, setDragEl] = React.useState<HTMLDivElement | null>(null)

  // Where the page has reserved room for the word, so the dust lands exactly
  // there. Measured again whenever the component changes size.
  const [metrics, setMetrics] = React.useState<WordMetrics | null>(null)
  React.useLayoutEffect(() => {
    const c = container.current
    const w = spacer.current
    if (!c || !w || !dragEl) return

    let cancelled = false
    const update = () => {
      if (cancelled) return
      const next = measureWord(c, w, dragEl)
      setMetrics((prev) => (sameMetrics(prev, next) ? prev : next))
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(c)
    // The dust takes its shape from the page's font, so measure again once it has loaded.
    document.fonts?.ready.then(update)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [dragEl])

  return (
    <div
      ref={container}
      // container-type: size lets the children size themselves from the
      // component's own height with `cqh` units.
      style={{ containerType: "size" }}
      className={`relative flex flex-row items-center justify-center ${className ?? ""}`}
    >
      <div ref={setDragEl} className="relative aspect-square h-full shrink-0">
        {/* The canvas is larger than the square, so the globe has room to run
            around the arena and hop without being cut off. It lets clicks
            through to whatever is underneath. */}
        <div
          className="pointer-events-none absolute"
          style={{ inset: `${-INSET * 100}%` }}
        >
          <Canvas camera={{ position: [0, 0, CAMERA_DISTANCE], fov: FOV }} dpr={[1, 2]}>
            <Globe
              color={ink ?? themeInk}
              links={links}
              activeTo={activeTo}
              reduceMotion={reduceMotion}
              idleSpin={idleSpin}
              dragTarget={dragEl}
              track={track}
              onRelease={handleRelease}
            />
          </Canvas>
        </div>
      </div>

      {/* Only holds the word's place in the layout. The letters are 3D dust. */}
      <div
        ref={spacer}
        aria-hidden="true"
        className="invisible shrink-0 select-none font-bold"
        style={{
          fontSize: `${TEXT_SCALE}cqh`,
          lineHeight: 1,
          letterSpacing: "-0.06em",
          marginLeft: "2cqh",
        }}
      >
        Sync
      </div>

      {metrics && (
        <WordStage
          metrics={metrics}
          ink={ink ?? themeInk}
          go={go}
          reduceMotion={reduceMotion}
          track={track}
        />
      )}
    </div>
  )
}