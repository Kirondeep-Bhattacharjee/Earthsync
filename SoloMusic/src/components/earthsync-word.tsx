import * as React from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  LinearFilter,
  PlaneGeometry,
  ShaderMaterial,
  type PerspectiveCamera,
} from "three"

// ---- "Sync", as a constellation ----------------------------------------------
// From the start, faint twinkling stars are scattered across the screen and
// drift very slowly. When the globe tips over and hits the floor (`go`), every
// star flies along a gentle curve to its place on the outline of the word.
// As neighbouring stars arrive, thin lines are drawn between them (same width
// and colour as the globe's wireframe), so the outline of the letters draws
// itself. Once the last line is drawn, nothing happens for a second. Then the
// whole outline fills in, and the stars and lines fade away, leaving the word.
//
// The globe tells this file (through `track`) where it is on screen and how big
// it looks, every frame, so the stars can dim as they pass behind it.
//
// The shape of the word is not hard-coded: the same text and font the page
// reserves room for is drawn once on a hidden canvas. Its outline is traced
// into closed loops (the stars sit on them) and the same canvas is used as the
// fill. So it always matches the page's own typeface, size and position.
//
// Units are CSS pixels, with the camera set up so 1 unit = 1 px.

const WORD = "Sync"

// Outline
const OUTLINE_WIDTH = 1.5 // px, same as the globe's wireframe
const OUTLINE_GAP = 0.11 // largest gap between neighbouring stars, as a share of the font size
const OUTLINE_SMOOTH = 0.012 // how much the traced outline is simplified, as a share of the font size

// Timing (seconds)
const SWEEP = 0.7 // arrival order leans left to right (S before c) by this much
const SPREAD = 0.6 // plus a random delay per star
const FLIGHT_MIN = 0.9 // time a star spends flying to its place
const FLIGHT_MAX = 1.5
const LINE_DRAW = 0.35 // time a line takes to draw once both its stars have arrived
const HOLD = 1.0 // nothing happens for this long after the last line
const FILL_DUR = 0.8 // the fill coming in
const FILL_SOFT = 0.5 // 0 = a hard left-to-right wipe, bigger = closer to "all at once"
const FADE_DELAY = 0.25 // stars and lines start fading this long after the fill starts
const FADE_DUR = 0.6

// Stars
const STAR_SHARE = 0.18 // share of stars drawn as four-point stars instead of round dots
const GLOBE_DIM_IN = 1.0 // stars fade out within this many globe radii of the globe...
const GLOBE_DIM_OUT = 1.4 // ...and are fully visible beyond this many

/** Written by the globe every frame, read by the stars. Pixels, y up. */
export type GlobeTrack = {
  valid: boolean
  dx: number // globe centre, from the middle of the globe's square
  dy: number
  r: number // how big the globe looks, radius in px
}

export type WordMetrics = {
  size: number // font size of the reserved word, px
  step: number // scale reference for the stars, px
  above: number // how far the stage reaches above the component, px
  below: number // how far it reaches below, px
  width: number // component size, px
  height: number
  left: number // the word's box, px from the component's top-left
  top: number
  wordWidth: number
  globeX: number // the globe's centre, px from the component's top-left
  globeY: number
  globeR: number // the globe's radius on screen, px (when it is at rest)
  loops: number[][] // closed outlines: x, y pairs inside the word's box, where the stars settle
  sig: number // a cheap fingerprint of `loops`
  font: string
  word: HTMLCanvasElement | null // the word drawn in black, used as the fill
}

const KEYS = [
  "size",
  "step",
  "above",
  "below",
  "width",
  "height",
  "left",
  "top",
  "wordWidth",
  "globeX",
  "globeY",
  "globeR",
] as const

