import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import { getFallbackTokenPackProducts } from '@/hooks/billingProductFallbacks';
import type { BillingProduct } from '@/hooks/useBillingProducts';

export function useTokenPacks() {
  return useQuery<BillingProduct[]>({
    queryKey: ['billing', 'products', 'pack'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        'billing-products?type=pack',
        { method: 'GET' },
      );
      if (error) return getFallbackTokenPackProducts();
      const products = (data as BillingProduct[]) ?? [];
      const visibleProducts =
        products.length > 0 ? products : getFallbackTokenPackProducts();
      return [...visibleProducts].sort((a, b) => a.tokenAmount - b.tokenAmount);
    },
  });
}
