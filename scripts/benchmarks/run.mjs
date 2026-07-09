import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_MODEL = 'google/gemini-3.5-flash';
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOOP_ITERATIONS = 8;
const PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PROCESS_OUTPUT = 200_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const promptsDir = path.join(repoRoot, 'benchmarks', 'prompts');
const resultsRoot = path.join(repoRoot, 'benchmarks', 'results');

function printUsage() {
  console.error(
    [
      'Usage: npm run benchmarks',
      '',
      'Required env vars:',
      '  BENCH_SUPABASE_URL   Supabase project URL, for example https://<project>.supabase.co',
      '  BENCH_ANON_KEY       Supabase anon key',
      '  BENCH_EMAIL          Benchmark user email',
      '  BENCH_PASSWORD       Benchmark user password',
      '',
      'Optional env vars:',
      `  BENCH_MODEL          Model id, default ${DEFAULT_MODEL}`,
      '  OPENSCAD_PATH        Path to openscad CLI for compile checks and PNG renders',
      '  BENCH_PROMPTS        Comma-separated filename-stem filters, for example 01-twisted,06-mug',
    ].join('\n'),
  );
}

function readConfig() {
  const required = [
    'BENCH_SUPABASE_URL',
    'BENCH_ANON_KEY',
    'BENCH_EMAIL',
    'BENCH_PASSWORD',
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    supabaseUrl: process.env.BENCH_SUPABASE_URL.trim().replace(/\/+$/, ''),
    anonKey: process.env.BENCH_ANON_KEY.trim(),
    email: process.env.BENCH_EMAIL.trim(),
    password: process.env.BENCH_PASSWORD,
    model: process.env.BENCH_MODEL?.trim() || DEFAULT_MODEL,
    openscadPath: process.env.OPENSCAD_PATH?.trim() || '',
    promptFilters: (process.env.BENCH_PROMPTS ?? '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  };
}

function timestampForDirectory(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error) {
  if (error?.name === 'AbortError') {
    return 'prompt timed out after 300 seconds';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function truncate(value, limit = 500) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function readErrorBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) {
    return response.statusText;
  }
  try {
    const data = JSON.parse(text);
    if (typeof data.error === 'string') return data.error;
    if (isRecord(data.error) && typeof data.error.message === 'string') {
      return data.error.message;
    }
    if (typeof data.message === 'string') return data.message;
  } catch {
    // Fall through to returning the raw text.
  }
  return truncate(text, 1000);
}

async function fetchJson(url, options, label) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(
      `${label} failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }
  return response.json();
}

async function fetchNoContent(url, options, label) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(
      `${label} failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }
}

function restHeaders(config, accessToken) {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

async function signIn(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const data = await fetchJson(
      `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          apikey: config.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: config.email,
          password: config.password,
        }),
        signal: controller.signal,
      },
      'sign in',
    );

    if (!data.access_token || !data.user?.id) {
      throw new Error(
        'sign in response did not include access_token and user.id',
      );
    }

    return {
      accessToken: data.access_token,
      userId: data.user.id,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadPrompts(config) {
  const entries = await fs.readdir(promptsDir, { withFileTypes: true });
  const prompts = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    if (
      config.promptFilters.length > 0 &&
      !config.promptFilters.some((filter) =>
        stem.toLowerCase().includes(filter),
      )
    ) {
      continue;
    }

    const filePath = path.join(promptsDir, entry.name);
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const heading = lines[0]?.trim() ?? '';
    const body = lines
      .slice(1)
      .join('\n')
      .replace(/^\s*\n/, '')
      .trim();

    if (!heading.startsWith('# ') || !body) {
      throw new Error(
        `${entry.name} must have a one-line "# ..." heading and a body`,
      );
    }

    prompts.push({
      fileName: entry.name,
      stem,
      title: heading.slice(2).trim(),
      text: body,
    });
  }

  prompts.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return prompts;
}

async function createConversation({
  config,
  auth,
  prompt,
  conversationId,
  signal,
}) {
  await fetchNoContent(
    `${config.supabaseUrl}/rest/v1/conversations`,
    {
      method: 'POST',
      headers: restHeaders(config, auth.accessToken),
      body: JSON.stringify({
        id: conversationId,
        user_id: auth.userId,
        title: prompt.title,
        type: 'parametric',
        settings: { model: config.model },
      }),
      signal,
    },
    'create conversation',
  );
}

async function insertUserMessage({
  config,
  auth,
  prompt,
  conversationId,
  messageId,
  signal,
}) {
  await fetchNoContent(
    `${config.supabaseUrl}/rest/v1/messages`,
    {
      method: 'POST',
      headers: restHeaders(config, auth.accessToken),
      body: JSON.stringify({
        id: messageId,
        role: 'user',
        content: {
          text: prompt.text,
          model: config.model,
        },
        parent_message_id: null,
        conversation_id: conversationId,
      }),
      signal,
    },
    'insert user message',
  );
}

function streamPayloadToMessage(payload) {
  if (isRecord(payload?.message)) return payload.message;
  return payload;
}

async function readNdjsonStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalMessage = null;

  function parseLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line);
      finalMessage = streamPayloadToMessage(parsed);
    } catch {
      // Ignore non-JSON stream fragments; the final parseable line is authoritative.
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        parseLine(line);
      }
    }

    buffer += decoder.decode();
    parseLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!finalMessage) {
    throw new Error('stream ended without a parseable JSON message');
  }
  return finalMessage;
}

async function invokeParametricChat({ config, auth, body, signal, label }) {
  const response = await fetch(
    `${config.supabaseUrl}/functions/v1/parametric-chat`,
    {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `${label} failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    return streamPayloadToMessage(data);
  }

  if (!response.body) {
    throw new Error(`${label} returned no response body`);
  }

  return readNdjsonStream(response.body);
}

function getContent(message) {
  if (isRecord(message?.content)) return message.content;
  if (isRecord(message?.message?.content)) return message.message.content;
  return null;
}

function extractArtifact(message) {
  const content = getContent(message);
  if (isRecord(content?.artifact)) return content.artifact;
  if (isRecord(message?.artifact)) return message.artifact;
  return null;
}

function extractLoop(message) {
  const content = getContent(message);
  return isRecord(content?.loop) ? content.loop : null;
}

function artifactCode(artifact) {
  return typeof artifact?.code === 'string' ? artifact.code : '';
}

function countCodeLines(code) {
  if (!code) return 0;
  return code.replace(/\s+$/, '').split(/\r?\n/).length;
}

function countTopLevelParameters(code) {
  if (!code) return 0;
  let count = 0;
  let sawAssignment = false;
  const assignment = /^\s*[$A-Za-z_][A-Za-z0-9_]*\s*=\s*.+;\s*(?:\/\/.*)?$/;

  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      if (!sawAssignment) continue;
      continue;
    }
    if (assignment.test(line)) {
      count += 1;
      sawAssignment = true;
      continue;
    }
    break;
  }

  return count;
}