export function sameMetrics(a: WordMetrics | null, b: WordMetrics) {
  return (
    !!a &&
    a.sig === b.sig &&
    a.font === b.font &&
    KEYS.every((k) => Math.abs(a[k] - b[k]) < 0.5)
  )
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const smooth = (u: number) => u * u * (3 - 2 * u)

// ---- The word: drawing it and tracing its outline -----------------------------

const K = 2 // canvas pixels per CSS pixel
const PAD = 4 // CSS px of room left of the word in the canvas

type Pt = [number, number]

// Draws the word the way the page does, in black on a transparent canvas.
function rasterWord(style: CSSStyleDeclaration, size: number, width: number) {
  const cw = Math.ceil(width + PAD * 2)
  const ch = Math.ceil(size * 1.4) // room for the tail of the y

  const canvas = document.createElement("canvas")
  canvas.width = cw * K
  canvas.height = ch * K
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null

  ctx.scale(K, K)
  const font = `${style.fontWeight} ${size}px ${style.fontFamily}`
  ctx.font = font
  if (style.letterSpacing.endsWith("px")) {
    ;(ctx as unknown as { letterSpacing: string }).letterSpacing = style.letterSpacing
  }
  ctx.textBaseline = "alphabetic"

  // Where the baseline sits inside a line-height: 1 box.
  const m = ctx.measureText(WORD)
  const ascent = m.fontBoundingBoxAscent ?? size * 0.93
  const descent = m.fontBoundingBoxDescent ?? size * 0.24
  const baseline = (size - (ascent + descent)) / 2 + ascent

  ctx.fillStyle = "#000"
  ctx.fillText(WORD, PAD, baseline)

  return { canvas, ctx, font }
}

// Douglas-Peucker on an open polyline (iterative, so long outlines are safe).
function simplify(pts: Pt[], tol: number): Pt[] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const L = Math.hypot(dx, dy)
    let md = -1
    let mi = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      const d =
        L < 1e-9
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * (px - ax) - dx * (py - ay)) / L
      if (d > md) {
        md = d
        mi = i
      }
    }
    if (md > tol && mi > 0) {
      keep[mi] = 1
      stack.push([a, mi], [mi, b])
    }
  }
  return pts.filter((_, i) => keep[i] === 1)
}

// The same for a closed ring: split it at the point farthest from the first one.
function simplifyRing(ring: Pt[], tol: number): Pt[] {
  const n = ring.length
  let f = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
    if (d > best) {
      best = d
      f = i
    }
  }
  const first = simplify(ring.slice(0, f + 1), tol)
  const second = simplify([...ring.slice(f), ring[0]], tol)
  return [...first, ...second.slice(1, -1)]
}

// Adds points along long edges so no two neighbouring stars are too far apart.
function subdivide(ring: Pt[], gap: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const parts = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / gap))
    for (let k = 0; k < parts; k++) {
      const t = k / parts
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

// Traces the edge of the letters (marching squares) into closed loops.
// Returns flat [x, y, x, y, ...] arrays in CSS px, from the word box's top-left.
function traceOutline(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  size: number
): number[][] {
  const W = canvas.width
  const H = canvas.height
  const data = ctx.getImageData(0, 0, W, H).data
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 128 ? 1 : 0
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H ? mask[y * W + x] : 0

  // Each crossing is the middle of a cell edge. Its key is built from doubled
  // coordinates so it is a whole number.
  const MUL = 1 << 16
  const key = (X: number, Y: number) => (X + 4) * MUL + (Y + 4)
  const adj = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    const la = adj.get(a)
    if (la) la.push(b)
    else adj.set(a, [b])
    const lb = adj.get(b)
    if (lb) lb.push(a)
    else adj.set(b, [a])
  }

  for (let cy = -1; cy < H; cy++) {
    for (let cx = -1; cx < W; cx++) {
      const tl = on(cx, cy)
      const tr = on(cx + 1, cy)
      const br = on(cx + 1, cy + 1)
      const bl = on(cx, cy + 1)
      const c = tl * 8 + tr * 4 + br * 2 + bl
      if (c === 0 || c === 15) continue

      const T = key(2 * cx + 1, 2 * cy)
      const R = key(2 * cx + 2, 2 * cy + 1)
      const B = key(2 * cx + 1, 2 * cy + 2)
      const L = key(2 * cx, 2 * cy + 1)

      switch (c) {
        case 1: case 14: link(L, B); break
        case 2: case 13: link(B, R); break
        case 3: case 12: link(L, R); break
        case 4: case 11: link(T, R); break
        case 5: link(T, R); link(L, B); break
        case 6: case 9: link(T, B); break
        case 7: case 8: link(T, L); break
        case 10: link(T, L); link(B, R); break
      }
    }
  }

  const tol = Math.max(0.8, size * OUTLINE_SMOOTH)
  const gap = Math.max(9, size * OUTLINE_GAP)
  const seen = new Set<number>()
  const loops: number[][] = []

  for (const start of adj.keys()) {
    if (seen.has(start)) continue

    const keys: number[] = []
    let prev = -1
    let cur = start
    for (;;) {
      keys.push(cur)
      seen.add(cur)
      const nb = adj.get(cur) as number[]
      const next = nb[0] !== prev ? nb[0] : nb[1]
      if (next === undefined) break
      prev = cur
      cur = next
      if (cur === start || seen.has(cur)) break
    }
    if (keys.length < 8) continue

    // Back to CSS px, measured from the word box.
    const ring: Pt[] = keys.map((k) => {
      const X = Math.floor(k / MUL) - 4
      const Y = (k % MUL) - 4
      return [(X / 2 + 0.5) / K - PAD, (Y / 2 + 0.5) / K]
    })

    let perimeter = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      perimeter += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    if (perimeter < size * 0.25) continue // specks

    const stars = subdivide(simplifyRing(ring, tol), gap)
    if (stars.length < 3) continue
    loops.push(stars.flatMap((p) => p))
  }

  return loops
}

