// Minimal entry point for the teleproto bundle.
// Only export what Squire actually uses.
export { TelegramClient, Api, WebSocketTransport } from 'teleproto';
export { StringSession } from 'teleproto/sessions';
export { NewMessage, Raw } from 'teleproto/events';
