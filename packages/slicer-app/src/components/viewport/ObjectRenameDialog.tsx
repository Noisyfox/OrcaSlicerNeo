// Minimal modal rename dialog for the scene object context menu. The object
// list renames inline in its row; the 3D viewport has no row to edit, so the
// scene menu opens this dialog instead. The commit path is the same
// `renameObjectInList` helper (which also syncs a single-volume object's part
// name), so both entry points stay consistent.
import { useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { renameObjectInList } from '../objectList/actions';

export function ObjectRenameDialog({ objectId, currentName, onClose }: {
  objectId: number;
  currentName: string;
  onClose: () => void;
}) {
  const platform = usePlatform();
  const [name, setName] = useState(currentName);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) void renameObjectInList(platform.runtime, objectId, trimmed);
    onClose();
  };

  return (
    <div
      data-testid="rename-object-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="rename-object-dialog"
        className="pointer-events-auto w-72 rounded-md border bg-card p-4 shadow-md"
        // A click inside the dialog must not fall through to the backdrop.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <label htmlFor="rename-object-input" className="mb-1 block text-xs font-medium">
          Name
        </label>
        <Input
          id="rename-object-input"
          data-testid="rename-object-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') onClose();
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" data-testid="rename-object-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" data-testid="rename-object-ok" onClick={commit}>
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
