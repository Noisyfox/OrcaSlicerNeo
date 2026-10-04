import { useRef, type ComponentProps } from 'react';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function SearchClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  return <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear search"
    disabled={disabled} className="size-5 shrink-0 rounded-sm text-muted-foreground"
    onMouseDown={(event) => event.preventDefault()} onClick={onClear}>
    <X className="size-3" aria-hidden="true" />
  </Button>;
}

export function SearchInput({ value, onValueChange, className, ...props }:
  Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'ref'> & {
    value: string;
    onValueChange: (value: string) => void;
  }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="relative min-w-0">
    <Input {...props} ref={input} type="search" value={value}
      className={cn('pr-7 [&::-webkit-search-cancel-button]:appearance-none', className)}
      onChange={(event) => onValueChange(event.currentTarget.value)} />
    {value.length > 0 && <div className="absolute inset-y-0 right-1 flex items-center">
      <SearchClearButton disabled={props.disabled || props.readOnly} onClear={() => {
        onValueChange('');
        input.current?.focus();
      }} />
    </div>}
  </div>;
}
