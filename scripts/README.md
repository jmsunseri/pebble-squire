# Telegram Bundle Build Scripts

This directory builds the [teleproto](https://github.com/sanyok12345/teleproto)
bundle used by PebbleKit JS.

## Rebuilding the Bundle

```bash
cd scripts
npm install
npm run build:telegram
```

This regenerates `src/pkjs/lib/telegram-bundle.js`.

## How It Works

`build-telegram-bundle.js` uses esbuild to bundle `telegram-entry.js` with:

- `platform: "browser"`, so teleproto resolves its browser implementations
  through the `#platform/*` conditional imports in its package.json
- `format: "cjs"`, because `src/pkjs/lib/bundle_loader.js` loads the bundle
  with `require()`
- `target: "es2017"` and minification

The output exports:

- `TelegramClient`
- `StringSession`
- `Api`
- `NewMessage`
- `Raw`
- `WebSocketTransport`

`bundle_loader.js` installs these as globals for `src/pkjs/telegram/*` and
`src/pkjs/session.js`.

## Why Browser?

The browser build uses `WebSocketTransport` (Telegram's `/apiws` endpoint)
instead of raw TCP, which PebbleKit JS cannot open. It also avoids Node-only
modules such as `fs`, `net` and `node-localstorage`.

## Rebuilding from a Local Checkout

If `npm install` is not available, extract the `teleproto` and `cifrante`
tarballs into `scripts/node_modules`, then run:

```bash
node scripts/build-telegram-bundle.js
```
