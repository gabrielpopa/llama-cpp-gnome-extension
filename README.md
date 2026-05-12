# llama.cpp GNOME Extension

A GNOME Shell panel indicator for a local `llama.cpp` server.

It starts the selected server profile command, reads the live `llama-server`
output, and shows the latest tokens-per-second value in the top bar. The menu
exposes prompt/eval throughput, token counts, total time, task/slot details,
process status, server selection, start/stop controls, and an action to open the
captured server logs.

Preferences include switches for which metrics appear directly in the panel:
status, generation TPS, prompt TPS, generated tokens, prompt tokens, total
tokens, total time, and slot/task.

The extension ships with no server profiles. Add one in Preferences with a
name, command, optional working directory, and optional process pattern.

Install:

```sh
make install
gnome-extensions enable llamacpp@gabrielpopa
```

If `gnome-extensions enable` says the extension does not exist immediately after
installing, restart GNOME Shell first. On Xorg press `Alt+F2`, enter `r`, and
press Enter. On Wayland, log out and back in.

Notes:

- Live TPS parsing works when the extension starts the server because it owns the process output stream.
- Server stdout/stderr is appended to `~/.local/state/llamacpp-gnome-extension/server.log` with one timestamped line per log line.
- The extension also detects existing `llama-server` processes with `pgrep`.
- Stop first terminates the process started by the extension. If the server was started elsewhere, it uses `pkill -f` with the configured process pattern.
