# Phoenix

A small, always-on personal agent. One container, one shareable setup file.
Pi runs the agent; Nix supplies its runtime. Use it from your browser, on your
computer or a VPS.

## Start

Install Docker with Compose, then run from this checkout:

```sh
git clone https://github.com/thanicsamin/phoenix.git
cd phoenix
docker compose up --build
```

The logs print a browser link and a generated password on first launch. Sign in
and add your OpenCode key in Settings. No provider key is included. For a
background service, add `-d`; retrieve the link with `docker compose logs phoenix`.
The first build downloads Chromium and its Nix dependencies. A published Docker
image is not available yet.

The default is OpenCode Go / Space Bunny Free while its free preview is available.
Pick a model and thinking level below the message box. Each chat remembers its
own choices, including for its scheduled jobs. Both OpenCode Go and Zen are
supported; no other model providers are enabled.
Every model request identifies Phoenix and sends `x-opencode-session` with the
conversation's persisted Pi ID, including compaction, retries and model changes.

## Share your setup

**Export setup** downloads instructions, personality files, the workspace flake,
extension declarations, chat models and
active scheduled jobs. **Import setup** validates and applies that file, then
reloads Phoenix. Sign in again after importing.

Imports keep existing conversations, browser profiles and credentials. Chat
and job templates match by chat name; imported jobs replace jobs in matching
chats. Other chats remain. The browser port must match your installation.
Imported configuration lives in `/data/setup.json`; remove it to return to the
mounted `agent.json`.

Exports exclude API keys, passwords, chat history, browser cookies, personal
memory, channel-linked chats and permission grants. Instructions and job prompts
are shared, so keep secrets out of them.

## Chats and background work