/** Reads where the page reserved room for the word and where the globe is. */
export function measureWord(
  container: HTMLElement,
  spacer: HTMLElement,
  square: HTMLElement
): WordMetrics {
  const c = container.getBoundingClientRect()
  const w = spacer.getBoundingClientRect()
  const s = square.getBoundingClientRect()
  const style = getComputedStyle(spacer)
  const size = parseFloat(style.fontSize) || 96

  const raster = rasterWord(style, size, w.width)
  const loops = raster ? traceOutline(raster.canvas, raster.ctx, size) : []

  return {
    size,
    step: clamp(size / 80, 1.3, 2.2),
    // Room for the stars to scatter around.
    above: Math.ceil(s.width * 0.9),
    below: Math.ceil(Math.max(size * 0.5, s.width * 0.9)),
    width: c.width,
    height: c.height,
    left: w.left - c.left,
    top: w.top - c.top,
    wordWidth: w.width,
    globeX: s.left - c.left + s.width / 2,
    globeY: s.top - c.top + s.height / 2,
    globeR: s.width * 0.425,
    loops,
    sig: loops.reduce((n, l) => n + l.length, 0),
    font: raster?.font ?? "",
    word: raster?.canvas ?? null,
  }
}

// ---- The constellation --------------------------------------------------------

type Sim = {
  geometry: BufferGeometry // the stars
  lineGeometry: BufferGeometry // the lines between them
  n: number // stars
  segs: number // lines
  // The globe, in stage coordinates. gx0/gy0/R0 are where it rests; gx/gy/R
  // follow it while it moves.
  gx0: number
  gy0: number
  R0: number
  gx: number
  gy: number
  R: number
  // Each star: where it floats before the thud (s), where it settles (t), and
  // the control point that bends its flight (c).
  sx: Float32Array
  sy: Float32Array
  tx: Float32Array
  ty: Float32Array
  cx: Float32Array
  cy: Float32Array
  delay: Float32Array
  dur: Float32Array
  base: Float32Array // size once settled
  idleS: Float32Array // size while floating
  idleA: Float32Array // brightness while floating
  amp: Float32Array // how far it drifts while floating
  sp: Float32Array
  wob: Float32Array
  zAmp: Float32Array
  ph: Float32Array
  // Each line joins star `segA` to star `segB`, and starts once both are there.
  segA: Uint32Array
  segB: Uint32Array
  segStart: Float32Array
  pos: Float32Array
  size: Float32Array
  alpha: Float32Array
  tw: Float32Array
  linePos: Float32Array
  lineAlpha: Float32Array
  tFill: number // when the fill starts
  end: number // when everything is finished
  fill: number // 0..1, how far the fill has come in
  done: boolean
}

