import { getLevel, useAuth } from '@/contexts/AuthContext';
import { Link } from '@tanstack/react-router';

export function LowPromptsWarningMessage({
  tokensRemaining,
}: {
  tokensRemaining: number;
  layout?: 'inline' | 'stacked';
}) {
  return (
    <div className="p-3 text-center text-sm text-adam-text-secondary">
      <LowTokensWarningContent tokensRemaining={tokensRemaining} />
    </div>
  );
}

function LowTokensWarningContent({
  tokensRemaining,
}: {
  tokensRemaining: number;
}) {
  const { billing } = useAuth();
  const level = getLevel(billing);

  const tokensText = `You have ${tokensRemaining} token${tokensRemaining === 1 ? '' : 's'} remaining`;

  if (level === 'free') {
    return (
      <span>
        {tokensText}.{' '}
        <Link to="/subscription" className="text-adam-blue hover:underline">
          Upgrade
        </Link>{' '}
        for more tokens.
      </span>
    );
  }

  // Paid tier
  return (
    <span>
      {tokensText}.{' '}
      <Link to="/settings" className="text-adam-blue hover:underline">
        Buy more tokens
      </Link>{' '}
      or{' '}
      <Link to="/subscription" className="text-adam-blue hover:underline">
        upgrade
      </Link>
      .
    </span>
  );
}
