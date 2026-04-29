-- Align legacy operation defaults with the 3x markup pricing model.
--
-- Edge functions now pass exact per-feature token costs directly. These values
-- keep the SQL fallback operation table aligned for older callers and admin
-- visibility.

INSERT INTO public.token_costs (operation, cost)
VALUES
  ('mesh', 41),
  ('parametric', 35),
  ('chat', 10)
ON CONFLICT (operation) DO UPDATE
SET cost = EXCLUDED.cost,
    updated_at = now();