function buildDust(m: WordMetrics, done: boolean): Sim {
  const rand = rng(11)
  const H = m.above + m.height + m.below
  // The stage reaches 25% past the component on the left and right.
  const hw = (m.width * 1.5) / 2
  const hh = H / 2

  const gx0 = m.globeX - m.width / 2
  const gy0 = H / 2 - (m.above + m.globeY)
  const R0 = m.globeR

  // Flatten the loops into stars and lines.
  const txL: number[] = []
  const tyL: number[] = []
  const bxL: number[] = [] // x inside the word's box, for the left-to-right lean
  const a: number[] = []
  const b: number[] = []
  for (const loop of m.loops) {
    const first = txL.length
    const cnt = loop.length / 2
    for (let k = 0; k < cnt; k++) {
      const bx = loop[k * 2]
      const by = loop[k * 2 + 1]
      txL.push(m.left + bx - m.width / 2)
      tyL.push(H / 2 - (m.above + m.top + by))
      bxL.push(bx)
      a.push(first + k)
      b.push(first + ((k + 1) % cnt))
    }
  }
  const n = txL.length
  const segs = a.length

  const f = () => new Float32Array(n)
  const sx = f(), sy = f(), cx = f(), cy = f()
  const tx = Float32Array.from(txL)
  const ty = Float32Array.from(tyL)
  const delay = f(), dur = f(), base = f(), idleS = f(), idleA = f()
  const amp = f(), sp = f(), wob = f(), zAmp = f(), ph = f()
  const aSpeed = f(), aStar = f(), aMix = f()

  const sc = m.step / 1.6 // stars scale a little with the type size

  for (let i = 0; i < n; i++) {
    // Scattered somewhere on the stage.
    sx[i] = (rand() * 2 - 1) * hw * 0.98
    sy[i] = (rand() * 2 - 1) * hh * 0.98

    // The flight bends to one side or the other.
    const bend = (rand() - 0.5) * 2 * (0.15 + rand() * 0.25)
    cx[i] = (sx[i] + tx[i]) / 2 - (ty[i] - sy[i]) * bend
    cy[i] = (sy[i] + ty[i]) / 2 + (tx[i] - sx[i]) * bend

    delay[i] = (bxL[i] / Math.max(1, m.wordWidth)) * SWEEP + rand() * SPREAD
    dur[i] = FLIGHT_MIN + rand() * (FLIGHT_MAX - FLIGHT_MIN)

    const star = rand() < STAR_SHARE
    aStar[i] = star ? 1 : 0
    aMix[i] = star ? 1 : 0
    base[i] = (star ? 11 : 3.6) * sc
    idleS[i] = (star ? 4 + rand() * 3 : 1.2 + rand() * 1.3) * sc
    idleA[i] = 0.22 + rand() * 0.22

    amp[i] = 4 + rand() * 8
    sp[i] = 0.25 + rand() * 0.5
    wob[i] = 2 + rand() * 3
    zAmp[i] = (rand() - 0.5) * 80
    ph[i] = rand() * Math.PI * 2
    aSpeed[i] = 0.8 + rand() * 2.2
  }

  // A line starts once both of its stars have arrived.
  const segA = Uint32Array.from(a)
  const segB = Uint32Array.from(b)
  const segStart = new Float32Array(segs)
  let tLines = 0
  for (let j = 0; j < segs; j++) {
    const la = delay[a[j]] + dur[a[j]]
    const lb = delay[b[j]] + dur[b[j]]
    segStart[j] = Math.max(la, lb)
    tLines = Math.max(tLines, segStart[j] + LINE_DRAW)
  }
  const tFill = tLines + HOLD
  const end = tFill + Math.max(FILL_DUR, FADE_DELAY + FADE_DUR) + 0.1

  const pos = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const alpha = new Float32Array(n)
  const tw = new Float32Array(n)

  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new BufferAttribute(pos, 3))
  geometry.setAttribute("aSize", new BufferAttribute(size, 1))
  geometry.setAttribute("aAlpha", new BufferAttribute(alpha, 1))
  geometry.setAttribute("aPhase", new BufferAttribute(ph, 1))
  geometry.setAttribute("aSpeed", new BufferAttribute(aSpeed, 1))
  geometry.setAttribute("aTw", new BufferAttribute(tw, 1))
  geometry.setAttribute("aStar", new BufferAttribute(aStar, 1))
  geometry.setAttribute("aMix", new BufferAttribute(aMix, 1))

  // Each line is a thin quad (so it has a real width), rebuilt every frame
  // while it draws in.
  const linePos = new Float32Array(segs * 4 * 3)
  const lineAlpha = new Float32Array(segs * 4)
  const index = new Uint32Array(segs * 6)
  for (let j = 0; j < segs; j++) {
    const v = j * 4
    index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], j * 6)
  }
  const lineGeometry = new BufferGeometry()
  lineGeometry.setAttribute("position", new BufferAttribute(linePos, 3))
  lineGeometry.setAttribute("aAlpha", new BufferAttribute(lineAlpha, 1))
  lineGeometry.setIndex(new BufferAttribute(index, 1))

  const sim: Sim = {
    geometry, lineGeometry, n, segs,
    gx0, gy0, R0, gx: gx0, gy: gy0, R: R0,
    sx, sy, tx, ty, cx, cy,
    delay, dur, base, idleS, idleA, amp, sp, wob, zAmp, ph,
    segA, segB, segStart,
    pos, size, alpha, tw, linePos, lineAlpha,
    tFill, end, fill: 0, done: false,
  }
  stepDust(sim, done ? Infinity : -1, 0)
  sim.done = done
  return sim
}

