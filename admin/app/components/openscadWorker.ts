// Compiles OpenSCAD source to binary STL (or SVG for 2D models) entirely in
// the browser, mirroring the main app's src/worker/openSCAD.ts. The wasm
// build, font and library zips are served from /public/openscad/.
import { ZipReader, BlobReader, Uint8ArrayWriter } from '@zip.js/zip.js';

// Typed view of the dedicated-worker globals used here (the project tsconfig
// loads the dom lib, not webworker).
type WorkerScope = {
  onmessage:
    | ((event: MessageEvent<OpenScadRenderRequest>) => void | Promise<void>)
    | null;
  postMessage: (
    message: OpenScadRenderResponse,
    transfer?: Transferable[],
  ) => void;
};
const workerScope = self as unknown as WorkerScope;

type WorkerParam = {
  name: string;
  type?: string;
  value: unknown;
};

export type OpenScadRenderRequest = {
  code: string;
  params: WorkerParam[];
};

export type OpenScadRenderResponse =
  | { ok: true; kind: 'stl'; data: ArrayBuffer; log: string[] }
  | { ok: true; kind: 'svg'; data: string; log: string[] }
  | { ok: false; error: string; log: string[] };

// Minimal surface of the emscripten module we use.
type OpenScadInstance = {
  FS: {
    writeFile: (path: string, data: string | Int8Array) => void;
    readFile: (
      path: string,
      opts: { encoding: 'binary' | 'utf8' },
    ) => Uint8Array | string;
    mkdir: (path: string) => void;
    stat: (path: string) => unknown;
  };
  callMain: (args: string[]) => number;
};

type OpenScadFactory = (opts: {
  noInitialRun: boolean;
  print: (text: string) => void;
  printErr: (text: string) => void;
  locateFile: (path: string) => string;
}) => Promise<OpenScadInstance>;

const LIBRARIES = ['BOSL2', 'BOSL', 'MCAD'];

const FONTS_CONF = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig></fontconfig>`;

let factoryPromise: Promise<OpenScadFactory> | null = null;
let fontPromise: Promise<ArrayBuffer> | null = null;
const libraryCache = new Map<
  string,
  Promise<{ path: string; data: Int8Array }[]>
>();

// The wasm glue is a plain ES module in /public, imported at runtime — the
// non-literal specifier plus webpackIgnore keeps both TS and webpack from
// trying to resolve it at build time.
const OPENSCAD_JS_URL = '/openscad/openscad.js';

function loadFactory(): Promise<OpenScadFactory> {
  factoryPromise ??= import(/* webpackIgnore: true */ OPENSCAD_JS_URL).then(
    (mod) => mod.default as OpenScadFactory,
  );
  return factoryPromise;
}

function loadFont(): Promise<ArrayBuffer> {
  fontPromise ??= fetch('/openscad/Geist-Regular.ttf').then((r) => {
    if (!r.ok) throw new Error('font fetch failed');
    return r.arrayBuffer();
  });
  return fontPromise;
}

function loadLibrary(name: string) {
  let cached = libraryCache.get(name);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(`/openscad/libraries/${name}.zip`);
      if (!response.ok) throw new Error(`library ${name} fetch failed`);
      const entries = await new ZipReader(
        new BlobReader(await response.blob()),
      ).getEntries();
      const files: { path: string; data: Int8Array }[] = [];
      for (const entry of entries) {
        if (entry.directory || !entry.getData) continue;
        const data = await entry.getData(new Uint8ArrayWriter());
        files.push({
          path: `/libraries/${name}/${entry.filename}`,
          data: new Int8Array(data),
        });
      }
      return files;
    })();
    libraryCache.set(name, cached);
  }
  return cached;
}

function mkdirRecursive(instance: OpenScadInstance, path: string) {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      instance.FS.stat(current);
    } catch {
      instance.FS.mkdir(current);
    }
  }
}

function escapeShell(value: string): string {
  return '"' + value.replace(/(["'$`\\])/g, '\\$1') + '"';
}

