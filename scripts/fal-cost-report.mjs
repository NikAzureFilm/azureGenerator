import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FAL_UNIT_PRICES,
  geminiImageCostUsd,
  openaiImageCostUsd,
} from '../shared/providerPricing.ts';

export const TOKEN_INTERNAL_USD_COST = 0.01;
export const TOKEN_USD_VALUE = 0.03;

// Single source of truth for fal unit prices lives in shared/providerPricing.ts
// (also consumed by the edge functions to compute real provider cost). Derive
// the CLI's endpoint list and price map from it so the two never drift.
export const FAL_ENDPOINTS = Object.keys(FAL_UNIT_PRICES);

const DEFAULT_UNIT_PRICES = new Map(
  Object.entries(FAL_UNIT_PRICES).map(([endpointId, { unitPrice, unit }]) => [
    endpointId,
    {
      endpoint_id: endpointId,
      unit_price: unitPrice,
      unit,
      currency: 'USD',
    },
  ]),
);

const CONFIGURED_TOKENS = {
  chat: 10,
  promptGeneration: 10,
  parametric: 50,
  parametricCadReasoning: 120,
  generatedInputImage: 22,
  generatedInputImageNanoBanana: 7,
  multiviewFrontImage: 22,
  multiviewNanoBananaView: 7,
  fastMesh: 41,
  qualityMesh: 34,
  ultraMesh: 110,
  multiviewMesh: 61,
  upscaleMesh: 76,
};

const FEATURE_BREAKDOWNS = [
  {
    id: 'chat',
    label: 'Assistant message',
    components: [{ name: 'LLM chat budget', costUsd: 0.1 }],
  },
  {
    id: 'promptGeneration',
    label: 'Prompt helper',
    components: [{ name: 'Prompt generation budget', costUsd: 0.1 }],
  },
  {
    id: 'parametric',
    label: 'Parametric CAD generation',
    components: [{ name: 'CAD model budget', costUsd: 0.5 }],
  },
  {
    id: 'parametricCadReasoning',
    label: 'CAD Reasoning generation',
    components: [{ name: 'CAD reasoning model budget', costUsd: 1.2 }],
  },
  {
    id: 'generatedInputImage',
    label: 'Generated input image - Premium',
    components: [
      {
        name: 'gpt-image-2 low-quality generated view',
        costUsd: openaiImageCostUsd('low'),
      },
    ],
  },
  {
    id: 'generatedInputImageNanoBanana',
    label: 'Generated input image - Lite',
    components: [
      {
        name: 'Gemini 3.1 Flash Image 1K output',
        costUsd: geminiImageCostUsd('gemini-3.1-flash-image-preview'),
      },
    ],
  },
  {
    id: 'multiviewFrontImage',
    label: 'Multiview front image',
    components: [
      {
        name: 'gpt-image-2 low-quality front image',
        costUsd: openaiImageCostUsd('low'),
      },
    ],
  },
  {
    id: 'multiviewNanoBananaView',
    label: 'Additional multiview angle',
    components: [
      {
        name: 'Gemini 3.1 Flash Image side/back view',
        costUsd: geminiImageCostUsd('gemini-3.1-flash-image-preview'),
      },
    ],
  },
  {
    id: 'fastMesh',
    label: 'Textureless mesh',
    components: [
      {
        name: 'gpt-image-2 low-quality seed image',
        costUsd: openaiImageCostUsd('low'),
      },
      {
        name: 'Tripo v2.5 textureless image-to-3D',
        endpoint: 'tripo3d/tripo/v2.5/image-to-3d',
        fixedCostUsd: 0.2,
        note: 'fal gallery fixed textureless cost',
      },
      {
        name: 'Hunyuan mini preview',
        endpoint: 'fal-ai/hunyuan3d/v2/mini/turbo',
      },
    ],
  },
  {
    id: 'qualityMesh',
    label: 'Draft mesh',
    components: [
      {
        name: 'gpt-image-2 high-quality seed image',
        costUsd: openaiImageCostUsd('high'),
      },
      {
        name: 'Moondream caption',
        endpoint: 'fal-ai/moondream3-preview/caption',
        fixedCostUsd: 0.001351,
        note: 'recent historical per-call estimate; caption length varies',
      },
      {
        name: 'SAM-3 image masks, up to 2 attempts',
        endpoint: 'fal-ai/sam-3/image',
        unitQuantity: 2,
      },
      {
        name: 'SAM-3 3D objects',
        endpoint: 'fal-ai/sam-3/3d-objects',
      },
      {
        name: 'Hunyuan mini preview',
        endpoint: 'fal-ai/hunyuan3d/v2/mini/turbo',
      },
    ],
  },
  {
    id: 'ultraMesh',
    label: 'Max quality mesh',
    components: [
      {
        name: 'gpt-image-2 high-quality seed image',
        costUsd: openaiImageCostUsd('high'),
      },
      {
        name: 'Meshy 6 Preview image-to-3D generation',
        endpoint: 'fal-ai/meshy/v6-preview/image-to-3d',
        note: 'fal model page lists $0.80 per generation',
      },
      {
        name: 'Hunyuan mini preview',
        endpoint: 'fal-ai/hunyuan3d/v2/mini/turbo',
      },
    ],
  },
  {
    id: 'multiviewMesh',
    label: 'Multiview mesh',
    components: [
      {
        name: 'Hunyuan 3D v3.1 Pro multiview mesh',
        endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
        fixedCostUsd: 0.525,
        note: 'base Pro image-to-3D plus multiview input surcharge',
      },
      {
        name: 'Hunyuan mini preview',
        endpoint: 'fal-ai/hunyuan3d/v2/mini/turbo',
      },
    ],
  },
  {
    id: 'upscaleMesh',
    label: 'Upscale mesh',
    components: [
      {
        name: 'Hunyuan 3D v3.1 Pro with PBR and custom face count',
        endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
        unitQuantity: 45,
        note: 'base generation + PBR + custom face count',
      },
      {
        name: 'Hunyuan mini preview',
        endpoint: 'fal-ai/hunyuan3d/v2/mini/turbo',
      },
    ],
  },
];

