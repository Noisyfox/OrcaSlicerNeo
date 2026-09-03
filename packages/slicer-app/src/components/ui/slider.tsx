import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

// Base UI anatomy: Root > Control > (Track > Indicator, Thumb). The Thumb
// stays a sibling of Track (as in the official base-mira anatomy): nesting it
// inside the overflow-hidden Track would clip the 12px knob to the 4px track
// band, hiding the grabber. thumbAlignment="edge" preserves the Radix
// thumb-in-bounds behavior at min/max.
//
// The official base-mira classes use `data-horizontal:`/`data-vertical:`,
// which compile to a bare `[data-horizontal]` attribute — Base UI 1.7 emits
// `data-orientation="horizontal"` instead, so those rules never match (the
// track would collapse to 0px). Use the bracketed `data-[orientation=…]:`
// form: the un-bracketed `data-orientation=horizontal:` shorthand is NOT
// valid Tailwind v4.3 syntax and compiles to nothing (regression 2026-08-16:
// the track collapsed to 0px and the scrubber was invisible to the e2e).
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-md bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className="relative z-10 block size-3 shrink-0 rounded-md border border-ring bg-white ring-ring/30 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-2 focus-visible:ring-2 focus-visible:outline-hidden active:ring-2 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
