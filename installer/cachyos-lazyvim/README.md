# SignalREACH for CachyOS + LazyVim

A client setup for the REACH endpoint: you chat with the models served by the
SignalREACH host (the machine that runs the relay/tunnel), right from your
terminal or Neovim. Nothing heavy runs locally — one small bridge process.

Works on CachyOS / Arch Linux (anything with `pacman` + `systemd`).

## Get the code

The project repository is private. Either:

1. **Invite** — accept the GitHub invitation, then:
   ```bash
   git clone https://github.com/falabellamichael/SignalR.E.A.C.H.git ~/src/signalreach
   ```
   (keeps `git pull` working for updates)

2. **Bundle** — extract the source bundle you were sent, e.g.:
   ```bash
   mkdir -p ~/src/signalreach && tar -xzf signal-reach-source.tar.gz -C ~/src/signalreach
   ```

## Install

From inside the project folder:

```bash
bash installer/cachyos-lazyvim/install.sh
```

It will:

- install `node` and `python` with `pacman` if they are missing (asks first)
- register **signalreach-endpoint** as a `systemd --user` service — a local
  OpenAI-compatible bridge on `127.0.0.1:20777` that follows the published
  REACH pointer
- install the **`reach`** command into `~/.local/bin`
- add **LazyVim keymaps** to `~/.config/nvim/lua/plugins/reach.lua`
- verify the client can reach the host

Options: `--no-nvim` · `--dir <path>` · `-y` · `--uninstall`.

If `~/.local/bin` is not on your PATH, the installer prints the one-liner for
your shell (fish/bash/zsh).

## Use it

```bash
reach chat               # interactive chat (also: /model <id>, /models, /web, /agent, /help)
reach ask "question"     # one-shot answer
reach web "question"     # grounded web answer with sources
reach models             # list models the host serves
```

In **LazyVim** (reload Neovim once after installing):

| Keys | Action |
| --- | --- |
| `<leader>ac` | open the REACH chat in a terminal |
| `<leader>af` | ask a question about the current file (prompted) |
| `<leader>as` | ask about the visual selection (line-based) |

Keymaps live in `~/.config/nvim/lua/plugins/reach.lua` — edit freely; the file
is yours, updates are only overwritten if still ours.

## Service notes

```bash
systemctl --user status signalreach-endpoint    # is it up?
systemctl --user restart signalreach-endpoint   # after network changes
journalctl --user -u signalreach-endpoint -n 50 # recent log
```

On a headless box, enable lingering so the client survives logout:
`sudo loginctl enable-linger "$USER"`.

Point a client elsewhere with `REACH_BASE_URL=http://host:20777/v1 reach chat`.

## Troubleshooting

- **`reach: command not found`** — `~/.local/bin` is not on PATH (see above).
- **Connections fail / 502** — the host is offline. The client follows the
  published pointer URL; confirm with
  `curl http://127.0.0.1:20777/public-url` from a terminal.
- **Port 20777 already in use** — something else claims it; stop that service
  (`ss -ltnp | grep 20777`) or edit `tools/endpoint-client.cjs`.
- **Neovim keys clash** — change the keys in `plugins/reach.lua` (e.g. to
  `<leader>R…`).

## Uninstall

```bash
bash installer/cachyos-lazyvim/install.sh --uninstall
```

Removes the service, the `reach` command and the LazyVim keymap file. The
project folder is kept — delete it yourself if you want.
