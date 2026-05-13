# Security Notes

- Do not commit plaintext `.env` or `.env.key` files.
- Store real SMTP credentials in `.env.enc` with `npm run env:encrypt`.
- Keep `HOST=127.0.0.1` unless you intentionally need network access.
- If the server is exposed beyond localhost, set `CONTROL_TOKEN` and use HTTPS/WSS behind a trusted reverse proxy.
- If `.env` was previously pushed with real credentials, rotate the SMTP/app password.
