import * as Sentry from '@sentry/react';
import { Await, RouterProvider } from '@tanstack/react-router';
import { hydrate } from '@tanstack/react-router/ssr/client';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';

import { getRouter } from './router';
import { normalizeViteEnv } from './lib/viteEnv';

function getSentryTracesSampleRate() {
  const configuredRate = import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE;

  if (configuredRate !== undefined && configuredRate !== '') {
    const parsedRate = Number(configuredRate);
    if (Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 1) {
      return parsedRate;
    }
  }

  return import.meta.env.PROD ? 0.1 : 1.0;
}

const router = getRouter();
let hydrationPromise: Promise<typeof router> | undefined;

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN ?? '',
  environment:
    normalizeViteEnv(import.meta.env.VITE_SENTRY_ENVIRONMENT) ?? 'local',
  integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],
  tracesSampleRate: getSentryTracesSampleRate(),
});

function renderStaticShellClient() {
  hydrationPromise ??= hydrateStaticShellRouter();

  return (
    <Await
      promise={hydrationPromise}
      children={(hydratedRouter) => <RouterProvider router={hydratedRouter} />}
    />
  );
}

async function hydrateStaticShellRouter() {
  const serializationAdapters = router.options.serializationAdapters ?? [];
  const startWindow = window as typeof window & {
    __TSS_START_OPTIONS__?: {
      serializationAdapters: typeof serializationAdapters;
    };
  };

  startWindow.__TSS_START_OPTIONS__ = { serializationAdapters };

  const routerOptions = {
    basepath: import.meta.env.TSS_ROUTER_BASEPATH,
    serializationAdapters,
  } as unknown as Parameters<typeof router.update>[0];

  router.update(routerOptions);

  if (window.$_TSR?.router) {
    await hydrate(router);
  } else {
    await router.load();
  }

  return router;
}

startTransition(() => {
  hydrateRoot(document, <StrictMode>{renderStaticShellClient()}</StrictMode>);
});
