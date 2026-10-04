# Documentation

- [Start](#start)
- [Share your setup](#share-your-setup)
- [Chats and background work](#chats-and-background-work)
- [Extensions](#extensions)
- [Browser links](#browser-links)
- [Credentials](#credentials)
- [Nix and development](#nix-and-development)
- [Oracle Always Free target](#oracle-always-free-target)
- [Finances (Plaid)](#finances-plaid)
- [Resource limits and logs](#resource-limits-and-logs)

## Start

Install Docker with Compose, then run from this checkout:

```sh
git clone https://github.com/thanicsamin/phoenix.git
cd phoenix
docker compose up --build
```

The logs print a browser link and a generated password on first launch. Sign in
and choose a provider and add its API key in Settings. No provider key is included. For a
background service, add `-d`; retrieve the link with `docker compose logs phoenix`.
The first build downloads Chromium and its Nix dependencies. A published Docker
image is not available yet.

The default is OpenCode Go / Space Bunny Free while its free preview is available.
Pick a model and thinking level below the message box. Each chat remembers its
own choices, including for its scheduled jobs. Settings supports OpenCode Go/Zen,
OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, Mistral, DeepSeek,
Moonshot AI, MiniMax and Z.AI through Pi's native providers. Connected providers
appear in the chat model picker; adding a key does not change existing chats.
Models come from the pinned Pi catalog. OpenRouter model IDs retain their full
namespace, for example `google/gemini-2.5-flash`.
Keys saved in Settings persist in private `/data/pi/auth.json` (mode `0600`),
outside the editable workspace and setup exports. Existing OpenCode keys continue
to work; replacing one saves it for both Go and Zen. Provider environment variables,
such as `OPENROUTER_API_KEY`, also work; `_FILE` variables are supported for the
legacy `OPENCODE_API_KEY` path. Keys are not checked against a paid API until use.
Every model request identifies Phoenix. OpenCode requests send `x-opencode-session` with the
conversation's persisted Pi ID, including compaction, retries and model changes.

## Local model servers

In Settings, choose **Ollama**, **LM Studio** or **OpenAI-compatible server**
(vLLM, SGLang, llama.cpp, LocalAI, or another compatible endpoint). Enter the
server's full API URL ending in `/v1` and its served model IDs, separated by
commas. Save, then choose a model below the chat box. Saving a server keeps
existing chat selections. Use a model that supports tool calls for agent tools.

| Server | Default URL when Phoenix runs in Docker |
| --- | --- |
| Ollama | `http://host.docker.internal:11434/v1` |
| LM Studio | `http://host.docker.internal:1234/v1` |
| Other compatible server | `http://host.docker.internal:8000/v1` |

The API key is optional for unauthenticated servers. Blank keeps a saved key
for the same URL; changing the URL with a blank key clears the old server's key.
Server settings and keys persist in private `/data/pi/models.json` (mode `0600`)
using Pi's native client. They are excluded from setup exports. Connect the
recipient's server before importing a setup that selects its models.

Under **Model options**, set context tokens to match the server (default 32,768).
This tells Pi when to compact; it does not increase the server's context or
allocate model memory. Enable Images for vision models, and Thinking only if
the endpoint accepts OpenAI `reasoning_effort`. For different capabilities per
model, edit Pi's `models.json` directly.

Docker's `host.docker.internal` reaches the computer running Docker; Compose
also configures it on Linux. The model server must listen on an interface
reachable from Docker. For Ollama, set `OLLAMA_HOST=0.0.0.0:11434` and
`OLLAMA_CONTEXT_LENGTH=32768`, then restart it using the
[instructions for your OS](https://docs.ollama.com/faq#how-do-i-configure-ollama-server).
Keep unauthenticated servers on a private network. With native Phoenix, use
`http://localhost:11434/v1` instead. With Phoenix on a VPS, this host name means
the VPS; to use a model on your computer, provide a URL reachable through your
private network or VPN. A model in another container can use its service name
on a shared Docker network. Requests come from Phoenix, so browser CORS settings
do not need changing.

Phoenix does not download models or run an inference engine inside its container.
The connected server supplies compute and model storage, keeping the VPS small.
See [Ollama's API](https://docs.ollama.com/api/openai-compatibility),
[LM Studio's API](https://lmstudio.ai/docs/developer/openai-compat) and
[Docker host networking](https://docs.docker.com/reference/cli/docker/container/run/#add-host).

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
Choose a one-time run or an hourly, daily or weekly interval. On startup, Phoenix
immediately checks every chat, including archived chats, and runs overdue or
interrupted jobs. A repeating job catches up once, then starts its next interval
after completion; it does not replay every missed interval. Completed one-time
jobs stay completed. Failed jobs retry after one minute, with the error visible
in the chat. Interrupted jobs may repeat steps completed before the restart.

Incoming email wakes an Inbox chat. Its content is treated as untrusted data;
external actions and privileged email-triggered tools require approval in the
browser. Sending mail is separate from receiving it.

At most three Pi sessions stay loaded, including main chat. Idle side chats
unload after five minutes and reopen from their session files. Browsers close
after three idle minutes; cookies remain on disk. Background jobs wait on disk
when two scheduled jobs are already running. `/data`, `/nix/store` and
`/nix/var/nix` are disk-backed volumes. Only disposable `/tmp` uses tmpfs.

Live updates use an authenticated WebSocket with polling as a reconnect
fallback. The UI has no framework; its TypeScript compiles to browser JavaScript during the image build or UI publication.

Chat messages render Markdown, including tables and code blocks, and LaTeX math
with `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. Rendering and fonts are served locally.
Raw HTML is escaped; HTTPS and protected attachment images can render inline. This renders equations,
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
  "extensions": ["/data/extensions/my-extension.ts"],
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
on **24843**, without a Cloudflare account or a domain. Oracle's Compose override
enables HTTPS and discovers the public IPv4 automatically using ipify.
On other VPS hosts, set `PHOENIX_PUBLIC_IP=YOUR_PUBLIC_IPV4` and `COMPOSE_PROFILES=public` in `.env`.
You can override Oracle's detection with `PHOENIX_PUBLIC_IP` too.
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

Open **Browser** in a chat to watch its Chromium browser without interrupting
the agent. Press **Take control** to pause the agent and interact. Click or tap
the live page, type normally on desktop, or use the keyboard field and Tab/Enter
buttons on mobile. You can navigate, scroll, sign in and complete website MFA
yourself. **Return to agent** hands back the same authenticated browser and
resumes an interrupted task while keeping the live view open. Queued messages
and jobs wait while you control it. Closing a view you took control of or losing
connectivity leaves the agent paused; reopen Browser
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

Paste images or files into the composer, drop them there, or use **Attach files**.
Ordinary text paste stays unchanged. OS file-copy clipboard support depends on
the browser; the file picker and drag/drop remain available. Images and PDFs
show small previews before and after sending. PDF first pages render on your
device with lazy-loaded [PDF.js](https://mozilla.github.io/pdf.js/), one visible
preview at a time, without server-side conversion or a thumbnail database.
Image decoding, Markdown and math rendering also use your device. Agent-created
images appear inline through `attach_file`; Markdown can embed protected
attachment images or HTTPS images. Remote images send a request to their host
without a referrer. Other files stay download-only.

To edit a waiting message, press **↑** in an empty composer, choose its **Edit**
button, right-click it, or hold it briefly. **Save** replaces that queued message
and its attachments; **Cancel** restores your draft. Already-started messages
cannot be edited, and simultaneous edits from another window are rejected.

Main stays at the top of the sidebar. Select a side chat and use **Pin chat** to
keep it above other side chats. Chats sort by your last sent message, including
queued messages; agent replies and scheduled jobs do not move them around.
Pins and message order persist across restarts.

Memory defaults to a disk-backed journal for each chat. The `memory` tool appends
short notes, searches the original records, pages through older notes and saves
day → month → year summaries. Phoenix loads a bounded selection into the prompt;
missing summaries never prevent work. Summaries are optional model-maintained
caches, and the original notes remain on disk. There are no embeddings, background
model calls or memory database. Journal files and summaries are visible in
**Files → memory → chats**. Shared `USER.md`, `MEMORY.md` and existing daily notes
continue to work. External email/channel runs cannot access the private memory
tool. This is an original implementation inspired by
[OptMem](https://github.com/VictorTaelin/OptMem); it includes none of that project's code.

Enable browser notifications in **Settings** for replies, failures and approvals
in background chats. Notification bodies do not include private message text.
The page must remain open and connected; there is no push service or closed-tab
delivery. HTTPS or localhost is required, and OS/browser notification settings
still apply. Unread activity also appears in the tab title.

## Credentials

Choose a provider and enter its API key in Settings, or set its Pi environment
variable (for example `OPENROUTER_API_KEY`). Saved keys take precedence over
environment and legacy OpenCode keys after restart. Set `PHOENIX_PASSWORD` (12+ characters) to choose
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

Node 24 is pinned in the Nix runtime; local development requires Node 24+.
Use `nix run .#default` for the packaged service. `nix/runtime.nix` defines its
system tools, browser and fonts. The Docker image contains the Nix closure and
runs as root **inside the container**, with a read-only base filesystem and
writable persistent data, Nix store and Nix state volumes. Compose caps the whole
container at 2 GiB with no extra swap; set `PHOENIX_MEMORY_LIMIT` to change it.
Chromium uses a 128 MiB JavaScript heap budget and a two-renderer process target;
the container limit is the hard boundary for all Chromium processes combined.
The running agent has a 256 MiB old-space limit. Type checking uses a temporary, bounded 1 GiB compiler process; it exits after publication. Large source builds may need a higher container
limit; cached Nix packages avoid most compilation. `/usr/bin/env` is supplied for
npm CLI shebangs. It does not receive
the host Docker socket or privileged mode.

The editable source is copied once into `/data/workspace/phoenix`; edits survive
reloads and container replacement. **Files** exposes this source. Ask the agent
to modify itself, check the result, and use `reload_agent` (or **Reload agent** in
Files). It checks the TypeScript project, compiles browser assets, snapshots code and dependencies in the Nix
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
public login bypass. UI publishing checks strict TypeScript and JavaScript syntax; the agent should
inspect the result and roll back experiments that do not work. Local development
without Nix serves the editable web folder directly: compile TypeScript with `npm run build`, then refresh to see edits.

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

With Docker Compose installed and this checkout on the instance, allow TCP ports
24843 and 80 in Oracle's network rules, then run one command:

```sh
docker compose -f compose.yaml -f compose.oracle.yaml up --build -d
```

The override selects a native ARM64 build and enables direct HTTPS on port 24843. The
same Nix runtime runs inside the container; you do not need to replace the VPS
host OS. Retrieve the browser link and initial password with
`docker compose logs phoenix`. The private application port is unpublished;
the HTTPS proxy forwards browser traffic and WebSockets internally.
No environment file, Cloudflare account or domain is needed. The public IP is
detected at startup; override it only if your server uses a separate outbound IP.

The pinned base image and Nix flake support both AMD64 and ARM64. CI builds and
smoke-tests the container on native Linux runners for both architectures, with
one CPU and the default 2 GiB memory cap. The connector has separate Windows/macOS jobs. Native
Oracle deployment has also been verified on an A1 ARM host; the local preview
runs on AMD64.

## Finances (Plaid)

Open **Settings → Finances** and save your Plaid client ID and secret. Start with
**Sandbox** for test banks. Choose **Production** only with approved live API
credentials from your [Plaid dashboard](https://dashboard.plaid.com/).
**Connect bank** opens Plaid Link; bank passwords and MFA stay in Plaid/the bank.
Use **Reconnect** to renew a login without creating another bank connection, or
**Disconnect** to revoke Phoenix's access through Plaid and remove its saved token.

Phoenix's `finance` tool reads accounts, balances and transactions. Ask in any
owner browser chat, or schedule a task in that chat. Transactions default to
30 days, with at most 100 per page; the agent can page through more. Incoming
email and messaging channels cannot invoke this tool. There are no payment or
transfer endpoints. Financial data read by the agent goes to your selected model
provider and is saved in the chat history; connect only accounts you want it to see.

No extra service, database, webhook or recurring polling is required. Link's web
SDK loads on your computer only when connecting or reconnecting. Server replies
are capped at 2 MiB. API secrets and bank access tokens are encrypted with a
private local key under `/data/plaid/`, outside Files, setup exports and Nix
snapshots. Back up both the vault and its key privately. Encryption does not
isolate credentials from the privileged agent or someone with root access.

You can instead set `PLAID_CLIENT_ID` and `PLAID_SECRET` (or their `_FILE`
variants). Environment credentials take precedence over Settings. Declare the
API environment and optional products in your setup:

```json
"plaid": {
  "environment": "sandbox",
  "countries": ["US"],
  "products": ["transactions"]
}
```

`investments` and `liabilities` enable the corresponding read tools when included
in `products`. New products require bank consent; disconnect and relink an
existing connection with the updated setup. Enable Account Select in your Plaid
dashboard to let users choose individual accounts.

For same-tab/mobile bank OAuth, set `redirectUri` to your Phoenix root URL, e.g.
`https://your-host:24843/`, and register that exact URI in the Plaid dashboard.
Phoenix resumes Link with the original redirect URI and its short-lived token.
Production requires HTTPS. Desktop popup OAuth does not require a redirect URI.

Plaid's [Trial plan](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)
currently supports eligible individual US/Canada developers and up to ten
lifetime-created bank connections. Deleting connections does not restore that
quota. Reconnect an existing bank when its login expires. Production availability,
institution support, product access and pricing depend on your Plaid account.
Real bank linking requires your credentials and your manual sign-in; automated
tests use local API/Link fixtures and do not connect to real accounts.

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
