# Install a portable native bundle

Extract the archive for your platform and run `sh omos/install.sh`. The installer
verifies the bundle's component checksums, copies the native runtime into
`~/.fx/releases/<runtime-hash>/`, and copies the pinned Fossil helper into
`~/.fx/libexec/`. It then installs `omos` and `omo` aliases in `~/.local/bin/`
or `XDG_BIN_HOME`. You can remove the unpacked download afterward. Keep the
published archive checksum when checking a downloaded release.

Installation creates an empty personal Fossil instance if none is bound. An
existing workspace binding, tasks, history, files, and branches remain intact.
The helper is part of the download; a separate Fossil installation is not
required. Linux bundles use the upstream glibc executables. macOS bundles use
the upstream Intel or Apple Silicon executable matching the archive name.
Preview bundles still require the normal release signing and qualification
before production distribution.

The CLI runtime and the Fossil helper are separate files. `installation.json`
records their hashes and sizes. Packaging also reports compressed download
bytes. The CLI binary-size policy does not describe the whole archive size.

Source installations can continue using `sh scripts/install-omos.sh` to link
the current checkout's built runtime. Use `--copy` for a durable runtime copy.
Both modes preserve a verified helper and refuse unrelated existing aliases.

To package a freshly built runtime, stage the matching pinned upstream helper
with `python3 scripts/stage-fossil-helper.py --platform PLATFORM`, then run
`python3 scripts/package-omos.py --platform PLATFORM --output PATH.tar.gz`.
The lock file records upstream source identity, archive hashes, executable
hashes, and platform sizes. Packaging does not fetch or mutate personal state.

Export personal state with `omos fossil export PATH`. The runtime installation
and credentials remain separate from that portable repository. Company service
deployment and authority recovery are described in
[the company deployment guide](company/README.md).
