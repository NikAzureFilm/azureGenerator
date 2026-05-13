import { createFileRoute } from '@tanstack/react-router';
import { PricingView } from '@/views/PricingView';

export const Route = createFileRoute('/_layout/pricing')({
  component: PricingView,
});