Main chat and side chats have separate Pi sessions, histories, browser profiles,
model choices and jobs. They share a persistent workspace. **Files** lets you
read, edit, preview and download its contents: `AGENTS.md` (system prompt),
`SOUL.md` (personality), `IDENTITY.md`, `TOOLS.md`, `USER.md`, `MEMORY.md` and
`memory/YYYY-MM-DD.md`. Instructions are reread for each turn; today and yesterday's
notes and curated memory are included for owner conversations and scheduled tasks.
Personal notes are excluded from automatic inbox and channel prompts.
This follows the documented [OpenClaw workspace](https://docs.openclaw.ai/concepts/agent-workspace)
and [Muse file/memory behavior](https://introducing.muse.ai/), using plain files.
Private owner profiles, memory, daily notes and attachments are excluded from setup exports.
Jobs run without an open browser and return results to their owning chat.
Choose a one-time run or an hourly, daily or weekly interval. Interrupted jobs
are reported after restart rather than silently replayed.

Incoming email wakes an Inbox chat. Its content is treated as untrusted data;
external actions and privileged email-triggered tools require approval in the
browser. Sending mail is separate from receiving it.

At most three Pi sessions stay loaded, including main chat. Idle side chats
unload after five minutes and reopen from their session files. Browsers close
after three idle minutes; cookies remain on disk. Background jobs wait on disk
when two scheduled jobs are already running. `/data`, `/nix/store` and
`/nix/var/nix` are disk-backed volumes. Only disposable `/tmp` uses tmpfs.

Live updates use an authenticated WebSocket with polling as a reconnect
fallback. No frontend framework or build step is required.

Chat messages render Markdown, including tables and code blocks, and LaTeX math
with `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. Rendering and fonts are served locally.
Raw HTML is escaped; remote images are shown as links. This renders equations,
rather than compiling full `.tex` documents. PDF command-line tools are included.

Use **＋** to attach up to eight files, 20 MB each. Images go directly to models
that accept images (20 MB total per message); other files are available to the agent in `uploads/`.
The agent can share generated files with `attach_file`; both sides get download
links. Attachments and downloads require your login and stay in their chat.
**Steer** injects a correction into a running Pi turn without cancelling it.

Voice uses browser dictation and read-aloud buttons. Dictation requires a browser
with Web Speech recognition and microphone access, usually over HTTPS or
localhost. Some browsers send recognition audio to their own speech service;
Phoenix does not receive or store that audio. Unsupported browsers hide the
microphone. Read-aloud uses the browser's available voices.

## Extensions

Bundled capabilities are native Pi extensions in `extensions/`. Enable optional
connectors in `agent.json`; use environment variables for credentials. Copy
`.env.example` to `.env` for Docker Compose. Every secret also accepts a `_FILE`
variable pointing to a mounted private file.

Example email configuration, inside `extensions`:

```json
"email": {
  "address": "agent@example.com",
  "imap": { "host": "imap.example.com", "port": 993 },
  "smtp": { "host": "smtp.example.com", "port": 465 },
  "passwordEnv": "EMAIL_PASSWORD",
  "allowSenders": [],
  "pollSeconds": 60
}
```

Use the mailbox's app password. IMAP requires TLS; SMTP uses TLS on port 465 or
STARTTLS on 587. An empty `allowSenders` accepts all incoming senders; a populated
list restricts incoming senders and outgoing recipients. Existing messages are
available to the read tool; first startup watches new arrivals. Incoming mail is
queued on disk before dispatch. A crash during processing may cause a retry.
OAuth mailbox authentication is not implemented.

Messaging extensions accept allowlisted direct messages:

```json
"telegram": { "allowUsers": ["123456789"] },
"slack": { "allowUsers": ["U123456789"] },
"discord": { "allowUsers": ["123456789012345678"] }
```

Set `TELEGRAM_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`, or
`DISCORD_BOT_TOKEN` respectively. Telegram uses long polling, so remove any bot
webhook; initial backlog is skipped. Slack needs Socket Mode, the `message.im`
event and scopes `app_mentions:read`, `im:history`, `im:read`, `im:write`, and
`chat:write` as appropriate to your Slack app. Discord handles DMs; it does not
join or read guild conversations. Replies stay in the corresponding channel's
chat. Outbound tools enforce the same recipient allowlists.

Add your own native Pi extensions and skills declaratively:

```json
"pi": {
  "extensions": ["/data/extensions/my-extension.js"],
  "skills": ["/data/skills"]
}
```

Pi package references such as `npm:` and `git:` are supported for extensions.
The `pi` CLI is available to the agent for installing, listing and removing
packages. Declare enabled sources in `pi.extensions` in your Phoenix setup;
CLI installs alone do not enable undeclared extensions. Removing that declaration
and reloading disables the extension. Pin npm versions or Git commits when sharing.
Pin versions for reproducibility. Extensions execute code with the agent's
permissions; import setups from people you trust. Extra tools must be present
in the runtime or added to its Nix package list.

## Browser links

Local Docker use opens `http://localhost:8080`. VPS use defaults to direct HTTPS
on **24843**, without a Cloudflare account or a domain. Set
`PHOENIX_PUBLIC_IP=YOUR_PUBLIC_IPV4` in `.env`. Oracle's Compose override enables
the HTTPS proxy automatically; on other VPS hosts also set `COMPOSE_PROFILES=public`.
Change `PHOENIX_HTTPS_PORT` in `.env` if that port is already in use.

Open TCP port **24843** in the VPS firewall and cloud network rules, plus **80**
for certificate validation. The application is served only through HTTPS; port
80 returns 404 except for certificate challenges. Caddy automatically obtains
and renews a trusted, short-lived IP certificate, storing it on disk. The small
proxy has a 128 MB memory cap; Phoenix keeps its 2 GB cap. Oracle does not publish
the agent's private HTTP port at all.

If you already use port 80 for another site, route Phoenix through your existing
HTTPS proxy instead. Set `web.url` to that proxy's HTTPS origin (including any
custom port); this preserves the HTTP and WebSocket origin checks. Do not publish
the application's unencrypted port publicly.

Cloudflare is optional. Add `"tunnel": { "mode": "quick" }` to `agent.json` for a
random HTTPS link that changes on restart. For a stable domain, use a named tunnel,
set `CLOUDFLARE_TUNNEL_TOKEN`, and declare:

```json
"tunnel": { "mode": "named", "url": "https://agent.example.com" }
```

Choose either direct HTTPS or a tunnel. For a tunnel, leave `PHOENIX_PUBLIC_IP`
unset and do not enable the public proxy.
[Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Browser automation uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
with persistent, headed Chromium on a virtual display. This addresses known
automation detection signals without maintaining a collection of fingerprint
spoofs. For local development install Xvfb, use an existing DISPLAY, or set
`"browser": { "headless": true }`. Website verification can still depend on the
VPS IP and site policy. The agent may try three CAPTCHA browser interactions per site. If still blocked,
it keeps the page open and asks you to approve another batch, take control or
stop. Press-and-hold checks support a bounded hold duration; successful
verification is not guaranteed.

Open **Browser** in a chat to take control of its Chromium browser. Click or tap
the live page, type normally on desktop, or use the keyboard field and Tab/Enter
buttons on mobile. You can navigate, scroll, sign in and complete website MFA
yourself. **Return to agent** hands back the same authenticated browser and
resumes an interrupted task. Queued messages and jobs wait while you control it.
Closing the view or losing connectivity leaves the agent paused; reopen Browser
to reconnect. An absent viewer releases Chromium RAM after three minutes while
retaining cookies, including session cookies in a private file. The live view uses the existing authenticated connection;
it requires HTTPS for remote access and adds no public port or VNC service.

Human keyboard input and frames bypass model requests, tool messages, chat
history and Phoenix logs. Website passwords are not saved by Chromium's
password manager. Password and standard one-time-code fields are cleared at
handback. Cookies still grant account access and remain accessible to the
privileged agent; this is not isolation from its root tools or a compromised
VPS. Hardware/platform passkeys, OS file-picker windows and other native browser
dialogs are not available through the page view. Browser state stays out of
setup exports; protect the persistent data volume and its backups.

## Credentials

Set `OPENCODE_API_KEY` in the environment or enter it in Settings. Environment
keys take precedence on restart. Set `PHOENIX_PASSWORD` (12+ characters) to choose
or reset the browser password; otherwise a strong password is generated once.
Passwords are hashed; sessions use HttpOnly cookies and writes require CSRF
protection. WebSocket upgrades check the session, origin and host.

API keys and browser cookies are stored unencrypted with private filesystem
permissions. The agent's tools can access its own credentials. This first
implementation is a prototype; use a dedicated test key.

## Nix and development

```sh
nix develop
npm ci --ignore-scripts
npm start
npm test
npm run check
```

Node 24 is pinned in the Nix runtime; local development requires Node 22.19+.
Use `nix run .#default` for the packaged service. `nix/runtime.nix` defines its
system tools, browser and fonts. The Docker image contains the Nix closure and
runs as root **inside the container**, with a read-only base filesystem and
writable persistent data, Nix store and Nix state volumes. Compose caps the whole
container at 2 GiB with no extra swap; set `PHOENIX_MEMORY_LIMIT` to change it.
Chromium uses a 128 MiB JavaScript heap budget and a two-renderer process target;
the container limit is the hard boundary for all Chromium processes combined.
Node has a 256 MiB old-space limit. Large source builds may need a higher container
limit; cached Nix packages avoid most compilation. `/usr/bin/env` is supplied for
npm CLI shebangs. It does not receive
the host Docker socket or privileged mode.

The editable source is copied once into `/data/workspace/phoenix`; edits survive
reloads and container replacement. **Files** exposes this source. Ask the agent
to modify itself, check the result, and use `reload_agent` (or **Reload agent** in
Files). It checks JavaScript syntax, snapshots code and dependencies in the Nix
store, and atomically switches a dedicated agent profile to the new generation.
**Files → History → Agent** lists prior versions and can restore them; the agent has
`rollback_agent` too. A failed startup automatically returns to the last working
generation and leaves the edited source available for repair. Code rollbacks
keep your chats, memory, credentials and separate tool profile. Reloading requires signing in again. Container rebuilds preserve this
customized copy; to reset the app, stop Phoenix and remove only
`/data/workspace/phoenix` and the `agent-profile*` links in `/data`, then restart. Your conversations and workspace remain.

UI changes have their own small Nix profile. Edit `phoenix/web` through Files or
ask the agent, then use **Apply UI** or `reload_ui`. The interface refreshes while
chats keep running; unsent messages and attachments survive the refresh. Open
dialogs defer it until closed. **Files → History → Interface** and `rollback_ui`
restore the live interface and editable web source together. A full agent
reload restores its matching UI; ordinary restarts retain your UI generation.

The agent can inspect its interface with `browser` at the URL returned by
`reload_ui`, including mobile viewport sizes with `resize`. Local preview uses a
short-lived internal sign-in, without exposing the owner's password or adding a
public login bypass. UI publishing checks JavaScript syntax; the agent should
inspect the result and roll back experiments that do not work. Local development
without Nix serves the editable web folder directly: refresh to see edits.

The editable `/data/workspace/nix/flake.nix` and `nix/flake.lock` declare personal tools.
To apply the flake from the workspace:

```sh
nix profile install ./nix             # first installation
nix profile upgrade nix              # subsequent changes
nix develop ./nix                    # temporary development shell
```

The dedicated flake folder keeps private memories and uploads out of its store snapshot.
The profile and store persist; the profile is already on PATH. Setup export/import
includes both flake files. Never put credentials in a flake: its contents enter
the Nix store. Nix can fetch cached packages and build missing ones locally.
The base toolkit includes ripgrep, curl, git, jq, Python, uv, FFmpeg, Poppler,
Chromium and Cloudflare. Python libraries belong in a writable virtual environment:

```sh
uv venv .venv
uv pip install --python .venv/bin/python requests
```

uv uses the supplied system Python; downloading standalone Python runtimes is
disabled because generic Linux binaries may not run in this Nix environment.
Set `TZ` in `.env` for daily-note dates; the container defaults to UTC.

A NixOS module is also included:

```nix
imports = [ phoenix.nixosModules.default ];
services.phoenix = {
  enable = true;
  environmentFile = "/run/secrets/phoenix.env";
  setup = builtins.fromJSON (builtins.readFile ./agent.json);
};
```

Keep secrets outside Nix configuration: Nix store contents are public.
`services.phoenix.extraPackages` supplies additional tools for custom extensions.
The service uses a private state directory and a dynamic system user, with a
2 GiB memory cap (`services.phoenix.memoryLimit`) and no swap allowance.

Research included [Pi](https://github.com/earendil-works/pi),
[pi.nix](https://github.com/lukasl-dev/pi.nix),
[another pi.nix setup](https://github.com/cyprx/pi.nix), and
[pi-flake](https://github.com/ChauDucToan/pi-flake). Phoenix packages upstream Pi
rather than adding a separate harness fork.

Tests cover authentication, HTTP/CSRF and WebSocket boundaries, queues and
cancellation, chat isolation, setup imports, model persistence, scheduled work,
email triage and approvals, workspace/attachment boundaries, Markdown/math,
voice controls, steering, mutable app reloads, shared memory, and real Pi streaming against local
OpenCode protocol fixtures. Live account tests for email and messaging still
require those account credentials.

This is an initial Muse-inspired implementation, not full feature or migration
compatibility with Muse, Dot or Grok. MIT licensed.


Phoenix ships a built-in operating guide in `PHOENIX.md`. The launcher reads it
from the packaged application and supplies it to every chat; mutable code/UI
rollbacks and imported setups do not replace it. In Docker, `/app` is read-only.
Owner instructions in `AGENTS.md` and Settings remain editable. This protects
that file from ordinary agent edits, not against deliberately rewriting the
entire self-modifiable runtime to ignore instructions.

While an agent works, **Queue** sends a follow-up after the task finishes;
**Steer** redirects the current task at the next Pi boundary. **Stop** cancels
active and queued work in that chat.

To browse through your computer's connection, open **Settings → Internet → Use
my internet**, download the connector, and run `node phoenix-connect.mjs` on your
computer. The same file works with Node.js 22+ on Windows, Linux and macOS. There
is one initial download/run step: browsers cannot launch a local network helper
without your action. Once it is running, switching between your connection and
VPS internet is one click. Keep the connector open; it reconnects when Phoenix
restarts. Disconnect computer revokes its separate pairing credential.

The optional `internet` extension carries Chromium and proxy-aware Bash web
requests (curl, Python's standard HTTP clients, Node's environment-proxy clients)
over the existing authenticated TLS WebSocket connection. Local previews bypass
it. This is not a full-container VPN: raw sockets, UDP, model API and messaging
connections stay direct. When the selected connector is offline, routed
requests fail instead of silently using the VPS. The connector allows only
public HTTP/HTTPS destinations, resolves DNS on your computer, blocks private
network addresses, and bounds connections and buffers. Remote pairing requires
HTTPS. Pairing credentials stay out of exported setups. A different IP may help
with datacenter blocks; websites can still require human verification.

## Oracle Always Free target

Use an **Ampere A1 Flex ARM64** instance with **1 OCPU, 6 GB RAM and a 100 GB
boot volume**, using an Always Free eligible Ubuntu image in your home region.
This leaves room for Docker builds, persistent Chromium, Nix generations and
user files; Phoenix keeps its existing **2 GiB container limit**, disk-backed
data, bounded sessions and idle browser shutdown. The 1 GB AMD Micro has very
little room for the host and Chromium, so A1 is the target for browser use.

As checked on 2026-10-03, Oracle's
[Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
lists **2 OCPUs / 12 GB total** for A1 Always Free tenancies and **200 GB total
block storage**. Older 4 OCPU / 24 GB guides are outdated for this target.
Check the Always Free allocation shown in your console before provisioning.
Availability is region-dependent; Oracle may reclaim idle free instances.
Keep backups of the persistent data and Nix store/state volumes for recovery.

With Docker Compose installed and this checkout on the instance, set
`PHOENIX_PUBLIC_IP` in `.env` and allow TCP ports 24843 and 80:

```sh
docker compose -f compose.yaml -f compose.oracle.yaml up --build -d
```

The override selects a native ARM64 build and enables direct HTTPS on port 24843. The
same Nix runtime runs inside the container; you do not need to replace the VPS
host OS. Retrieve the browser link and initial password with
`docker compose logs phoenix`. The private application port is unpublished;
the HTTPS proxy forwards browser traffic and WebSockets internally.

The pinned base image and Nix flake support both AMD64 and ARM64. CI builds and
smoke-tests the container on native Linux runners for both architectures, with
one CPU and 1 GiB smoke-test caps; the default deployment budget is 2 GiB. The connector has separate Windows/macOS jobs. Native
Oracle deployment has also been verified on an A1 ARM host; the local preview
runs on AMD64.

## Resource limits and logs

The Dockerfile declares the recommended budget as image labels: **2 GiB RAM,
one CPU, 256 MiB shared memory and 64 MiB temporary RAM**. The shared and
temporary memory count toward the total 2 GiB cap; `/data` stays on disk.
Dockerfiles cannot enforce host resource limits. `compose.yaml` applies the
limits, with no additional swap, on every architecture. Change
`PHOENIX_MEMORY_LIMIT` and `PHOENIX_CPU_LIMIT` in `.env` to override them.
Node's 256 MiB heap limit remains declared in the Dockerfile.

Phoenix writes timestamped JSON event logs to stdout: startup/shutdown,
generation recovery, extension failures, agent runs, scheduled jobs, channel
reconnects and HTTP requests. Errors include stacks and request/run/chat IDs
where applicable. HTTP responses carry `X-Request-Id`; failed API responses
also return that ID so you can find the corresponding log event. Routine
reads are debug-only and successful health checks are omitted.

Use `docker compose logs --tail=200 -f phoenix` for diagnostics. Set
`PHOENIX_LOG_LEVEL=debug` in `.env` and recreate the container for more detail.
Compose uses Docker's rotating `local` log driver, capped at three 10 MB
files per container, with compression. It stores logs on the host's disk;
there is no in-memory history or extra logging service. Logs survive container
restarts; export them before replacing/removing a container if you need them.

Phoenix event logs omit chat text, file contents, tool arguments, request
bodies, headers and query strings. The logger redacts credential fields,
loaded secrets and common API-token patterns in errors. The generated initial
login password is intentionally printed once for setup; set `PHOENIX_PASSWORD`
or its `_FILE` option to avoid that. Review diagnostic logs before sharing:
third-party programs and owner-installed extensions control their own output.


Archive a side chat with **Archive chat** in the sidebar. Open **Archived** in the sidebar to find it and choose **Restore**. History, files and scheduled jobs are retained; archiving only hides the chat from the active list and does not stop its jobs.

The **Chats** button toggles the sidebar on desktop and mobile. Desktop collapse is remembered locally without changing your current chat or draft.

Choose **System**, **Light** or **Dark** in Settings → Theme. The choice is remembered in your browser; System follows your device.
