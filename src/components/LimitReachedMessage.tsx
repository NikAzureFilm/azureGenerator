import { getLevel, useAuth } from '@/contexts/AuthContext';
import { Link } from '@tanstack/react-router';

export function LimitReachedMessage() {
  return (
    <div className="p-3 text-center text-sm text-adam-text-secondary">
      <LimitReachedSpan />
    </div>
  );
}

function LimitReachedSpan() {
  const { billing } = useAuth();
  const level = getLevel(billing);

  if (level === 'free') {
    return (
      <span>
        You've used all your tokens.{' '}
        <Link to="/subscription" className="text-adam-blue hover:underline">
          Upgrade
        </Link>{' '}
        for more tokens, or{' '}
        <Link to="/settings" className="text-adam-blue hover:underline">
          buy a token pack
        </Link>
        .
      </span>
    );
  }

  // Standard or Pro tier
  return (
    <span>
      You've used all your tokens for this period.{' '}
      <Link to="/settings" className="text-adam-blue hover:underline">
        Buy more tokens
      </Link>{' '}
      or{' '}
      <Link to="/subscription" className="text-adam-blue hover:underline">
        upgrade your plan
      </Link>
      .
    </span>
  );
}
