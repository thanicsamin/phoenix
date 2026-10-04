# Phoenix

A small, always-on personal agent. Pi runs the agent; Nix supplies the runtime.
One container, one shareable setup file. Use it from your browser, on your
computer or a VPS.

```sh
git clone https://github.com/thanicsamin/phoenix.git
cd phoenix
docker compose up --build
```

The logs print your link and password. Sign in and add an API key in Settings.
OpenCode Go/Zen, OpenRouter and other Pi providers are supported.

- Separate chats, scheduled jobs and incoming email.
- Browser automation with one-button owner control.
- Files, memory, attachments, Markdown and math.
- Extensions and editable UI/runtime with generation rollback.
- Export and import your setup as a file.

[Documentation](docs/README.md) · [Oracle VPS setup](docs/README.md#oracle-always-free-target) · [Development](docs/README.md#nix-and-development)

[MIT licensed](LICENSE). Bundled dependencies retain their own licenses.
