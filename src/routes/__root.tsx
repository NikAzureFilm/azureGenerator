import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router';
import App from '@/App';
import { BRAND_NAME } from '@/config/brand';
import '@/index.css';

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: ({ error }) => (
    <RootDocument>
      <App error={error} />
    </RootDocument>
  ),
});

function RootComponent() {
  return (
    <RootDocument>
      <App />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>{BRAND_NAME}</title>
        <meta
          name="description"
          content="Generate CAD and mesh models from natural language with AzureFilm Generator."
        />
        <meta name="theme-color" content="#080b0f" />
        <link rel="icon" type="image/png" href="/azurefilm-a-favicon.png" />
        <link rel="apple-touch-icon" href="/azurefilm-a-favicon.png" />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
