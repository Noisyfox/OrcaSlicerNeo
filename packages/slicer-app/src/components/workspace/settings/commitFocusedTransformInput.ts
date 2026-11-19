/** Menu and keyboard commands can run without a pointer-induced blur. */
export function commitFocusedTransformInput(): void {
  const input = typeof document === 'undefined' ? null : document.activeElement;
  if (input && input instanceof HTMLElement && input.hasAttribute('data-transform-input')) input.blur();
}
