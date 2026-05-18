import { createFileRoute } from '@tanstack/react-router';
import { SignUpEmailView } from '@/views/SignUpEmailView';

export const Route = createFileRoute('/signup-email')({
  component: SignUpEmailView,
});
