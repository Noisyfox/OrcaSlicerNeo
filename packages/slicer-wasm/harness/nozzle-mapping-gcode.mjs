/** Physical tools used for depositing model/support features, excluding custom purge moves.
 * @param {string} gcode
 * @returns {number[]}
 */
export function extrudingTools(gcode) {
  let active = null, relative = true, e = 0, feature = '';
  const tools = new Set();
  for (const line of gcode.split(/\r?\n/)) {
    const activated = line.match(/^ACTIVATE_EXTRUDER EXTRUDER=extruder(\d+)/);
    if (activated) active = Number(activated[1]);
    const tool = line.match(/^T(\d+)(?:\s+H(\d+))?\b/);
    if (tool && Number(tool[1]) < 254) active = Number(tool[2] ?? tool[1]);
    if (line.startsWith(';TYPE:')) feature = line.slice(6).trim();
    if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim();
    if (/^M83\b/.test(line)) relative = true;
    if (/^M82\b/.test(line)) relative = false;
    const value = line.match(/\bE(-?[\d.]+)/);
    if (/^G92\b/.test(line) && value) e = Number(value[1]);
    if (!/^G[123]\b/.test(line) || !value) continue;
    const next = Number(value[1]);
    if (feature && feature !== 'Custom' && active !== null && /\b[XY]-?[\d.]+/.test(line) && (relative ? next > 0 : next > e)) tools.add(active);
    e = next;
  }
  return [...tools].sort();
}
