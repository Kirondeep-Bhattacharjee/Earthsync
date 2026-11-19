import * as React from "react"

// Picks black or white from the text colour the element inherits, so it follows
// whatever theme system the app uses (class, data-theme, system preference).
export function useInk(ref: React.RefObject<HTMLElement | null>) {
  const [ink, setInk] = React.useState<"#000000" | "#ffffff">("#000000")

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const ctx = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    })

    const update = () => {
      if (!ctx) return
      // Drawing to a 1px canvas converts any CSS colour (rgb, oklch, ...) to rgb.
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#000"
      ctx.fillStyle = getComputedStyle(el).color
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      setInk(luminance > 0.5 ? "#ffffff" : "#000000")
    }

    update()

    const observer = new MutationObserver(() => requestAnimationFrame(update))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    })

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", update)

    return () => {
      observer.disconnect()
      media.removeEventListener("change", update)
    }
  }, [ref])

  return ink
}
