// Dependency-free, deterministic low-level 3MF builder for Step 0.
// This intentionally does not call an exporter or the native bridge.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const encoder = new TextEncoder();

function concat(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, text } of entries) {
    const nameBytes = encoder.encode(name);
    const content = text instanceof Uint8Array ? text : encoder.encode(text);
    const crc = crc32(content);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, content.length, true);
    lv.setUint32(22, content.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); locals.push(local, content);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, content.length, true);
    cv.setUint32(24, content.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); central.set(nameBytes, 46); centrals.push(central);
    offset += local.length + content.length;
  }
  const central = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true); ev.setUint32(12, central.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, central, eocd]);
}

/** Assemble a minimal but structurally valid 3MF archive from XML/JSON parts. */
export function buildIndependentReader3mf() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="json" ContentType="application/json"/><Override PartName="/Metadata/model_settings.config" ContentType="text/xml"/></Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>
`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="Application">OrcaSlicer-Neo-fixture</metadata><metadata name="OrcaSlicer">multi-filament-step-0</metadata><resources><object id="1" type="model"><mesh><vertices><vertex x="-10" y="-10" z="-10"/><vertex x="-10" y="10" z="-10"/><vertex x="10" y="10" z="-10"/><vertex x="10" y="-10" z="-10"/><vertex x="-10" y="-10" z="10"/><vertex x="10" y="-10" z="10"/><vertex x="10" y="10" z="10"/><vertex x="-10" y="10" z="10"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="3" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="3" v2="2" v3="6"/><triangle v1="3" v2="6" v3="5"/><triangle v1="2" v2="1" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="1" v2="0" v3="4"/><triangle v1="1" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 10" printable="1" auto_drop="1"/></build></model>
`;
  const modelRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config><object id="1"><metadata key="name" value="Two Material Cube"/><metadata key="extruder" value="2"/><part id="1" subtype="normal_part"><metadata key="name" value="Two Material Cube"/><metadata key="extruder" value="2"/><metadata key="source_file" value="independent-reader-basic.3mf"/><mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Independent Two Material Plate"/><metadata key="lock" value="false"/><metadata key="filament_maps" value="1 1"/><metadata key="filament_volume_maps" value="0 0"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance><filament id="1" tray_info_idx="PLA-RED" type="PLA" color="#FF0000" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/><filament id="2" tray_info_idx="PETG-GREEN" type="PETG" color="#00FF00" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/><nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/></plate><assemble></assemble></config>
`;
  const project = '{"version":"1.0.0","name":"project_settings","from":"project","filament_settings_id":["Generic PLA @Project","Generic PETG @Project"],"filament_colour":["#FF0000","#00FF00"],"filament_map":["1","1"],"filament_volume_map":["0","0"],"filament_nozzle_map":["0","0"],"flush_volumes_matrix":["0","100","100","0"]}\n';
  const filament1 = '{"version":"1.0.0","name":"Generic PLA @Project","filament_settings_id":["Generic PLA @Project"],"filament_colour":["#FF0000"],"filament_type":["PLA"],"filament_diameter":["1.75"],"filament_density":["1.24"],"nozzle_diameter":["0.4"]}\n';
  const filament2 = '{"version":"1.0.0","name":"Generic PETG @Project","filament_settings_id":["Generic PETG @Project"],"filament_colour":["#00FF00"],"filament_type":["PETG"],"filament_diameter":["1.75"],"filament_density":["1.27"],"nozzle_diameter":["0.4"]}\n';
  return storedZip([
    { name: '[Content_Types].xml', text: contentTypes },
    { name: '_rels/.rels', text: rels },
    { name: '3D/3dmodel.model', text: model },
    { name: '3D/_rels/3dmodel.model.rels', text: modelRels },
    { name: 'Metadata/model_settings.config', text: settings },
    { name: 'Metadata/project_settings.config', text: project },
    { name: 'Metadata/filament_settings_1.config', text: filament1 },
    { name: 'Metadata/filament_settings_2.config', text: filament2 }
  ]);
}

export async function writeIndependentReader3mf(path) {
  const bytes = buildIndependentReader3mf();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}
