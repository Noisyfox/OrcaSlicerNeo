import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from './button';

// shadcn base-mira Toast primitives; placement and stacking belong to the feature.
function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return <ToastPrimitive.Root data-slot="toast" className={cn(
    'group/toast pointer-events-auto w-full origin-top-left rounded-md border bg-popover text-popover-foreground shadow-lg outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
    className,
  )} {...props} />;
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return <ToastPrimitive.Viewport data-slot="toast-viewport" className={cn('outline-none', className)} {...props} />;
}
function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return <ToastPrimitive.Content data-slot="toast-content" className={cn('flex items-start gap-2 p-2', className)} {...props} />;
}
function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return <ToastPrimitive.Title data-slot="toast-title" className={cn('text-xs font-medium', className)} {...props} />;
}
function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
  return <ToastPrimitive.Description data-slot="toast-description" className={cn('whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]', className)} {...props} />;
}
function ToastClose({ className, children, render = <Button variant="ghost" size="icon-xs" />, ...props }: ToastPrimitive.Close.Props) {
  return <ToastPrimitive.Close data-slot="toast-close" aria-label="Dismiss notification" render={render}
    className={cn('shrink-0 text-muted-foreground hover:text-foreground', className)} {...props}>
    {children ?? <X aria-hidden="true" />}
  </ToastPrimitive.Close>;
}

const ToastProvider = ToastPrimitive.Provider;
const createToastManager = ToastPrimitive.createToastManager;
const useToastManager = ToastPrimitive.useToastManager;
export { Toast, ToastViewport, ToastContent, ToastTitle, ToastDescription, ToastClose,
  ToastProvider, createToastManager, useToastManager };
