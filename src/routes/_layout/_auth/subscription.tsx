import { createFileRoute } from '@tanstack/react-router';
import { SubscriptionView } from '@/views/SubscriptionView';

export const Route = createFileRoute('/_layout/_auth/subscription')({
  component: SubscriptionView,
});
