import * as React from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Line, useTexture } from "@react-three/drei"
import {
  CanvasTexture,
  ExtrudeGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Group,
} from "three"
import { useInk } from "../lib/use-ink"

// ---- Dimensions (scene units) ----------------------------------------------
const BODY_W = 1
const BODY_H = 2.05
const DEPTH = 0.11
const BODY_R = 0.17
const BEZEL = 0.045
const SCREEN_W = BODY_W - BEZEL * 2
const SCREEN_H = BODY_H - BEZEL * 2
const SCREEN_R = 0.125

const LINE_WIDTH = 1.5
const CAMERA_DISTANCE = 4.6

// Small offsets keep lines and the screen from z-fighting with the body.
const Z_SCREEN = DEPTH / 2 + 0.004
const Z_FRONT = DEPTH / 2 + 0.006
const Z_BEZEL = DEPTH / 2 + 0.008
const Z_BACK = -DEPTH / 2 - 0.006

// Screen texture size, matching the screen's aspect ratio.
const TEX_W = 640
const TEX_H = Math.round((TEX_W * SCREEN_H) / SCREEN_W)

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`

// ---- Geometry helpers -------------------------------------------------------
function roundedShape(w: number, h: number, r: number) {
  const x = -w / 2
  const y = -h / 2
  const s = new Shape()
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - r)
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  s.lineTo(x + r, y + h)
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + r)
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}

function closedPoints(shape: Shape) {
  const pts = shape.getPoints(10)
  pts.push(pts[0].clone())
  return pts
}

const loop = (pts: Vector2[], z: number) => pts.map((p) => new Vector3(p.x, p.y, z))

function circle(cx: number, cy: number, r: number, z: number, n = 40) {
  const pts: Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2
    pts.push(new Vector3(cx + Math.cos(t) * r, cy + Math.sin(t) * r, z))
  }
  return pts
}

function rectLoop(x0: number, y0: number, x1: number, y1: number, z: number) {
  return [
    new Vector3(x0, y0, z),
    new Vector3(x1, y0, z),
    new Vector3(x1, y1, z),
    new Vector3(x0, y1, z),
    new Vector3(x0, y0, z),
  ]
}

function buildPhone() {
  const bodyShape = roundedShape(BODY_W, BODY_H, BODY_R)

  // Invisible solid: writes depth only, so hidden edges stay hidden and the
  // page background shows through (same trick as the globe).
  const body = new ExtrudeGeometry(bodyShape, {
    depth: DEPTH,
    bevelEnabled: false,
    curveSegments: 24,
  })
  body.translate(0, 0, -DEPTH / 2)

  const outline = closedPoints(bodyShape)
  const front = loop(outline, Z_FRONT)
  const back = loop(outline, Z_BACK)

  // Edge connectors between the front and back outlines (pairs of points).
  const connectors: Vector3[] = []
  const step = Math.max(1, Math.floor(outline.length / 18))
  for (let i = 0; i < outline.length - 1; i += step) {
    connectors.push(
      new Vector3(outline[i].x, outline[i].y, Z_FRONT),
      new Vector3(outline[i].x, outline[i].y, Z_BACK)
    )
  }

  // Screen: rounded plane with UVs mapped 0..1 across it.
  const screenShape = roundedShape(SCREEN_W, SCREEN_H, SCREEN_R)
  const screen = new ShapeGeometry(screenShape, 16)
  const pos = screen.attributes.position
  const uv = screen.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) + SCREEN_W / 2) / SCREEN_W, (pos.getY(i) + SCREEN_H / 2) / SCREEN_H)
  }
  const bezel = loop(closedPoints(screenShape), Z_BEZEL)

  // Side buttons (thin rectangles at the middle of the depth).
  const buttons = [
    rectLoop(BODY_W / 2, 0.25, BODY_W / 2 + 0.022, 0.62, 0), // power
    rectLoop(-BODY_W / 2 - 0.022, 0.4, -BODY_W / 2, 0.56, 0), // volume up
    rectLoop(-BODY_W / 2 - 0.022, 0.18, -BODY_W / 2, 0.34, 0), // volume down
  ]

  // Back: camera module (top-left when seen from behind) and a small globe mark.
  const cameraBlock = closedPoints(roundedShape(0.34, 0.34, 0.09)).map(
    (p) => new Vector3(p.x + 0.27, p.y + 0.78, Z_BACK)
  )
  const lenses = [
    circle(0.2, 0.85, 0.055, Z_BACK, 28),
    circle(0.2, 0.71, 0.055, Z_BACK, 28),
    circle(0.34, 0.78, 0.055, Z_BACK, 28),
  ]

  const markRadius = 0.17
  const mark = [
    circle(0, -0.1, markRadius, Z_BACK, 56),
    ...[0.07, -0.07].map((dy) => {
      const half = Math.sqrt(markRadius * markRadius - dy * dy)
      return [new Vector3(-half, -0.1 + dy, Z_BACK), new Vector3(half, -0.1 + dy, Z_BACK)]
    }),
  ]

  return { body, front, back, connectors, screen, bezel, buttons, backDetails: [cameraBlock, ...lenses, ...mark] }
}

// ---- The mock chat screen ---------------------------------------------------
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

export type ChatMessage = { text: string; sent: boolean }

const DEFAULT_MESSAGES: ChatMessage[] = [
  { text: "Are we still on for tonight?", sent: false },
  { text: "Yes! Just finishing up at work", sent: true },
  { text: "Should I bring anything?", sent: true },
  { text: "Just yourself", sent: false },
  { text: "I synced the plan on EarthSync", sent: false },
  { text: "Perfect, see you at 8", sent: true },
]

// Pure black and white: sent bubbles are filled, received ones are outlined.
function drawChat(canvas: HTMLCanvasElement, ink: string, messages: ChatMessage[], contact: string) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const W = canvas.width
  const H = canvas.height
  const fg = ink
  const bg = ink === "#ffffff" ? "#000000" : "#ffffff"

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = fg
  ctx.fillStyle = fg
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"

  // Status bar
  ctx.font = `700 26px ${FONT}`
  ctx.fillText("9:41", 56, 58)
  for (let i = 0; i < 3; i++) {
    const h = 10 + i * 6
    ctx.fillRect(W - 196 + i * 14, 70 - h, 8, h)
  }
  ctx.lineWidth = 3
  rr(ctx, W - 118, 46, 54, 26, 8)
  ctx.stroke()
  ctx.fillRect(W - 112, 52, 34, 14)
  ctx.fillRect(W - 62, 54, 5, 10)

  // Dynamic island
  rr(ctx, W / 2 - 80, 36, 160, 44, 22)
  ctx.fillStyle = "#000"
  ctx.fill()
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = fg

  // Header: back chevron, avatar, name
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(60, 152)
  ctx.lineTo(40, 178)
  ctx.lineTo(60, 204)
  ctx.stroke()

  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(124, 178, 36, 0, Math.PI * 2)
  ctx.stroke()
  ctx.font = `700 32px ${FONT}`
  ctx.textAlign = "center"
  ctx.fillText(contact.charAt(0).toUpperCase(), 124, 180)
  ctx.textAlign = "left"

  ctx.font = `700 32px ${FONT}`
  ctx.fillText(contact, 180, 166)
  ctx.beginPath()
  ctx.arc(188, 202, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = `400 22px ${FONT}`
  ctx.fillText("online", 202, 202)

  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 252)
  ctx.lineTo(W, 252)
  ctx.stroke()

  // Messages
  let y = 292
  const lineHeight = 40

  for (const message of messages) {
    ctx.font = `500 30px ${FONT}`
    const lines = wrap(ctx, message.text, W * 0.62)
    const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width))
    const bw = textWidth + 56
    const bh = lines.length * lineHeight + 34
    const x = message.sent ? W - 40 - bw : 40

    rr(ctx, x, y, bw, bh, 30)
    if (message.sent) {
      ctx.fillStyle = fg
      ctx.fill()
    } else {
      ctx.fillStyle = bg
      ctx.fill()
      ctx.lineWidth = 3
      ctx.stroke()
    }

    ctx.fillStyle = message.sent ? bg : fg
    lines.forEach((l, i) => ctx.fillText(l, x + 28, y + 17 + lineHeight * i + lineHeight / 2))
    ctx.fillStyle = fg
    y += bh + 18
  }

  // Typing indicator
  rr(ctx, 40, y, 132, 64, 32)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.fillStyle = fg
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(78 + i * 28, y + 32, 7, 0, Math.PI * 2)
    ctx.fill()
  }

  // Message field + send button
  ctx.lineWidth = 3
  rr(ctx, 40, H - 204, W - 80 - 92, 76, 38)
  ctx.stroke()
  ctx.font = `400 28px ${FONT}`
  ctx.fillText("Message", 76, H - 166)

  const cx = W - 40 - 38
  const cy = H - 166
  ctx.beginPath()
  ctx.arc(cx, cy, 38, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = bg
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(cx, cy + 14)
  ctx.lineTo(cx, cy - 14)
  ctx.moveTo(cx - 12, cy - 3)
  ctx.lineTo(cx, cy - 15)
  ctx.lineTo(cx + 12, cy - 3)
  ctx.stroke()
  ctx.strokeStyle = fg

  // Home indicator
  rr(ctx, W / 2 - 90, H - 36, 180, 9, 4.5)
  ctx.fill()
}

function MockScreen({
  geometry,
  ink,
  messages,
  contact,
}: {
  geometry: ShapeGeometry
  ink: string
  messages: ChatMessage[]
  contact: string
}) {
  const texture = React.useMemo(() => {
    const canvas = document.createElement("canvas")
    canvas.width = TEX_W
    canvas.height = TEX_H
    drawChat(canvas, ink, messages, contact)
    const t = new CanvasTexture(canvas)
    t.colorSpace = SRGBColorSpace
    t.anisotropy = 8
    return t
    // Redrawn below when the theme or content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useLayoutEffect(() => {
    drawChat(texture.image as HTMLCanvasElement, ink, messages, contact)
    texture.needsUpdate = true
  }, [texture, ink, messages, contact])

  React.useEffect(() => () => texture.dispose(), [texture])

  return (
    <mesh geometry={geometry} position-z={Z_SCREEN}>
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  )
}

// Use your own screenshot instead of the mock.
function ImageScreen({ geometry, src }: { geometry: ShapeGeometry; src: string }) {
  const texture = useTexture(src)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8

  return (
    <mesh geometry={geometry} position-z={Z_SCREEN}>
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  )
}

// ---- The phone --------------------------------------------------------------
type PhoneProps = {
  color: string
  screenImage?: string
  screenImageDark?: string
  messages: ChatMessage[]
  contact: string
}

function Phone({ color, screenImage, screenImageDark, messages, contact }: PhoneProps) {
  const group = React.useRef<Group>(null)
  const { gl } = useThree()
  const phone = React.useMemo(buildPhone, [])
  const isDark = color === "#ffffff"
  const imageSrc = isDark && screenImageDark ? screenImageDark : screenImage

  const s = React.useRef({
    active: false,
    x: 0,
    y: 0,
    yaw: 0, // extra rotation from dragging; eases back to 0
    pitch: 0,
    idle: 1, // 0..1 weight of the gentle idle sway
  })

  // Drag to turn the phone; it eases back to its resting sway on release.
  React.useEffect(() => {
    const el = gl.domElement
    const d = s.current

    el.style.cursor = "grab"
    el.style.touchAction = "pan-y" // vertical swipes still scroll the page on touch

    const onDown = (e: PointerEvent) => {
      d.active = true
      d.x = e.clientX
      d.y = e.clientY
      el.setPointerCapture(e.pointerId)
      el.style.cursor = "grabbing"
    }

    const onMove = (e: PointerEvent) => {
      if (!d.active) return
      const k = 3 / el.clientHeight // a full-height drag turns about 3 radians
      d.yaw += (e.clientX - d.x) * k
      d.pitch = Math.max(-1.1, Math.min(1.1, d.pitch + (e.clientY - d.y) * k))
      d.x = e.clientX
      d.y = e.clientY
    }

    const onUp = (e: PointerEvent) => {
      if (!d.active) return
      d.active = false
      // Wrap so it takes the short way back to the front.
      d.yaw = ((((d.yaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI
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
  }, [gl])

  useFrame((state, delta) => {
    const g = group.current
    const d = s.current
    if (!g) return

    if (d.active) {
      d.idle = Math.max(0, d.idle - delta * 4)
    } else {
      const damping = Math.exp(-delta * 1.8)
      d.yaw *= damping
      d.pitch *= damping
      d.idle = Math.min(1, d.idle + delta * 0.8)
    }

    const t = state.clock.elapsedTime
    const swayYaw = Math.sin(t * 0.5) * 0.5 * d.idle
    const swayPitch = Math.sin(t * 0.37) * 0.1 * d.idle

    g.rotation.set(swayPitch + d.pitch, swayYaw + d.yaw, 0, "YXZ")
    g.position.y = Math.sin(t * 0.9) * 0.04 * d.idle
  })

  return (
    <group ref={group}>
      <mesh geometry={phone.body}>
        <meshBasicMaterial colorWrite={false} />
      </mesh>

      <Line points={phone.front} color={color} lineWidth={LINE_WIDTH} />
      <Line points={phone.back} color={color} lineWidth={LINE_WIDTH} />
      <Line points={phone.connectors} segments color={color} lineWidth={LINE_WIDTH} />
      <Line points={phone.bezel} color={color} lineWidth={LINE_WIDTH} />

      {phone.buttons.map((points, i) => (
        <Line key={`b${i}`} points={points} color={color} lineWidth={LINE_WIDTH} />
      ))}
      {phone.backDetails.map((points, i) => (
        <Line key={`d${i}`} points={points} color={color} lineWidth={LINE_WIDTH} />
      ))}

      {imageSrc ? (
        <React.Suspense fallback={null}>
          <ImageScreen geometry={phone.screen} src={imageSrc} />
        </React.Suspense>
      ) : (
        <MockScreen geometry={phone.screen} ink={color} messages={messages} contact={contact} />
      )}
    </group>
  )
}

// The parent must give this a size, for example className="h-[28rem] w-64".
export default function ChatPhone({
  className,
  ink,
  screenImage,
  screenImageDark,
  messages = DEFAULT_MESSAGES,
  contact = "Maya",
}: {
  className?: string
  /** Force black or white linework instead of following the theme. */
  ink?: "#000000" | "#ffffff"
  /** Show your own screenshot on the screen instead of the mock chat. */
  screenImage?: string
  /** Optional dark-mode version of the screenshot. */
  screenImageDark?: string
  messages?: ChatMessage[]
  contact?: string
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const themeInk = useInk(container)

  return (
    <div ref={container} className={className}>
      <Canvas
        camera={{ position: [0, 0, CAMERA_DISTANCE], fov: 35, near: 1, far: 20 }}
        dpr={[1, 2]}
      >
        <Phone
          color={ink ?? themeInk}
          screenImage={screenImage}
          screenImageDark={screenImageDark}
          messages={messages}
          contact={contact}
        />
      </Canvas>
    </div>
  )
}