export function tokensForCostUsd(costUsd) {
  return Math.max(0, Math.ceil(costUsd / TOKEN_INTERNAL_USD_COST - 1e-9));
}

function mergeUnitPrices(livePrices) {
  return new Map([...DEFAULT_UNIT_PRICES, ...livePrices]);
}

function resolveComponentCost(component, unitPrices) {
  if (typeof component.costUsd === 'number') {
    return { ...component, costUsd: component.costUsd, source: 'configured' };
  }

  if (typeof component.fixedCostUsd === 'number') {
    return {
      ...component,
      costUsd: component.fixedCostUsd,
      source: component.note ?? 'fixed model catalog cost',
    };
  }

  const price = unitPrices.get(component.endpoint);
  if (!price) {
    throw new Error(`Missing fal price for ${component.endpoint}`);
  }

  const unitQuantity = component.unitQuantity ?? 1;
  return {
    ...component,
    costUsd: price.unit_price * unitQuantity,
    source: `${unitQuantity} ${price.unit}`,
    unitPriceUsd: price.unit_price,
    unit: price.unit,
  };
}

export function buildFeatureCostRows(unitPrices = DEFAULT_UNIT_PRICES) {
  const prices = mergeUnitPrices(unitPrices);

  return FEATURE_BREAKDOWNS.map((feature) => {
    const components = feature.components.map((component) =>
      resolveComponentCost(component, prices),
    );
    const providerCostUsd = components.reduce(
      (total, component) => total + component.costUsd,
      0,
    );
    const suggestedTokens = tokensForCostUsd(providerCostUsd);
    const configuredTokens = CONFIGURED_TOKENS[feature.id];
    const customerRevenueUsd = configuredTokens * TOKEN_USD_VALUE;

    return {
      id: feature.id,
      label: feature.label,
      providerCostUsd,
      suggestedTokens,
      configuredTokens,
      customerRevenueUsd,
      grossMarginUsd: customerRevenueUsd - providerCostUsd,
      components,
    };
  });
}

function parseDotenvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadFalKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY.trim();

  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return '';

  const env = readFileSync(envPath, 'utf8');
  for (const line of env.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#') || !line.includes('=')) {
      continue;
    }
    const [name, ...valueParts] = line.split('=');
    if (name.trim() === 'FAL_KEY') {
      return parseDotenvValue(valueParts.join('='));
    }
  }
  return '';
}

async function fetchFalPricing(falKey) {
  const authorization = falKey.startsWith('Key ') ? falKey : `Key ${falKey}`;
  const url = new URL('https://api.fal.ai/v1/models/pricing');
  url.searchParams.set('endpoint_id', FAL_ENDPOINTS.join(','));

  const response = await fetch(url, {
    headers: { Authorization: authorization },
  });

  if (!response.ok) {
    throw new Error(`fal pricing request failed: ${response.status}`);
  }

  const data = await response.json();
  return new Map(data.prices.map((price) => [price.endpoint_id, price]));
}

function formatUsd(value) {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function printTable(rows, usedLivePricing) {
  console.log(
    `Token basis: internal ${formatUsd(TOKEN_INTERNAL_USD_COST)} -> customer ${formatUsd(TOKEN_USD_VALUE)} (${TOKEN_USD_VALUE / TOKEN_INTERNAL_USD_COST}x)`,
  );
  console.log(
    `fal prices: ${usedLivePricing ? 'live Platform Pricing API' : 'checked-in fallback prices'}\n`,
  );

  const tableRows = rows.map((row) => ({
    feature: row.id,
    cost: formatUsd(row.providerCostUsd),
    suggested: row.suggestedTokens,
    configured: row.configuredTokens,
    revenue: formatUsd(row.customerRevenueUsd),
    margin: formatUsd(row.grossMarginUsd),
  }));

  console.table(tableRows);
}

function printDetails(rows) {
  for (const row of rows) {
    console.log(`\n${row.label} (${row.id})`);
    for (const component of row.components) {
      const suffix = component.endpoint ? ` [${component.endpoint}]` : '';
      console.log(
        `  - ${component.name}${suffix}: ${formatUsd(component.costUsd)} (${component.source})`,
      );
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(
      [
        'Usage: npm run pricing:fal -- [--json] [--details] [--no-live]',
        '',
        'Reads FAL_KEY from the environment or .env and queries fal Platform Pricing.',
        'Falls back to checked-in prices when --no-live is supplied.',
      ].join('\n'),
    );
    return;
  }

  let usedLivePricing = false;
  let unitPrices = DEFAULT_UNIT_PRICES;

  if (!args.has('--no-live')) {
    const falKey = loadFalKey();
    if (falKey) {
      unitPrices = await fetchFalPricing(falKey);
      usedLivePricing = true;
    }
  }

  const rows = buildFeatureCostRows(unitPrices);

  if (args.has('--json')) {
    console.log(
      JSON.stringify(
        {
          tokenInternalUsdCost: TOKEN_INTERNAL_USD_COST,
          tokenUsdValue: TOKEN_USD_VALUE,
          usedLivePricing,
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTable(rows, usedLivePricing);
  if (args.has('--details')) {
    printDetails(rows);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
