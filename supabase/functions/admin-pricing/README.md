# Admin pricing secrets

This function reads internal pricing from Supabase secrets so provider costs and
markup never ship in the frontend bundle.

Required secrets:

```bash
supabase secrets set ADMIN_EMAILS="you@example.com"
supabase secrets set ADMIN_PRICING_CONFIG_JSON='<private-json>'
```

`ADMIN_PRICING_CONFIG_JSON` must contain `tokenUsdValue`, `markupMultiplier`,
and `rows` keyed by the public feature ids in `shared/tokenCosts.ts`.
