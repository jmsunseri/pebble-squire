# Squire (formerly Bobby Assistant)

Squire is an AI assistant that runs on your Pebble smartwatch, connecting to a [Hermes](https://github.com/nousresearch/hermes-agent) or [OpenClaw](https://github.com/openclaw/openclaw) backend via Telegram.

## Prerequisites

Squire requires a **Telegram bot** connected to a running instance of **Hermes** or **OpenClaw**. Without one of these backends, Squire will not function.

### Setting up a Telegram Bot

1. Open a conversation with [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot API token — you'll need it for your backend configuration
4. Note your bot username (e.g., `@MySquireBot`)

### Setting up Hermes or OpenClaw

1. Install [Hermes](https://github.com/nousresearch/hermes-agent) or [OpenClaw](https://github.com/openclaw/openclaw) on a server or locally
2. Configure it with your Telegram bot token from BotFather
3. Make sure the backend is running and accessible

## Architecture

The phone app communicates directly with Telegram using MTProto, sending messages to your Hermes or OpenClaw bot instance. Since Squire just acts as a frontend for your agent, the potential features are limitless — anything you can configure your agent to do on your behalf works the same way on your watch.

**Flow:**
```
Watch App → Phone App (pkjs) → Telegram MTProto → Hermes/OpenClaw Bot
```

## Setup

### 1. Building the App

1. Install the [Pebble SDK](https://developer.rebble.io/developer.pebble.com/sdk/index.html)
2. Clone this repository
3. Build: `pebble build`
4. Install: `pebble install`

The build writes `build/pebble-js-app.js.map` so `pebble logs` can map phone log
lines back to source, but leaves it out of the packaged `.pbw`. The SDK would
otherwise ship the map, which is larger than the app's JavaScript and counts
against the appstore's 4.4 MB limit. See `wscript`.

### 2. Configuration

1. Open the application settings on your phone (or run `./open-clay-config.py` in the emulator)
2. Enter your Hermes or OpenClaw bot username (e.g., `@MySquireBot`) and press Save
3. Launch Squire on the watch — it will prompt you to sign in to Telegram directly from the watch:
   - Enter your phone number in international format (e.g., `+1234567890`)
   - A verification code is sent to your Telegram app; enter it on the watch when prompted
   - If your account has 2FA enabled, you'll also be asked for your password
4. Use the **Disconnect** button in the phone settings to sign out of Telegram

### 3. Telegram API Credentials

Squire talks to Telegram directly over MTProto, so it needs a Telegram API ID
and API hash.

These are read from the `TELEGRAM_APP_ID` and `TELEGRAM_APP_HASH` environment
variables when PebbleKit JS is built (see `src/pkjs/telegram/auth.js` and
`src/pkjs/telegram/client.js`). The values are inlined into the built bundle;
they are not stored in this repository.

- **Release builds** are built in CloudPebble. Both variables must be set in
  CloudPebble's PebbleKit JS environment variables. CloudPebble applies them
  during the build, before the app is deployed to the store.
- **Local builds** do not read `.env` and do not inject these variables by
  default (`pebble build` with SDK 4.9.x). The `.env` file in this repository is
  only used by the test suite. A local build is fine for UI and compile checks,
  but Telegram sign-in will fail unless your local build step substitutes the
  values.
- **CI** (`.github/workflows/build-pbw.yaml`) builds the app for compile
  verification only. It does not have the store credentials, so its artifact is
  not suitable for testing Telegram sign-in.

If either variable is missing, the app still builds, but every Telegram sign-in
fails at runtime with a generic "Auth Failed" message.

Create your own credentials at [my.telegram.org](https://my.telegram.org) (API
development tools). Never commit real credentials.

## Development

### Project Structure

```
src/
├── c/                 # Watch app C code
├── pkjs/              # Phone app JavaScript
│   ├── telegram/      # Telegram MTProto client
│   └── session.js     # Main session management
resources/             # Watch app resources (icons, images, etc.)
package.json           # Pebble app configuration
```

### Key Files

- `src/pkjs/telegram/` - teleproto-based Telegram client
- `src/pkjs/session.js` - Session management and backend communication
- `src/pkjs/config.json` - Settings UI configuration

## Security Considerations

- Telegram session is stored in localStorage (consider encryption for production)
- Phone numbers are used only during authentication, not stored

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for details.

## License

Apache 2.0; see [`LICENSE`](LICENSE) for details.

## Disclaimer

This project is not an official Google project. It is not supported by
Google and Google specifically disclaims all warranties as to its quality,
merchantability, or fitness for a particular purpose.