// `t` is the time since the thud (negative = not yet), `now` is the clock.
function stepDust(s: Sim, t: number, now: number) {
  const { pos, size, alpha, tw } = s

  s.fill = smooth(clamp((t - s.tFill) / FILL_DUR, 0, 1))
  const keep = 1 - clamp((t - s.tFill - FADE_DELAY) / FADE_DUR, 0, 1)
  const dimIn = s.R * GLOBE_DIM_IN
  const dimOut = Math.max(dimIn + 1, s.R * GLOBE_DIM_OUT)

  for (let i = 0; i < s.n; i++) {
    const j = i * 3
    const raw = (t - s.delay[i]) / s.dur[i]

    let px: number
    let py: number
    let pz = 0
    let sz: number
    let al: number
    let twd: number

    if (raw >= 1) {
      // Settled: a little flash as it lands, then a steady, calm twinkle.
      px = s.tx[i]
      py = s.ty[i]
      const flash = Math.exp(-(t - s.delay[i] - s.dur[i]) * 7)
      sz = s.base[i] * (1 + 0.9 * flash)
      al = 1
      twd = 0.12
    } else if (raw <= 0) {
      // Floating, faint, drifting slowly.
      px = s.sx[i] + Math.sin(now * s.sp[i] + s.ph[i]) * s.amp[i]
      py = s.sy[i] + Math.cos(now * s.sp[i] * 0.8 + s.ph[i] * 1.3) * s.amp[i]
      sz = s.idleS[i]
      al = s.idleA[i]
      twd = 0.55
    } else {
      // Flying: pulled toward its place along a curve.
      const u = raw
      const soft = smooth(u)
      const pull = 1 - Math.pow(1 - u, 3)
      const e = soft * 0.6 + pull * 0.4
      const k = 1 - e

      const dw = 1 - clamp(u / 0.25, 0, 1) // the drift dies away as it sets off
      const env = Math.sin(Math.PI * u)
      const driftX = Math.sin(now * s.sp[i] + s.ph[i]) * s.amp[i] * dw
      const driftY = Math.cos(now * s.sp[i] * 0.8 + s.ph[i] * 1.3) * s.amp[i] * dw

      px =
        k * k * s.sx[i] + 2 * k * e * s.cx[i] + e * e * s.tx[i] +
        driftX + Math.sin(s.ph[i] + u * 10) * s.wob[i] * env
      py =
        k * k * s.sy[i] + 2 * k * e * s.cy[i] + e * e * s.ty[i] +
        driftY + Math.cos(s.ph[i] * 1.3 + u * 9) * s.wob[i] * env
      pz = Math.sin(Math.PI * e) * s.zAmp[i]

      sz = s.idleS[i] + (s.base[i] - s.idleS[i]) * e
      al = s.idleA[i] + (1 - s.idleA[i]) * e
      twd = 0.55 + (0.12 - 0.55) * e
    }

    // Fade out behind the globe (only until the star has settled).
    if (raw < 1) {
      const d = Math.hypot(px - s.gx, py - s.gy)
      al *= smooth(clamp((d - dimIn) / (dimOut - dimIn), 0, 1))
    }

    pos[j] = px
    pos[j + 1] = py
    pos[j + 2] = pz
    size[i] = sz
    alpha[i] = al * keep
    tw[i] = twd
  }

  // Lines: each one grows from its first star to its second once both are in place.
  const half = OUTLINE_WIDTH / 2
  const lp = s.linePos
  const la = s.lineAlpha
  for (let q = 0; q < s.segs; q++) {
    const a = s.segA[q]
    const b = s.segB[q]
    const x0 = s.tx[a]
    const y0 = s.ty[a]
    const x1 = s.tx[b]
    const y1 = s.ty[b]

    const p = smooth(clamp((t - s.segStart[q]) / LINE_DRAW, 0, 1))
    const ex = x0 + (x1 - x0) * p
    const ey = y0 + (y1 - y0) * p
    const dx = ex - x0
    const dy = ey - y0
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * half
    const ny = (dx / len) * half

    const v = q * 12
    lp[v] = x0 + nx
    lp[v + 1] = y0 + ny
    lp[v + 2] = 0
    lp[v + 3] = x0 - nx
    lp[v + 4] = y0 - ny
    lp[v + 5] = 0
    lp[v + 6] = ex + nx
    lp[v + 7] = ey + ny
    lp[v + 8] = 0
    lp[v + 9] = ex - nx
    lp[v + 10] = ey - ny
    lp[v + 11] = 0

    const al = p > 0 ? 0.95 * keep : 0
    const w = q * 4
    la[w] = al
    la[w + 1] = al
    la[w + 2] = al
    la[w + 3] = al
  }

  const g = s.geometry.attributes
  g.position.needsUpdate = true
  g.aSize.needsUpdate = true
  g.aAlpha.needsUpdate = true
  g.aTw.needsUpdate = true
  const lg = s.lineGeometry.attributes
  lg.position.needsUpdate = true
  lg.aAlpha.needsUpdate = true
}

