import { ColorPickerPopover, type ColorPickerPopoverProps } from '@/components/ui/color-picker-popover';
import { useColorFavorites } from '@/lib/useColorFavorites';

/** Application binding; the reusable picker itself never accesses platform state. */
export function UserColorPickerPopover(props: Omit<ColorPickerPopoverProps,
  'favorites' | 'favoritesReady' | 'onFavoriteAdd' | 'onFavoriteRemove'>) {
  const favorites = useColorFavorites();
  return <ColorPickerPopover {...props} {...favorites} />;
}
