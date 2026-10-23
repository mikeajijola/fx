#!/bin/sh
set -eu

checkout_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
binary_path="$checkout_dir/zig-out/bin/fx"
install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"

if [ ! -x "$binary_path" ]; then
    echo 'Build the CLI with zig build before installing its commands.' >&2
    exit 1
fi

mkdir -p "$install_dir"
for command in omos omo; do
    destination="$install_dir/$command"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        if [ ! -L "$destination" ] || [ "$(readlink "$destination")" != "$binary_path" ]; then
            echo "Refusing to replace an existing command: $destination" >&2
            exit 1
        fi
    fi
done
# Prefer a packaged helper when supplied; source installs can use host Fossil.
fossil_source="$checkout_dir/zig-out/libexec/fossil"
if [ ! -x "$fossil_source" ]; then
    fossil_source=$(command -v fossil || true)
fi
if [ -z "$fossil_source" ] || [ ! -x "$fossil_source" ]; then
    echo 'The installation requires its packaged Fossil helper or an existing Fossil executable.' >&2
    exit 1
fi
helper_dir="$HOME/.fx/libexec"
mkdir -p "$helper_dir"
chmod 700 "$helper_dir"
helper_temporary=$(mktemp "$helper_dir/fossil.install.XXXXXXXX")
trap 'rm -f "$helper_temporary" "$helper_temporary.manifest"' EXIT HUP INT TERM
cp "$fossil_source" "$helper_temporary"
chmod 700 "$helper_temporary"
if command -v sha256sum >/dev/null 2>&1; then
    helper_hash=$(sha256sum "$helper_temporary" | cut -d ' ' -f 1)
else
    helper_hash=$(shasum -a 256 "$helper_temporary" | cut -d ' ' -f 1)
fi
printf '{"version":1,"file":"fossil-%s","sha256":"%s"}\n' "$helper_hash" "$helper_hash" > "$helper_temporary.manifest"
chmod 600 "$helper_temporary.manifest"
mv "$helper_temporary" "$helper_dir/fossil-$helper_hash"
mv "$helper_temporary.manifest" "$helper_dir/fossil.json"
trap - EXIT HUP INT TERM

for command in omos omo; do
    destination="$install_dir/$command"
    if [ ! -L "$destination" ]; then
        ln -s "$binary_path" "$destination"
    fi
    echo "Installed $command: $destination"
done

"$install_dir/omos" fossil ensure --json

case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) echo "Add $install_dir to your PATH to use these commands." ;;
esac
