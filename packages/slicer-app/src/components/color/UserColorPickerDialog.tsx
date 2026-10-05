import { ColorPickerDialog, type ColorPickerDialogProps } from '@/components/ui/color-picker-dialog';
import { useColorFavorites } from '@/lib/useColorFavorites';

/** Application binding; the reusable picker itself never accesses platform state. */
export function UserColorPickerDialog(props: Omit<ColorPickerDialogProps,
  'favorites' | 'favoritesReady' | 'onFavoriteAdd' | 'onFavoriteRemove'>) {
  const favorites = useColorFavorites();
  return <ColorPickerDialog {...props} {...favorites} />;
}
