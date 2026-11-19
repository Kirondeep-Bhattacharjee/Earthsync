import * as React from "react"
import SkyBackground from "@/components/sky-background"
import EarthSyncGlobe from "@/components/earthmodel"

function Home() {
  // Belt and braces: the page itself never scrolls on this screen.
  React.useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prev = [html.style.overflow, body.style.overflow]
    html.style.overflow = "hidden"
    body.style.overflow = "hidden"
    return () => {
      html.style.overflow = prev[0]
      body.style.overflow = prev[1]
    }
  }, [])

  return (
    <SkyBackground className="h-dvh overflow-hidden">
      <div className="pointer-events-none fixed inset-0 z-0 flex items-center justify-center overflow-hidden">
        <div className="pointer-events-auto">
          <EarthSyncGlobe className="aspect-[3.8/1] w-[min(80vw,60rem,calc(80dvh*3.8))]" />
        </div>
      </div>
    </SkyBackground>
  )
}

export default Home