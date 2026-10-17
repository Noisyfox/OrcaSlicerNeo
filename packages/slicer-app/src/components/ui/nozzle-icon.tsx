import type { SVGProps } from 'react';

/** Orca resources/images/multi_extruder.svg, with the stroke inherited from text. */
export function NozzleIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M3.5,3.5h8M3.5,5.5h8M3.5,1.5h8M6.5,5.5v7l1,1,1-1v-7" />
  </svg>;
}
