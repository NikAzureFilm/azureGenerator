# Benchmarks

This directory contains a repeatable prompt set for checking text-to-CAD quality against the production parametric pipeline. The runner creates conversations, sends each prompt through `parametric-chat`, saves the returned OpenSCAD, and writes a summary table.

## Run

```sh
BENCH_SUPABASE_URL="https://<project>.supabase.co" \
BENCH_ANON_KEY="<anon key>" \
BENCH_EMAIL="<benchmark user email>" \
BENCH_PASSWORD="<benchmark user password>" \
npm run benchmarks
```

Required environment variables:

- `BENCH_SUPABASE_URL`
- `BENCH_ANON_KEY`
- `BENCH_EMAIL`
- `BENCH_PASSWORD`

Optional environment variables:

- `BENCH_MODEL`, defaults to `anthropic/claude-fable-5`
- `OPENSCAD_PATH`, path to the OpenSCAD CLI for compile checks and PNG rendering
- `BENCH_PROMPTS`, comma-separated filename-stem filters such as `01-twisted,06-mug`

Results are written to `benchmarks/results/<yyyymmdd-HHMMSS>/`.

## Cost Warning

Each full run calls the production Supabase project and spends real model tokens. Do not run this from CI or casual local checks.

## Limitations

The runner can drive compile-error repair rounds when `OPENSCAD_PATH` is set. Visual inspection rounds require a browser-rendered inspection sheet, so the headless runner records those cases as `needs-browser`.
