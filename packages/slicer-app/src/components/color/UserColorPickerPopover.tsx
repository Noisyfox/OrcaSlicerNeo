import { usePlatform } from '@orca/platform-contract';
import { ColorPickerPopover, type ColorPickerPopoverProps } from '@/components/ui/color-picker-popover';
import { useColorFavorites } from '@/lib/useColorFavorites';

/** Application binding; the reusable picker itself never accesses platform state. */
export function UserColorPickerPopover(props: Omit<ColorPickerPopoverProps,
  'screenColorSources' | 'favorites' | 'favoritesReady' | 'onFavoriteAdd' | 'onFavoriteRemove' | 'uiState' | 'onUiStateChange'>) {
  const favorites = useColorFavorites();
  const { screenColor } = usePlatform();
  return <ColorPickerPopover {...props} {...favorites} screenColorSources={screenColor} />;
}
