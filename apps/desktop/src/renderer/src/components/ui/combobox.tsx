import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon } from "lucide-react"

const Combobox = ComboboxPrimitive.Root

// Doesn't render its own element (base-ui 1.7: children/placeholder only).
function ComboboxValue(props: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value {...props} />
}

function ComboboxTrigger({
  className,
  disabled = false,
  ...props
}: ComboboxPrimitive.Trigger.Props & { disabled?: boolean }) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "ml-auto flex size-6 shrink-0 cursor-default items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent/60 focus-visible:bg-accent/60 data-disabled:pointer-events-none",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="pointer-events-none size-3.5" />
    </ComboboxPrimitive.Trigger>
  )
}

// The searchable trigger control: a select-look input that also accepts
// typed text. The popup opens on click/focus and typing filters the items.
function ComboboxInput({
  className,
  disabled = false,
  placeholder = "— select —",
  ...props
}: ComboboxPrimitive.Input.Props & { placeholder?: string }) {
  return (
    <div
      className={cn(
        "relative flex h-8 w-full items-center rounded-md border border-input bg-transparent px-1.5 shadow-sm transition-colors has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/30 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50",
        className
      )}
    >
      <ComboboxPrimitive.Input
        placeholder={placeholder}
        disabled={disabled}
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-xs/relaxed outline-none placeholder:text-muted-foreground disabled:pointer-events-none"
        {...props}
      />
      <ComboboxTrigger disabled={disabled} />
    </div>
  )
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-[calc(var(--anchor-width)_+_1.75rem)] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-card text-card-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed whitespace-nowrap outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "hidden w-full justify-center py-2 text-center text-xs/relaxed text-muted-foreground group-data-empty/combobox-content:flex",
        className
      )}
      {...props}
    />
  )
}

function ComboboxSeparator({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("-mx-1 my-1 h-px bg-border/50", className)}
      {...props}
    />
  )
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
}
