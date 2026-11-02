# Codex Pane Remote

English | [简体中文](README.zh-CN.md)

Codex Pane remote access connects desktop and phone through a self-hosted relay. The relay serves the web bootstrap and forwards encrypted messages without storing accounts or business messages. The desktop delivers its matching mobile interface.

## Deploy the relay

Requires Docker Compose and an HTTPS domain. Run `npm run package:relay` from the repository root, upload `release/relay-deploy`, and follow the [deployment guide](relay/deploy/README.md). For source deployment, the same guide applies to the repository's `remote/relay` directory.

After deployment, follow the [desktop remote-access steps](../README.md#remote-access) to enable access and pair the phone. Keep the desktop app running during remote use.

## Devices and data

Revoke phones individually in desktop settings; a revoked phone must pair again. **Sign out all phones** clears login sessions only, so registered devices can sign in again with their Passkeys.

Desktop and phone reconnect after a relay restart. Docker volumes store only Caddy certificates and configuration; there is no business database to back up. The relay sees IP addresses, connection timing, and frame sizes. Messages are end-to-end encrypted, but a compromised relay could replace the web bootstrap, so its deployment environment must still be trusted.

## Updates

The mobile business interface updates with the desktop and normally needs no relay update. Redeploy the relay for its own security fixes, infrastructure changes, or outer-protocol updates.

## Local development

Use Node.js 24 or later. Install repository-root dependencies with `npm install`, then install and use `npm run dev`, `npm test`, and `npm run build` separately in `relay` and `mobile`. Set `PUBLIC_ORIGIN` before starting the relay, for example `http://localhost:3000` with the default port. Set `PORT` too if you change that port.

WebAuthn requires a secure context. Use the production HTTPS deployment for phone testing; localhost is suitable only when the browser treats it as a trusted local origin.
