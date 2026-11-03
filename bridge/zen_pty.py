"""
A real terminal for ZEN's terminal window, with no native Node module.

The bridge runs this with four pipes:
  fd 0  keystrokes from the browser, written to the terminal as-is
  fd 1  everything the shell prints, raw bytes
  fd 3  control lines, JSON: {"cols": 120, "rows": 32} to resize

It forks the user's login shell on a pseudo-terminal (so colours, prompts,
vim and top all behave) and relays between the pipes and the terminal until
either side closes.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = os.environ.get("SHELL") or "/bin/zsh"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ.get("ZEN_TERM_CWD") or os.path.expanduser("~"))
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    os.execvp(shell, [shell, "-l"])


def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)


ctl_buf = b""
inputs = [0, 3, fd]
try:
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
                continue
            ctl_buf += data
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                    resize(int(msg["cols"]), int(msg["rows"]))
                except (ValueError, KeyError, OSError):
                    pass
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    sys.exit(0)