function appendProcessOutput(current, chunk) {
  if (current.length >= MAX_PROCESS_OUTPUT) return current;
  const next = current + chunk.toString();
  return next.length > MAX_PROCESS_OUTPUT
    ? next.slice(0, MAX_PROCESS_OUTPUT)
    : next;
}

function runProcess(command, args, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, { windowsHide: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    child.stdout?.on('data', (chunk) => {
      stdout = appendProcessOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendProcessOutput(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        timedOut,
      });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr: timedOut ? `${stderr}\nprocess timed out`.trim() : stderr,
        timedOut,
      });
    });
  });
}

async function compileScad(openscadPath, code, resultDir, stem, round) {
  const tempDir = await fs.mkdtemp(path.join(resultDir, '.tmp-'));
  try {
    const sourcePath = path.join(tempDir, `${stem}-round-${round}.scad`);
    const stlPath = path.join(tempDir, `${stem}-round-${round}.stl`);
    await fs.writeFile(sourcePath, code, 'utf8');
    return runProcess(openscadPath, ['-o', stlPath, sourcePath]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderPng(openscadPath, scadPath, pngPath) {
  return runProcess(openscadPath, [
    '--render',
    '-o',
    pngPath,
    '--imgsize=800,600',
    scadPath,
  ]);
}

function createSummaryRow(prompt) {
  return {
    prompt: prompt.stem,
    artifact: false,
    compileOk: 'n/a',
    repairsUsed: 0,
    parameterCount: 0,
    codeLines: 0,
    seconds: '0.0',
    notes: [],
  };
}

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function writeSummary(resultDir, rows, startedAt) {
  const lines = [
    '# Benchmark Summary',
    '',
    `Started: ${startedAt.toISOString()}`,
    '',
    '| prompt | artifact? | compile ok? | repairs used | parameter count | code lines | seconds |',
    '|---|---|---|---:|---:|---:|---:|',
  ];

  for (const row of rows) {
    lines.push(
      [
        markdownCell(row.prompt),
        row.artifact ? 'yes' : 'no',
        row.compileOk,
        row.repairsUsed,
        row.parameterCount,
        row.codeLines,
        row.seconds,
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    );
  }

  const notes = rows.flatMap((row) =>
    row.notes.map((note) => `- ${row.prompt}: ${note}`),
  );
  if (notes.length > 0) {
    lines.push('', '## Notes', '', ...notes);
  }

  await fs.writeFile(
    path.join(resultDir, 'summary.md'),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

async function driveAgenticLoop({
  config,
  auth,
  resultDir,
  conversationId,
  assistantMessageId,
  initialMessage,
  initialCode,
  signal,
  row,
  prompt,
}) {
  let finalMessage = initialMessage;
  let code = initialCode;

  for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
    const loop = extractLoop(finalMessage);
    if (loop?.status !== 'awaiting_client') {
      return { finalMessage, code, lastCompile: null };
    }

    if (!code) {
      row.notes.push('awaiting-client-no-artifact');
      return { finalMessage, code, lastCompile: null };
    }

    if (!config.openscadPath) {
      row.notes.push('awaiting-client-no-openscad');
      return { finalMessage, code, lastCompile: null };
    }

    const compileResult = await compileScad(
      config.openscadPath,
      code,
      resultDir,
      prompt.stem,
      iteration,
    );

    if (compileResult.ok) {
      row.notes.push('needs-browser');
      return { finalMessage, code, lastCompile: compileResult };
    }

    row.repairsUsed += 1;
    const round = Number.isInteger(loop.round) ? loop.round : iteration;
    const errorText = (
      compileResult.stderr ||
      compileResult.stdout ||
      'OpenSCAD failed'
    ).slice(0, 4000);

    finalMessage = await invokeParametricChat({
      config,
      auth,
      signal,
      label: `continuation ${prompt.stem} round ${round}`,
      body: {
        continuation: {
          conversationId,
          assistantMessageId,
          round,
          result: {
            type: 'compile_error',
            error: errorText,
          },
        },
      },
    });

    const nextArtifact = extractArtifact(finalMessage);
    const nextCode = artifactCode(nextArtifact);
    if (nextCode) {
      code = nextCode;
    }
  }

  row.notes.push('max-loop-iterations');
  return { finalMessage, code, lastCompile: null };
}

async function runPrompt({ config, auth, prompt, resultDir, index, total }) {
  console.log(`[${index + 1}/${total}] ${prompt.stem}`);

  const row = createSummaryRow(prompt);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  const scadPath = path.join(resultDir, `${prompt.stem}.scad`);

  try {
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();

    await createConversation({
      config,
      auth,
      prompt,
      conversationId,
      signal: controller.signal,
    });
    await insertUserMessage({
      config,
      auth,
      prompt,
      conversationId,
      messageId: userMessageId,
      signal: controller.signal,
    });

    let finalMessage = await invokeParametricChat({
      config,
      auth,
      signal: controller.signal,
      label: `initial generation ${prompt.stem}`,
      body: {
        conversationId,
        messageId: userMessageId,
        model: config.model,
        newMessageId: assistantMessageId,
      },
    });

    let artifact = extractArtifact(finalMessage);
    let code = artifactCode(artifact);

    const loopResult = await driveAgenticLoop({
      config,
      auth,
      resultDir,
      conversationId,
      assistantMessageId: finalMessage?.id ?? assistantMessageId,
      initialMessage: finalMessage,
      initialCode: code,
      signal: controller.signal,
      row,
      prompt,
    });

    finalMessage = loopResult.finalMessage;
    artifact = extractArtifact(finalMessage) ?? artifact;
    code = loopResult.code || artifactCode(artifact);

    row.artifact = Boolean(code);
    row.parameterCount = countTopLevelParameters(code);
    row.codeLines = countCodeLines(code);
    await fs.writeFile(scadPath, code, 'utf8');

    if (!code) {
      row.notes.push('no artifact code returned');
    } else if (config.openscadPath) {
      const compileResult =
        loopResult.lastCompile ??
        (await compileScad(
          config.openscadPath,
          code,
          resultDir,
          prompt.stem,
          'final',
        ));
      row.compileOk = compileResult.ok ? 'yes' : 'no';
      if (!compileResult.ok) {
        row.notes.push(
          `compile failed: ${truncate(compileResult.stderr || compileResult.stdout || 'OpenSCAD failed')}`,
        );
      }

      const pngPath = path.join(resultDir, `${prompt.stem}.png`);
      const renderResult = await renderPng(
        config.openscadPath,
        scadPath,
        pngPath,
      );
      if (!renderResult.ok) {
        row.notes.push(
          `render failed: ${truncate(renderResult.stderr || renderResult.stdout || 'OpenSCAD render failed')}`,
        );
      }
    }
  } catch (error) {
    await fs.writeFile(scadPath, '', 'utf8').catch(() => {});
    row.notes.push(safeErrorMessage(error));
  } finally {
    clearTimeout(timeout);
    row.seconds = ((Date.now() - started) / 1000).toFixed(1);
  }

  return row;
}

async function main() {
  const config = readConfig();
  if (!config.ok) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date();
  const resultDir = path.join(resultsRoot, timestampForDirectory(startedAt));
  await fs.mkdir(resultDir, { recursive: true });

  let prompts = [];
  const rows = [];

  try {
    prompts = await loadPrompts(config);
  } catch (error) {
    rows.push({
      prompt: 'prompt-load',
      artifact: false,
      compileOk: 'n/a',
      repairsUsed: 0,
      parameterCount: 0,
      codeLines: 0,
      seconds: '0.0',
      notes: [safeErrorMessage(error)],
    });
    await writeSummary(resultDir, rows, startedAt);
    console.error(`Could not load prompts. Summary: ${resultDir}`);
    return;
  }

  if (prompts.length === 0) {
    rows.push({
      prompt: 'no-prompts',
      artifact: false,
      compileOk: 'n/a',
      repairsUsed: 0,
      parameterCount: 0,
      codeLines: 0,
      seconds: '0.0',
      notes: ['no prompt files matched BENCH_PROMPTS'],
    });
    await writeSummary(resultDir, rows, startedAt);
    console.log(`Summary: ${resultDir}`);
    return;
  }

  let auth;
  try {
    auth = await signIn(config);
  } catch (error) {
    for (const prompt of prompts) {
      const row = createSummaryRow(prompt);
      row.notes.push(`setup failed: ${safeErrorMessage(error)}`);
      rows.push(row);
      await fs
        .writeFile(path.join(resultDir, `${prompt.stem}.scad`), '', 'utf8')
        .catch(() => {});
    }
    await writeSummary(resultDir, rows, startedAt);
    console.error(
      `Setup failed before benchmark prompts ran. Summary: ${resultDir}`,
    );
    return;
  }

  for (let index = 0; index < prompts.length; index += 1) {
    const row = await runPrompt({
      config,
      auth,
      prompt: prompts[index],
      resultDir,
      index,
      total: prompts.length,
    });
    rows.push(row);
    await writeSummary(resultDir, rows, startedAt);
  }

  await writeSummary(resultDir, rows, startedAt);
  console.log(`Summary: ${resultDir}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `Benchmark runner failed before completion: ${safeErrorMessage(error)}`,
    );
    process.exitCode = 1;
  });
}
