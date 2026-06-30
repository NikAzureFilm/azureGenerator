INSERT INTO public.token_costs (operation, cost)
VALUES ('parametric', 25)
ON CONFLICT (operation)
DO UPDATE SET
  cost = EXCLUDED.cost,
  updated_at = now();
