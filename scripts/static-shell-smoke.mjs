import { createServer } from 'node:http';
import { createInflate } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const distDir = resolve('dist');
const outDir = join(tmpdir(), 'azurefilm-static-shell-smoke');

await stat(join(distDir, 'index.html')).catch(() => {
  throw new Error('dist/index.html not found. Run `npm run build` first.');
});

await mkdir(outDir, { recursive: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const requestPath = decodeURIComponent(url.pathname);
  const candidate =
    requestPath === '/'
      ? join(distDir, 'index.html')
      : join(distDir, requestPath.replace(/^\/+/, ''));

  const filePath = candidate.startsWith(distDir)
    ? await stat(candidate)
        .then((entry) => (entry.isFile() ? candidate : join(distDir, 'index.html')))
        .catch(() => join(distDir, 'index.html'))
    : join(distDir, 'index.html');

  const contentType =
    {
      '.css': 'text/css',
      '.hdr': 'application/octet-stream',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.ttf': 'font/ttf',
      '.wasm': 'application/wasm',
      '.webp': 'image/webp',
    }[extname(filePath)] ?? 'text/html';

  res.setHeader('Content-Type', contentType);
  createReadStream(filePath).pipe(res);
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const checks = [
    { label: 'home', path: '/', selector: 'button' },
    { label: 'signin', path: '/signin', selector: 'input[type=password]' },
  ];

  for (const check of checks) {
    const screenshotPath = join(outDir, `${check.label}.png`);
    await run('npx', [
      '--yes',
      'playwright',
      'screenshot',
      `--wait-for-selector=${check.selector}`,
      '--wait-for-timeout=1000',
      '--full-page',
      '--viewport-size=1440,1000',
      `${origin}${check.path}`,
      screenshotPath,
    ]);

    const { differingPixels, brightPixels } =
      await analyzeScreenshot(screenshotPath);

    if (differingPixels < 10_000 || brightPixels < 1_000) {
      throw new Error(
        `Static ${check.label} shell looks blank: ${differingPixels} differing pixels, ${brightPixels} bright pixels. Screenshot: ${screenshotPath}`,
      );
    }

    console.log(
      `Static ${check.label} shell rendered meaningful content: ${differingPixels} differing pixels, ${brightPixels} bright pixels.`,
    );
  }
} finally {
  server.close();
}

async function analyzeScreenshot(screenshotPath) {
  const png = await readPng(screenshotPath);
  const first = png.pixels.subarray(0, 4);
  let differingPixels = 0;
  let brightPixels = 0;

  for (let i = 0; i < png.pixels.length; i += 4) {
    const r = png.pixels[i];
    const g = png.pixels[i + 1];
    const b = png.pixels[i + 2];
    const delta =
      Math.abs(r - first[0]) + Math.abs(g - first[1]) + Math.abs(b - first[2]);

    if (delta > 18) differingPixels += 1;
    if (r + g + b > 180) brightPixels += 1;
  }

  return { differingPixels, brightPixels };
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child =
      process.platform === 'win32'
        ? spawn(
            'cmd.exe',
            ['/d', '/s', '/c', [command, ...args.map(quoteWindowsArg)].join(' ')],
            { stdio: 'inherit' },
          )
        : spawn(command, args, { stdio: 'inherit' });

    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function quoteWindowsArg(arg) {
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/gu, '\\"')}"`;
}

async function readPng(path) {
  const bytes = await readFile(path);
  const signature = bytes.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('Screenshot is not a PNG.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
      }
    }

    if (type === 'IDAT') idatChunks.push(data);
    if (type === 'IEND') break;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = await inflate(Buffer.concat(idatChunks));
  const raw = Buffer.alloc(width * height * channels);
  let sourceOffset = 0;
  let targetOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    unfilter(row, previous, channels, filter);
    row.copy(raw, targetOffset);
    targetOffset += stride;
    previous = row;
  }

  const pixels = channels === 4 ? raw : rgbToRgba(raw);

  return { width, height, pixels };
}

function rgbToRgba(rgb) {
  const rgba = Buffer.alloc((rgb.length / 3) * 4);
  let target = 0;

  for (let source = 0; source < rgb.length; source += 3) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
    target += 4;
  }

  return rgba;
}

function inflate(data) {
  return new Promise((resolveInflate, rejectInflate) => {
    const inflater = createInflate();
    const chunks = [];
    inflater.on('data', (chunk) => chunks.push(chunk));
    inflater.on('end', () => resolveInflate(Buffer.concat(chunks)));
    inflater.on('error', rejectInflate);
    inflater.end(data);
  });
}

function unfilter(row, previous, bytesPerPixel, filter) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;

    if (filter === 1) row[i] = (row[i] + left) & 0xff;
    else if (filter === 2) row[i] = (row[i] + up) & 0xff;
    else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}