const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aTw;
  attribute float aStar;
  attribute float aMix;
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;
  varying float vStar;
  varying float vMix;
  void main() {
    float tw = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
    vAlpha = aAlpha * (1.0 - aTw * tw);
    vStar = aStar;
    vMix = aMix;
    gl_PointSize = aSize * uScale * (1.0 + 0.25 * aTw * tw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const STAR_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAccent;
  varying float vAlpha;
  varying float vStar;
  varying float vMix;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.25, d);
    if (vStar > 0.5) {
      // A four-point star: a bright core with a thin cross.
      float core = smoothstep(0.14, 0.0, d);
      float rays = (smoothstep(0.04, 0.0, abs(c.x)) + smoothstep(0.04, 0.0, abs(c.y)))
        * smoothstep(0.5, 0.0, d);
      a = max(core, rays);
    }
    a *= vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(uColor, uAccent, vMix), a);
  }
`

const LINE_VERTEX = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const LINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(uColor, vAlpha);
  }
`

const FILL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FILL_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uProg;
  uniform float uSoft;
  varying vec2 vUv;
  void main() {
    float a = texture2D(uMap, vUv).a;
    // A soft front that sweeps left to right; with a big uSoft it is nearly all at once.
    float front = uProg * (1.0 + uSoft);
    a *= 1.0 - smoothstep(front - uSoft, front, vUv.x);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

// ---- Scene -------------------------------------------------------------------

// Perspective camera, set up so 1 unit = 1 px at the middle depth.
function PixelCamera() {
  const { camera, size } = useThree()
  React.useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera
    const fov = 28
    cam.fov = fov
    cam.near = 50
    cam.far = 50000
    cam.position.set(0, 0, size.height / 2 / Math.tan((fov * Math.PI) / 360))
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
  }, [camera, size])
  return null
}

