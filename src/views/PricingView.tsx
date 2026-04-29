import { Link } from 'react-router-dom';
import { ArrowRight, CircleDollarSign } from 'lucide-react';
import { FEATURE_COSTS, formatTokenCost } from '@shared/tokenCosts';
import { Button } from '@/components/ui/button';

const FEATURE_ROWS = [
  {
    group: 'Core',
    rows: [FEATURE_COSTS.chat, FEATURE_COSTS.parametric],
  },
  {
    group: 'Image inputs',
    rows: [
      FEATURE_COSTS.generatedInputImage,
      FEATURE_COSTS.generatedInputImageNanoBanana,
      FEATURE_COSTS.multiviewFrontImage,
      FEATURE_COSTS.multiviewNanoBananaView,
    ],
  },
  {
    group: '3D generation',
    rows: [
      FEATURE_COSTS.fastMesh,
      FEATURE_COSTS.qualityMesh,
      FEATURE_COSTS.ultraMesh,
      FEATURE_COSTS.multiviewMesh,
      FEATURE_COSTS.upscaleMesh,
    ],
  },
];

export function PricingView() {
  return (
    <main className="min-h-full overflow-auto bg-adam-bg-dark text-adam-text-primary">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 md:px-8">
        <section className="flex flex-col gap-5 border-b border-adam-neutral-800 pb-8 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-adam-neutral-700 bg-adam-neutral-900 text-adam-blue">
              <CircleDollarSign className="h-5 w-5" />
            </div>
            <h1 className="font-kumbh-sans text-3xl font-light text-white md:text-4xl">
              Pricing
            </h1>
            <p className="mt-3 text-sm leading-6 text-adam-text-secondary">
              CADAM uses tokens for image generation, CAD generation, and 3D
              mesh creation. The table below shows the token cost before you run
              each workflow.
            </p>
          </div>
          <Button asChild className="w-fit rounded-lg">
            <Link to="/subscription">
              Buy tokens
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </section>

        <section className="flex flex-col gap-6">
          {FEATURE_ROWS.map((group) => (
            <div key={group.group} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium uppercase tracking-normal text-adam-text-secondary">
                {group.group}
              </h2>
              <div className="overflow-hidden rounded-lg border border-adam-neutral-800 bg-adam-neutral-950">
                {group.rows.map((row, index) => (
                  <div
                    key={`${group.group}-${row.id}-${index}`}
                    className="grid gap-3 border-adam-neutral-800 p-4 text-sm md:grid-cols-[1fr_auto] md:items-center"
                    style={{
                      borderTopWidth: index === 0 ? 0 : 1,
                    }}
                  >
                    <div>
                      <div className="font-medium text-white">{row.label}</div>
                      <p className="mt-1 text-xs leading-5 text-adam-text-secondary">
                        {row.description}
                      </p>
                    </div>
                    <div className="font-medium text-adam-blue">
                      {formatTokenCost(row.tokens)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
