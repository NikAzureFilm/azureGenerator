import { Subscriptions } from '@/components/Subscriptions';
import { TrialDialog } from '@/components/auth/TrialDialog';
import { useLocation } from '@tanstack/react-router';
import { useState } from 'react';

export function SubscriptionView() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.searchStr);
  const isTrial = searchParams.has('trial');
  const [open, setOpen] = useState(isTrial);
  return (
    <>
      <TrialDialog open={open} onOpenChange={setOpen} />
      <Subscriptions />
    </>
  );
}
