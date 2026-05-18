import { createFileRoute } from '@tanstack/react-router';
import { SignUpView } from '@/views/SignUpView';

export const Route = createFileRoute('/signup')({
  component: SignUpView,
});
