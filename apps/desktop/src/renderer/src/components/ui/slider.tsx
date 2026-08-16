import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

// Base UI anatomy: Root > Control > Track > (Indicator, Thumb). The old
// layout classes moved from the Radix Root onto Control (the interactive
// surface); thumbAlignment="edge" preserves the Radix thumb-in-bounds
// behavior at min/max.
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    thumbAlignment="edge"
    className={className}
    {...props}
  >
    <SliderPrimitive.Control className="relative flex w-full touch-none select-none items-center">
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Indicator className="absolute h-full bg-primary" />
        <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </SliderPrimitive.Track>
    </SliderPrimitive.Control>
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';
