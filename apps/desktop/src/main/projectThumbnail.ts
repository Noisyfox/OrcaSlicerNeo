import { open, type ZipFile, type Entry } from 'yauzl';
import { SaxesParser } from 'saxes';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// These bound optional preview decoding, never project import or archive size.
const MAX_RELATIONSHIPS_BYTES = 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: false }, (error, archive) => {
      if (error) reject(error); else resolve(archive);
    });
  });
}

function readDirectory(archive: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    archive.on('error', reject);
    archive.on('entry', (entry: Entry) => {
      const key = entry.fileName.toLowerCase();
      if (!entry.fileName.endsWith('/') && !entries.has(key)) entries.set(key, entry);
      archive.readEntry();
    });
    archive.once('end', () => resolve(entries));
    archive.readEntry();
  });
}

function readEntry(archive: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) return Promise.reject(new Error('Preview entry is too large'));
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) { reject(error); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on('error', reject);
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) {
          stream.destroy(); reject(new Error('Preview entry is too large'));
        } else chunks.push(chunk);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks, length)));
    });
  });
}

/** Match Orca's _BBS_3MF_Importer::get_thumbnail relationship selection. */
function thumbnailTarget(xml: string): string {
  let middle = '', standard = '';
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('Unsupported relationship document'); });
  parser.on('opentag', tag => {
    if (tag.name.split(':').pop() !== 'Relationship') return;
    const type = tag.attributes.Type ?? '';
    const path = tag.attributes.Target ?? '';
    if (type.startsWith('http://schemas.openxmlformats.org/') && type.endsWith('thumbnail') && path.endsWith('.png')) standard = path;
    else if (type.startsWith('http://schemas.bambulab.com/') && type.endsWith('cover-thumbnail-middle')) middle = path;
  });
  parser.write(xml).close();
  return middle || standard || 'Metadata/plate_1.png';
}

/** Read only the ZIP directory, relationships and selected PNG; never unpack geometry. */
export async function readProjectThumbnail(path: string): Promise<string | null> {
  let archive: ZipFile | undefined;
  try {
    archive = await openArchive(path);
    const entries = await readDirectory(archive);
    const find = (name: string) => entries.get(name.replace(/^\//, '').toLowerCase());
    const relationships = find('_rels/.rels');
    if (!relationships) return null;
    const target = thumbnailTarget((await readEntry(archive, relationships, MAX_RELATIONSHIPS_BYTES)).toString('utf8'));
    const image = find(target);
    if (!image) return null;
    const bytes = await readEntry(archive, image, MAX_THUMBNAIL_BYTES);
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    // Missing/corrupt/unsupported optional previews never hide a recent project.
    return null;
  } finally { archive?.close(); }
}