function paramFlags(params: WorkerParam[]): string[] {
  return params
    .filter((p) => p && p.name && p.value !== undefined && p.value !== null)
    .map(({ name, type, value }) => {
      let rendered: unknown = value;
      if (type === 'string' && typeof value === 'string') {
        rendered = escapeShell(value);
      } else if (
        (type === 'number[]' || type === 'boolean[]') &&
        Array.isArray(value)
      ) {
        rendered = `[${value.join(',')}]`;
      } else if (type === 'string[]' && Array.isArray(value)) {
        rendered = `[${value
          .map((item) => (typeof item === 'string' ? escapeShell(item) : item))
          .join(',')}]`;
      }
      return `-D${name}=${rendered}`;
    });
}

async function createInstance(log: { out: string[]; err: string[] }) {
  const factory = await loadFactory();
  const instance = await factory({
    noInitialRun: true,
    print: (text) => log.out.push(text),
    printErr: (text) => log.err.push(text),
    locateFile: (path) => `/openscad/${path}`,
  });

  try {
    mkdirRecursive(instance, '/fonts');
    instance.FS.writeFile('/fonts/fonts.conf', FONTS_CONF);
    instance.FS.writeFile(
      '/fonts/Geist-Regular.ttf',
      new Int8Array(await loadFont()),
    );
  } catch {
    // text() models may fail without fonts; everything else is unaffected
  }

  return instance;
}

async function execute(
  code: string,
  outFile: string,
  flags: string[],
  log: { out: string[]; err: string[] },
): Promise<{ exitCode: number; output: Uint8Array | string | null }> {
  // A fresh instance per run: the wasm build can throw opaque errors when an
  // instance is reused (same workaround as the main app's worker).
  const instance = await createInstance(log);
  instance.FS.writeFile('/input.scad', code);
  mkdirRecursive(instance, '/libraries');

  for (const name of LIBRARIES) {
    if (!code.includes(name)) continue;
    try {
      for (const file of await loadLibrary(name)) {
        const dir = file.path.split('/').slice(0, -1).join('/');
        mkdirRecursive(instance, dir);
        instance.FS.writeFile(file.path, file.data);
      }
    } catch {
      log.err.push(`Failed to load library ${name}`);
    }
  }

  let exitCode: number;
  try {
    exitCode = instance.callMain(['/input.scad', '-o', outFile, ...flags]);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `OpenSCAD exited with an error: ${error.message}`
        : 'OpenSCAD exited with an error',
    );
  }

  if (exitCode !== 0) return { exitCode, output: null };
  const encoding = outFile.endsWith('.svg') ? 'utf8' : 'binary';
  return {
    exitCode,
    output: instance.FS.readFile(outFile, { encoding }) as Uint8Array | string,
  };
}

const BASE_FLAGS = [
  '--backend=manifold',
  '--enable=lazy-union',
  '--enable=roof',
];

workerScope.onmessage = async (event: MessageEvent<OpenScadRenderRequest>) => {
  const { code, params } = event.data;
  const log = { out: [] as string[], err: [] as string[] };
  const respond = (
    message: OpenScadRenderResponse,
    transfer?: Transferable[],
  ) => workerScope.postMessage(message, transfer ?? []);

  try {
    const flags = [
      ...paramFlags(params),
      '--export-format=binstl',
      ...BASE_FLAGS,
    ];
    const stl = await execute(code, '/out.stl', flags, log);

    if (stl.exitCode === 0 && stl.output instanceof Uint8Array) {
      // Copy into a plain ArrayBuffer so it can be transferred.
      const buffer = new ArrayBuffer(stl.output.byteLength);
      new Uint8Array(buffer).set(stl.output);
      respond({ ok: true, kind: 'stl', data: buffer, log: log.err }, [buffer]);
      return;
    }

    // 2D models (e.g. plates, gaskets sketched in 2D) export as SVG instead.
    if (
      log.err.some((l) =>
        l.includes('Current top level object is not a 3D object'),
      )
    ) {
      const svgLog = { out: [] as string[], err: [] as string[] };
      const svg = await execute(
        code,
        '/out.svg',
        [...paramFlags(params), '--export-format=svg', ...BASE_FLAGS],
        svgLog,
      );
      if (svg.exitCode === 0 && typeof svg.output === 'string') {
        respond({ ok: true, kind: 'svg', data: svg.output, log: svgLog.err });
        return;
      }
      log.err.push(...svgLog.err);
    }

    respond({
      ok: false,
      error: 'OpenSCAD could not compile this model.',
      log: log.err,
    });
  } catch (error) {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : 'Render failed',
      log: log.err,
    });
  }
};
