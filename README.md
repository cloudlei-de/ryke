# Ryke

A Git platform built for agents, on Cloudflare Workers and Artifacts.
Entry for the [Cloudflare next-Git-platform challenge](docs/challenge.md).

## Run

```sh
mise install
npm ci
npm run dev
```

`npm test` runs the Worker tests in the Workers runtime, `npm run deploy` deploys to your
Cloudflare account (Workers Paid plan, Artifacts beta enabled).

## License

MIT
