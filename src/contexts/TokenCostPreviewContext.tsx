import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type TokenCostPreview = {
  /** Estimated cost of the submission the user is about to make. 0 = idle. */
  pendingCost: number;
  setPendingCost: (n: number) => void;
  clearPendingCost: () => void;
};

// Default value is a working no-op fallback so `useTokenCostPreview()` is safe
// to call outside a provider (tests / storybook won't crash).
const FALLBACK: TokenCostPreview = {
  pendingCost: 0,
  setPendingCost: () => {},
  clearPendingCost: () => {},
};

const TokenCostPreviewContext = createContext<TokenCostPreview>(FALLBACK);

export function TokenCostPreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [pendingCost, setPendingCostState] = useState(0);

  const setPendingCost = useCallback((n: number) => {
    setPendingCostState(Math.max(0, Math.round(n)));
  }, []);

  const clearPendingCost = useCallback(() => {
    setPendingCostState(0);
  }, []);

  const value = useMemo<TokenCostPreview>(
    () => ({ pendingCost, setPendingCost, clearPendingCost }),
    [pendingCost, setPendingCost, clearPendingCost],
  );

  return (
    <TokenCostPreviewContext.Provider value={value}>
      {children}
    </TokenCostPreviewContext.Provider>
  );
}

export function useTokenCostPreview(): TokenCostPreview {
  return useContext(TokenCostPreviewContext);
}
