#!/usr/bin/env python3
"""Minimal pty runner for the Dokkabi desktop gateway on macOS.

BSD `script(1)` cannot run with a non-tty stdin (its tcgetattr call fails
fatally on pipes), so the gateway cannot use it when spawning terminals
programmatically. This helper forks the child onto a fresh pty and shuttles
bytes between the gateway's pipes and the pty master, then exits with the
child's exit code so `terminal.exited` stays truthful.

Standard library only. Not user-facing. Invoked by desktop-server.ts as:

    python3 pty-run.py CMD [ARGS...]

DK_PTY_COLS / DK_PTY_ROWS size the pty (default 80x24).
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios


def exit_code(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def set_winsize(master: int) -> None:
    cols = int(os.environ.get("DK_PTY_COLS", "80"))
    rows = int(os.environ.get("DK_PTY_ROWS", "24"))
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def drain(master: int, stdout: int) -> None:
    while True:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            return
        try:
            chunk = os.read(master, 4096)
        except OSError:
            return
        if not chunk:
            return
        os.write(stdout, chunk)


def pump(pid: int, master: int) -> int:
    stdin = sys.stdin.fileno()
    stdout = sys.stdout.fileno()
    watch_stdin = True
    while True:
        fds = [master] + ([stdin] if watch_stdin else [])
        readable, _, _ = select.select(fds, [], [], 0.2)
        if stdin in readable:
            chunk = os.read(stdin, 4096)
            if chunk:
                os.write(master, chunk)
            else:
                # The gateway closed its input pipe. Closing the master hangs
                # up the pty (SIGHUP to the child), so shut down instead of
                # leaking an orphaned agent.
                return reap(pid)
        if master in readable:
            try:
                chunk = os.read(master, 4096)
            except OSError:  # EIO: child exited and the slave side is gone
                return reap(pid)
            if not chunk:
                return reap(pid)
            os.write(stdout, chunk)
        else:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                drain(master, stdout)
                return exit_code(status)


def reap(pid: int) -> int:
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return 1
    return exit_code(status)


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        return 64  # EX_USAGE
    pid, master = pty.fork()
    if pid == 0:
        # Child side: the pty slave is now stdin/stdout/stderr.
        os.execvp(argv[0], argv)
        os._exit(127)
    set_winsize(master)
    try:
        return pump(pid, master)
    finally:
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())
