// ----------------------------------------------------------------
// ------------ Mock Emscripten module (harness self-test) --------
// ----------------------------------------------------------------
// Mimics the shape of an Emscripten MODULARIZE+EXPORT_ES6 factory (FS +
// callMain) so run-slice.mjs can be validated before the real WASM build
// exists. It does not slice; it echoes a trivial, valid G-code so the staging,
// callMain, read-back, and validation paths are all exercised.
export default async function createMockModule(opts = {}) {
  const files = new Map();

  const FS = {
    writeFile(path, data) {
      files.set(path, Buffer.from(data));
    },
    readFile(path) {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return new Uint8Array(files.get(path));
    },
  };

  return {
    FS,
    callMain(args) {
      const [modelPath, configPath, outPath] = args;
      const model = files.get(modelPath);
      if (!model) {
        opts.printErr?.('error: model missing');
        return 1;
      }
      const config = files.get(configPath);
      const gcode = [
        '; mock slice (harness self-test, not a real slice)',
        `; model bytes: ${model.length}`,
        `; config bytes: ${config ? config.length : 0}`,
        'G21',
        'G90',
        'G1 X0 Y0 Z0.2 F1200',
        'G1 X20 Y0 E1.0',
        'M104 S0',
        '',
      ].join('\n');
      files.set(outPath, Buffer.from(gcode, 'utf8'));
      opts.print?.(`ok: wrote ${outPath}`);
      return 0;
    },
  };
}
