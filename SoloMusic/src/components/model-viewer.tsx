import * as React from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { OrbitControls, useAnimations, useGLTF } from "@react-three/drei"
import { LoopOnce, type Group } from "three"

const MODEL_URL = "/models/scene.gltf"

// Clip names must match the action names you gave in Blender. If one is
// missing, the model falls back to its first clip.
const IDLE_CLIP = "idle"
const HOVER_CLIP = "hover"
const CLICK_CLIP = "click"

function Model() {
  const group = React.useRef<Group>(null)
  const { scene, animations } = useGLTF(MODEL_URL)
  const { actions, names } = useAnimations(animations, group)
  const [hovered, setHovered] = React.useState(false)
  const clickedRef = React.useRef(false)

  const pick = React.useCallback(
    (name: string) => actions[name] ?? actions[names[0]] ?? null,
    [actions, names]
  )

  // Loop idle, or hover while the pointer is over the model, cross-fading.
  React.useEffect(() => {
    const action = pick(hovered ? HOVER_CLIP : IDLE_CLIP)

    if (!action || clickedRef.current) {
      return
    }

    action.reset().fadeIn(0.25).play()

    return () => {
      action.fadeOut(0.25)
    }
  }, [hovered, pick])

  // Play a one-shot clip on click, then return to idle.
  function handleClick() {
    const action = actions[CLICK_CLIP]

    if (!action || clickedRef.current) {
      return
    }

    clickedRef.current = true
    action.reset().setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.fadeIn(0.15).play()

    const mixer = action.getMixer()
    const onFinished = () => {
      mixer.removeEventListener("finished", onFinished)
      action.fadeOut(0.25)
      clickedRef.current = false
      setHovered((value) => value) // re-run is not needed; idle resumes below
      pick(IDLE_CLIP)?.reset().fadeIn(0.25).play()
    }

    mixer.addEventListener("finished", onFinished)
  }

  // Animating in code, no Blender needed: a slow turn.
  useFrame((_, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * 0.2
    }
  })

  return (
    <group
      ref={group}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
      }}
      onPointerOut={() => setHovered(false)}
      onClick={handleClick}
    >
      <primitive object={scene} />
    </group>
  )
}

useGLTF.preload(MODEL_URL)

// The parent must give this a height, for example className="h-96".
export default function ModelViewer({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Canvas camera={{ position: [0, 1, 4], fov: 45 }} dpr={[1, 2]}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[3, 5, 2]} intensity={1.5} />
        <React.Suspense fallback={null}>
          <Model />
        </React.Suspense>
        <OrbitControls enablePan={false} enableZoom={false} />
      </Canvas>
    </div>
  )
}