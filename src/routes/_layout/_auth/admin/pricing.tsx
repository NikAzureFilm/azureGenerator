import { createFileRoute } from '@tanstack/react-router';
import { AdminPricingView } from '@/views/AdminPricingView';

export const Route = createFileRoute('/_layout/_auth/admin/pricing')({
  component: AdminPricingView,
});
