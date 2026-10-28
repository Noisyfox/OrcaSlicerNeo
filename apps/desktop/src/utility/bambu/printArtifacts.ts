import { open as openZip, type ZipFile, type Entry } from 'yauzl';
import { SaxesParser } from 'saxes';
import type * as D from '@orca/printer-control/domain';
/** Lazy ZIP inspection bounds metadata and never buffers the G-code into the utility. */
function metadata(path: string, withGcode: boolean): Promise<string> {
  return new Promise((resolve, reject) => openZip(path, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(new Error('Invalid print archive')); return; }
    let xml: string | undefined, gcode = false, entries = 0; const names = new Set<string>();
    const fail = () => { zip.close(); reject(new Error('Invalid print archive')); };
    zip.on('error', fail);
    zip.on('entry', (entry: Entry) => {
      if (++entries > 256 || names.has(entry.fileName) || entry.uncompressedSize > 1024 * 1024 * 1024) { fail(); return; }
      names.add(entry.fileName);
      if (entry.fileName === 'Metadata/plate_1.gcode') gcode = true;
      if (entry.fileName !== 'Metadata/slice_info.config') { zip.readEntry(); return; }
      if (entry.uncompressedSize > 1024 * 1024) { fail(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail(); return; }
        const chunks: Buffer[] = []; let count = 0;
        stream.on('data', (chunk: Buffer) => { count += chunk.length; if (count > 1024 * 1024) { stream.destroy(); fail(); } else chunks.push(chunk); });
        stream.on('error', fail);
        stream.on('end', () => { xml = Buffer.concat(chunks).toString('utf8'); zip.readEntry(); });
      });
    });
    zip.on('end', () => { if (!xml || gcode !== withGcode) fail(); else resolve(xml); });
    zip.readEntry();
  }));
}
export async function validatePrintArtifacts(print: string, configuration: string, requirements: D.PrintRequirements) {
  const [xml, other] = await Promise.all([metadata(print, true), metadata(configuration, false)]);
  if (xml !== other) throw new Error('Print artifacts do not share the same slice metadata');
  const ids: number[] = [];
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('Unexpected archive document type'); });
  parser.on('opentag', tag => { if (tag.name === 'filament') ids.push(Number(tag.attributes.id) - 1); });
  parser.write(xml).close();
  if (JSON.stringify(ids.sort((a, b) => a - b)) !== JSON.stringify(requirements.materials.map(m => m.index).sort((a, b) => a - b))) throw new Error('Print material identities differ from the archive');
}
