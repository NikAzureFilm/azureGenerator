import { createFileRoute } from '@tanstack/react-router';
import { SignInView } from '@/views/SignInView';

export const Route = createFileRoute('/signin')({
  component: SignInView,
});