function Constellation({
  metrics,
  ink,
  accent,
  go,
  reduceMotion,
  track,
}: {
  metrics: WordMetrics
  ink: string
  accent?: string
  go: boolean
  reduceMotion: boolean
  track?: React.MutableRefObject<GlobeTrack>
}) {
  // Once the word has formed it stays formed if the layout is re-measured.
  const finished = React.useRef(reduceMotion)
  const startAt = React.useRef(-1) // clock time of the thud

  const sim = React.useMemo(
    () => buildDust(metrics, finished.current),
    [metrics]
  )
  React.useEffect(
    () => () => {
      sim.geometry.dispose()
      sim.lineGeometry.dispose()
    },
    [sim]
  )

  const starMaterial = React.useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: STAR_VERTEX,
        fragmentShader: STAR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uScale: { value: 1 },
          uColor: { value: new Color(ink) },
          uAccent: { value: new Color(accent ?? ink) },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const lineMaterial = React.useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: LINE_VERTEX,
        fragmentShader: LINE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: { uColor: { value: new Color(ink) } },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // The fill: the word drawn on the hidden canvas, laid exactly over the
  // place the page reserved for it.
  const fill = React.useMemo(() => {
    const canvas = metrics.word
    if (!canvas) return null
    const texture = new CanvasTexture(canvas)
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = false

    const cw = canvas.width / K
    const ch = canvas.height / K
    const H = metrics.above + metrics.height + metrics.below

    return {
      texture,
      geometry: new PlaneGeometry(cw, ch),
      material: new ShaderMaterial({
        vertexShader: FILL_VERTEX,
        fragmentShader: FILL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMap: { value: texture },
          uColor: { value: new Color(ink) },
          uProg: { value: 0 },
          uSoft: { value: FILL_SOFT },
        },
      }),
      x: metrics.left - PAD - metrics.width / 2 + cw / 2,
      y: H / 2 - (metrics.above + metrics.top) - ch / 2,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics])
  React.useEffect(
    () => () => {
      fill?.texture.dispose()
      fill?.geometry.dispose()
      fill?.material.dispose()
    },
    [fill]
  )

  React.useEffect(() => {
    starMaterial.uniforms.uColor.value.set(ink)
    starMaterial.uniforms.uAccent.value.set(accent ?? ink)
    lineMaterial.uniforms.uColor.value.set(ink)
    fill?.material.uniforms.uColor.value.set(ink)
  }, [starMaterial, lineMaterial, fill, ink, accent])
  React.useEffect(
    () => () => {
      starMaterial.dispose()
      lineMaterial.dispose()
    },
    [starMaterial, lineMaterial]
  )

  // Reduced motion turned on mid-show: skip to the finished word.
  React.useEffect(() => {
    if (!reduceMotion || sim.done) return
    stepDust(sim, Infinity, 0)
    sim.done = true
    finished.current = true
  }, [reduceMotion, sim])

  useFrame((state) => {
    const now = state.clock.elapsedTime
    starMaterial.uniforms.uTime.value = now
    starMaterial.uniforms.uScale.value = state.viewport.dpr
    if (fill) fill.material.uniforms.uProg.value = sim.fill

    if (sim.done) return

    // Follow the globe, so the stars can dim as they pass behind it.
    const tr = track?.current
    if (tr?.valid) {
      sim.gx = sim.gx0 + tr.dx
      sim.gy = sim.gy0 + tr.dy
      sim.R = Math.max(1, tr.r)
    }

    if (go && startAt.current < 0) startAt.current = now

    // Before the thud the stars just float; after it they fly in.
    const t = startAt.current < 0 ? -1 : now - startAt.current
    stepDust(sim, t, now)
    if (fill) fill.material.uniforms.uProg.value = sim.fill

    if (t > sim.end) {
      stepDust(sim, Infinity, now)
      if (fill) fill.material.uniforms.uProg.value = sim.fill
      sim.done = true
      finished.current = true
    }
  })

  return (
    <>
      {fill && (
        <mesh
          geometry={fill.geometry}
          material={fill.material}
          position={[fill.x, fill.y, 0]}
          renderOrder={0}
          frustumCulled={false}
        />
      )}
      <mesh
        geometry={sim.lineGeometry}
        material={lineMaterial}
        renderOrder={1}
        frustumCulled={false}
      />
      <points
        geometry={sim.geometry}
        material={starMaterial}
        renderOrder={2}
        frustumCulled={false}
      />
    </>
  )
}

/**
 * Sits over the component (it reaches well past it, so the stars can be
 * scattered around it) and draws the constellation and the word. `go` fires
 * the flight of the stars. `track` is where the globe is on screen. `accent`
 * tints the four-point stars, for example a pale blue to sit in a night sky.
 */
export default function WordStage({
  metrics,
  ink,
  accent,
  go,
  reduceMotion,
  track,
}: {
  metrics: WordMetrics
  ink: string
  accent?: string
  go: boolean
  reduceMotion: boolean
  track?: React.MutableRefObject<GlobeTrack>
}) {
  return (
    <div
      role="img"
      aria-label="Sync"
      className="pointer-events-none absolute z-10 select-none"
      style={{
        top: -metrics.above,
        bottom: -metrics.below,
        left: "-25%",
        right: "-25%",
      }}
    >
      <Canvas camera={{ fov: 28, near: 50, far: 50000, position: [0, 0, 3000] }} dpr={[1, 1.5]}>
        <PixelCamera />
        <Constellation
          metrics={metrics}
          ink={ink}
          accent={accent}
          go={go}
          reduceMotion={reduceMotion}
          track={track}
        />
      </Canvas>
    </div>
  )
}