import * as React from 'react';
import { cn } from '@/lib/utils';

// Migrated off the Radix label primitive: Base UI ships no Label part, so
// this is the native <label> (htmlFor + peer-disabled styles work as-is).
export const Label = React.forwardRef<
  React.ElementRef<'label'>,
  React.ComponentProps<'label'>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)}
    {...props}
  />
));
Label.displayName = 'Label';
